import { randomUUID } from "node:crypto"
import { SqlClient } from "@effect/sql"
import { Data, Effect, Schema } from "effect"
import { handleAgentMessage, type AgentHistory } from "./agent.js"

export class AgentConversationRefused extends Data.TaggedError("AgentConversationRefused")<{
  readonly reason: "NOT_FOUND" | "BUSY" | "STALE"
}> {}
const Citation = Schema.Struct({ kind: Schema.String, id: Schema.String, text: Schema.String })
const Usage = Schema.Struct({ observedModel: Schema.NullOr(Schema.String), promptTokens: Schema.NullOr(Schema.Number), outputTokens: Schema.NullOr(Schema.Number), thoughtTokens: Schema.NullOr(Schema.Number), totalTokens: Schema.NullOr(Schema.Number) })
const Message = Schema.Struct({ role: Schema.Literal("user", "agent"), text: Schema.String, citations: Schema.optional(Schema.Array(Citation)), toolCalls: Schema.optional(Schema.Array(Schema.Struct({ tool: Schema.String, summary: Schema.String }))), inference: Schema.optional(Schema.Struct({ provider: Schema.String, requestedModel: Schema.String, usage: Schema.Array(Usage) })) })
const Conversation = Schema.Struct({ id: Schema.UUID, messages: Schema.Array(Message), revision: Schema.Number })
const parse = Schema.decodeUnknown(Conversation)
export type ConversationScope = { readonly accountId: string; readonly userId: string; readonly businessId: string }
export const loadConversation = (scope: ConversationScope) => Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql`SELECT id, messages, revision FROM agent_conversations WHERE account_id = ${scope.accountId}
    AND business_id = ${scope.businessId} AND user_id = ${scope.userId} AND expires_at > now()`
  return rows[0] ? yield* parse(rows[0]) : null
})
// The signed-in user's saved conversations in this account, newest first, for
// the chat history. Titled by the first question asked; empty ones are skipped.
export type ConversationSummary = {
  readonly businessId: string; readonly businessName: string; readonly isClient: boolean
  readonly title: string; readonly messages: number; readonly updatedAt: string
}
export const listConversations = (scope: { readonly accountId: string; readonly userId: string }) => Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql`SELECT c.business_id, b.name, (rp.business_id IS NOT NULL) AS is_client, c.updated_at,
      jsonb_array_length(c.messages) AS message_count,
      (SELECT m->>'text' FROM jsonb_array_elements(c.messages) WITH ORDINALITY AS e(m, i) WHERE m->>'role' = 'user' ORDER BY i LIMIT 1) AS first_message
    FROM agent_conversations c
    JOIN businesses b ON b.id = c.business_id AND b.account_id = c.account_id
    JOIN account_users au ON au.account_id = c.account_id AND au.user_id = c.user_id
    LEFT JOIN record_profiles rp ON rp.business_id = c.business_id
    WHERE c.account_id = ${scope.accountId} AND c.user_id = ${scope.userId}
      AND c.expires_at > now() AND jsonb_array_length(c.messages) > 0
    ORDER BY c.updated_at DESC LIMIT 30`
  return rows.map((r): ConversationSummary => ({
    businessId: String(r["business_id"]), businessName: String(r["name"]), isClient: r["is_client"] === true,
    title: String(r["first_message"] ?? "").replace(/\s+/g, " ").trim().slice(0, 120),
    messages: Number(r["message_count"]), updatedAt: new Date(r["updated_at"] as string | Date).toISOString(),
  }))
})
export const deleteConversation = (scope: ConversationScope) => Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  // Delete also fences an in-flight response: its lease cannot recreate the row.
  yield* sql`DELETE FROM agent_conversations WHERE account_id = ${scope.accountId} AND business_id = ${scope.businessId} AND user_id = ${scope.userId}`
})
export const sendConversation = (scope: ConversationScope, body: {
  readonly message: string; readonly requestId: string; readonly conversationId?: string | undefined; readonly revision: number
}, respond = handleAgentMessage) => Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const lease = randomUUID()
  const conversation = yield* sql.withTransaction(Effect.gen(function*() {
    yield* sql`DELETE FROM agent_conversations WHERE account_id = ${scope.accountId} AND user_id = ${scope.userId} AND expires_at <= now()`
    // All identity comes from the session and trusted route, never model input.
    yield* sql`INSERT INTO agent_conversations(account_id,business_id,user_id)
      SELECT ${scope.accountId}, b.id, ${scope.userId} FROM businesses b
      JOIN account_users au ON au.account_id = b.account_id AND au.user_id = ${scope.userId}
      WHERE b.id = ${scope.businessId} AND b.account_id = ${scope.accountId}
      ON CONFLICT(account_id,business_id,user_id) DO NOTHING`
    const rows = yield* sql`SELECT id, messages, revision, last_request_id, last_reply,
      (lease_until > now()) AS busy FROM agent_conversations
      WHERE account_id = ${scope.accountId} AND business_id = ${scope.businessId} AND user_id = ${scope.userId} FOR UPDATE`
    const row = rows[0]
    if (!row) return yield* Effect.fail(new AgentConversationRefused({ reason: "NOT_FOUND" }))
    const current = yield* parse(row)
    if (body.conversationId && current.id !== body.conversationId) return yield* Effect.fail(new AgentConversationRefused({ reason: "NOT_FOUND" }))
    if (row["last_request_id"] === body.requestId && row["last_reply"]) return { kind: "replay" as const, reply: row["last_reply"] }
    if (row["busy"] === true) return yield* Effect.fail(new AgentConversationRefused({ reason: "BUSY" }))
    if (body.revision !== current.revision) return yield* Effect.fail(new AgentConversationRefused({ reason: "STALE" }))
    yield* sql`UPDATE agent_conversations SET lease_id = ${lease}, lease_until = now() + interval '120 seconds' WHERE id = ${current.id}`
    return { kind: "reserved" as const, current }
  }))
  if (conversation.kind === "replay") return conversation.reply
  const { current } = conversation
  const history: AgentHistory = current.messages
  return yield* Effect.gen(function*() {
    const reply = yield* respond(scope.accountId, scope.userId, scope.businessId, body.message, history)
    const messages = [...current.messages, { role: "user", text: body.message }, { role: "agent", text: reply.reply, citations: reply.citations, toolCalls: reply.toolCalls, inference: { provider: reply.provider, requestedModel: reply.requestedModel, usage: reply.usage } }].slice(-24)
    const response = { ...reply, conversationId: current.id, revision: current.revision + 1 }
    const updated = yield* sql`UPDATE agent_conversations SET messages = ${JSON.stringify(messages)}::jsonb, revision = revision + 1,
      last_request_id = ${body.requestId}, last_reply = ${JSON.stringify(response)}::jsonb, lease_id = NULL, lease_until = NULL,
      updated_at = now(), expires_at = now() + interval '30 days'
      WHERE id = ${current.id} AND lease_id = ${lease} AND lease_until > now() RETURNING id`
    if (!updated.length) return yield* Effect.fail(new AgentConversationRefused({ reason: "STALE" }))
    return response
  }).pipe(Effect.ensuring(sql`UPDATE agent_conversations SET lease_id = NULL, lease_until = NULL WHERE id = ${current.id} AND lease_id = ${lease}`.pipe(Effect.orDie)))
})
