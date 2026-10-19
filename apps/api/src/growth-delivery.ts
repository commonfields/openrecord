// Marketing delivery service (P2): prepare -> human approval -> pull request
// -> GitHub-confirmed merge -> operator-attested deployment.
//
// prepare   reads the file from the connected repository's base branch,
//           applies exact find/replace edits, and stores the diff, the
//           approved bytes and a patch hash bound to the base blob.
// approve   a person approves exactly that patch hash (or rejects it).
// open PR   claims an attempt before any GitHub write, re-checks that the
//           base file is still the reviewed blob (otherwise STALE, nothing
//           written), then creates the delivery branch, one commit with the
//           approved bytes, and one pull request. A request whose outcome
//           GitHub did not confirm is UNKNOWN; the next request reconciles
//           against GitHub (existing branch, commit, pull request) before
//           writing, so retries never open a second pull request.
// refresh   reads the pull request state from GitHub. Merged is recorded with
//           GitHub's merge commit; it is not a deployment.
// deploy    a person attests where and when they saw the change live. The
//           record says it is operator-attested; OpenRecord does not verify it.
import { createHash } from "node:crypto"
import { Effect } from "effect"
import {
  applyDeliveryEdits, diffLines, pathAllowed, unifiedDiff,
  type ConnectDeliveryTarget, type DeliveryDecision, type PrepareDelivery, type AttestDeployment, type GrowthDelivery,
} from "@openrecord/contracts"
import { DeliveryRefused, GrowthDeliveryRepository, GrowthRepository, deliveryHeadBranch, type Session } from "@openrecord/db"
import { GitHubDelivery, GitHubError, MAX_DELIVERY_FILE_BYTES, gitBlobSha, githubEffect, type GitHubTransport } from "./github-delivery.js"

export const DELIVERY_PLAN_VERSION = "growth-delivery-plan/1"
const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex")
export const deliveryPatchHash = (p: { owner: string; repository: string; filePath: string; baseBlobSha: string; beforeSha256: string; afterSha256: string }) =>
  sha256([DELIVERY_PLAN_VERSION, `${p.owner.toLowerCase()}/${p.repository.toLowerCase()}`, p.filePath, p.baseBlobSha, p.beforeSha256, p.afterSha256].join("\n"))

const refuse = (reason: string) => Effect.fail(new DeliveryRefused({ reason }))

/** The configured transport, only for a repository on this account's allowlist. */
const transportFor = (accountId: string, owner: string, repository: string) => Effect.gen(function*() {
  const config = yield* GitHubDelivery
  if (!config.transport) return yield* refuse("DeliveryNotConfigured")
  if (!config.allowed(owner, repository, accountId)) return yield* refuse("RepositoryNotAuthorized")
  return config.transport
})

export const connectTarget = (session: Session, businessId: string, input: ConnectDeliveryTarget) => Effect.gen(function*() {
  const repo = yield* GrowthDeliveryRepository
  const github = yield* transportFor(session.accountId, input.owner, input.repository)
  const found = yield* githubEffect(() => github.repository(input.owner, input.repository))
  if (!found) return yield* refuse("RepositoryNotFound")
  const head = yield* githubEffect(() => github.branchHead(input.owner, input.repository, input.baseBranch))
  if (!head) return yield* refuse("BaseBranchNotFound")
  return yield* repo.connect(session, businessId, input)
})

export const prepareDelivery = (session: Session, businessId: string, opportunityId: string, actor: "OPERATOR" | "ASSISTANT", input: PrepareDelivery) =>
  Effect.gen(function*() {
    const repo = yield* GrowthDeliveryRepository
    // A repeated request returns its draft without reading GitHub again.
    const replay = yield* repo.byRequest(session.accountId, businessId, input.idempotencyKey)
    if (replay) {
      if (replay.opportunityId !== opportunityId || replay.proposedBy !== actor) return yield* refuse("IdempotencyConflict")
      return replay
    }
    const opportunity = yield* (yield* GrowthRepository).get(session.accountId, businessId, opportunityId).pipe(
      Effect.catchTag("GrowthRefused", e => refuse(e.reason)))
    if (opportunity.status !== "APPROVED") return yield* refuse("OpportunityNotApproved")
    const target = yield* repo.target(session.accountId, businessId, input.targetId)
    if (!pathAllowed(input.filePath, target.allowedPaths)) return yield* refuse("PathNotAllowed")
    const github = yield* transportFor(session.accountId, target.owner, target.repository)
    const baseCommitSha = yield* githubEffect(() => github.branchHead(target.owner, target.repository, target.baseBranch))
    if (!baseCommitSha) return yield* refuse("BaseBranchNotFound")
    const file = yield* githubEffect(() => github.file(target.owner, target.repository, input.filePath, baseCommitSha))
    if (file.kind === "missing") return yield* refuse("SourceNotFound")
    if (file.kind === "not_file") return yield* refuse("SourceNotAFile")
    if (file.kind === "too_large" || file.kind === "not_text") return yield* refuse("SourceUnsupported")
    if (Buffer.byteLength(file.content, "utf8") > MAX_DELIVERY_FILE_BYTES) return yield* refuse("SourceUnsupported")
    // What GitHub returned must be the blob it named.
    if (gitBlobSha(file.content) !== file.blobSha) return yield* refuse("SourceIntegrity")
    const applied = applyDeliveryEdits(file.content, input.edits)
    if (!applied.ok) return yield* refuse(`Edit${applied.failure.code === "NO_CHANGE" ? "NoChange" : applied.failure.code === "NOT_FOUND" ? "NotFound" : applied.failure.code === "AMBIGUOUS" ? "Ambiguous" : "Overlap"}`)
    if (Buffer.byteLength(applied.content, "utf8") > MAX_DELIVERY_FILE_BYTES) return yield* refuse("ResultTooLarge")
    const beforeSha256 = sha256(file.content), afterSha256 = sha256(applied.content)
    return yield* repo.draft(session, businessId, opportunityId, actor, {
      targetId: target.id, filePath: input.filePath, baseBranch: target.baseBranch, baseCommitSha, baseBlobSha: file.blobSha,
      afterBlobSha: gitBlobSha(applied.content), beforeSha256, afterSha256,
      patchSha256: deliveryPatchHash({ owner: target.owner, repository: target.repository, filePath: input.filePath, baseBlobSha: file.blobSha, beforeSha256, afterSha256 }),
      edits: input.edits, afterContent: applied.content, diff: unifiedDiff(input.filePath, diffLines(file.content, applied.content)),
      rationale: input.rationale, assumptions: input.assumptions, idempotencyKey: input.idempotencyKey,
    })
  })

export const decideDelivery = (session: Session, businessId: string, deliveryId: string, input: DeliveryDecision) =>
  Effect.flatMap(GrowthDeliveryRepository, repo => repo.decide(session, businessId, deliveryId, input))

const oneLine = (s: string, max: number) => s.replace(/\s+/g, " ").trim().slice(0, max)

const pullRequestText = (delivery: GrowthDelivery, title: string) => ({
  title: oneLine(`Marketing copy: ${title}`, 120),
  message: `${oneLine(`Update ${delivery.filePath}: ${title}`, 72)}\n\nApproved in OpenRecord before this commit was created.`,
  body: [
    `**Opportunity:** ${oneLine(title, 200)}`, "",
    `**Why:** ${delivery.rationale}`, "",
    `**Assumptions:** ${delivery.assumptions}`, "",
    "This pull request was opened by OpenRecord after a person approved this exact change.",
    "OpenRecord does not merge or deploy it. Merging and deployment are separate decisions.", "",
    `OpenRecord delivery \`${delivery.id}\` · patch \`${delivery.patchSha256.slice(0, 12)}\``,
  ].join("\n"),
})

type AttemptResult = { readonly state: "SUCCEEDED"; readonly commitSha: string; readonly prNumber: number; readonly prUrl: string }
  | { readonly state: "FAILED"; readonly code: string; readonly detail: string; readonly stale: boolean }

/**
 * The GitHub steps for one claimed attempt. Every step first looks at what
 * already exists, so running it again after an unconfirmed outcome finishes
 * the same branch, commit and pull request instead of creating new ones.
 */
const runAttempt = (github: GitHubTransport, delivery: GrowthDelivery, afterContent: string, title: string) => Effect.gen(function*() {
  const { owner, repository: repo, baseBranch, filePath } = delivery
  const head = deliveryHeadBranch(delivery.id)
  const failed = (code: string, detail: string, stale = false): AttemptResult => ({ state: "FAILED", code, detail, stale })
  const text = pullRequestText(delivery, title)

  const existing = yield* githubEffect(() => github.findPullRequest(owner, repo, head, baseBranch))
  if (existing) {
    const onHead = yield* githubEffect(() => github.file(owner, repo, filePath, existing.headSha))
    if (onHead.kind !== "file" || onHead.blobSha !== delivery.afterBlobSha) return failed("HEAD_DIVERGED", "the delivery branch no longer holds the approved change")
    return { state: "SUCCEEDED", commitSha: existing.headSha, prNumber: existing.number, prUrl: existing.url } satisfies AttemptResult
  }
  const baseHead = yield* githubEffect(() => github.branchHead(owner, repo, baseBranch))
  if (!baseHead) return failed("BASE_BRANCH_MISSING", "the base branch no longer exists")
  const baseFile = yield* githubEffect(() => github.file(owner, repo, filePath, baseHead))
  // The reviewed source must still be what is on the base branch.
  if (baseFile.kind !== "file" || baseFile.blobSha !== delivery.baseBlobSha) {
    return failed("STALE_BASE", "the file on the base branch changed after the change was reviewed", true)
  }
  let headSha = yield* githubEffect(() => github.branchHead(owner, repo, head))
  if (!headSha) {
    yield* githubEffect(() => github.createBranch(owner, repo, head, baseHead))
    headSha = yield* githubEffect(() => github.branchHead(owner, repo, head))
    if (!headSha) return failed("BRANCH_UNAVAILABLE", "GitHub did not show the delivery branch after creating it")
  }
  const onHead = yield* githubEffect(() => github.file(owner, repo, filePath, headSha!))
  let commitSha: string
  if (onHead.kind === "file" && onHead.blobSha === delivery.afterBlobSha) {
    commitSha = headSha // committed by an earlier attempt
  } else if (onHead.kind === "file" && onHead.blobSha === delivery.baseBlobSha) {
    // Exactly the approved bytes, and only if the branch still has the reviewed blob.
    commitSha = (yield* githubEffect(() => github.putFile(owner, repo, { path: filePath, branch: head, content: afterContent, expectedBlobSha: delivery.baseBlobSha, message: text.message }))).commitSha
  } else {
    return failed("HEAD_DIVERGED", "the delivery branch holds a different version of the file")
  }
  const pr = yield* githubEffect(() => github.createPullRequest(owner, repo, { head, base: baseBranch, title: text.title, body: text.body })).pipe(
    Effect.catchIf(e => e.kind === "CONFLICT", () => githubEffect(async () => {
      const found = await github.findPullRequest(owner, repo, head, baseBranch)
      if (!found) throw new GitHubError("UNAVAILABLE", "GitHub reported a conflict but no pull request was found")
      return found
    })))
  return { state: "SUCCEEDED", commitSha, prNumber: pr.number, prUrl: pr.url } satisfies AttemptResult
})

// Deterministic GitHub refusals end the attempt; anything that may have
// happened without confirmation is UNKNOWN and reconciled next time.
const definite = new Set(["NOT_FOUND", "AUTH", "INVALID", "CONFLICT"])

export const openPullRequest = (session: Session, businessId: string, deliveryId: string, requestKey: string) => Effect.gen(function*() {
  const repo = yield* GrowthDeliveryRepository
  const current = yield* repo.get(session.accountId, businessId, deliveryId)
  // Authorization is checked again at execution, not only when connecting.
  const github = yield* transportFor(session.accountId, current.owner, current.repository)
  const claim = yield* repo.claimAttempt(session, businessId, deliveryId, requestKey)
  if (claim.kind === "replay") return { delivery: claim.delivery, outcome: "REPLAYED" as const }
  const opportunity = yield* (yield* GrowthRepository).get(session.accountId, businessId, claim.delivery.opportunityId).pipe(
    Effect.catchTag("GrowthRefused", e => refuse(e.reason)))
  const result = yield* runAttempt(github, claim.delivery, claim.afterContent, opportunity.title).pipe(Effect.either)
  if (result._tag === "Right") {
    const delivery = yield* repo.completeAttempt(session, businessId, deliveryId, claim.attempt.id, result.right)
    return { delivery, outcome: result.right.state === "SUCCEEDED" ? "OPENED" as const : result.right.stale ? "STALE" as const : "FAILED" as const }
  }
  const e = result.left
  const delivery = definite.has(e.kind)
    ? yield* repo.completeAttempt(session, businessId, deliveryId, claim.attempt.id, { state: "FAILED", code: `GITHUB_${e.kind}`, detail: e.message, stale: false })
    : yield* repo.completeAttempt(session, businessId, deliveryId, claim.attempt.id, { state: "UNKNOWN", detail: e.message })
  return { delivery, outcome: definite.has(e.kind) ? "FAILED" as const : "UNKNOWN" as const }
})

export const refreshDelivery = (session: Session, businessId: string, deliveryId: string) => Effect.gen(function*() {
  const repo = yield* GrowthDeliveryRepository
  const delivery = yield* repo.get(session.accountId, businessId, deliveryId)
  if (delivery.state !== "PR_OPENED") return delivery
  const attempt = delivery.attempts.find(a => a.state === "SUCCEEDED")
  if (!attempt?.prNumber) return delivery
  const github = yield* transportFor(session.accountId, delivery.owner, delivery.repository)
  const pr = yield* githubEffect(() => github.pullRequest(delivery.owner, delivery.repository, attempt.prNumber!))
  if (pr.merged && pr.mergeCommitSha) return yield* repo.recordPullRequest(session, businessId, deliveryId, { state: "MERGED", mergeCommitSha: pr.mergeCommitSha, mergedAt: pr.mergedAt })
  if (pr.state === "closed") return yield* repo.recordPullRequest(session, businessId, deliveryId, { state: "CLOSED", closedAt: pr.closedAt })
  return delivery
})

export const attestDeployment = (session: Session, businessId: string, deliveryId: string, input: AttestDeployment) =>
  Effect.flatMap(GrowthDeliveryRepository, repo => repo.attestDeployment(session, businessId, deliveryId, input))
