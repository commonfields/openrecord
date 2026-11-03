// Decision feedback: the person's verdict on the agent's work and the reason,
// kept so the agent learns what this business accepts and rejects, plus the
// outcome note the agent records once enough time has passed to measure.
//
//   POST /api/businesses/:id/decision-feedback   record a verdict (and reason) after a decision
//
// Agent tools:
//   read_decision_feedback   past verdicts and reasons, newest first; approved work due an outcome note
//   record_outcome_note      a measured note on approved work, after N days (no claim of cause)
import { SqlClient } from "@effect/sql"
import { HttpRouter } from "@effect/platform"
import { Effect, JSONSchema, Schema } from "effect"
import { BusinessRepository, type Session } from "@openrecord/db"
import { AgentNotInScope } from "./agent-tool-errors.js"
import type { AgentToolResult } from "./agent-tools.js"
import type { ToolContext, ToolDeclaration } from "./agent-registry.js"
import { decode, json, operatorSessionFor, readJson, type WithSession } from "./record-routes.js"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const Kind = Schema.Literal("AGENT_PROPOSAL", "AGENT_DRAFT", "GROWTH_OPPORTUNITY", "WORDPRESS_CHANGE")
const Feedback = Schema.Struct({
  kind: Kind, itemId: Schema.UUID, verdict: Schema.Literal("APPROVED", "REJECTED"),
  title: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(300)),
  reason: Schema.optional(Schema.String.pipe(Schema.maxLength(500))),
})

export const decisionFeedbackApi = (withSession: WithSession) => {
  const operator = operatorSessionFor(withSession)
  return HttpRouter.empty.pipe(
    HttpRouter.post("/api/businesses/:id/decision-feedback", operator((s: Session) => Effect.gen(function*() {
      const { params } = yield* HttpRouter.RouteContext
      const businessId = params["id"] ?? ""
      if (!UUID.test(businessId)) return yield* json(422, { _tag: "InvalidRequest" })
      if (!(yield* (yield* BusinessRepository).getScoped(s.accountId, businessId))) return yield* json(404, { _tag: "BusinessNotFound" })
      const body = decode(Feedback, yield* readJson)
      if (!body) return yield* json(422, { _tag: "InvalidRequest" })
      const reason = body.reason?.trim() || null
      const sql = yield* SqlClient.SqlClient
      yield* sql`INSERT INTO decision_feedback(account_id, business_id, kind, item_id, verdict, title, reason, decided_by_user_id)
        VALUES (${s.accountId}, ${businessId}, ${body.kind}, ${body.itemId}, ${body.verdict}, ${body.title.trim()}, ${reason}, ${s.userId})
        ON CONFLICT (business_id, kind, item_id) DO UPDATE SET verdict = EXCLUDED.verdict, title = EXCLUDED.title, reason = COALESCE(EXCLUDED.reason, decision_feedback.reason),
          decided_by_user_id = EXCLUDED.decided_by_user_id, decided_at = now()`
      return yield* json(200, { recorded: true })
    })).pipe(Effect.catchAll(e => json(typeof e === "object" && e !== null && "_tag" in e && e._tag === "NotAuthenticated" ? 401 : 500, { _tag: "FeedbackUnavailable" })))),
  )
}

const scoped = (ctx: ToolContext) => Effect.gen(function*() {
  if (!(yield* (yield* BusinessRepository).getScoped(ctx.accountId, ctx.businessId))) return yield* Effect.fail(new AgentNotInScope())
})
const ReadInput = Schema.Struct({ limit: Schema.optional(Schema.Int.pipe(Schema.between(1, 50))), dueAfterDays: Schema.optional(Schema.Int.pipe(Schema.between(7, 180))) })
const NoteInput = Schema.Struct({ feedbackId: Schema.UUID, note: Schema.String.pipe(Schema.minLength(10), Schema.maxLength(1000)) })

const read = (ctx: ToolContext, args: typeof ReadInput.Type) => Effect.gen(function*() {
  yield* scoped(ctx)
  const sql = yield* SqlClient.SqlClient
  const due = args.dueAfterDays ?? 30
  const rows = yield* sql`SELECT id, kind, verdict, title, reason, decided_at, outcome_note, outcome_at,
      (verdict = 'APPROVED' AND outcome_note IS NULL AND decided_at <= now() - make_interval(days => ${due})) AS outcome_due
    FROM decision_feedback WHERE business_id = ${ctx.businessId} ORDER BY decided_at DESC LIMIT ${args.limit ?? 20}`
  const items = rows.map(r => ({ feedbackId: String(r["id"]), kind: String(r["kind"]), verdict: String(r["verdict"]), title: String(r["title"]), reason: (r["reason"] as string | null) ?? null,
    decidedAt: new Date(r["decided_at"] as string).toISOString(), outcomeNote: (r["outcome_note"] as string | null) ?? null, outcomeDue: r["outcome_due"] === true }))
  const rejected = items.filter(i => i.verdict === "REJECTED")
  return { summary: items.length ? `${items.length} past decisions: ${items.length - rejected.length} approved, ${rejected.length} rejected; ${items.filter(i => i.outcomeDue).length} approved items due an outcome note` : "No decisions recorded yet",
    citations: [], data: { items, note: "The owner's verdicts and reasons. Do not re-propose a rejected idea unless something material changed, and say what changed. Weigh stated reasons as preferences for future proposals. For approved work due an outcome note, measure what changed since the decision (search, AI answers, traffic, revenue) and record it with record_outcome_note: describe the change and competing explanations, never claim the work caused it." } } satisfies AgentToolResult
})

const note = (ctx: ToolContext, args: typeof NoteInput.Type) => Effect.gen(function*() {
  yield* scoped(ctx)
  const sql = yield* SqlClient.SqlClient
  const done = yield* sql`UPDATE decision_feedback SET outcome_note = ${args.note.trim()}, outcome_at = now() WHERE id = ${args.feedbackId} AND business_id = ${ctx.businessId} AND verdict = 'APPROVED' RETURNING title`
  if (!done.length) return { summary: "No approved decision with that id for this business", citations: [], data: { status: "NOT_FOUND" } } satisfies AgentToolResult
  return { summary: `Outcome noted for “${String(done[0]!["title"])}”`, citations: [], data: { status: "RECORDED" } } satisfies AgentToolResult
})

export const decisionFeedbackDeclarations: ReadonlyArray<ToolDeclaration> = [
  { name: "read_decision_feedback", description: "The owner's past decisions on your proposals, drafts, initiatives and website changes: approved or rejected, the reason they gave, and which approved items are due an outcome note. Read it before proposing work so you don't repeat rejected ideas. Read-only.", parametersJsonSchema: JSONSchema.make(ReadInput) },
  { name: "record_outcome_note", description: "Save a short, measured note on what happened after approved work (by feedbackId from read_decision_feedback): what changed in the numbers since the decision, with dates and sources, and competing explanations. Never claim the work caused the change.", parametersJsonSchema: JSONSchema.make(NoteInput) },
]
export const dispatchDecisionFeedback = (ctx: ToolContext, name: string, raw: unknown) => Effect.gen(function*() {
  if (name === "read_decision_feedback") return yield* read(ctx, yield* Schema.decodeUnknown(ReadInput, { onExcessProperty: "error" })(raw))
  return yield* note(ctx, yield* Schema.decodeUnknown(NoteInput, { onExcessProperty: "error" })(raw))
})
