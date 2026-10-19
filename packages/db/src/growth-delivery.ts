import { randomUUID } from "node:crypto"
import { Context, Data, Effect, Layer, Schema } from "effect"
import { PgClient } from "@effect/sql-pg"
import type { SqlError } from "@effect/sql/SqlError"
import {
  ConnectDeliveryTarget, DeliveryDecision, DeliveryEdit, DeliveryState, AttestDeployment, canTransitionDelivery,
  type DeliveryAttempt, type DeliveryTarget, type GrowthDelivery,
} from "@openrecord/contracts"
import { decodeRow, type RowDecodeError } from "./row-codecs.js"
import type { Session } from "./auth.js"

// Persistence for marketing delivery (P2). The service in apps/api talks to
// GitHub; this repository only records what was proposed, decided and
// confirmed, in the order the database guard (0031) allows.

export class DeliveryRefused extends Data.TaggedError("DeliveryRefused")<{ readonly reason: string }> {}
export type DeliveryEffect<A> = Effect.Effect<A, SqlError | RowDecodeError | DeliveryRefused>

const Target = Schema.Struct({ id: Schema.UUID, businessId: Schema.UUID, provider: Schema.Literal("GITHUB"), owner: Schema.String, repository: Schema.String,
  baseBranch: Schema.String, allowedPaths: Schema.Array(Schema.String), createdByUserId: Schema.UUID, createdAt: Schema.String })
const Event = Schema.Struct({ id: Schema.UUID, state: DeliveryState, revision: Schema.Int, actor: Schema.Literal("OPERATOR", "ASSISTANT", "DELIVERY_SYSTEM"),
  userId: Schema.UUID, reason: Schema.String, detail: Schema.Record({ key: Schema.String, value: Schema.Unknown }), createdAt: Schema.String })
const Attempt = Schema.Struct({ id: Schema.UUID, state: Schema.Literal("CLAIMED", "SUCCEEDED", "FAILED", "UNKNOWN"), headBranch: Schema.String,
  commitSha: Schema.NullOr(Schema.String), prNumber: Schema.NullOr(Schema.Int), prUrl: Schema.NullOr(Schema.String),
  failureCode: Schema.NullOr(Schema.String), failureDetail: Schema.NullOr(Schema.String), createdAt: Schema.String, updatedAt: Schema.String })
const Delivery = Schema.Struct({ id: Schema.UUID, businessId: Schema.UUID, opportunityId: Schema.UUID, targetId: Schema.UUID, owner: Schema.String,
  repository: Schema.String, filePath: Schema.String, baseBranch: Schema.String, baseCommitSha: Schema.String, baseBlobSha: Schema.String,
  beforeSha256: Schema.String, afterSha256: Schema.String, afterBlobSha: Schema.String, patchSha256: Schema.String, edits: Schema.Array(DeliveryEdit),
  diff: Schema.String, rationale: Schema.String, assumptions: Schema.String, proposedBy: Schema.Literal("OPERATOR", "ASSISTANT"),
  createdByUserId: Schema.UUID, createdAt: Schema.String, state: DeliveryState, revision: Schema.Int, events: Schema.Array(Event), attempts: Schema.Array(Attempt) })

/** Everything the API derived from GitHub and the edits before drafting. */
export interface DeliveryDraft {
  readonly targetId: string; readonly filePath: string; readonly baseBranch: string; readonly baseCommitSha: string
  readonly baseBlobSha: string; readonly afterBlobSha: string; readonly beforeSha256: string; readonly afterSha256: string
  readonly patchSha256: string; readonly edits: ReadonlyArray<DeliveryEdit>; readonly afterContent: string; readonly diff: string
  readonly rationale: string; readonly assumptions: string; readonly idempotencyKey: string
}
export type ClaimResult =
  | { readonly kind: "claimed"; readonly attempt: DeliveryAttempt; readonly delivery: GrowthDelivery; readonly afterContent: string }
  | { readonly kind: "reconcile"; readonly attempt: DeliveryAttempt; readonly delivery: GrowthDelivery; readonly afterContent: string }
  | { readonly kind: "replay"; readonly delivery: GrowthDelivery }
export type AttemptOutcome =
  | { readonly state: "SUCCEEDED"; readonly commitSha: string; readonly prNumber: number; readonly prUrl: string }
  | { readonly state: "FAILED"; readonly code: string; readonly detail: string; readonly stale: boolean }
  | { readonly state: "UNKNOWN"; readonly detail: string }
export type ObservedPullRequest =
  | { readonly state: "OPEN" }
  | { readonly state: "MERGED"; readonly mergeCommitSha: string; readonly mergedAt: string | null }
  | { readonly state: "CLOSED"; readonly closedAt: string | null }

export class GrowthDeliveryRepository extends Context.Tag("GrowthDeliveryRepository")<GrowthDeliveryRepository, {
  readonly targets: (accountId: string, businessId: string) => DeliveryEffect<ReadonlyArray<DeliveryTarget>>
  readonly target: (accountId: string, businessId: string, targetId: string) => DeliveryEffect<DeliveryTarget>
  readonly connect: (session: Session, businessId: string, input: ConnectDeliveryTarget) => DeliveryEffect<DeliveryTarget>
  readonly list: (accountId: string, businessId: string, opportunityId: string | null) => DeliveryEffect<ReadonlyArray<GrowthDelivery>>
  readonly get: (accountId: string, businessId: string, deliveryId: string) => DeliveryEffect<GrowthDelivery>
  /** Replays the delivery a request key already created, if any. */
  readonly byRequest: (accountId: string, businessId: string, idempotencyKey: string) => DeliveryEffect<GrowthDelivery | null>
  readonly draft: (session: Session, businessId: string, opportunityId: string, actor: "OPERATOR" | "ASSISTANT", draft: DeliveryDraft) => DeliveryEffect<GrowthDelivery>
  /** Human decision only: approve binds the reviewed patch hash, or reject. */
  readonly decide: (session: Session, businessId: string, deliveryId: string, input: DeliveryDecision) => DeliveryEffect<GrowthDelivery>
  readonly claimAttempt: (session: Session, businessId: string, deliveryId: string, requestKey: string) => DeliveryEffect<ClaimResult>
  readonly completeAttempt: (session: Session, businessId: string, deliveryId: string, attemptId: string, outcome: AttemptOutcome) => DeliveryEffect<GrowthDelivery>
  /** Records the pull request state GitHub reported; never a claim. */
  readonly recordPullRequest: (session: Session, businessId: string, deliveryId: string, observed: ObservedPullRequest) => DeliveryEffect<GrowthDelivery>
  readonly attestDeployment: (session: Session, businessId: string, deliveryId: string, input: AttestDeployment) => DeliveryEffect<GrowthDelivery>
}>() {}

/** Deterministic per delivery, so a retry finds the branch an earlier attempt created. */
export const deliveryHeadBranch = (deliveryId: string) => `openrecord/growth-${deliveryId}`

export const GrowthDeliveryRepositoryLive = Layer.effect(GrowthDeliveryRepository, Effect.map(PgClient.PgClient, sql => {
  const refuse = (reason: string) => Effect.fail(new DeliveryRefused({ reason }))
  const parse = <A, I>(schema: Schema.Schema<A, I>, input: unknown) => Schema.decodeUnknown(schema, { onExcessProperty: "error" })(input).pipe(
    Effect.mapError(() => new DeliveryRefused({ reason: "InvalidRequest" })))
  const scope = (accountId: string, businessId: string) => Effect.gen(function*() {
    const rows = yield* sql`SELECT 1 FROM businesses b JOIN growth_profiles p ON p.business_id=b.id WHERE b.id=${businessId} AND b.account_id=${accountId}`
    if (!rows.length) return yield* refuse("GrowthNotFound")
  })
  const member = (session: Session, businessId: string) => Effect.gen(function*() {
    yield* scope(session.accountId, businessId)
    const rows = yield* sql`SELECT 1 FROM account_users WHERE account_id=${session.accountId} AND user_id=${session.userId}`
    if (!rows.length) return yield* refuse("GrowthNotFound")
  })
  const targetDoc = (row: Record<string, unknown>) => ({
    id: row["id"], businessId: row["business_id"], provider: row["provider"], owner: row["owner"], repository: row["repository"],
    baseBranch: row["base_branch"], allowedPaths: row["allowed_paths"], createdByUserId: row["created_by_user_id"],
    createdAt: new Date(row["created_at"] as string | Date).toISOString(),
  })
  const target = (accountId: string, businessId: string, targetId: string): DeliveryEffect<DeliveryTarget> => Effect.gen(function*() {
    yield* scope(accountId, businessId)
    const rows = yield* sql`SELECT * FROM growth_delivery_targets WHERE id=${targetId} AND business_id=${businessId}`
    if (!rows[0]) return yield* refuse("TargetNotFound")
    return yield* decodeRow(Target, "growth_delivery_targets", targetDoc(rows[0]))
  })
  const get = (accountId: string, businessId: string, deliveryId: string): DeliveryEffect<GrowthDelivery> => Effect.gen(function*() {
    yield* scope(accountId, businessId)
    const rows = yield* sql`SELECT document FROM growth_delivery_documents WHERE id=${deliveryId} AND business_id=${businessId}`
    if (!rows[0]) return yield* refuse("DeliveryNotFound")
    return yield* decodeRow(Delivery, "growth_deliveries", rows[0]["document"])
  })
  const lock = (businessId: string, deliveryId: string) => Effect.gen(function*() {
    const rows = yield* sql`SELECT id FROM growth_deliveries WHERE id=${deliveryId} AND business_id=${businessId} FOR UPDATE`
    if (!rows.length) return yield* refuse("DeliveryNotFound")
  })
  const appendEvent = (businessId: string, delivery: GrowthDelivery, state: DeliveryState, actor: "OPERATOR" | "DELIVERY_SYSTEM", userId: string,
    reason: string, detail: Record<string, unknown>, requestKey: string) =>
    Effect.gen(function*() {
      if (!canTransitionDelivery(delivery.state, state, actor)) return yield* refuse("TransitionRefused")
      yield* sql`INSERT INTO growth_delivery_events(delivery_id,business_id,revision,state,actor,user_id,reason,detail,request_key)
        VALUES(${delivery.id},${businessId},${delivery.revision + 1},${state},${actor},${userId},${reason},${JSON.stringify(detail)}::jsonb,${requestKey})`
    })
  // The opportunity side moves in the same transaction as the delivery event
  // that justifies it; the database refuses it otherwise.
  const moveOpportunity = (businessId: string, delivery: GrowthDelivery, from: string, to: string, actor: "OPERATOR" | "DELIVERY_SYSTEM", userId: string, reason: string) =>
    Effect.gen(function*() {
      const rows = yield* sql`SELECT status, revision FROM growth_opportunity_events WHERE opportunity_id=${delivery.opportunityId} ORDER BY revision DESC LIMIT 1 FOR UPDATE`
      if (rows[0]?.["status"] !== from) return
      yield* sql`INSERT INTO growth_opportunity_events(opportunity_id,business_id,revision,status,actor,user_id,reason,request_key,delivery_id)
        VALUES(${delivery.opportunityId},${businessId},${Number(rows[0]["revision"]) + 1},${to},${actor},${userId},${reason},${randomUUID()},${delivery.id})`
    })

  return {
    target, get,
    targets: (accountId, businessId) => Effect.gen(function*() {
      yield* scope(accountId, businessId)
      const rows = yield* sql`SELECT * FROM growth_delivery_targets WHERE business_id=${businessId} ORDER BY created_at, id`
      return yield* Effect.forEach(rows, row => decodeRow(Target, "growth_delivery_targets", targetDoc(row)))
    }),
    connect: (session, businessId, raw) => sql.withTransaction(Effect.gen(function*() {
      yield* member(session, businessId)
      const input = yield* parse(ConnectDeliveryTarget, raw)
      yield* sql`SELECT business_id FROM growth_profiles WHERE business_id=${businessId} FOR UPDATE`
      const replay = yield* sql`SELECT id FROM growth_delivery_targets WHERE business_id=${businessId} AND request_key=${input.idempotencyKey}`
      if (replay[0]) return yield* target(session.accountId, businessId, String(replay[0]["id"]))
      const existing = yield* sql`SELECT id FROM growth_delivery_targets WHERE business_id=${businessId} AND lower(owner)=lower(${input.owner}) AND lower(repository)=lower(${input.repository})`
      if (existing.length) return yield* refuse("TargetExists")
      // The database trigger is the backstop; refusing here gives a typed answer.
      const foreign = yield* sql`SELECT 1 FROM growth_delivery_targets t JOIN businesses b ON b.id=t.business_id
        WHERE lower(t.owner)=lower(${input.owner}) AND lower(t.repository)=lower(${input.repository}) AND b.account_id<>${session.accountId}`
      if (foreign.length) return yield* refuse("RepositoryInAnotherAccount")
      const rows = yield* sql`INSERT INTO growth_delivery_targets(business_id,provider,owner,repository,base_branch,allowed_paths,created_by_user_id,request_key)
        VALUES(${businessId},'GITHUB',${input.owner},${input.repository},${input.baseBranch},ARRAY(SELECT jsonb_array_elements_text(${JSON.stringify(input.allowedPaths)}::jsonb)),${session.userId},${input.idempotencyKey})
        RETURNING id`
      return yield* target(session.accountId, businessId, String(rows[0]!["id"]))
    })),
    list: (accountId, businessId, opportunityId) => Effect.gen(function*() {
      yield* scope(accountId, businessId)
      const rows = opportunityId
        ? yield* sql`SELECT document FROM growth_delivery_documents WHERE business_id=${businessId} AND opportunity_id=${opportunityId} ORDER BY created_at DESC, id LIMIT 50`
        : yield* sql`SELECT document FROM growth_delivery_documents WHERE business_id=${businessId} ORDER BY created_at DESC, id LIMIT 50`
      return yield* Effect.forEach(rows, row => decodeRow(Delivery, "growth_deliveries", row["document"]))
    }),
    byRequest: (accountId, businessId, idempotencyKey) => Effect.gen(function*() {
      yield* scope(accountId, businessId)
      const rows = yield* sql`SELECT id FROM growth_deliveries WHERE business_id=${businessId} AND request_key=${idempotencyKey}`
      return rows[0] ? yield* get(accountId, businessId, String(rows[0]["id"])) : null
    }),
    draft: (session, businessId, opportunityId, actor, d) => sql.withTransaction(Effect.gen(function*() {
      yield* member(session, businessId)
      if (actor !== "OPERATOR" && actor !== "ASSISTANT") return yield* refuse("ActorRefused")
      const locked = yield* sql`SELECT id FROM growth_opportunities WHERE id=${opportunityId} AND business_id=${businessId} FOR UPDATE`
      if (!locked.length) return yield* refuse("OpportunityNotFound")
      const replay = yield* sql`SELECT id, opportunity_id, proposed_by FROM growth_deliveries WHERE business_id=${businessId} AND request_key=${d.idempotencyKey}`
      if (replay[0]) {
        if (replay[0]["opportunity_id"] !== opportunityId || replay[0]["proposed_by"] !== actor) return yield* refuse("IdempotencyConflict")
        return yield* get(session.accountId, businessId, String(replay[0]["id"]))
      }
      const status = yield* sql`SELECT growth_opportunity_status(${opportunityId}::uuid) AS status`
      if (status[0]?.["status"] !== "APPROVED") return yield* refuse("OpportunityNotApproved")
      const rows = yield* sql`INSERT INTO growth_deliveries(business_id,opportunity_id,target_id,file_path,base_branch,base_commit_sha,base_blob_sha,after_blob_sha,
          before_sha256,after_sha256,patch_sha256,edits,after_content,diff,rationale,assumptions,proposed_by,created_by_user_id,request_key)
        VALUES(${businessId},${opportunityId},${d.targetId},${d.filePath},${d.baseBranch},${d.baseCommitSha},${d.baseBlobSha},${d.afterBlobSha},
          ${d.beforeSha256},${d.afterSha256},${d.patchSha256},${JSON.stringify(d.edits)}::jsonb,${d.afterContent},${d.diff},${d.rationale},${d.assumptions},
          ${actor},${session.userId},${d.idempotencyKey}) RETURNING id`
      const id = String(rows[0]!["id"])
      yield* sql`INSERT INTO growth_delivery_events(delivery_id,business_id,revision,state,actor,user_id,reason,request_key)
        VALUES(${id},${businessId},1,'DRAFTED',${actor},${session.userId},'Change drafted for review',${d.idempotencyKey})`
      return yield* get(session.accountId, businessId, id)
    })),
    decide: (session, businessId, deliveryId, raw) => sql.withTransaction(Effect.gen(function*() {
      yield* member(session, businessId)
      const input = yield* parse(DeliveryDecision, raw)
      yield* lock(businessId, deliveryId)
      const to: DeliveryState = input.approve ? "APPROVED_FOR_PR" : "REJECTED"
      const replay = yield* sql`SELECT state, revision, reason FROM growth_delivery_events WHERE delivery_id=${deliveryId} AND request_key=${input.idempotencyKey}`
      if (replay[0]) {
        if (replay[0]["state"] !== to || replay[0]["revision"] !== input.expectedRevision + 1 || replay[0]["reason"] !== input.reason) return yield* refuse("IdempotencyConflict")
        return yield* get(session.accountId, businessId, deliveryId)
      }
      const current = yield* get(session.accountId, businessId, deliveryId)
      if (current.revision !== input.expectedRevision) return yield* refuse("StaleDecision")
      // Approval binds the exact change the person reviewed.
      if (input.approve && input.reviewedPatchSha256 !== current.patchSha256) return yield* refuse("ReviewedPatchMismatch")
      yield* appendEvent(businessId, current, to, "OPERATOR", session.userId, input.reason,
        input.approve ? { approvedPatchSha256: current.patchSha256 } : {}, input.idempotencyKey)
      return yield* get(session.accountId, businessId, deliveryId)
    })),
    claimAttempt: (session, businessId, deliveryId, requestKey) => sql.withTransaction(Effect.gen(function*() {
      yield* member(session, businessId)
      yield* lock(businessId, deliveryId)
      const delivery = yield* get(session.accountId, businessId, deliveryId)
      const content = yield* sql`SELECT after_content FROM growth_deliveries WHERE id=${deliveryId}`
      const afterContent = String(content[0]!["after_content"])
      const byKey = yield* sql`SELECT id FROM growth_delivery_attempts WHERE delivery_id=${deliveryId} AND request_key=${requestKey}`
      // The same request again returns what it produced, and a delivery whose
      // pull request exists returns it: nothing is sent to GitHub twice.
      if (byKey[0] || delivery.attempts.some(a => a.state === "SUCCEEDED")) return { kind: "replay", delivery } as const
      if (delivery.state !== "APPROVED_FOR_PR") return yield* refuse(delivery.state === "STALE" ? "StaleBase" : "NotApprovedForPullRequest")
      if (delivery.attempts.some(a => a.state === "CLAIMED")) return yield* refuse("AttemptInFlight")
      const unknown = delivery.attempts.find(a => a.state === "UNKNOWN")
      if (unknown) {
        // An earlier attempt may have written to GitHub: reconcile before any new write.
        yield* sql`UPDATE growth_delivery_attempts SET state='CLAIMED', failure_detail=NULL WHERE id=${unknown.id}`
        const refreshed = yield* get(session.accountId, businessId, deliveryId)
        return { kind: "reconcile", attempt: refreshed.attempts.find(a => a.id === unknown.id)!, delivery: refreshed, afterContent } as const
      }
      const rows = yield* sql`INSERT INTO growth_delivery_attempts(delivery_id,business_id,request_key,state,head_branch,requested_by_user_id)
        VALUES(${deliveryId},${businessId},${requestKey},'CLAIMED',${deliveryHeadBranch(deliveryId)},${session.userId}) RETURNING id`
      const refreshed = yield* get(session.accountId, businessId, deliveryId)
      return { kind: "claimed", attempt: refreshed.attempts.find(a => a.id === String(rows[0]!["id"]))!, delivery: refreshed, afterContent } as const
    })),
    completeAttempt: (session, businessId, deliveryId, attemptId, outcome) => sql.withTransaction(Effect.gen(function*() {
      yield* member(session, businessId)
      yield* lock(businessId, deliveryId)
      if (outcome.state === "SUCCEEDED") {
        yield* sql`UPDATE growth_delivery_attempts SET state='SUCCEEDED', commit_sha=${outcome.commitSha}, pr_number=${outcome.prNumber}, pr_url=${outcome.prUrl}
          WHERE id=${attemptId} AND delivery_id=${deliveryId} AND state='CLAIMED'`
        const delivery = yield* get(session.accountId, businessId, deliveryId)
        yield* appendEvent(businessId, delivery, "PR_OPENED", "DELIVERY_SYSTEM", session.userId, "Pull request opened on GitHub",
          { prNumber: outcome.prNumber, prUrl: outcome.prUrl, commitSha: outcome.commitSha, headBranch: deliveryHeadBranch(deliveryId) }, randomUUID())
        const opened = yield* get(session.accountId, businessId, deliveryId)
        yield* moveOpportunity(businessId, opened, "APPROVED", "IN_DELIVERY", "DELIVERY_SYSTEM", session.userId, "Pull request opened; not merged or deployed")
      } else if (outcome.state === "FAILED") {
        yield* sql`UPDATE growth_delivery_attempts SET state='FAILED', failure_code=${outcome.code}, failure_detail=${outcome.detail.slice(0, 500)}
          WHERE id=${attemptId} AND delivery_id=${deliveryId} AND state='CLAIMED'`
        if (outcome.stale) {
          const delivery = yield* get(session.accountId, businessId, deliveryId)
          yield* appendEvent(businessId, delivery, "STALE", "DELIVERY_SYSTEM", session.userId,
            "The file changed on the base branch after review; prepare the change again", { failureCode: outcome.code }, randomUUID())
        }
      } else {
        yield* sql`UPDATE growth_delivery_attempts SET state='UNKNOWN', failure_detail=${outcome.detail.slice(0, 500)}
          WHERE id=${attemptId} AND delivery_id=${deliveryId} AND state='CLAIMED'`
      }
      return yield* get(session.accountId, businessId, deliveryId)
    })),
    recordPullRequest: (session, businessId, deliveryId, observed) => sql.withTransaction(Effect.gen(function*() {
      yield* member(session, businessId)
      yield* lock(businessId, deliveryId)
      const delivery = yield* get(session.accountId, businessId, deliveryId)
      if (delivery.state !== "PR_OPENED" || observed.state === "OPEN") return delivery
      if (observed.state === "MERGED") {
        yield* appendEvent(businessId, delivery, "PR_MERGED", "DELIVERY_SYSTEM", session.userId, "GitHub reports the pull request merged; deployment not verified",
          { mergeCommitSha: observed.mergeCommitSha, mergedAt: observed.mergedAt }, randomUUID())
        // A merge GitHub confirmed is evidence of the action, not of deployment.
        yield* sql`INSERT INTO growth_opportunity_evidence(opportunity_id,business_id,type,reference_kind,reference_id,note)
          VALUES(${delivery.opportunityId},${businessId},'VERIFIED_ACTION','GROWTH_DELIVERY',${deliveryId},
            ${`Pull request merged in ${delivery.owner}/${delivery.repository} (merge ${observed.mergeCommitSha.slice(0, 12)}). Deployment is not verified by this record.`})
          ON CONFLICT DO NOTHING`
      } else {
        yield* appendEvent(businessId, delivery, "CLOSED_WITHOUT_DELIVERY", "DELIVERY_SYSTEM", session.userId, "GitHub reports the pull request closed without merging",
          { closedAt: observed.closedAt }, randomUUID())
        const closed = yield* get(session.accountId, businessId, deliveryId)
        yield* moveOpportunity(businessId, closed, "IN_DELIVERY", "APPROVED", "DELIVERY_SYSTEM", session.userId, "Pull request closed without merging; nothing was delivered")
      }
      return yield* get(session.accountId, businessId, deliveryId)
    })),
    attestDeployment: (session, businessId, deliveryId, raw) => sql.withTransaction(Effect.gen(function*() {
      yield* member(session, businessId)
      const input = yield* parse(AttestDeployment, raw)
      yield* lock(businessId, deliveryId)
      const replay = yield* sql`SELECT state FROM growth_delivery_events WHERE delivery_id=${deliveryId} AND request_key=${input.idempotencyKey}`
      if (replay[0]) {
        if (replay[0]["state"] !== "DEPLOYMENT_VERIFIED") return yield* refuse("IdempotencyConflict")
        return yield* get(session.accountId, businessId, deliveryId)
      }
      const current = yield* get(session.accountId, businessId, deliveryId)
      if (current.revision !== input.expectedRevision) return yield* refuse("StaleDecision")
      if (current.state !== "PR_MERGED") return yield* refuse("NotMerged")
      yield* appendEvent(businessId, current, "DEPLOYMENT_VERIFIED", "OPERATOR", session.userId, input.note,
        { provenance: "OPERATOR_ATTESTED", url: input.url, observedAt: new Date(input.observedAt).toISOString() }, input.idempotencyKey)
      const verified = yield* get(session.accountId, businessId, deliveryId)
      yield* moveOpportunity(businessId, verified, "IN_DELIVERY", "DELIVERED", "OPERATOR", session.userId, "Deployment attested by the operator")
      return verified
    })),
  } satisfies Context.Tag.Service<GrowthDeliveryRepository>
}))
