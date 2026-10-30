// W7 connected execution repository. Operator calls (connect a repository,
// prepare, authorize, dispatch, cancel, request a check) carry a session and
// are scoped to the account's business. Worker calls (claim, record provider
// evidence, move an operation, verify a merge, record a live observation) are
// the "execution system" side: they carry no session, take only ids, and every
// write still passes the database guards in 0034, so an unauthorized, stale
// or self-contradicting claim fails closed.
//
// The three facts stay separate: provider request accepted (events/evidence),
// provider action verified (PR_MERGE_CONFIRMED + one SYSTEM_VERIFIED receipt
// linked to the initiative) and live change observed (live checks).
import { createHash } from "node:crypto"
import { Context, Data, Effect, Layer, Schema } from "effect"
import { PgClient } from "@effect/sql-pg"
import type { SqlError } from "@effect/sql/SqlError"
import {
  AuthorizeExecution, CancelExecution, ConnectExecutionTarget, DispatchExecution, EXECUTION_AUTHORIZATION_HOURS, EXECUTION_TERMINAL, ExecutionActionKind,
  ExecutionEvidenceKind, ExecutionLiveResult, ExecutionState, RequestExecutionCheck, canTransitionExecution, decodeRouteId,
  type ExecutionOperation, type ExecutionTarget,
} from "@openrecord/contracts"
import { decodeRow, type RowDecodeError } from "./row-codecs.js"
import type { Session } from "./auth.js"

export class GrowthExecutionRefused extends Data.TaggedError("GrowthExecutionRefused")<{ readonly reason: string }> {}
export type GrowthExecutionEffect<A> = Effect.Effect<A, SqlError | RowDecodeError | GrowthExecutionRefused>

const guardReasons: ReadonlyArray<{ readonly needle: string; readonly reason: string }> = [
  { needle: "execution requires an approved initiative", reason: "InitiativeNotApproved" },
  { needle: "authorization requires an approved initiative", reason: "InitiativeNotApproved" },
  { needle: "dispatch requires an approved initiative", reason: "InitiativeNotApproved" },
  { needle: "authorization expired", reason: "AuthorizationExpired" },
  { needle: "authorization must bind the prepared patch", reason: "PatchMismatch" },
  { needle: "another unsettled execution already covers this page", reason: "ExecutionAlreadyOpen" },
  { needle: "execution page is not allowed", reason: "PathNotPermitted" },
  { needle: "live page outside the registered website", reason: "LivePageOutsideSite" },
  { needle: "finding does not describe this page", reason: "FindingMismatch" },
  { needle: "repository is connected to another account", reason: "RepositoryNotPermitted" },
  { needle: "own repository is never an execution target", reason: "RepositoryNotPermitted" },
  { needle: "stale execution revision", reason: "StaleExecution" },
  { needle: "execution transition refused", reason: "TransitionRefused" },
  { needle: "execution unresolved", reason: "ExecutionUnresolved" },
]
const guard = <A, R>(effect: Effect.Effect<A, SqlError, R>): Effect.Effect<A, SqlError | GrowthExecutionRefused, R> => effect.pipe(
  Effect.mapError(e => {
    const message = String((e as unknown as { cause?: { message?: string } }).cause?.message ?? "")
    for (const { needle, reason } of guardReasons) if (message.includes(needle)) return new GrowthExecutionRefused({ reason })
    return e
  }))

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex")
const Json = Schema.Record({ key: Schema.String, value: Schema.Unknown })
const TargetDoc = Schema.Struct({ id: Schema.UUID, businessId: Schema.UUID, provider: Schema.Literal("GITHUB"), owner: Schema.String, repository: Schema.String,
  baseBranch: Schema.String, siteTargetId: Schema.UUID, allowedPaths: Schema.Array(Schema.String), createdByUserId: Schema.UUID, createdAt: Schema.String })
const OperationDoc = Schema.Struct({
  id: Schema.UUID, businessId: Schema.UUID, opportunityId: Schema.UUID, targetId: Schema.UUID, owner: Schema.String, repository: Schema.String, baseBranch: Schema.String,
  actionKind: ExecutionActionKind, filePath: Schema.String, liveUrl: Schema.String, siteFindingId: Schema.NullOr(Schema.UUID),
  baseCommitSha: Schema.String, baseBlobSha: Schema.String, beforeSha256: Schema.String, afterSha256: Schema.String, patchSha256: Schema.String,
  diff: Schema.String, rationale: Schema.String, proposedBy: Schema.Literal("OPERATOR", "ASSISTANT"), createdByUserId: Schema.UUID, createdAt: Schema.String,
  state: ExecutionState, revision: Schema.Int,
  events: Schema.Array(Schema.Struct({ id: Schema.UUID, state: ExecutionState, revision: Schema.Int, actor: Schema.Literal("OPERATOR", "ASSISTANT", "EXECUTION_SYSTEM"),
    userId: Schema.NullOr(Schema.UUID), reason: Schema.String, detail: Json, createdAt: Schema.String })),
  evidence: Schema.Array(Schema.Struct({ id: Schema.UUID, kind: ExecutionEvidenceKind, detail: Json, observedAt: Schema.String })),
  liveChecks: Schema.Array(Schema.Struct({ id: Schema.UUID, result: ExecutionLiveResult, url: Schema.String, httpStatus: Schema.NullOr(Schema.Int),
    detail: Schema.String, bodyDigest: Schema.NullOr(Schema.String), checkedAt: Schema.String })),
  receipt: Schema.NullOr(Schema.Struct({ interventionId: Schema.UUID, claim: Schema.Literal("PR_MERGED"), mergedAt: Schema.String, mergeCommitSha: Schema.String, pullRequestUrl: Schema.String })),
})

/** Everything computed from the provider before an operation is stored. The API builds it; the guards verify it. */
export interface PreparedExecution {
  readonly targetId: string; readonly actionKind: "REMOVE_NOINDEX_META"; readonly filePath: string; readonly liveUrl: string; readonly siteFindingId: string | null
  readonly baseBranch: string; readonly baseCommitSha: string; readonly baseBlobSha: string; readonly afterBlobSha: string
  readonly beforeSha256: string; readonly afterSha256: string; readonly patchSha256: string; readonly afterContent: string; readonly diff: string
  readonly rationale: string; readonly idempotencyKey: string
}
export type JobKind = "DISPATCH" | "RECONCILE" | "LIVE_CHECK"
export interface ExecutionJob { readonly id: string; readonly operationId: string; readonly businessId: string; readonly kind: JobKind; readonly attemptCount: number }
/** What a worker needs to act: the stored change, its bytes, the repository and the owning account. */
export interface ExecutionWork {
  readonly operation: ExecutionOperation; readonly accountId: string; readonly afterContent: string; readonly afterBlobSha: string
  readonly authorizedPatchSha256: string | null; readonly authorizationExpiresAt: string | null; readonly authorizedByUserId: string | null
  readonly siteOrigin: string; readonly sitePathPrefix: string; readonly initiativeStatus: string; readonly allowedPaths: ReadonlyArray<string>
}

export class GrowthExecutionRepository extends Context.Tag("GrowthExecutionRepository")<GrowthExecutionRepository, {
  readonly targets: (accountId: string, businessId: string) => GrowthExecutionEffect<ReadonlyArray<ExecutionTarget>>
  readonly connectTarget: (session: Session, businessId: string, input: ConnectExecutionTarget) => GrowthExecutionEffect<ExecutionTarget>
  readonly list: (accountId: string, businessId: string, opportunityId: string) => GrowthExecutionEffect<ReadonlyArray<ExecutionOperation>>
  readonly get: (accountId: string, businessId: string, operationId: string) => GrowthExecutionEffect<ExecutionOperation>
  /** Replays by request key when the request is identical; a different request under the key is refused. */
  readonly findPrepared: (session: Session, businessId: string, opportunityId: string, fingerprint: string, idempotencyKey: string) => GrowthExecutionEffect<ExecutionOperation | null>
  readonly prepare: (session: Session, businessId: string, opportunityId: string, fingerprint: string, plan: PreparedExecution, actor?: "OPERATOR" | "ASSISTANT") => GrowthExecutionEffect<ExecutionOperation>
  readonly authorize: (session: Session, businessId: string, operationId: string, input: AuthorizeExecution) => GrowthExecutionEffect<ExecutionOperation>
  readonly dispatch: (session: Session, businessId: string, operationId: string, input: DispatchExecution) => GrowthExecutionEffect<ExecutionOperation>
  readonly cancel: (session: Session, businessId: string, operationId: string, input: CancelExecution) => GrowthExecutionEffect<ExecutionOperation>
  readonly requestReconcile: (session: Session, businessId: string, operationId: string, input: RequestExecutionCheck) => GrowthExecutionEffect<ExecutionOperation>
  readonly requestLiveCheck: (session: Session, businessId: string, operationId: string, input: RequestExecutionCheck) => GrowthExecutionEffect<ExecutionOperation>
  // ---- execution system (worker) ----
  /** `only` limits the claim to those operations (tests sharing a database); production claims any due job. */
  readonly claimJob: (workerId: string, leaseSeconds: number, only?: ReadonlyArray<string>) => GrowthExecutionEffect<ExecutionJob | null>
  readonly finishJob: (jobId: string, workerId: string) => GrowthExecutionEffect<void>
  readonly retryJob: (jobId: string, workerId: string, delaySeconds: number, errorCode: string) => GrowthExecutionEffect<void>
  readonly ensureJob: (operationId: string, businessId: string, kind: JobKind, delaySeconds: number) => GrowthExecutionEffect<void>
  /** Queues the missing job for any in-flight operation that has none (a worker died between a state change and the next enqueue). Returns how many were queued. */
  readonly repairJobs: () => GrowthExecutionEffect<number>
  readonly work: (businessId: string, operationId: string) => GrowthExecutionEffect<ExecutionWork>
  readonly recordEvidence: (operationId: string, businessId: string, kind: ExecutionEvidenceKind, detail: Record<string, unknown>) => GrowthExecutionEffect<void>
  readonly transition: (operationId: string, businessId: string, to: ExecutionState, reason: string, detail: Record<string, unknown>) => GrowthExecutionEffect<ExecutionOperation>
  /** One transaction: merge evidence, the SYSTEM_VERIFIED receipt, the initiative link and the VERIFIED event. */
  readonly verifyMerge: (operationId: string, businessId: string, evidence: Record<string, unknown>) => GrowthExecutionEffect<ExecutionOperation>
  readonly recordLiveCheck: (operationId: string, businessId: string, check: { result: "CHANGE_OBSERVED" | "CHANGE_NOT_OBSERVED" | "INCONCLUSIVE"; httpStatus: number | null; detail: string; bodyDigest: string | null }) => GrowthExecutionEffect<void>
}>() {}

export const GrowthExecutionRepositoryLive = Layer.effect(GrowthExecutionRepository, Effect.map(PgClient.PgClient, sql => {
  const refuse = (reason: string) => Effect.fail(new GrowthExecutionRefused({ reason }))
  const parse = <A, I>(schema: Schema.Schema<A, I>, input: unknown) => Schema.decodeUnknown(schema, { onExcessProperty: "error" })(input).pipe(
    Effect.mapError(() => new GrowthExecutionRefused({ reason: "InvalidRequest" })))
  const ids = (...values: ReadonlyArray<string>) => values.some(v => decodeRouteId(v)._tag === "Left") ? refuse("InvalidRequest") : Effect.void
  const scope = (accountId: string, businessId: string) => Effect.gen(function*() {
    const rows = yield* sql`SELECT b.id FROM businesses b JOIN record_profiles r ON r.business_id=b.id WHERE b.id=${businessId} AND b.account_id=${accountId}`
    if (!rows.length) return yield* refuse("GrowthNotFound")
  })
  const member = (session: Session, businessId: string) => Effect.gen(function*() {
    yield* scope(session.accountId, businessId)
    const rows = yield* sql`SELECT 1 FROM account_users WHERE account_id=${session.accountId} AND user_id=${session.userId}`
    if (!rows.length) return yield* refuse("GrowthNotFound")
  })
  const read = (businessId: string, operationId: string): GrowthExecutionEffect<ExecutionOperation> => Effect.gen(function*() {
    const rows = yield* sql`SELECT document FROM growth_execution_documents WHERE id=${operationId} AND business_id=${businessId}`
    if (!rows[0]) return yield* refuse("ExecutionNotFound")
    return (yield* decodeRow(OperationDoc, "growth_execution_documents", rows[0]["document"])) as ExecutionOperation
  })
  /** The operation row lock serializes every operator and worker move on one operation. */
  const lock = (businessId: string, operationId: string) => Effect.gen(function*() {
    const rows = yield* sql`SELECT id,opportunity_id FROM growth_execution_operations WHERE id=${operationId} AND business_id=${businessId} FOR UPDATE`
    if (!rows.length) return yield* refuse("ExecutionNotFound")
    return String(rows[0]!["opportunity_id"])
  })
  const append = (operationId: string, businessId: string, revision: number, state: ExecutionState, actor: "OPERATOR" | "ASSISTANT" | "EXECUTION_SYSTEM",
    userId: string | null, reason: string, detail: Record<string, unknown>, requestKey: string | null) => guard(sql`
      INSERT INTO growth_execution_events(operation_id,business_id,revision,state,actor,user_id,reason,detail,request_key)
      VALUES(${operationId},${businessId},${revision},${state},${actor},${userId},${reason},${JSON.stringify(detail)}::jsonb,${requestKey})`)
  /** A repeated request key replays the original event; a different request under it is refused. */
  const replayed = (operationId: string, key: string, expect: { state: ExecutionState; reason?: string; revision: number }) => Effect.gen(function*() {
    const rows = yield* sql`SELECT state,reason,revision FROM growth_execution_events WHERE operation_id=${operationId} AND request_key=${key}`
    if (!rows[0]) return false
    if (rows[0]["state"] !== expect.state || (expect.reason !== undefined && rows[0]["reason"] !== expect.reason) || Number(rows[0]["revision"]) !== expect.revision + 1) return yield* refuse("IdempotencyConflict")
    return true
  })
  const operatorMove = (session: Session, businessId: string, operationId: string, to: ExecutionState, key: string, expectedRevision: number, reason: string,
    from: ReadonlyArray<ExecutionState>, detail: (current: ExecutionOperation) => Record<string, unknown>, after?: (current: ExecutionOperation) => GrowthExecutionEffect<void>) =>
    sql.withTransaction(Effect.gen(function*() {
      yield* ids(businessId, operationId)
      yield* member(session, businessId)
      yield* lock(businessId, operationId)
      if (yield* replayed(operationId, key, { state: to, reason, revision: expectedRevision })) return yield* read(businessId, operationId)
      const current = yield* read(businessId, operationId)
      if (current.revision !== expectedRevision) return yield* refuse("StaleExecution")
      if (!from.includes(current.state) || !canTransitionExecution(current.state, to, "OPERATOR")) return yield* refuse("TransitionRefused")
      yield* append(operationId, businessId, current.revision + 1, to, "OPERATOR", session.userId, reason, detail(current), key)
      if (after) yield* after(current)
      return yield* read(businessId, operationId)
    }))
  const enqueue = (operationId: string, businessId: string, kind: JobKind, delaySeconds: number, requestKey: string | null, userId: string | null) => guard(sql`
    INSERT INTO growth_execution_jobs(operation_id,business_id,kind,not_before,request_key,requested_by_user_id)
    VALUES(${operationId},${businessId},${kind},now()+${delaySeconds}*interval '1 second',${requestKey},${userId})
    ON CONFLICT DO NOTHING`)

  return {
    targets: (accountId, businessId) => Effect.gen(function*() {
      yield* ids(businessId)
      yield* scope(accountId, businessId)
      const rows = yield* sql`SELECT document FROM growth_execution_target_documents WHERE business_id=${businessId} ORDER BY created_at DESC LIMIT 50`
      return (yield* Effect.forEach(rows, r => decodeRow(TargetDoc, "growth_execution_targets", r["document"]))) as ExecutionTarget[]
    }),
    connectTarget: (session, businessId, raw) => sql.withTransaction(Effect.gen(function*() {
      yield* ids(businessId)
      yield* member(session, businessId)
      const input = yield* parse(ConnectExecutionTarget, raw)
      const content = { owner: input.owner, repository: input.repository, baseBranch: input.baseBranch, siteTargetId: input.siteTargetId, allowedPaths: [...input.allowedPaths] }
      const seen = yield* sql`SELECT t.id,d.document FROM growth_execution_targets t JOIN growth_execution_target_documents d ON d.id=t.id WHERE t.business_id=${businessId} AND t.request_key=${input.idempotencyKey}`
      if (seen[0]) {
        const doc = (yield* decodeRow(TargetDoc, "growth_execution_targets", seen[0]["document"])) as ExecutionTarget
        const same = doc.owner === content.owner && doc.repository === content.repository && doc.baseBranch === content.baseBranch && doc.siteTargetId === content.siteTargetId
          && JSON.stringify(doc.allowedPaths) === JSON.stringify(content.allowedPaths) && doc.createdByUserId === session.userId
        return same ? doc : yield* refuse("IdempotencyConflict")
      }
      const rows = yield* guard(sql`INSERT INTO growth_execution_targets(business_id,provider,owner,repository,base_branch,site_target_id,allowed_paths,created_by_user_id,request_key)
        VALUES(${businessId},'GITHUB',${content.owner},${content.repository},${content.baseBranch},${content.siteTargetId},${content.allowedPaths},${session.userId},${input.idempotencyKey}) RETURNING id`).pipe(
        Effect.catchIf((e): e is SqlError => (e as { cause?: { code?: string } }).cause?.code === "23505", () => refuse("TargetAlreadyConnected")))
      const doc = yield* sql`SELECT document FROM growth_execution_target_documents WHERE id=${rows[0]!["id"] as string}`
      return (yield* decodeRow(TargetDoc, "growth_execution_targets", doc[0]!["document"])) as ExecutionTarget
    })),
    list: (accountId, businessId, opportunityId) => Effect.gen(function*() {
      yield* ids(businessId, opportunityId)
      yield* scope(accountId, businessId)
      const rows = yield* sql`SELECT document FROM growth_execution_documents WHERE business_id=${businessId} AND opportunity_id=${opportunityId} ORDER BY created_at DESC LIMIT 20`
      return (yield* Effect.forEach(rows, r => decodeRow(OperationDoc, "growth_execution_documents", r["document"]))) as ExecutionOperation[]
    }),
    get: (accountId, businessId, operationId) => Effect.gen(function*() {
      yield* ids(businessId, operationId)
      yield* scope(accountId, businessId)
      return yield* read(businessId, operationId)
    }),
    findPrepared: (session, businessId, opportunityId, fingerprint, key) => Effect.gen(function*() {
      yield* ids(businessId, opportunityId)
      yield* member(session, businessId)
      const rows = yield* sql`SELECT id,opportunity_id,request_fingerprint,created_by_user_id FROM growth_execution_operations WHERE business_id=${businessId} AND request_key=${key}`
      if (!rows[0]) return null
      if (rows[0]["request_fingerprint"] !== fingerprint || rows[0]["opportunity_id"] !== opportunityId || rows[0]["created_by_user_id"] !== session.userId) return yield* refuse("IdempotencyConflict")
      return yield* read(businessId, String(rows[0]["id"]))
    }),
    prepare: (session, businessId, opportunityId, fingerprint, plan, actor = "OPERATOR") => sql.withTransaction(Effect.gen(function*() {
      yield* ids(businessId, opportunityId, plan.targetId)
      yield* member(session, businessId)
      const locked = yield* sql`SELECT id FROM growth_opportunities WHERE id=${opportunityId} AND business_id=${businessId} FOR UPDATE`
      if (!locked.length) return yield* refuse("OpportunityNotFound")
      const inserted = yield* guard(sql`INSERT INTO growth_execution_operations(business_id,opportunity_id,target_id,action_kind,file_path,live_url,site_finding_id,base_branch,
          base_commit_sha,base_blob_sha,after_blob_sha,before_sha256,after_sha256,patch_sha256,after_content,diff,rationale,proposed_by,created_by_user_id,request_key,request_fingerprint)
        VALUES(${businessId},${opportunityId},${plan.targetId},${plan.actionKind},${plan.filePath},${plan.liveUrl},${plan.siteFindingId},${plan.baseBranch},${plan.baseCommitSha},${plan.baseBlobSha},
          ${plan.afterBlobSha},${plan.beforeSha256},${plan.afterSha256},${plan.patchSha256},${plan.afterContent},${plan.diff},${plan.rationale},${actor},${session.userId},${plan.idempotencyKey},${fingerprint})
        RETURNING id`).pipe(Effect.catchIf((e): e is SqlError => (e as { cause?: { code?: string } }).cause?.code === "23505", () => refuse("IdempotencyConflict")))
      const id = String(inserted[0]!["id"])
      yield* append(id, businessId, 1, "PREPARED", actor, session.userId, "Exact change prepared for review", {}, null)
      return yield* read(businessId, id)
    })),
    authorize: (session, businessId, operationId, raw) => Effect.gen(function*() {
      const input = yield* parse(AuthorizeExecution, raw)
      const expires = new Date(Date.now() + EXECUTION_AUTHORIZATION_HOURS * 3_600_000).toISOString()
      return yield* operatorMove(session, businessId, operationId, "AUTHORIZED", input.idempotencyKey, input.expectedRevision, input.reason, ["PREPARED"],
        () => ({ approvedPatchSha256: input.reviewedPatchSha256, expiresAt: expires, authorizedByUserId: session.userId }))
    }),
    dispatch: (session, businessId, operationId, raw) => Effect.gen(function*() {
      const input = yield* parse(DispatchExecution, raw)
      return yield* operatorMove(session, businessId, operationId, "DISPATCHING", input.idempotencyKey, input.expectedRevision, "Dispatch requested by an operator", ["AUTHORIZED"],
        () => ({}), () => enqueue(operationId, businessId, "DISPATCH", 0, input.idempotencyKey, session.userId))
    }),
    cancel: (session, businessId, operationId, raw) => Effect.gen(function*() {
      const input = yield* parse(CancelExecution, raw)
      return yield* operatorMove(session, businessId, operationId, "CANCELLED", input.idempotencyKey, input.expectedRevision, input.reason, ["PREPARED", "AUTHORIZED"], () => ({}))
    }),
    requestReconcile: (session, businessId, operationId, raw) => sql.withTransaction(Effect.gen(function*() {
      const input = yield* parse(RequestExecutionCheck, raw)
      yield* ids(businessId, operationId)
      yield* member(session, businessId)
      yield* lock(businessId, operationId)
      const current = yield* read(businessId, operationId)
      if (!["AWAITING_MERGE", "RECONCILING", "UNKNOWN"].includes(current.state)) return yield* refuse("TransitionRefused")
      // An open job is made due now instead of adding a second one.
      const woke = yield* sql`UPDATE growth_execution_jobs SET not_before=LEAST(not_before,now()) WHERE operation_id=${operationId} AND kind='RECONCILE' AND status='QUEUED' RETURNING id`
      if (!woke.length) yield* enqueue(operationId, businessId, "RECONCILE", 0, input.idempotencyKey, session.userId)
      return current
    })),
    requestLiveCheck: (session, businessId, operationId, raw) => sql.withTransaction(Effect.gen(function*() {
      const input = yield* parse(RequestExecutionCheck, raw)
      yield* ids(businessId, operationId)
      yield* member(session, businessId)
      yield* lock(businessId, operationId)
      const current = yield* read(businessId, operationId)
      if (current.state !== "VERIFIED") return yield* refuse("TransitionRefused")
      // A delayed automatic check is made due now instead of being shadowed by the open job.
      const woke = yield* sql`UPDATE growth_execution_jobs SET not_before=LEAST(not_before,now()) WHERE operation_id=${operationId} AND kind='LIVE_CHECK' AND status='QUEUED' RETURNING id`
      if (!woke.length) yield* enqueue(operationId, businessId, "LIVE_CHECK", 0, input.idempotencyKey, session.userId)
      return current
    })),

    claimJob: (workerId, leaseSeconds, only) => sql.withTransaction(Effect.gen(function*() {
      // SKIP LOCKED: two workers never claim the same job; an expired lease is reclaimed.
      const rows = only === undefined
        ? yield* sql`SELECT id,operation_id,business_id,kind FROM growth_execution_jobs
          WHERE (status='QUEUED' AND not_before<=now()) OR (status='CLAIMED' AND lease_expires_at<now())
          ORDER BY not_before,created_at LIMIT 1 FOR UPDATE SKIP LOCKED`
        : yield* sql`SELECT id,operation_id,business_id,kind FROM growth_execution_jobs
          WHERE ((status='QUEUED' AND not_before<=now()) OR (status='CLAIMED' AND lease_expires_at<now())) AND operation_id = ANY(${only}::uuid[])
          ORDER BY not_before,created_at LIMIT 1 FOR UPDATE SKIP LOCKED`
      if (!rows[0]) return null
      const claimed = yield* sql`UPDATE growth_execution_jobs SET status='CLAIMED',claimed_by=${workerId},lease_expires_at=now()+${leaseSeconds}*interval '1 second',attempt_count=attempt_count+1
        WHERE id=${rows[0]["id"] as string} RETURNING attempt_count`
      return { id: String(rows[0]["id"]), operationId: String(rows[0]["operation_id"]), businessId: String(rows[0]["business_id"]), kind: rows[0]["kind"] as JobKind, attemptCount: Number(claimed[0]!["attempt_count"]) }
    })),
    finishJob: (jobId, workerId) => Effect.gen(function*() {
      yield* sql`UPDATE growth_execution_jobs SET status='DONE',claimed_by=NULL,lease_expires_at=NULL WHERE id=${jobId} AND claimed_by=${workerId} AND status='CLAIMED'`
    }),
    retryJob: (jobId, workerId, delaySeconds, errorCode) => Effect.gen(function*() {
      yield* sql`UPDATE growth_execution_jobs SET status='QUEUED',claimed_by=NULL,lease_expires_at=NULL,not_before=now()+${delaySeconds}*interval '1 second',last_error=${errorCode.slice(0, 200)}
        WHERE id=${jobId} AND claimed_by=${workerId} AND status='CLAIMED'`
    }),
    ensureJob: (operationId, businessId, kind, delaySeconds) => enqueue(operationId, businessId, kind, delaySeconds, null, null),
    repairJobs: () => sql.withTransaction(Effect.gen(function*() {
      const rows = yield* sql`INSERT INTO growth_execution_jobs(operation_id,business_id,kind)
        SELECT o.id,o.business_id,CASE WHEN growth_execution_state(o.id)='DISPATCHING' THEN 'DISPATCH' ELSE 'RECONCILE' END
        FROM growth_execution_operations o
        WHERE growth_execution_state(o.id) IN ('DISPATCHING','AWAITING_MERGE','RECONCILING','UNKNOWN')
          AND NOT EXISTS (SELECT 1 FROM growth_execution_jobs j WHERE j.operation_id=o.id AND j.status IN ('QUEUED','CLAIMED') AND j.kind IN ('DISPATCH','RECONCILE'))
        ON CONFLICT DO NOTHING RETURNING id`
      return rows.length
    })),
    work: (businessId, operationId) => Effect.gen(function*() {
      const operation = yield* read(businessId, operationId)
      const rows = yield* sql`SELECT b.account_id,o.after_content,o.after_blob_sha,s.canonical_origin,s.path_prefix,t.allowed_paths,growth_opportunity_status(o.opportunity_id) AS initiative_status,
          (SELECT e.detail FROM growth_execution_events e WHERE e.operation_id=o.id AND e.state='AUTHORIZED' ORDER BY e.revision DESC LIMIT 1) AS authorized,
          (SELECT e.user_id FROM growth_execution_events e WHERE e.operation_id=o.id AND e.state='AUTHORIZED' ORDER BY e.revision DESC LIMIT 1) AS authorized_by
        FROM growth_execution_operations o JOIN businesses b ON b.id=o.business_id
        JOIN growth_execution_targets t ON t.id=o.target_id AND t.business_id=o.business_id JOIN site_targets s ON s.id=t.site_target_id AND s.business_id=o.business_id
        WHERE o.id=${operationId} AND o.business_id=${businessId}`
      const r = rows[0]!
      const auth = (r["authorized"] ?? null) as { approvedPatchSha256?: string; expiresAt?: string } | null
      return { operation, accountId: String(r["account_id"]), afterContent: String(r["after_content"]), afterBlobSha: String(r["after_blob_sha"]),
        authorizedPatchSha256: auth?.approvedPatchSha256 ?? null, authorizationExpiresAt: auth?.expiresAt ?? null, authorizedByUserId: r["authorized_by"] ? String(r["authorized_by"]) : null,
        siteOrigin: String(r["canonical_origin"]), sitePathPrefix: String(r["path_prefix"]), initiativeStatus: String(r["initiative_status"]), allowedPaths: (r["allowed_paths"] as string[]) }
    }),
    recordEvidence: (operationId, businessId, kind, detail) => sql.withTransaction(Effect.gen(function*() {
      yield* lock(businessId, operationId)
      yield* guard(sql`INSERT INTO growth_execution_evidence(operation_id,business_id,kind,detail) VALUES(${operationId},${businessId},${kind},${JSON.stringify(detail)}::jsonb)`).pipe(
        Effect.catchIf((e): e is SqlError => (e as { cause?: { code?: string } }).cause?.code === "23505", () => Effect.void))
    })),
    transition: (operationId, businessId, to, reason, detail) => sql.withTransaction(Effect.gen(function*() {
      yield* lock(businessId, operationId)
      const current = yield* read(businessId, operationId)
      if (current.state === to) return current
      if (!canTransitionExecution(current.state, to, "EXECUTION_SYSTEM")) return yield* refuse("TransitionRefused")
      yield* append(operationId, businessId, current.revision + 1, to, "EXECUTION_SYSTEM", null, reason, detail, null)
      return yield* read(businessId, operationId)
    })),
    verifyMerge: (operationId, businessId, evidence) => sql.withTransaction(Effect.gen(function*() {
      yield* lock(businessId, operationId)
      const current = yield* read(businessId, operationId)
      if (current.state === "VERIFIED") return current
      if (current.state !== "RECONCILING") return yield* refuse("TransitionRefused")
      const w = yield* sql`SELECT o.opportunity_id,o.before_sha256,o.after_sha256,(SELECT e.user_id FROM growth_execution_events e WHERE e.operation_id=o.id AND e.state='AUTHORIZED' ORDER BY e.revision DESC LIMIT 1) AS authorized_by
        FROM growth_execution_operations o WHERE o.id=${operationId} AND o.business_id=${businessId}`
      const mergedAt = String(evidence["mergedAt"] ?? ""), prUrl = String(evidence["prUrl"] ?? "")
      yield* guard(sql`INSERT INTO growth_execution_evidence(operation_id,business_id,kind,detail) VALUES(${operationId},${businessId},'PR_MERGE_CONFIRMED',${JSON.stringify(evidence)}::jsonb)`)
      // The receipt: SYSTEM_VERIFIED / GROWTH_DELIVERY / PR_MERGED, fixed here. No request field reaches it.
      const receipt = yield* guard(sql`INSERT INTO interventions(business_id,type,target,performed_at,actor,notes,evidence_before_digest,evidence_after_digest,channel,assurance,verification_kind,verification_id,verification_claim)
        VALUES(${businessId},'SOURCE_UPDATED',${prUrl},${mergedAt}::timestamptz,'SYSTEM','Pull request merge confirmed by the repository provider. This does not show the website was deployed.',
          ${String(w[0]!["before_sha256"])},${String(w[0]!["after_sha256"])},'WEBSITE','SYSTEM_VERIFIED','GROWTH_DELIVERY',${operationId},'PR_MERGED') RETURNING id`)
      yield* guard(sql`INSERT INTO growth_initiative_actions(intervention_id,opportunity_id,business_id,request_key,created_by_user_id)
        VALUES(${receipt[0]!["id"] as string},${String(w[0]!["opportunity_id"])},${businessId},${operationId},${String(w[0]!["authorized_by"])})`)
      yield* append(operationId, businessId, current.revision + 1, "VERIFIED", "EXECUTION_SYSTEM", null, "GitHub merge confirmed", { interventionId: receipt[0]!["id"], mergeCommitSha: evidence["mergeCommitSha"] }, null)
      return yield* read(businessId, operationId)
    })),
    recordLiveCheck: (operationId, businessId, check) => sql.withTransaction(Effect.gen(function*() {
      yield* lock(businessId, operationId)
      const op = yield* read(businessId, operationId)
      yield* guard(sql`INSERT INTO growth_execution_live_checks(operation_id,business_id,result,url,http_status,detail,body_digest)
        VALUES(${operationId},${businessId},${check.result},${op.liveUrl},${check.httpStatus},${check.detail.slice(0, 500)},${check.bodyDigest})`)
    })),
  } satisfies Context.Tag.Service<GrowthExecutionRepository>
}))

export const executionRequestFingerprint = (p: { opportunityId: string; targetId: string; actionKind: string; filePath: string; liveUrl: string; rationale: string; siteFindingId: string | null }): string =>
  sha256(JSON.stringify([p.opportunityId, p.targetId, p.actionKind, p.filePath, p.liveUrl, p.rationale.trim(), p.siteFindingId]))
export const isTerminalExecutionState = (s: ExecutionState): boolean => (EXECUTION_TERMINAL as ReadonlyArray<string>).includes(s)
