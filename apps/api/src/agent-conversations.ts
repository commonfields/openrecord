import { createHash, randomUUID } from "node:crypto"
import { SqlClient } from "@effect/sql"
import { Cause, Data, Effect, Schema } from "effect"
import { agentWorkflow, DEFAULT_RUN_BUDGET, handleAgentMessage, type AgentHistory } from "./agent.js"
import { finishRun, settleRuns, startRun, type RunJournal, type RunOutcome } from "./agent-run.js"
import type { HarnessSelection } from "@openrecord/contracts"
import { HarnessReasoningEffort } from "@openrecord/contracts"
import { AgentModelError } from "./agent-model.js"

export class AgentConversationRefused extends Data.TaggedError("AgentConversationRefused")<{
  readonly reason: "NOT_FOUND" | "BUSY" | "STALE"
}> {}
const Citation = Schema.Struct({ kind: Schema.String, id: Schema.String, text: Schema.String })
const Usage = Schema.Struct({ observedModel: Schema.NullOr(Schema.String), promptTokens: Schema.NullOr(Schema.Number), outputTokens: Schema.NullOr(Schema.Number), thoughtTokens: Schema.NullOr(Schema.Number), totalTokens: Schema.NullOr(Schema.Number) })
// The run that produced an agent message: its outcome, or how it stopped.
const RunRef = Schema.Struct({ id: Schema.UUID, status: Schema.Literal("COMPLETED", "FAILED", "CANCELLED", "INTERRUPTED"),
  outcome: Schema.optional(Schema.Literal("ANSWERED", "ANSWERED_WITH_GAPS")), gaps: Schema.optional(Schema.Array(Schema.String)) })
const Message = Schema.Struct({ role: Schema.Literal("user", "agent"), text: Schema.String, citations: Schema.optional(Schema.Array(Citation)), toolCalls: Schema.optional(Schema.Array(Schema.Struct({ tool: Schema.String, summary: Schema.String }))), run: Schema.optional(RunRef), inference: Schema.optional(Schema.Struct({ provider: Schema.String, requestedModel: Schema.String, instanceId: Schema.optional(Schema.UUID), reasoningEffort: Schema.optional(HarnessReasoningEffort), usage: Schema.Array(Usage) })) })
const Conversation = Schema.Struct({ id: Schema.UUID, messages: Schema.Array(Message), revision: Schema.Number })
const parse = Schema.decodeUnknown(Conversation)
export type ConversationScope = { readonly accountId: string; readonly userId: string; readonly businessId: string | null }
export const loadConversation = (scope: ConversationScope, conversationId?: string) => Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* settleConversation(scope, conversationId)
  const rows = yield* sql`SELECT id, messages, revision FROM agent_conversations WHERE account_id = ${scope.accountId}
    AND business_id IS NOT DISTINCT FROM ${scope.businessId}::uuid AND user_id = ${scope.userId} AND expires_at > now()
    AND (${conversationId ?? null}::uuid IS NOT NULL AND id=${conversationId ?? null}::uuid
      OR ${conversationId ?? null}::uuid IS NULL AND archived_at IS NULL)`
  return rows[0] ? yield* parse(rows[0]) : null
})
/** Settles stopped runs before a conversation is read, so a reply lost to a
 * crash or cancel shows as an explicit note instead of silence. */
const settleConversation = (scope: ConversationScope, conversationId?: string) => Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const pending = yield* sql`SELECT DISTINCT r.conversation_id FROM agent_runs r JOIN agent_conversations c ON c.id = r.conversation_id
    WHERE r.settled_at IS NULL AND c.account_id = ${scope.accountId} AND c.user_id = ${scope.userId}
      AND c.business_id IS NOT DISTINCT FROM ${scope.businessId}::uuid
      AND (${conversationId ?? null}::uuid IS NOT NULL AND c.id = ${conversationId ?? null}::uuid OR ${conversationId ?? null}::uuid IS NULL AND c.archived_at IS NULL)
      AND (r.status <> 'RUNNING' OR c.lease_id IS DISTINCT FROM r.lease_id OR c.lease_until IS NULL OR c.lease_until <= now())`
  for (const row of pending) yield* sql.withTransaction(Effect.gen(function*() {
    yield* sql`SELECT id FROM agent_conversations WHERE id = ${String(row["conversation_id"])} FOR UPDATE`
    yield* settleRuns(String(row["conversation_id"]))
  }))
})
// The signed-in user's saved conversations in this account, newest first, for
// the chat history. Titled by the first question asked; empty ones are skipped.
export type ConversationSummary = {
  readonly id: string
  readonly businessId: string | null; readonly businessName: string; readonly isClient: boolean
  readonly title: string; readonly messages: number; readonly updatedAt: string
}
export const listConversations = (scope: { readonly accountId: string; readonly userId: string }) => Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql`SELECT c.id, c.business_id, b.name, (rp.business_id IS NOT NULL) AS is_client, c.updated_at,
      jsonb_array_length(c.messages) AS message_count,
      (SELECT m->>'text' FROM jsonb_array_elements(c.messages) WITH ORDINALITY AS e(m, i) WHERE m->>'role' = 'user' ORDER BY i LIMIT 1) AS first_message
    FROM agent_conversations c
    LEFT JOIN businesses b ON b.id = c.business_id AND b.account_id = c.account_id
    JOIN account_users au ON au.account_id = c.account_id AND au.user_id = c.user_id
    LEFT JOIN record_profiles rp ON rp.business_id = c.business_id
    WHERE c.account_id = ${scope.accountId} AND c.user_id = ${scope.userId}
      AND c.expires_at > now() AND jsonb_array_length(c.messages) > 0
    ORDER BY c.updated_at DESC LIMIT 30`
  return rows.map((r): ConversationSummary => ({
    id: String(r["id"]),
    businessId: r["business_id"] === null ? null : String(r["business_id"]), businessName: r["business_id"] === null ? "General chat" : String(r["name"]), isClient: r["is_client"] === true,
    title: String(r["first_message"] ?? "").replace(/\s+/g, " ").trim().slice(0, 120),
    messages: Number(r["message_count"]), updatedAt: new Date(r["updated_at"] as string | Date).toISOString(),
  }))
})
export const createConversation = (scope: ConversationScope, id: string) => Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  return yield* sql.withTransaction(Effect.gen(function*() {
    // Serialize new-chat retries and concurrent clicks without deleting history.
    const owned = yield* sql`SELECT au.account_id FROM account_users au WHERE au.account_id=${scope.accountId} AND au.user_id=${scope.userId}
      AND (${scope.businessId}::uuid IS NULL OR EXISTS(SELECT 1 FROM businesses WHERE id=${scope.businessId} AND account_id=${scope.accountId})) FOR UPDATE OF au`
    if (!owned.length) return yield* Effect.fail(new AgentConversationRefused({ reason: "NOT_FOUND" }))
    const existing = yield* sql`SELECT id,account_id,business_id,user_id FROM agent_conversations WHERE id=${id}`
    if (existing[0]) {
      if (existing[0]["account_id"] !== scope.accountId || existing[0]["business_id"] !== scope.businessId || existing[0]["user_id"] !== scope.userId)
        return yield* Effect.fail(new AgentConversationRefused({ reason: "NOT_FOUND" }))
      const saved = yield* loadConversation(scope, id)
      if (!saved) return yield* Effect.fail(new AgentConversationRefused({ reason: "NOT_FOUND" }))
      return saved
    }
    // Archiving only changes which thread opens by default. An existing turn
    // keeps its lease and can safely save its reply to the original ID.
    yield* sql`UPDATE agent_conversations SET archived_at=now() WHERE account_id=${scope.accountId}
      AND business_id IS NOT DISTINCT FROM ${scope.businessId}::uuid AND user_id=${scope.userId} AND archived_at IS NULL`
    yield* sql`INSERT INTO agent_conversations(id,account_id,business_id,user_id) VALUES(${id},${scope.accountId},${scope.businessId},${scope.userId})`
    return { id, messages: [], revision: 0 }
  }))
})
export const deleteConversation = (scope: ConversationScope, conversationId?: string) => Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  // Delete also fences an in-flight response: its lease cannot recreate the row.
  yield* sql`DELETE FROM agent_conversations WHERE account_id = ${scope.accountId} AND business_id IS NOT DISTINCT FROM ${scope.businessId}::uuid AND user_id = ${scope.userId}
    AND (${conversationId ?? null}::uuid IS NOT NULL AND id=${conversationId ?? null}::uuid
      OR ${conversationId ?? null}::uuid IS NULL AND archived_at IS NULL)`
})
/** A turn responder: the production agent, or a fixture in tests. Outcome and
 * gaps come from the run loop; the journal records the run as it happens. */
type Responder = (accountId: string, userId: string, businessId: string | null, message: string, history: AgentHistory, selection: HarnessSelection | undefined,
  assertActive: Effect.Effect<void, AgentModelError, SqlClient.SqlClient>, journal: RunJournal) => Effect.Effect<{
    readonly reply: string; readonly citations: ReadonlyArray<unknown>; readonly toolCalls: ReadonlyArray<unknown>; readonly usage: ReadonlyArray<unknown>
    readonly provider: string; readonly requestedModel: string; readonly outcome?: RunOutcome | undefined; readonly gaps?: ReadonlyArray<string> | undefined
  }, unknown, Effect.Effect.Context<ReturnType<typeof handleAgentMessage>>>
export const sendConversation = (scope: ConversationScope, body: {
  readonly message: string; readonly requestId: string; readonly conversationId?: string | undefined; readonly revision: number; readonly selection?: HarnessSelection | undefined
}, respond: Responder = handleAgentMessage) => Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const lease = randomUUID()
  const digest = createHash("sha256").update(JSON.stringify({ message:body.message, selection:body.selection ?? null })).digest("hex")
  const conversation = yield* sql.withTransaction(Effect.gen(function*() {
    yield* sql`DELETE FROM agent_conversations WHERE account_id = ${scope.accountId} AND user_id = ${scope.userId} AND expires_at <= now()`
    // All identity comes from the session and trusted route, never model input.
    yield* sql`INSERT INTO agent_conversations(account_id,business_id,user_id)
      SELECT ${scope.accountId}, ${scope.businessId}::uuid, ${scope.userId} FROM account_users au
      WHERE au.account_id=${scope.accountId} AND au.user_id=${scope.userId} AND ${body.conversationId === undefined}
      AND (${scope.businessId}::uuid IS NULL OR EXISTS(SELECT 1 FROM businesses WHERE id=${scope.businessId} AND account_id=${scope.accountId}))
      ON CONFLICT(account_id,business_id,user_id) WHERE archived_at IS NULL DO NOTHING`
    const select = sql`SELECT id, messages, revision, last_request_id, last_reply,last_request_digest,
      (lease_until > now()) AS busy FROM agent_conversations
      WHERE account_id = ${scope.accountId} AND business_id IS NOT DISTINCT FROM ${scope.businessId}::uuid AND user_id = ${scope.userId}
      AND (${body.conversationId ?? null}::uuid IS NOT NULL AND id=${body.conversationId ?? null}::uuid
        OR ${body.conversationId ?? null}::uuid IS NULL AND archived_at IS NULL) FOR UPDATE`
    const locked = (yield* select)[0]
    if (!locked) return yield* Effect.fail(new AgentConversationRefused({ reason: "NOT_FOUND" }))
    const seenRevision = Number(locked["revision"])
    // A run that stopped earlier becomes its interruption note first. The
    // client's revision predates that note, so it still counts as current.
    const settled = locked["busy"] === true ? 0 : yield* settleRuns(String(locked["id"]))
    const row = settled ? (yield* select)[0]! : locked
    const current = yield* parse(row)
    if (body.conversationId && current.id !== body.conversationId) return yield* Effect.fail(new AgentConversationRefused({ reason: "NOT_FOUND" }))
    if (row["last_request_id"] === body.requestId && row["last_reply"]) {
      if ((row["last_request_digest"] && row["last_request_digest"] !== digest) || (!row["last_request_digest"] && body.selection)) return yield* Effect.fail(new AgentConversationRefused({ reason:"STALE" }))
      return { kind: "replay" as const, reply: row["last_reply"] }
    }
    if (row["busy"] === true) return yield* Effect.fail(new AgentConversationRefused({ reason: "BUSY" }))
    if (body.revision !== current.revision && body.revision !== seenRevision) return yield* Effect.fail(new AgentConversationRefused({ reason: "STALE" }))
    yield* sql`UPDATE agent_conversations SET lease_id = ${lease}, lease_until = now() + interval '600 seconds' WHERE id = ${current.id}`
    return { kind: "reserved" as const, current }
  }))
  if (conversation.kind === "replay") return conversation.reply
  const { current } = conversation
  const history: AgentHistory = current.messages
  const workflow = agentWorkflow(scope.businessId, body.message)
  const { runId, journal } = yield* startRun(scope, { conversationId: current.id, leaseId: lease, requestId: body.requestId, objective: body.message,
    workflow: workflow ? { id: workflow.id, version: workflow.version } : null, budget: workflow?.budget ?? DEFAULT_RUN_BUDGET })
  // Stopped runs are recorded and settled into the conversation before the
  // lease is released, so the next reader sees what was saved and what was not.
  const stop = (status: "FAILED" | "CANCELLED" | "INTERRUPTED", reason: string) => sql.withTransaction(Effect.gen(function*() {
    yield* finishRun(runId, status, { reason })
    yield* sql`SELECT id FROM agent_conversations WHERE id = ${current.id} FOR UPDATE`
    yield* settleRuns(current.id)
  })).pipe(Effect.orDie)
  return yield* Effect.gen(function*() {
    const assertActive = Effect.gen(function*() {
      const active = yield* sql`SELECT id FROM agent_conversations WHERE id=${current.id} AND lease_id=${lease} AND lease_until>now()`
      if (!active.length) return yield* Effect.fail(new AgentModelError({ reason:"CANCELLED" }))
    }).pipe(Effect.mapError(e => e instanceof AgentModelError ? e : new AgentModelError({ reason:"UNAVAILABLE" })))
    const reply = yield* respond(scope.accountId, scope.userId, scope.businessId, body.message, history, body.selection, assertActive, journal)
    const run = { id: runId, status: "COMPLETED" as const, outcome: reply.outcome ?? "ANSWERED", gaps: reply.gaps ?? [] }
    const messages = [...current.messages, { role: "user", text: body.message }, { role: "agent", text: reply.reply, citations: reply.citations, toolCalls: reply.toolCalls, run, inference: { provider: reply.provider, requestedModel: reply.requestedModel, usage: reply.usage, ...(body.selection ? { instanceId:body.selection.instanceId, ...(body.selection.reasoningEffort ? { reasoningEffort:body.selection.reasoningEffort } : {}) } : {}) } }].slice(-200)
    const response = { ...reply, outcome: run.outcome, gaps: run.gaps, runId, conversationId: current.id, revision: current.revision + 1 }
    const updated = yield* sql.withTransaction(Effect.gen(function*() {
      const rows = yield* sql`UPDATE agent_conversations SET messages = ${JSON.stringify(messages)}::jsonb, revision = revision + 1,
      last_request_id = ${body.requestId}, last_request_digest=${digest}, last_reply = ${JSON.stringify(response)}::jsonb, lease_id = NULL, lease_until = NULL,
      updated_at = now(), expires_at = now() + interval '30 days'
      WHERE id = ${current.id} AND lease_id = ${lease} AND lease_until > now()
        AND (${body.selection === undefined} OR EXISTS(SELECT 1 FROM agent_harness_instances i JOIN agent_bridges b ON b.id=i.bridge_id
          WHERE i.id=${body.selection?.instanceId ?? null} AND i.account_id=${scope.accountId} AND i.user_id=${scope.userId} AND i.enabled AND b.revoked_at IS NULL))
      RETURNING id`
      // The reply and the run's completion commit together.
      if (rows.length) yield* finishRun(runId, "COMPLETED", { outcome: run.outcome, gaps: run.gaps })
      return rows.length > 0
    }))
    if (!updated) {
      // The lease was revoked (stop or delete) after the answer was produced.
      yield* stop("CANCELLED", "CANCELLED")
      return yield* Effect.fail(new AgentConversationRefused({ reason: "STALE" }))
    }
    return response
  }).pipe(
    Effect.onExit(exit => exit._tag === "Success" ? Effect.void : Effect.gen(function*() {
      const failure = exit.cause._tag === "Fail" ? exit.cause.error : null
      if (failure instanceof AgentConversationRefused) return
      if (failure instanceof AgentModelError) return yield* stop(failure.reason === "CANCELLED" ? "CANCELLED" : "FAILED", failure.reason)
      yield* stop(Cause.isInterruptedOnly(exit.cause) ? "INTERRUPTED" : "FAILED", Cause.isInterruptedOnly(exit.cause) ? "INTERRUPTED" : "UNAVAILABLE")
    })),
    Effect.ensuring(sql`UPDATE agent_conversations SET lease_id = NULL, lease_until = NULL WHERE id = ${current.id} AND lease_id = ${lease}`.pipe(Effect.orDie)))
})
