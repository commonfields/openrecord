// What the agent tells OpenRecord about OpenRecord's own capabilities:
//
//   MISSING       it needed something no registered tool or research capability
//                 does (recorded by itself when a search finds nothing, or by the agent), so the team sees what to add next;
//   POOR_RESULT   a tool or research capability returned something wrong, empty,
//                 stale or beside the point, which ranks it
//                 lower in this workspace's searches.
//
// Signals are notes about tools, never business evidence, and grant nothing.
//
//   GET /api/businesses/:id/capability-signals   recent requests and reports, grouped
import { SqlClient } from "@effect/sql"
import { HttpRouter } from "@effect/platform"
import { Effect, JSONSchema, Schema } from "effect"
import { BusinessRepository, type Session } from "@openrecord/db"
import { AgentInvalidInput, type AgentToolResult } from "./agent-tools.js"
import { AgentNotInScope } from "./agent-tool-errors.js"
import type { ToolContext, ToolDeclaration } from "./agent-registry.js"
import { json, operatorSessionFor, type WithSession } from "./record-routes.js"

// One small tool: the general turn declares every card, so each byte counts.
const FeedbackInput = Schema.Struct({
  // Lengths are checked below rather than in the schema, to keep the card small.
  kind: Schema.Literal("MISSING", "WRONG", "EMPTY", "STALE", "OFF_TOPIC"),
  tool: Schema.optional(Schema.String),
  text: Schema.String,
})

export const TOOL_FEEDBACK = "tool_feedback"
export const capabilitySignalDeclarations: ReadonlyArray<ToolDeclaration> = [
  { name: TOOL_FEEDBACK, description: "Report a missing capability or poor tool result. kind MISSING: the task needs something no registered tool or research capability does; text says the need in task words and what it would have answered (saved as a request for the team, it does not add the capability; carry on and say plainly what is missing). kind WRONG (contradicts better evidence), EMPTY (nothing where data should be), STALE (out of date), OFF_TOPIC (beside the question): a tool or research capability you called here returned that; tool is its name or research capability id, text says what you checked. It lowers that tool in this workspace's searches and never changes the evidence.",
    parametersJsonSchema: JSONSchema.make(FeedbackInput) },
]

const clean = (s: string | undefined) => s?.replace(/\s+/g, " ").trim() || null

/** Saves a need nothing could meet. Never fails the caller's work. */
export const recordMissingCapability = (ctx: { readonly accountId: string; readonly businessId: string }, need: string, source: "SEARCH_MISS" | "AGENT", note?: string) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const text = clean(need)?.slice(0, 300)
    if (!text || text.length < 2) return
    // A search that misses again with the same words today is the same request.
    yield* sql`INSERT INTO agent_capability_signals(account_id, business_id, kind, need, note, source)
      SELECT ${ctx.accountId}, ${ctx.businessId}, 'MISSING', ${text}, ${clean(note)}, ${source}
      WHERE NOT EXISTS (SELECT 1 FROM agent_capability_signals WHERE business_id=${ctx.businessId} AND kind='MISSING'
        AND lower(need)=lower(${text}) AND created_at > now() - interval '1 day')`
  }).pipe(Effect.catchAllCause(() => Effect.void))

export const dispatchCapabilitySignal = (ctx: ToolContext, _name: string, raw: unknown) => Effect.gen(function*() {
  if (!(yield* (yield* BusinessRepository).getScoped(ctx.accountId, ctx.businessId))) return yield* Effect.fail(new AgentNotInScope())
  const input = yield* Schema.decodeUnknown(FeedbackInput, { onExcessProperty: "error" })(raw)
  if (input.text.length > 500) return yield* Effect.fail(new AgentInvalidInput({ tool: TOOL_FEEDBACK }))
  if (input.kind === "MISSING") {
    if ((clean(input.text) ?? "").length < 2) return yield* Effect.fail(new AgentInvalidInput({ tool: TOOL_FEEDBACK }))
    yield* recordMissingCapability(ctx, input.text, "AGENT")
    return { summary: "Saved as a capability request for the team", citations: [],
      data: { saved: true, note: "This does not add the capability. Answer with what you have and say plainly what OpenRecord cannot do yet." } } satisfies AgentToolResult
  }
  const tool = input.tool?.trim() ?? ""
  if (!/^[a-z][a-z0-9_.-]{1,119}$/.test(tool)) return yield* Effect.fail(new AgentInvalidInput({ tool: TOOL_FEEDBACK }))
  const sql = yield* SqlClient.SqlClient
  // A retried or repeated report of the same problem within the hour counts once.
  yield* sql`INSERT INTO agent_capability_signals(account_id, business_id, kind, tool, problem, need, note, source)
    SELECT ${ctx.accountId}, ${ctx.businessId}, 'POOR_RESULT', ${tool}, ${input.kind}, ${`Result of ${tool}`}, ${clean(input.text)}, 'AGENT'
    WHERE NOT EXISTS (SELECT 1 FROM agent_capability_signals WHERE business_id=${ctx.businessId} AND kind='POOR_RESULT'
      AND tool=${tool} AND problem=${input.kind} AND created_at > now() - interval '1 hour')`
  return { summary: `Reported ${input.kind.toLowerCase()} result from ${tool}`, citations: [],
    data: { saved: true, note: "The tool ranks lower in this workspace's searches. The evidence it returned is unchanged; say in your answer what was wrong with it." } } satisfies AgentToolResult
})

/** Reported problems per tool in this account over the last `days` days. */
export const reportedProblems = (accountId: string, tools: ReadonlyArray<string>, days = 30) => Effect.gen(function*() {
  if (!tools.length) return new Map<string, number>()
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql`SELECT tool, count(*)::int AS n FROM agent_capability_signals
    WHERE account_id=${accountId} AND kind='POOR_RESULT' AND tool IN ${sql.in([...tools])} AND created_at > now() - make_interval(days => ${days}) GROUP BY tool`
  return new Map(rows.map(r => [String(r["tool"]), Number(r["n"])]))
})

/** What the team sees: needs nothing met, most asked first, and tools reported for poor results. */
export const capabilitySignalsApi = (withSession: WithSession) => {
  const operator = operatorSessionFor(withSession)
  return HttpRouter.empty.pipe(
    HttpRouter.get("/api/businesses/:id/capability-signals", operator((s: Session) => Effect.gen(function*() {
      const { params } = yield* HttpRouter.RouteContext
      const businessId = params["id"] ?? ""
      if (!/^[0-9a-f-]{36}$/i.test(businessId)) return yield* json(422, { _tag: "InvalidRequest" })
      if (!(yield* (yield* BusinessRepository).getScoped(s.accountId, businessId))) return yield* json(404, { _tag: "BusinessNotFound" })
      const sql = yield* SqlClient.SqlClient
      const missing = yield* sql`SELECT lower(need) AS need, count(*)::int AS times, max(created_at) AS last_at,
          bool_or(source='AGENT') AS asked, (array_agg(note ORDER BY created_at DESC) FILTER (WHERE note IS NOT NULL))[1] AS note
        FROM agent_capability_signals WHERE business_id=${businessId} AND kind='MISSING' AND created_at > now() - interval '90 days'
        GROUP BY lower(need) ORDER BY times DESC, last_at DESC LIMIT 50`
      const poor = yield* sql`SELECT tool, problem, count(*)::int AS times, max(created_at) AS last_at
        FROM agent_capability_signals WHERE business_id=${businessId} AND kind='POOR_RESULT' AND created_at > now() - interval '90 days'
        GROUP BY tool, problem ORDER BY times DESC, last_at DESC LIMIT 50`
      return yield* json(200, {
        missing: missing.map(r => ({ need: String(r["need"]), times: Number(r["times"]), lastAt: new Date(r["last_at"] as string).toISOString(),
          askedByAgent: r["asked"] === true, note: (r["note"] as string | null) ?? null })),
        poorResults: poor.map(r => ({ tool: String(r["tool"]), problem: String(r["problem"]), times: Number(r["times"]), lastAt: new Date(r["last_at"] as string).toISOString() })),
      }, { "cache-control": "no-store" })
    })).pipe(Effect.catchAll(e => json(typeof e === "object" && e !== null && "_tag" in e && e._tag === "NotAuthenticated" ? 401 : 500, { _tag: "CapabilitySignalsUnavailable" })))),
  )
}
