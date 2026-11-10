import { createHash, randomUUID } from "node:crypto"
import { SqlClient } from "@effect/sql"
import { AgentMessageRequest } from "@openrecord/contracts"
import { Data, Effect, Schedule, Schema } from "effect"
import { AgentModelError } from "./agent-model.js"
import { sendConversation, type ConversationScope, type Responder } from "./agent-conversations.js"
import { sessionResponder, wakeSessionParent } from "./agent-sessions.js"
import { cancelHarnessConversation } from "./harness-store.js"

export class AgentRequestRefused extends Data.TaggedError("AgentRequestRefused")<{ reason: "NOT_FOUND" | "CONFLICT" | "QUEUE_FULL" | "CONVERSATION_REQUIRED" }> {}
const refuse = (reason: AgentRequestRefused["reason"]) => Effect.fail(new AgentRequestRefused({ reason }))
type Job = { request_id: string; account_id: string; user_id: string; business_id: string | null; conversation_id: string; payload: unknown; claim_id: string }

/** Requeue only claims fenced before execution. Unknown execution is never replayed. */
export const reconcileRequestJobs = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql.withTransaction(Effect.gen(function*() {
    // Lock/fence expired claims before inspecting execution. The old worker must
    // win the execution marker update while its lease is live, or cannot start.
    yield* sql`UPDATE agent_request_jobs j SET status='QUEUED',claim_id=NULL,lease_until=NULL,started_at=NULL
      WHERE j.status='RUNNING' AND j.lease_until<=now() AND j.execution_started_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM agent_runs r WHERE r.request_id=j.request_id)
      AND NOT EXISTS(SELECT 1 FROM agent_conversations c WHERE c.id=j.conversation_id AND c.last_request_id=j.request_id)`
    const expired = yield* sql`UPDATE agent_request_jobs j SET status=CASE WHEN c.last_request_id=j.request_id AND c.last_reply IS NOT NULL THEN 'COMPLETED' ELSE 'INTERRUPTED' END,
      result=CASE WHEN c.last_request_id=j.request_id THEN c.last_reply ELSE NULL END,
      failure_reason=CASE WHEN c.last_request_id=j.request_id THEN NULL ELSE 'INTERRUPTED' END,finished_at=now(),claim_id=NULL,lease_until=NULL
      FROM agent_conversations c WHERE c.id=j.conversation_id AND j.status='RUNNING' AND j.lease_until<=now()
      RETURNING j.request_id,j.conversation_id`
    for (const job of expired) yield* sql`UPDATE agent_conversations c SET lease_id=NULL,lease_until=NULL
      WHERE c.id=${job["conversation_id"]} AND EXISTS(SELECT 1 FROM agent_runs r WHERE r.conversation_id=c.id AND r.request_id=${job["request_id"]} AND r.lease_id=c.lease_id)`
    yield* sql`UPDATE agent_request_jobs SET status='FAILED',failure_reason='QUEUE_EXPIRED',finished_at=now() WHERE status='QUEUED' AND expires_at<=now()`
  }))
})

export const enqueueAgentRequest = (scope: ConversationScope, raw: unknown) => Effect.gen(function*() {
  const body = yield* Schema.decodeUnknown(AgentMessageRequest, { onExcessProperty: "error" })(raw)
  if (!body.conversationId) return yield* refuse("CONVERSATION_REQUIRED")
  const digest = createHash("sha256").update(JSON.stringify([body.message,body.conversationId,body.revision,body.selection ?? null,body.style ?? null,body.attachments ?? [],...(body.surfaces ? [body.surfaces] : [])])).digest("hex")
  const sql = yield* SqlClient.SqlClient
  return yield* sql.withTransaction(Effect.gen(function*() {
    // Serialize account caps and enqueue-versus-cancel ordering across API replicas.
    const member = yield* sql`SELECT account_id FROM account_users WHERE account_id=${scope.accountId} AND user_id=${scope.userId} FOR UPDATE`
    if (!member[0]) return yield* refuse("NOT_FOUND")
    yield* sql`SELECT id FROM accounts WHERE id=${scope.accountId} FOR UPDATE`
    const conversation = (yield* sql`SELECT id,revision,lease_until FROM agent_conversations WHERE id=${body.conversationId} AND account_id=${scope.accountId}
      AND user_id=${scope.userId} AND business_id IS NOT DISTINCT FROM ${scope.businessId}::uuid AND expires_at>now() FOR UPDATE`)[0]
    if (!conversation) return yield* refuse("NOT_FOUND")
    const previous = (yield* sql`SELECT request_id,status,digest FROM agent_request_jobs WHERE request_id=${body.requestId} AND account_id=${scope.accountId} AND user_id=${scope.userId}`)[0]
    if (previous) {
      if (previous["digest"] !== digest) return yield* refuse("CONFLICT")
      return { requestId: body.requestId, status: String(previous["status"]), conversationId: body.conversationId }
    }
    if (Number(conversation["revision"]) !== body.revision || (conversation["lease_until"] && new Date(String(conversation["lease_until"])).getTime()>Date.now())) return yield* refuse("CONFLICT")
    const active = yield* sql`SELECT request_id FROM agent_request_jobs WHERE conversation_id=${body.conversationId} AND status IN ('QUEUED','RUNNING')`
    if (active[0]) return yield* refuse("CONFLICT")
    const count = (yield* sql`SELECT count(*)::int AS n FROM agent_request_jobs WHERE account_id=${scope.accountId} AND status IN ('QUEUED','RUNNING')`)[0]
    if (Number(count?.["n"] ?? 0)>=8) return yield* refuse("QUEUE_FULL")
    const inserted = yield* sql`INSERT INTO agent_request_jobs(request_id,account_id,user_id,business_id,conversation_id,payload,digest)
      VALUES (${body.requestId},${scope.accountId},${scope.userId},${scope.businessId},${body.conversationId},${JSON.stringify(body)}::jsonb,${digest}) ON CONFLICT DO NOTHING RETURNING request_id`
    if (!inserted[0]) return yield* refuse("CONFLICT")
    return { requestId: body.requestId, status: "QUEUED", conversationId: body.conversationId }
  }))
})

export const claimAgentRequest = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* reconcileRequestJobs
  return yield* sql.withTransaction(Effect.gen(function*() {
    yield* sql`SELECT pg_advisory_xact_lock(703941219)`
    const running = (yield* sql`SELECT count(*)::int AS n FROM agent_request_jobs WHERE status='RUNNING'`)[0]
    if (Number(running?.["n"] ?? 0)>=4) return null
    const row = (yield* sql<Job>`SELECT j.* FROM agent_request_jobs j
      WHERE j.status='QUEUED' AND j.expires_at>now()
      AND (SELECT count(*) FROM agent_request_jobs a WHERE a.account_id=j.account_id AND a.status='RUNNING')<2
      ORDER BY j.created_at FOR UPDATE SKIP LOCKED LIMIT 1`)[0]
    if (!row) return null
    const claimId = randomUUID()
    yield* sql`UPDATE agent_request_jobs SET status='RUNNING',claim_id=${claimId},lease_until=now()+interval '30 seconds',started_at=now() WHERE request_id=${row.request_id}`
    return { ...row, claim_id: claimId }
  }))
})

export const executeAgentRequest = <R>(job: Job, responder: Responder<R>) => Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const scope = { accountId: job.account_id, userId: job.user_id, businessId: job.business_id }
  const started = yield* sql`UPDATE agent_request_jobs SET execution_started_at=now()
    WHERE request_id=${job.request_id} AND claim_id=${job.claim_id} AND status='RUNNING'
    AND lease_until>now() AND execution_started_at IS NULL RETURNING request_id`
  if (!started[0]) return
  const active = Effect.gen(function*() {
    const rows = yield* sql`SELECT j.request_id FROM agent_request_jobs j JOIN account_users u ON u.account_id=j.account_id AND u.user_id=j.user_id
      WHERE j.request_id=${job.request_id} AND j.claim_id=${job.claim_id} AND j.status='RUNNING' AND j.lease_until>now()
      AND (j.business_id IS NULL OR EXISTS(SELECT 1 FROM businesses b WHERE b.id=j.business_id AND b.account_id=j.account_id)) FOR SHARE OF j`
    if (!rows[0]) return yield* Effect.fail(new AgentModelError({ reason: "CANCELLED" }))
  }).pipe(Effect.mapError(e => e instanceof AgentModelError ? e : new AgentModelError({ reason: "UNAVAILABLE" })))
  const heartbeat = Effect.forever(Effect.gen(function*() {
    yield* Effect.sleep("10 seconds")
    const rows = yield* sql`UPDATE agent_request_jobs SET lease_until=now()+interval '30 seconds' WHERE request_id=${job.request_id}
      AND claim_id=${job.claim_id} AND status='RUNNING' AND lease_until>now() RETURNING request_id`
    if (!rows[0]) return yield* Effect.fail(new AgentModelError({ reason: "CANCELLED" }))
  }))
  const guarded: Responder<R | SqlClient.SqlClient> = (accountId,userId,businessId,message,history,selection,assertActive,journal,turn) =>
    responder(accountId,userId,businessId,message,history,selection,assertActive.pipe(Effect.andThen(active)),journal,turn)
  const work = Effect.gen(function*() {
    yield* active
    const body = yield* Schema.decodeUnknown(AgentMessageRequest)(job.payload)
    return yield* sendConversation(scope,body,guarded,active)
  })
  const outcome = yield* Effect.raceFirst(work,heartbeat).pipe(Effect.exit)
  if (outcome._tag === "Success") {
    yield* sql`UPDATE agent_request_jobs SET status='COMPLETED',result=${JSON.stringify(outcome.value)}::jsonb,finished_at=now(),lease_until=NULL,claim_id=NULL
      WHERE request_id=${job.request_id} AND claim_id=${job.claim_id} AND status='RUNNING'`
  } else {
    const failure = outcome.cause._tag === "Fail" ? outcome.cause.error : null
    const reason = failure instanceof AgentModelError ? failure.reason : "UNAVAILABLE"
    yield* sql`UPDATE agent_request_jobs SET status=${reason === "CANCELLED" ? "CANCELLED" : "FAILED"},failure_reason=${reason},finished_at=now(),lease_until=NULL,claim_id=NULL
      WHERE request_id=${job.request_id} AND claim_id=${job.claim_id} AND status='RUNNING'`
  }
})

export const cancelAgentRequest = (accountId: string,userId: string,requestId: string) => Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  return yield* sql.withTransaction(Effect.gen(function*() {
    const job = (yield* sql<Job & { status: string }>`SELECT * FROM agent_request_jobs WHERE request_id=${requestId} AND account_id=${accountId} AND user_id=${userId} FOR UPDATE`)[0]
    if (!job) return yield* refuse("NOT_FOUND")
    if (job.status !== "QUEUED" && job.status !== "RUNNING") return { cancelled: false }
    const committed = (yield* sql`SELECT last_reply FROM agent_conversations WHERE id=${job.conversation_id} AND last_request_id=${requestId} AND last_reply IS NOT NULL`)[0]
    if (committed) {
      yield* sql`UPDATE agent_request_jobs SET status='COMPLETED',result=${JSON.stringify(committed["last_reply"])}::jsonb,finished_at=now(),claim_id=NULL,lease_until=NULL WHERE request_id=${requestId}`
      return { cancelled: false }
    }
    yield* sql`UPDATE agent_request_jobs SET status='CANCELLED',finished_at=now(),claim_id=NULL,lease_until=NULL WHERE request_id=${requestId}`
    if (job.status === "RUNNING") yield* cancelHarnessConversation({ accountId,userId,businessId:job.business_id,conversationId:job.conversation_id })
    return { cancelled: true }
  }))
})

export const agentRequestWorker = Effect.all([0,1].map(() => Effect.gen(function*() {
  const job = yield* claimAgentRequest
  if (job) {
    yield* executeAgentRequest(job,sessionResponder)
    if (job.business_id !== null) yield* wakeSessionParent({accountId:job.account_id,userId:job.user_id,businessId:job.business_id},job.conversation_id)
  }
}).pipe(Effect.catchAllCause(() => Effect.logWarning("agent request worker unavailable")),Effect.repeat(Schedule.spaced("1 second")))),{ concurrency: 2 })
