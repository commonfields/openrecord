// ExecutionRunner (W7): claims one durable execution job and carries it out.
//
//   DISPATCH    open the pull request for the exact authorized change
//   RECONCILE   learn the provider's authoritative state of that pull request
//   LIVE_CHECK  re-observe the configured live page (a separate fact)
//
// Safety rules this file enforces:
//  - Read before write. Every provider write is preceded by a read of the
//    provider's current state, so a replay after a crash, a timeout or a lost
//    response can only ever reach the same branch, commit and pull request.
//    There is no "retry the POST": the second attempt first discovers whether
//    the first one worked.
//  - A timeout is not proof of failure. A write whose outcome is unknown moves
//    the operation to UNKNOWN and is reconciled before anything is written again.
//  - Only the exact authorized change is written: repository, branch, base
//    revision, page, bytes. Anything else stops the operation (BLOCKED) and
//    needs a new human authorization.
//  - A merge is verified against provider evidence, not against the fact that
//    a pull request existed. OpenRecord never merges and never deploys.
//  - Errors carry stable codes. No token, URL query or provider text is logged.
import { Context, Duration, Effect, Layer, Option } from "effect"
import type { SqlError } from "@effect/sql/SqlError"
import {
  GrowthExecutionRepository, GrowthExecutionRefused, type ExecutionJob, type ExecutionWork, type RowDecodeError,
} from "@openrecord/db"
import { executionPathAllowed, executionRepositoryDenied, type ExecutionOperation, type ExecutionStopCode } from "@openrecord/contracts"
import { safeFetch, type HttpTransport } from "@openrecord/representation"
import { isInScope } from "@openrecord/discovery"
import {
  GitHubError, GitHubExecution, executionHeadBranch, executionPullRequestText, githubEffect, githubOutcomeUncertain, inspectPage, sha256Text, type GitHubExecutionConfig, type GitHubPullRequest,
} from "@openrecord/site-operator"

export class ExecutionRunner extends Context.Tag("ExecutionRunner")<
  ExecutionRunner,
  { readonly runOnce: () => Effect.Effect<boolean, SqlError | RowDecodeError> }
>() {}

export interface ExecutionRunnerOptions {
  /** Test seam for the live-site fetch. Production uses the shared SSRF-safe fetch. */
  readonly transport?: HttpTransport
  readonly workerId?: string
  /** Tests sharing a database claim only their own operations. */
  readonly operationIds?: ReadonlyArray<string>
  readonly leaseSeconds?: number
  readonly maxAttempts?: number
  readonly reconcilePollSeconds?: number
  /** First live check after a verified merge. A deployment takes time; 0 in tests. */
  readonly liveCheckDelaySeconds?: number
}
const SITE_FETCH_TIMEOUT_MS = 10_000
const LIVE_MAX_BYTES = 1_000_000

/** Transient failures back off exponentially with a ceiling; a rate limit follows the provider's own hint. */
export const executionBackoffSeconds = (attempt: number, error: GitHubError | null): number =>
  error?.kind === "RATE_LIMITED" && error.retryAfterSeconds ? Math.min(3600, error.retryAfterSeconds) : Math.min(600, 15 * 2 ** Math.max(0, attempt - 1))

type Outcome = { readonly done: true } | { readonly retry: number; readonly code: string }
const DONE: Outcome = { done: true }
const sameRepo = (a: string, owner: string, repository: string) => a.toLowerCase() === `${owner}/${repository}`.toLowerCase()

export const makeExecutionRunnerLive = (opts: ExecutionRunnerOptions = {}) => Layer.effect(ExecutionRunner, Effect.gen(function*() {
  const repo = yield* GrowthExecutionRepository
  const config: GitHubExecutionConfig = Option.getOrElse(yield* Effect.serviceOption(GitHubExecution), () => ({ transport: null, allowed: () => false }))
  const workerId = opts.workerId ?? `execution-worker-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  const leaseSeconds = opts.leaseSeconds ?? 120
  const maxAttempts = opts.maxAttempts ?? 5
  const pollSeconds = opts.reconcilePollSeconds ?? 120
  const liveDelay = opts.liveCheckDelaySeconds ?? 300
  const only = opts.operationIds

  const log = (message: string, extra: Record<string, unknown> = {}) => Effect.logInfo(message).pipe(Effect.annotateLogs({ component: "execution-runner", ...extra }))
  const stop = (op: ExecutionOperation, to: "FAILED" | "BLOCKED", code: ExecutionStopCode, reason: string, detail: Record<string, unknown> = {}) =>
    repo.transition(op.id, op.businessId, to, reason, { code, ...detail }).pipe(Effect.zipLeft(log("execution stopped", { operationId: op.id, to, code })))

  /** The provider call, with GitHubError kept as a value so callers can classify without parsing text. */
  const gh = <A>(f: () => Promise<A>) => githubEffect(f).pipe(Effect.either)

  // ---------------------------------------------------------------- dispatch
  const dispatch = (job: ExecutionJob, work: ExecutionWork): Effect.Effect<Outcome, SqlError | RowDecodeError | GrowthExecutionRefused> => Effect.gen(function*() {
    const op = work.operation
    if (op.state !== "DISPATCHING") return DONE                                           // already settled elsewhere
    const transport = config.transport
    // Re-prove authority now, not when the job was queued.
    if (work.initiativeStatus !== "APPROVED") { yield* stop(op, "BLOCKED", "INITIATIVE_NOT_APPROVED", "The initiative is no longer approved"); return DONE }
    if (work.authorizedPatchSha256 !== op.patchSha256 || !work.authorizationExpiresAt) { yield* stop(op, "BLOCKED", "AUTHORIZATION_EXPIRED", "The authorization does not match the change"); return DONE }
    if (Date.parse(work.authorizationExpiresAt) <= Date.now()) { yield* stop(op, "BLOCKED", "AUTHORIZATION_EXPIRED", "The authorization expired before dispatch"); return DONE }
    if (executionRepositoryDenied(op.owner, op.repository) || !config.allowed(op.owner, op.repository, work.accountId)) { yield* stop(op, "BLOCKED", "REPOSITORY_NOT_PERMITTED", "The repository is not permitted for this account"); return DONE }
    if (!executionPathAllowed(op.filePath, work.allowedPaths)) { yield* stop(op, "BLOCKED", "PATH_NOT_PERMITTED", "The page is outside the connected paths"); return DONE }
    if (!transport) { yield* stop(op, "BLOCKED", "NOT_CONFIGURED", "Provider access is not configured"); return DONE }
    const { owner, repository } = op
    const branch = executionHeadBranch(op.id)
    let writeAttempted = false
    const uncertain = (e: GitHubError) => githubOutcomeUncertain(e) && writeAttempted
    const fail = (e: GitHubError, step: string): Effect.Effect<Outcome, SqlError | RowDecodeError | GrowthExecutionRefused> => Effect.gen(function*() {
      if (e.kind === "AUTH") { yield* stop(op, "FAILED", "PROVIDER_AUTH", "The provider refused the execution credentials"); return DONE }
      if (e.kind === "NOT_FOUND") { yield* stop(op, "FAILED", "PROVIDER_NOT_FOUND", `The provider could not find the ${step}`); return DONE }
      if (e.kind === "INVALID") { yield* stop(op, "FAILED", "PROVIDER_REJECTED", `The provider rejected the ${step}`); return DONE }
      if (uncertain(e)) {
        // The write may have happened. Record that, then reconcile before any further write.
        yield* repo.recordEvidence(op.id, op.businessId, "DISPATCH_UNCERTAIN", { step, kind: e.kind })
        yield* repo.transition(op.id, op.businessId, "UNKNOWN", "The provider did not confirm the request", { step, kind: e.kind })
        yield* repo.ensureJob(op.id, op.businessId, "RECONCILE", 0)
        return DONE
      }
      if (job.attemptCount >= maxAttempts) { yield* stop(op, "FAILED", "RETRIES_EXHAUSTED", "The provider stayed unavailable; nothing was written"); return DONE }
      return { retry: executionBackoffSeconds(job.attemptCount, e), code: e.kind }
    })

    const info = yield* gh(() => transport.repository(owner, repository))
    if (info._tag === "Left") return yield* fail(info.left, "repository")
    if (!info.right || !sameRepo(info.right.fullName, owner, repository)) { yield* stop(op, "FAILED", "PROVIDER_NOT_FOUND", "The repository is not the one that was authorized"); return DONE }
    // The approved source: the page must still be the bytes the person reviewed.
    const head = yield* gh(() => transport.branchHead(owner, repository, op.baseBranch))
    if (head._tag === "Left") return yield* fail(head.left, "base branch")
    if (!head.right) { yield* stop(op, "FAILED", "PROVIDER_NOT_FOUND", "The base branch no longer exists"); return DONE }
    const current = yield* gh(() => transport.file(owner, repository, op.filePath, head.right!))
    if (current._tag === "Left") return yield* fail(current.left, "page")
    if (current.right.kind !== "file" || current.right.blobSha !== op.baseBlobSha) {
      // The branch may have already been merged by another route: a missing file or changed blob is the same stop.
      const alreadyBranch = yield* gh(() => transport.branchHead(owner, repository, branch))
      if (alreadyBranch._tag === "Right" && alreadyBranch.right) { /* our own branch exists: continue with it below */ } else { yield* stop(op, "BLOCKED", "SOURCE_CHANGED", "The page changed after it was reviewed"); return DONE }
    }
    // Branch: create only when absent. An existing branch is ours by name, and is checked below before it is trusted.
    const existing = yield* gh(() => transport.branchHead(owner, repository, branch))
    if (existing._tag === "Left") return yield* fail(existing.left, "branch")
    if (!existing.right) {
      writeAttempted = true
      const made = yield* gh(() => transport.createBranch(owner, repository, branch, op.baseCommitSha))
      if (made._tag === "Left") return yield* fail(made.left, "branch")
      yield* repo.recordEvidence(op.id, op.businessId, "BRANCH_READY", { branch, created: made.right === "created" })
    }
    // Commit: write only the authorized bytes, only over the reviewed blob.
    const onBranch = yield* gh(() => transport.file(owner, repository, op.filePath, branch))
    if (onBranch._tag === "Left") return yield* fail(onBranch.left, "page")
    if (onBranch.right.kind !== "file") { yield* stop(op, "BLOCKED", "BRANCH_CONFLICT", "The working branch does not hold the page"); return DONE }
    if (onBranch.right.blobSha === work.afterBlobSha) { /* the authorized commit is already there */ }
    else if (onBranch.right.blobSha === op.baseBlobSha) {
      const text = executionPullRequestText({ operationId: op.id, filePath: op.filePath, patchSha256: op.patchSha256, diff: op.diff, rationale: op.rationale, liveUrl: op.liveUrl })
      writeAttempted = true
      const put = yield* gh(() => transport.putFile(owner, repository, { path: op.filePath, branch, content: work.afterContent, expectedBlobSha: op.baseBlobSha, message: text.commitMessage }))
      if (put._tag === "Left") {
        if (put.left.kind === "CONFLICT") { yield* stop(op, "BLOCKED", "BRANCH_CONFLICT", "The working branch changed while writing"); return DONE }
        return yield* fail(put.left, "commit")
      }
      yield* repo.recordEvidence(op.id, op.businessId, "COMMIT_CREATED", { commitSha: put.right.commitSha })
    } else { yield* stop(op, "BLOCKED", "BRANCH_CONFLICT", "The working branch holds a different change"); return DONE }
    // Pull request: find before creating. A second attempt can never open a second request.
    const text = executionPullRequestText({ operationId: op.id, filePath: op.filePath, patchSha256: op.patchSha256, diff: op.diff, rationale: op.rationale, liveUrl: op.liveUrl })
    let pr: GitHubPullRequest | null = null
    const found = yield* gh(() => transport.findPullRequest(owner, repository, branch, op.baseBranch))
    if (found._tag === "Left") return yield* fail(found.left, "pull request")
    pr = found.right
    if (!pr) {
      writeAttempted = true
      const created = yield* gh(() => transport.createPullRequest(owner, repository, { head: branch, base: op.baseBranch, title: text.title, body: text.body }))
      if (created._tag === "Left") {
        if (created.left.kind === "CONFLICT") {
          const again = yield* gh(() => transport.findPullRequest(owner, repository, branch, op.baseBranch))
          if (again._tag === "Right" && again.right) pr = again.right
          else { yield* stop(op, "BLOCKED", "BRANCH_CONFLICT", "The provider reported an existing pull request that could not be read"); return DONE }
        } else return yield* fail(created.left, "pull request")
      } else pr = created.right
    }
    if (!sameRepo(pr.baseRepository, owner, repository) || pr.baseRef !== op.baseBranch || pr.headRef !== branch) { yield* stop(op, "BLOCKED", "PR_WRONG_TARGET", "The pull request targets another repository or branch"); return DONE }
    yield* repo.recordEvidence(op.id, op.businessId, "PR_OPENED", { prNumber: pr.number, prUrl: pr.url, headSha: pr.headSha, headRef: pr.headRef, baseRef: pr.baseRef, baseRepository: pr.baseRepository })
    yield* repo.transition(op.id, op.businessId, "AWAITING_MERGE", "Pull request opened; waiting for the repository maintainer", { prNumber: pr.number, prUrl: pr.url })
    yield* repo.ensureJob(op.id, op.businessId, "RECONCILE", pollSeconds)
    yield* log("pull request opened", { operationId: op.id, prNumber: pr.number })
    return DONE
  })

  // --------------------------------------------------------------- reconcile
  const reconcile = (job: ExecutionJob, work: ExecutionWork): Effect.Effect<Outcome, SqlError | RowDecodeError | GrowthExecutionRefused> => Effect.gen(function*() {
    let op = work.operation
    const transport = config.transport
    if (op.state === "VERIFIED" || op.state === "FAILED" || op.state === "BLOCKED" || op.state === "CANCELLED") return DONE
    if (!transport) { yield* stop(op, "BLOCKED", "NOT_CONFIGURED", "Provider access is not configured"); return DONE }
    const { owner, repository } = op
    const branch = executionHeadBranch(op.id)
    const transient = (e: GitHubError): Outcome => {
      if (e.kind === "AUTH") return { retry: executionBackoffSeconds(job.attemptCount, e), code: "AUTH" }
      return { retry: executionBackoffSeconds(job.attemptCount, e), code: e.kind }
    }
    const opened = op.evidence.find(e => e.kind === "PR_OPENED")
    if (op.state === "UNKNOWN" && !opened) {
      // The dispatch outcome is unknown. Ask the provider whether the pull request exists before anything is written again.
      const found = yield* gh(() => transport.findPullRequest(owner, repository, branch, op.baseBranch))
      if (found._tag === "Left") {
        if (found.left.kind === "AUTH") { yield* stop(op, "FAILED", "PROVIDER_AUTH", "The provider refused the execution credentials"); return DONE }
        return transient(found.left)
      }
      if (found.right) {
        const pr = found.right
        if (!sameRepo(pr.baseRepository, owner, repository) || pr.baseRef !== op.baseBranch || pr.headRef !== branch) { yield* stop(op, "BLOCKED", "PR_WRONG_TARGET", "The pull request targets another repository or branch"); return DONE }
        yield* repo.recordEvidence(op.id, op.businessId, "PR_OPENED", { prNumber: pr.number, prUrl: pr.url, headSha: pr.headSha, headRef: pr.headRef, baseRef: pr.baseRef, baseRepository: pr.baseRepository })
        yield* repo.transition(op.id, op.businessId, "AWAITING_MERGE", "Reconciled: the pull request exists", { prNumber: pr.number, prUrl: pr.url, providerChecked: true })
        return { retry: 0, code: "PENDING_MERGE" }               // finish this job and look again at once
      }
      // Nothing opened. Retrying is safe now because the dispatch steps read before they write.
      const uncertainCycles = op.evidence.filter(e => e.kind === "DISPATCH_UNCERTAIN").length
      if (uncertainCycles >= 3) { yield* stop(op, "BLOCKED", "RETRIES_EXHAUSTED", "The outcome could not be confirmed; check the repository before authorizing again"); return DONE }
      yield* repo.transition(op.id, op.businessId, "DISPATCHING", "Reconciled: no pull request exists; dispatching again", { providerChecked: true })
      yield* repo.ensureJob(op.id, op.businessId, "DISPATCH", 0)
      return DONE
    }
    if (!opened) return DONE
    // A pull request is recorded but the state never advanced (a crash between the two writes): advance it now.
    if (op.state === "UNKNOWN") op = yield* repo.transition(op.id, op.businessId, "AWAITING_MERGE", "Reconciled: the pull request exists", { providerChecked: true })
    const prNumber = Number(opened.detail["prNumber"])
    const prRead = yield* gh(() => transport.pullRequest(owner, repository, prNumber))
    if (prRead._tag === "Left") {
      if (prRead.left.kind === "AUTH") { yield* stop(op, "FAILED", "PROVIDER_AUTH", "The provider refused the execution credentials"); return DONE }
      if (prRead.left.kind === "NOT_FOUND") { yield* stop(op, "BLOCKED", "PR_WRONG_TARGET", "The pull request can no longer be found"); return DONE }
      return transient(prRead.left)
    }
    const pr = prRead.right
    const openedUrl = String(opened.detail["prUrl"] ?? ""), openedHead = String(opened.detail["headSha"] ?? "")
    if (!sameRepo(pr.baseRepository, owner, repository) || pr.baseRef !== op.baseBranch || pr.headRef !== branch || pr.url !== openedUrl) {
      yield* repo.recordEvidence(op.id, op.businessId, "PR_CONTENT_CHANGED", { reason: "target", baseRepository: pr.baseRepository, baseRef: pr.baseRef }).pipe(Effect.catchAll(() => Effect.void))
      yield* stop(op, "BLOCKED", "PR_WRONG_TARGET", "The pull request no longer targets the authorized repository and branch")
      return DONE
    }
    if (!pr.merged) {
      if (pr.state === "closed") {
        yield* repo.recordEvidence(op.id, op.businessId, "PR_CLOSED_UNMERGED", { prNumber, closedAt: pr.closedAt })
        yield* stop(op, "FAILED", "PR_CLOSED_WITHOUT_MERGE", "The pull request was closed without being merged")
        return DONE
      }
      if (pr.headSha !== openedHead) {
        yield* repo.recordEvidence(op.id, op.businessId, "PR_CONTENT_CHANGED", { reason: "head", expected: openedHead, actual: pr.headSha })
        yield* stop(op, "BLOCKED", "PR_CONTENT_CHANGED", "The pull request was changed after it was opened, so it is no longer the approved change")
        return DONE
      }
      if (op.state === "RECONCILING") yield* repo.transition(op.id, op.businessId, "AWAITING_MERGE", "Not merged after all", {})
      return { retry: pollSeconds, code: "PENDING_MERGE" }
    }
    // The provider says merged. Verify what was merged before claiming anything.
    if (op.state === "AWAITING_MERGE") op = yield* repo.transition(op.id, op.businessId, "RECONCILING", "Merge observed; verifying the merged change", { mergeObserved: true, mergeCommitSha: pr.mergeCommitSha })
    const mismatch = (reason: string) => Effect.gen(function*() {
      yield* repo.recordEvidence(op.id, op.businessId, "PR_CONTENT_CHANGED", { reason, merged: true })
      yield* stop(op, "BLOCKED", "MERGED_CONTENT_DIFFERS", "The merged change is not the change that was authorized")
      return DONE as Outcome
    })
    if (pr.headSha !== openedHead) return yield* mismatch("head")
    if (!pr.mergeCommitSha || !/^[a-f0-9]{40}$/.test(pr.mergeCommitSha) || !pr.mergedAt) return yield* mismatch("merge-commit")
    const files = yield* gh(() => transport.pullRequestFiles(owner, repository, prNumber))
    if (files._tag === "Left") return transient(files.left)
    if (files.right.length !== 1 || files.right[0]!.path !== op.filePath) return yield* mismatch("files")
    const merged = yield* gh(() => transport.file(owner, repository, op.filePath, pr.mergeCommitSha!))
    if (merged._tag === "Left") return transient(merged.left)
    if (merged.right.kind !== "file" || merged.right.blobSha !== work.afterBlobSha || sha256Text(merged.right.content) !== op.afterSha256) return yield* mismatch("content")
    yield* repo.verifyMerge(op.id, op.businessId, {
      prNumber, prUrl: pr.url, headSha: pr.headSha, headRef: pr.headRef, baseRef: pr.baseRef, baseRepository: pr.baseRepository,
      mergeCommitSha: pr.mergeCommitSha, mergedAt: pr.mergedAt, mergedBlobSha: merged.right.blobSha, changedPaths: [op.filePath],
    })
    yield* log("merge verified", { operationId: op.id, prNumber })
    // One automatic look at the live page after a delay; the operator can ask again. It is a separate fact.
    yield* repo.ensureJob(op.id, op.businessId, "LIVE_CHECK", liveDelay)
    return DONE
  })

  // -------------------------------------------------------------- live check
  const liveCheck = (_job: ExecutionJob, work: ExecutionWork): Effect.Effect<Outcome, SqlError | RowDecodeError | GrowthExecutionRefused> => Effect.gen(function*() {
    const op = work.operation
    if (op.state !== "VERIFIED") return DONE
    const record = (result: "CHANGE_OBSERVED" | "CHANGE_NOT_OBSERVED" | "INCONCLUSIVE", detail: string, httpStatus: number | null, bodyDigest: string | null) =>
      repo.recordLiveCheck(op.id, op.businessId, { result, httpStatus, detail, bodyDigest })
    const scope = { canonical_origin: work.siteOrigin, path_prefix: work.sitePathPrefix }
    if (!isInScope(op.liveUrl, scope)) { yield* record("INCONCLUSIVE", "The page is outside the registered website, so it was not fetched", null, null); return DONE }
    const ev = yield* Effect.promise(() => safeFetch(op.liveUrl, {
      ...(opts.transport ? { transport: opts.transport } : {}),
      limits: { timeoutMs: SITE_FETCH_TIMEOUT_MS, maxRedirects: 5, maxBytes: LIVE_MAX_BYTES, acceptedContentTypes: ["text/html", "application/xhtml+xml"] },
      redirectPolicy: { maxRedirects: 5, allowCrossOrigin: false, scopeOrigin: work.siteOrigin },
      userAgent: "OpenRecord-ExecutionCheck/1",
    })).pipe(Effect.catchAll(() => Effect.succeed(null)))
    if (!ev) { yield* record("INCONCLUSIVE", "The page could not be fetched", null, null); return DONE }
    if (ev.failure !== null) { yield* record("INCONCLUSIVE", `The page could not be observed (${ev.failure.toLowerCase().replaceAll("_", " ")})`, ev.status, null); return DONE }
    if (ev.outOfScopeRedirect) { yield* record("INCONCLUSIVE", "The page redirected outside the registered website", ev.status, null); return DONE }
    if (ev.status !== 200 || !ev.body) { yield* record("INCONCLUSIVE", `The page answered with status ${ev.status ?? "none"}`, ev.status, ev.bodyDigest); return DONE }
    const page = inspectPage({ url: op.liveUrl, finalUrl: ev.finalUrl, status: ev.status, contentType: ev.contentType, redirectChain: ev.redirectChain, headers: ev.headers, html: Buffer.from(ev.body).toString("utf8"), failure: null })
    const blocked = page.indexability === "BLOCKED_BY_META" || page.indexability === "BLOCKED_BY_HEADER"
    yield* record(blocked ? "CHANGE_NOT_OBSERVED" : "CHANGE_OBSERVED",
      blocked ? "The live page still carries a noindex directive" : "The live page no longer carries a noindex directive", ev.status, ev.bodyDigest)
    return DONE
  })

  const runOnce = (): Effect.Effect<boolean, SqlError | RowDecodeError> => Effect.gen(function*() {
    const job = yield* repo.claimJob(workerId, leaseSeconds, only).pipe(Effect.catchTag("GrowthExecutionRefused", () => Effect.succeed(null)))
    if (!job) return false
    const outcome = yield* repo.work(job.businessId, job.operationId).pipe(
      Effect.flatMap(work => job.kind === "DISPATCH" ? dispatch(job, work) : job.kind === "RECONCILE" ? reconcile(job, work) : liveCheck(job, work)),
      // A refused move (stale state after a race) means someone else already settled it: finish rather than loop.
      Effect.catchTag("GrowthExecutionRefused", e => Effect.as(log("execution job refused", { reason: e.reason, kind: job.kind }), DONE as Outcome)),
    )
    if ("done" in outcome) yield* repo.finishJob(job.id, workerId).pipe(Effect.catchTag("GrowthExecutionRefused", () => Effect.void))
    else if (job.kind === "RECONCILE" && outcome.code === "PENDING_MERGE") {
      // Waiting for a maintainer is not a retry: it does not count against the attempt budget.
      yield* repo.finishJob(job.id, workerId).pipe(Effect.catchTag("GrowthExecutionRefused", () => Effect.void))
      yield* repo.ensureJob(job.operationId, job.businessId, "RECONCILE", outcome.retry).pipe(Effect.catchTag("GrowthExecutionRefused", () => Effect.void))
    } else yield* repo.retryJob(job.id, workerId, outcome.retry, outcome.code).pipe(Effect.catchTag("GrowthExecutionRefused", () => Effect.void))
    return true
  }).pipe(Effect.timeout(Duration.seconds(300)), Effect.catchTag("TimeoutException", () => Effect.succeed(false)))

  return { runOnce }
}))
export const ExecutionRunnerLive = makeExecutionRunnerLive()
