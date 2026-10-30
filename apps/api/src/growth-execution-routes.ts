// W7 connected execution routes. Operator-only, session- and origin-scoped like
// every growth route; every response is no-store. An agent or an unauthenticated
// request can reach none of them: only a signed-in account member can connect a
// repository, review an exact change, authorize it and dispatch it. Provider
// credentials come from server configuration and never leave the process.
import { HttpRouter } from "@effect/platform"
import { Effect, Option } from "effect"
import {
  GrowthExecutionRefused, GrowthExecutionRepository, executionRequestFingerprint, type Session,
} from "@openrecord/db"
import {
  AuthorizeExecution, CancelExecution, ConnectExecutionTarget, DispatchExecution, EXECUTION_MAX_FILE_BYTES, PrepareExecution, RequestExecutionCheck,
  decodeRouteId, diffLines, executionPathAllowed, executionRepositoryDenied, unifiedDiff,
} from "@openrecord/contracts"
import {
  GitHubError, GitHubExecution, executionPatchSha256, gitBlobSha, githubEffect, removeNoindexFromHtml, sha256Text,
} from "@openrecord/site-operator"
import { decode, json, operatorSessionFor, readJson, type WithSession } from "./record-routes.js"

const PRIVATE_HEADERS = { "cache-control": "no-store" }
const failure = (e: unknown) => {
  if (e instanceof GrowthExecutionRefused) {
    const r = e.reason
    const status = r === "InvalidRequest" ? 422 : r.endsWith("NotFound") ? 404 : r === "ProviderUnavailable" || r === "ProviderRateLimited" ? 503 : 409
    return json(status, { _tag: "GrowthExecutionRefused", reason: r }, PRIVATE_HEADERS)
  }
  if (typeof e === "object" && e !== null && "_tag" in e && e._tag === "NotAuthenticated") return json(401, { _tag: "NotAuthenticated" }, PRIVATE_HEADERS)
  const detail = process.env["NODE_ENV"] === "test" && e instanceof Error ? String((e as unknown as { cause?: { message?: string } }).cause?.message ?? e.message) : undefined
  return json(500, { _tag: "GrowthRequestFailed", ...(detail ? { detail } : {}) }, PRIVATE_HEADERS)
}
/** Execution is refused, never simulated, when no provider layer is configured. */
const gitHubConfig = Effect.map(Effect.serviceOption(GitHubExecution), o => Option.getOrElse(o, () => ({ transport: null, allowed: () => false })))
const refuse = (reason: string) => Effect.fail(new GrowthExecutionRefused({ reason }))
/** A provider failure becomes a stable reason; no provider text, token or URL reaches the client. */
const providerRefusal = (e: unknown) => {
  if (!(e instanceof GitHubError)) return new GrowthExecutionRefused({ reason: "ProviderUnavailable" })
  switch (e.kind) {
    case "AUTH": return new GrowthExecutionRefused({ reason: "ProviderAuth" })
    case "NOT_FOUND": return new GrowthExecutionRefused({ reason: "RepositoryNotFound" })
    case "RATE_LIMITED": return new GrowthExecutionRefused({ reason: "ProviderRateLimited" })
    case "CONFLICT": case "INVALID": return new GrowthExecutionRefused({ reason: "ProviderRejected" })
    default: return new GrowthExecutionRefused({ reason: "ProviderUnavailable" })
  }
}
const robotsNoindex = /<meta\s+[^>]*name=["']robots["'][^>]*noindex/i

/** Whether this account may use this repository: server allowlist and the OpenRecord-repository denial. */
export const executionRepositoryPermitted = (allowed: (o: string, r: string, a: string) => boolean, owner: string, repository: string, accountId: string) =>
  !executionRepositoryDenied(owner, repository) && allowed(owner, repository, accountId)

export const prepareConnectedExecution = (session: Session, businessId: string, opportunityId: string, input: PrepareExecution, actor: "OPERATOR" | "ASSISTANT" = "OPERATOR") => Effect.gen(function*() {
    const repo = yield* GrowthExecutionRepository
    const gh = yield* gitHubConfig
    const fingerprint = executionRequestFingerprint({ opportunityId, targetId: input.targetId, actionKind: input.actionKind, filePath: input.filePath, liveUrl: input.liveUrl, rationale: input.rationale, siteFindingId: input.siteFindingId })
    const replay = yield* repo.findPrepared(session, businessId, opportunityId, fingerprint, input.idempotencyKey)
    if (replay) return replay
    const target = (yield* repo.targets(session.accountId, businessId)).find(t => t.id === input.targetId)
    if (!target) return yield* refuse("ExecutionTargetNotFound")
    if (!executionRepositoryPermitted(gh.allowed, target.owner, target.repository, session.accountId)) return yield* refuse("RepositoryNotPermitted")
    if (!executionPathAllowed(input.filePath, target.allowedPaths)) return yield* refuse("PathNotPermitted")
    const transport = gh.transport
    if (!transport) return yield* refuse("ExecutionNotConfigured")
    const mapped = <A>(f: () => Promise<A>) => githubEffect(f).pipe(Effect.mapError(providerRefusal))
    const info = yield* mapped(() => transport.repository(target.owner, target.repository))
    if (!info || info.fullName.toLowerCase() !== `${target.owner}/${target.repository}`.toLowerCase()) return yield* refuse("RepositoryNotFound")
    const baseCommitSha = yield* mapped(() => transport.branchHead(target.owner, target.repository, target.baseBranch))
    if (!baseCommitSha) return yield* refuse("BaseBranchNotFound")
    const file = yield* mapped(() => transport.file(target.owner, target.repository, input.filePath, baseCommitSha))
    if (file.kind !== "file") return yield* refuse(file.kind === "missing" ? "PageNotFound" : "PageNotSupported")
    if (Buffer.byteLength(file.content, "utf8") > EXECUTION_MAX_FILE_BYTES) return yield* refuse("PageNotSupported")
    // The only supported change: the existing deterministic transform. Anything it cannot do safely is refused, never guessed.
    const after = removeNoindexFromHtml(file.content)
    if (after === null || after === file.content || robotsNoindex.test(after)) return yield* refuse("NotApplicable")
    const beforeSha256 = sha256Text(file.content), afterSha256 = sha256Text(after)
    const patchSha256 = executionPatchSha256({ actionKind: input.actionKind, owner: target.owner, repository: target.repository, baseBranch: target.baseBranch, baseCommitSha, filePath: input.filePath, liveUrl: input.liveUrl, beforeSha256, afterSha256 })
    const diff = unifiedDiff(input.filePath, diffLines(file.content, after))
    const plan = { targetId: target.id, actionKind: input.actionKind, filePath: input.filePath, liveUrl: input.liveUrl, siteFindingId: input.siteFindingId, baseBranch: target.baseBranch, baseCommitSha,
      baseBlobSha: file.blobSha, afterBlobSha: gitBlobSha(after), beforeSha256, afterSha256, patchSha256, afterContent: after, diff, rationale: input.rationale.trim(), idempotencyKey: input.idempotencyKey } as const
    return yield* repo.prepare(session, businessId, opportunityId, fingerprint, plan, actor).pipe(
      // Two identical requests racing: the loser returns the winner's operation.
      // (The page guard can refuse the loser first, so that reason is a replay candidate too.)
      Effect.catchIf((e): e is GrowthExecutionRefused => e instanceof GrowthExecutionRefused && (e.reason === "IdempotencyConflict" || e.reason === "ExecutionAlreadyOpen"),
        e => repo.findPrepared(session, businessId, opportunityId, fingerprint, input.idempotencyKey).pipe(Effect.flatMap(found => found ? Effect.succeed(found) : Effect.fail(e)))))
  })

export const growthExecutionApi = (withSession: WithSession) => {
  const operator = operatorSessionFor(withSession)
  const scoped = <E, R>(param: string | null, run: (session: Session, businessId: string, id: string) => Effect.Effect<import("@effect/platform/HttpServerResponse").HttpServerResponse, E, R>) =>
    operator(session => Effect.gen(function*() {
      const { params } = yield* HttpRouter.RouteContext
      const businessId = params["id"] ?? "", id = param === null ? "" : params[param] ?? ""
      if (decodeRouteId(businessId)._tag === "Left" || (param !== null && decodeRouteId(id)._tag === "Left")) return yield* json(422, { _tag: "InvalidRequest" }, PRIVATE_HEADERS)
      return yield* run(session, businessId, id)
    })).pipe(Effect.catchAll(failure))
  const base = "/api/growth/clients/:id"

  return HttpRouter.empty.pipe(
    HttpRouter.get(`${base}/execution-targets`, scoped(null, (session, businessId) => Effect.gen(function*() {
      return yield* json(200, { targets: yield* (yield* GrowthExecutionRepository).targets(session.accountId, businessId) }, PRIVATE_HEADERS)
    }))),
    HttpRouter.post(`${base}/execution-targets`, scoped(null, (session, businessId) => Effect.gen(function*() {
      const input = decode(ConnectExecutionTarget, yield* readJson)
      if (!input) return yield* json(422, { _tag: "InvalidRequest" }, PRIVATE_HEADERS)
      const gh = yield* gitHubConfig
      // Scope first: another account's business is "not found" before anything about the destination is discussed.
      yield* (yield* GrowthExecutionRepository).targets(session.accountId, businessId)
      // A repository must be on the server allowlist for this account before it can even be connected.
      if (!executionRepositoryPermitted(gh.allowed, input.owner, input.repository, session.accountId)) return yield* refuse("RepositoryNotPermitted")
      return yield* json(200, { target: yield* (yield* GrowthExecutionRepository).connectTarget(session, businessId, input) }, PRIVATE_HEADERS)
    }))),
    HttpRouter.get(`${base}/opportunities/:opportunityId/connected-executions`, scoped("opportunityId", (session, businessId, opportunityId) => Effect.gen(function*() {
      return yield* json(200, { operations: yield* (yield* GrowthExecutionRepository).list(session.accountId, businessId, opportunityId) }, PRIVATE_HEADERS)
    }))),
    HttpRouter.post(`${base}/opportunities/:opportunityId/connected-executions`, scoped("opportunityId", (session, businessId, opportunityId) => Effect.gen(function*() {
      const input = decode(PrepareExecution, yield* readJson)
      if (!input) return yield* json(422, { _tag: "InvalidRequest" }, PRIVATE_HEADERS)
      return yield* json(200, { operation: yield* prepareConnectedExecution(session, businessId, opportunityId, input) }, PRIVATE_HEADERS)
    }))),
    HttpRouter.get(`${base}/connected-executions/:operationId`, scoped("operationId", (session, businessId, operationId) => Effect.gen(function*() {
      return yield* json(200, { operation: yield* (yield* GrowthExecutionRepository).get(session.accountId, businessId, operationId) }, PRIVATE_HEADERS)
    }))),
    HttpRouter.post(`${base}/connected-executions/:operationId/authorize`, scoped("operationId", (session, businessId, operationId) => Effect.gen(function*() {
      const input = decode(AuthorizeExecution, yield* readJson)
      if (!input) return yield* json(422, { _tag: "InvalidRequest" }, PRIVATE_HEADERS)
      return yield* json(200, { operation: yield* (yield* GrowthExecutionRepository).authorize(session, businessId, operationId, input) }, PRIVATE_HEADERS)
    }))),
    HttpRouter.post(`${base}/connected-executions/:operationId/dispatch`, scoped("operationId", (session, businessId, operationId) => Effect.gen(function*() {
      const input = decode(DispatchExecution, yield* readJson)
      if (!input) return yield* json(422, { _tag: "InvalidRequest" }, PRIVATE_HEADERS)
      const repo = yield* GrowthExecutionRepository
      // Re-check the destination now: the allowlist may have changed since preparation.
      const current = yield* repo.get(session.accountId, businessId, operationId)
      const gh = yield* gitHubConfig
      if (!executionRepositoryPermitted(gh.allowed, current.owner, current.repository, session.accountId)) return yield* refuse("RepositoryNotPermitted")
      if (!gh.transport) return yield* refuse("ExecutionNotConfigured")
      return yield* json(200, { operation: yield* repo.dispatch(session, businessId, operationId, input) }, PRIVATE_HEADERS)
    }))),
    HttpRouter.post(`${base}/connected-executions/:operationId/cancel`, scoped("operationId", (session, businessId, operationId) => Effect.gen(function*() {
      const input = decode(CancelExecution, yield* readJson)
      if (!input) return yield* json(422, { _tag: "InvalidRequest" }, PRIVATE_HEADERS)
      return yield* json(200, { operation: yield* (yield* GrowthExecutionRepository).cancel(session, businessId, operationId, input) }, PRIVATE_HEADERS)
    }))),
    HttpRouter.post(`${base}/connected-executions/:operationId/check`, scoped("operationId", (session, businessId, operationId) => Effect.gen(function*() {
      const input = decode(RequestExecutionCheck, yield* readJson)
      if (!input) return yield* json(422, { _tag: "InvalidRequest" }, PRIVATE_HEADERS)
      return yield* json(200, { operation: yield* (yield* GrowthExecutionRepository).requestReconcile(session, businessId, operationId, input) }, PRIVATE_HEADERS)
    }))),
    HttpRouter.post(`${base}/connected-executions/:operationId/live-check`, scoped("operationId", (session, businessId, operationId) => Effect.gen(function*() {
      const input = decode(RequestExecutionCheck, yield* readJson)
      if (!input) return yield* json(422, { _tag: "InvalidRequest" }, PRIVATE_HEADERS)
      return yield* json(200, { operation: yield* (yield* GrowthExecutionRepository).requestLiveCheck(session, businessId, operationId, input) }, PRIVATE_HEADERS)
    }))),
  )
}
