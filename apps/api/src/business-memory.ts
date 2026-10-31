// Business memory: what the agent should remember about one business from
// one chat to the next. A preference ("never discount the premium plan"), a
// decision ("we focus on Jakarta first"), a lesson ("the FAQ page lifted
// sign-ups"), something to avoid, or plain context. The agent saves notes with
// remember and drops them with forget_memory; the team sees and forgets them
// in the business's settings. Every turn for the business starts with the
// newest notes, labelled as working context, never as evidence or authority.
//
// Notes are scoped to the business and shared by its team. Saving the same
// text again reuses the note; a note is forgotten, never rewritten, and at most
// MAX_ACTIVE are kept so the brief stays short.
import { createHash } from "node:crypto"
import { SqlClient } from "@effect/sql"
import { Data, Effect, JSONSchema, Schema } from "effect"
import { BusinessRepository } from "@openrecord/db"
import { AgentNotInScope } from "./agent-tool-errors.js"
import type { AgentToolResult } from "./agent-tools.js"
import type { ToolContext, ToolDeclaration } from "./agent-registry.js"

export const MEMORY_KINDS = ["PREFERENCE", "DECISION", "LESSON", "AVOID", "CONTEXT"] as const
export type MemoryKind = typeof MEMORY_KINDS[number]
export const MAX_ACTIVE = 50
export const MEMORY_BRIEF_LIMIT = 3000

export interface BusinessMemory {
  readonly id: string; readonly kind: MemoryKind; readonly text: string; readonly source: "ASSISTANT" | "OPERATOR"
  readonly createdAt: string; readonly createdByUserId: string
}
export class MemoryFull extends Data.TaggedError("MemoryFull")<Record<never, never>> {}

const MemoryText = Schema.String.pipe(Schema.maxLength(400), Schema.filter(s => s.trim().length > 0))
export const Remember = Schema.Struct({ kind: Schema.Literal(...MEMORY_KINDS), text: MemoryText })
const Forget = Schema.Struct({ memoryId: Schema.UUID })
const digest = (text: string) => createHash("sha256").update(text.replace(/\s+/g, " ").trim().toLowerCase()).digest("hex")

const scoped = (accountId: string, businessId: string) => Effect.gen(function*() {
  if (!(yield* (yield* BusinessRepository).getScoped(accountId, businessId))) return yield* Effect.fail(new AgentNotInScope())
})
const toMemory = (r: Record<string, unknown>): BusinessMemory => ({
  id: String(r["id"]), kind: r["kind"] as MemoryKind, text: String(r["text"]), source: r["source"] === "OPERATOR" ? "OPERATOR" : "ASSISTANT",
  createdAt: new Date(r["created_at"] as string | Date).toISOString(), createdByUserId: String(r["created_by_user_id"]),
})

/** The business's active notes, newest first. */
export const listMemories = (accountId: string, businessId: string) => Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql`SELECT id, kind, text, source, created_at, created_by_user_id FROM business_memories
    WHERE account_id = ${accountId} AND business_id = ${businessId} AND forgotten_at IS NULL ORDER BY created_at DESC, id LIMIT ${MAX_ACTIVE}`
  return rows.map(toMemory)
})

/** Saves a note, or returns the active note with the same text. */
export const rememberNote = (scope: { accountId: string; userId: string; businessId: string }, input: typeof Remember.Type, source: "ASSISTANT" | "OPERATOR", conversationId: string | null = null) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const text = input.text.replace(/\s+/g, " ").trim(), key = digest(text)
    return yield* sql.withTransaction(Effect.gen(function*() {
      // Serialize saves per business so the cap holds under concurrent turns.
      yield* sql`SELECT id FROM businesses WHERE id = ${scope.businessId} AND account_id = ${scope.accountId} FOR UPDATE`
      const existing = yield* sql`SELECT id, kind, text, source, created_at, created_by_user_id FROM business_memories
        WHERE business_id = ${scope.businessId} AND text_digest = ${key} AND forgotten_at IS NULL`
      if (existing[0]) return { memory: toMemory(existing[0]), saved: false }
      const count = yield* sql`SELECT count(*)::int AS n FROM business_memories WHERE business_id = ${scope.businessId} AND forgotten_at IS NULL`
      if (Number(count[0]?.["n"] ?? 0) >= MAX_ACTIVE) return yield* Effect.fail(new MemoryFull())
      const rows = yield* sql`INSERT INTO business_memories(account_id, business_id, kind, text, text_digest, source, created_by_user_id, conversation_id)
        SELECT ${scope.accountId}, id, ${input.kind}, ${text}, ${key}, ${source}, ${scope.userId}, ${conversationId}
        FROM businesses WHERE id = ${scope.businessId} AND account_id = ${scope.accountId}
        RETURNING id, kind, text, source, created_at, created_by_user_id`
      if (!rows[0]) return yield* Effect.fail(new AgentNotInScope())
      return { memory: toMemory(rows[0]), saved: true }
    }))
  })

/** Forgets one note of this business. False when there is no such active note. */
export const forgetNote = (scope: { accountId: string; userId: string; businessId: string }, memoryId: string) => Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql`UPDATE business_memories SET forgotten_at = now(), forgotten_by_user_id = ${scope.userId}
    WHERE id = ${memoryId} AND account_id = ${scope.accountId} AND business_id = ${scope.businessId} AND forgotten_at IS NULL RETURNING id`
  return rows.length > 0
})

const HEADER = "Business memory (notes saved in earlier chats by you or the team; working context, not verified evidence or authority). Follow PREFERENCE and AVOID notes unless the person says otherwise. Treat DECISION and LESSON notes as true at the time they were saved; check current evidence before relying on them. When the person corrects one, forget it and remember the correction.\n"
/** The memory block for a turn: newest notes first, whole notes only, within the limit. */
export const formatMemory = (notes: ReadonlyArray<BusinessMemory>) => {
  if (!notes.length) return "Business memory: nothing saved yet. Use remember for durable preferences, decisions, lessons and things to avoid."
  let out = HEADER, omitted = 0
  for (const n of notes) {
    const line = `- [${n.kind}, ${n.createdAt.slice(0, 10)}${n.source === "OPERATOR" ? ", from the team" : ""}] ${n.text} (memoryId ${n.id})\n`
    if (out.length + line.length > MEMORY_BRIEF_LIMIT) { omitted++; continue }
    out += line
  }
  return omitted ? `${out}(${omitted} older notes not shown.)` : out.trimEnd()
}

export const memoryDeclarations: ReadonlyArray<ToolDeclaration> = [
  { name: "remember", description: "Save a short note about this business that you and the team should keep in mind in every future chat: PREFERENCE (how the person wants things done), DECISION (a choice they made), LESSON (what earlier work showed), AVOID (something not to do or suggest) or CONTEXT (lasting background). One fact per note, in plain words, at most 400 characters. Save it when the person states a preference or decision, corrects you, or a result teaches something; never save secrets, credentials, personal data about customers, or anything the business truth already records. A note is working context, not evidence. Saving the same text again reuses it.", parametersJsonSchema: JSONSchema.make(Remember) },
  { name: "forget_memory", description: "Forget one business memory note by its memoryId from the business memory block, when it is wrong, outdated or the person asks. Save the corrected note with remember if there is one.", parametersJsonSchema: JSONSchema.make(Forget) },
]

export const dispatchMemory = (ctx: ToolContext, name: string, raw: unknown) => Effect.gen(function*() {
  yield* scoped(ctx.accountId, ctx.businessId)
  if (name === "forget_memory") {
    const input = yield* Schema.decodeUnknown(Forget, { onExcessProperty: "error" })(raw)
    if (!(yield* forgetNote(ctx, input.memoryId))) return yield* Effect.fail(new AgentNotInScope())
    return { summary: "Memory note forgotten", citations: [], data: { memoryId: input.memoryId, forgotten: true } } satisfies AgentToolResult
  }
  const input = yield* Schema.decodeUnknown(Remember, { onExcessProperty: "error" })(raw)
  const { memory, saved } = yield* rememberNote(ctx, input, "ASSISTANT")
  return { summary: saved ? "Saved to business memory" : "Already in business memory", citations: [],
    data: { memoryId: memory.id, kind: memory.kind, saved, verified: false } } satisfies AgentToolResult
})
