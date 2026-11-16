// A business's marketing strategy, shared by every campaign: audience,
// positioning, offer, voice, phrases to avoid, priority bets and a budget
// limit. The agent proposes a version against the approved one; a person
// approves it in Needs you. The approved version is read into every business
// turn, so campaigns follow it without the owner explaining it again, and its
// phrases to avoid are checked on every campaign page before launch.
import { createHash } from "node:crypto"
import { HttpRouter } from "@effect/platform"
import { SqlClient } from "@effect/sql"
import { BusinessRepository, type Session } from "@openrecord/db"
import { decodeRouteId } from "@openrecord/contracts"
import { Data, Effect, JSONSchema, Schema } from "effect"
import { AgentNotInScope } from "./agent-tool-errors.js"
import type { ToolContext, ToolDeclaration } from "./agent-registry.js"
import { json, operatorSessionFor, type WithSession } from "./record-routes.js"

export class StrategyRefused extends Data.TaggedError("StrategyRefused")<{ readonly reason: string }> {}
const refuse = (reason: string) => Effect.fail(new StrategyRefused({ reason }))
const PRIVATE = { "cache-control": "no-store" }
const Text = (max: number) => Schema.String.pipe(Schema.maxLength(max))

const Propose = Schema.Struct({
  /** The approved version this is written against; null when none is approved yet. */
  basedOnVersion: Schema.NullOr(Schema.Int.pipe(Schema.positive())),
  audience: Text(1500), positioning: Text(1500), offer: Text(1500), voice: Text(1000),
  avoidPhrases: Schema.Array(Text(80)).pipe(Schema.maxItems(30)),
  priorityBets: Schema.Array(Text(300)).pipe(Schema.maxItems(10)),
  budgetLimit: Text(300),
  rationale: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(2000)),
})
const Empty = Schema.Struct({})

export interface Strategy {
  readonly id: string; readonly version: number; readonly status: string; readonly audience: string; readonly positioning: string; readonly offer: string
  readonly voice: string; readonly avoidPhrases: ReadonlyArray<string>; readonly priorityBets: ReadonlyArray<string>; readonly budgetLimit: string
  readonly rationale: string; readonly createdAt: string
}
const toStrategy = (r: Record<string, unknown>): Strategy => ({
  id: String(r["id"]), version: Number(r["version"]), status: String(r["status"]), audience: String(r["audience"]), positioning: String(r["positioning"]),
  offer: String(r["offer"]), voice: String(r["voice"]), avoidPhrases: (r["avoid_phrases"] as string[]) ?? [], priorityBets: (r["priority_bets"] as string[]) ?? [],
  budgetLimit: String(r["budget_limit"]), rationale: String(r["rationale"]), createdAt: new Date(r["created_at"] as string).toISOString(),
})

/** The approved version and the one waiting for a decision, if any. */
export const strategyOf = (businessId: string) => Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const rows = (yield* sql`SELECT * FROM marketing_strategy_versions WHERE business_id=${businessId} AND status IN ('APPROVED','PROPOSED')`).map(toStrategy)
  return { approved: rows.find(r => r.status === "APPROVED") ?? null, proposed: rows.find(r => r.status === "PROPOSED") ?? null }
})

/** The approved strategy as a short block for the turn's business context, or nothing. */
export const strategyContext = (s: Strategy | null): string => {
  if (!s) return ""
  const line = (label: string, value: string) => value.trim() ? `\n${label}: ${value.trim().replace(/\s+/g, " ").slice(0, 400)}` : ""
  return `Approved marketing strategy (version ${s.version}; follow it in every campaign and artifact unless the owner says otherwise):`
    + line("Audience", s.audience) + line("Positioning", s.positioning) + line("Offer", s.offer) + line("Voice", s.voice)
    + (s.avoidPhrases.length ? `\nAvoid: ${s.avoidPhrases.map(p => `"${p}"`).join(", ")}` : "")
    + (s.priorityBets.length ? `\nPriority bets: ${s.priorityBets.join("; ")}` : "")
    + line("Budget limit (planning only, never authorizes spend)", s.budgetLimit)
}

const scoped = (accountId: string, businessId: string) => Effect.gen(function*() {
  if (!(yield* (yield* BusinessRepository).getScoped(accountId, businessId))) return yield* Effect.fail(new AgentNotInScope())
})

export const proposeStrategy = (ctx: ToolContext, raw: unknown, actor: "ASSISTANT" | "OPERATOR" = "ASSISTANT") => Effect.gen(function*() {
  const input = yield* Schema.decodeUnknown(Propose, { onExcessProperty: "error" })(raw)
  yield* scoped(ctx.accountId, ctx.businessId)
  const clean = (xs: ReadonlyArray<string>) => [...new Set(xs.map(x => x.trim()).filter(Boolean))]
  const avoid = clean(input.avoidPhrases), bets = clean(input.priorityBets)
  if (![input.audience, input.positioning, input.offer].some(x => x.trim())) return yield* refuse("StrategyEmpty")
  const sql = yield* SqlClient.SqlClient
  const key = createHash("sha256").update(JSON.stringify(["strategy-v1", ctx.businessId, ctx.userId, { ...input, avoidPhrases: avoid, priorityBets: bets }])).digest("hex")
  return yield* sql.withTransaction(Effect.gen(function*() {
    yield* sql`SELECT id FROM businesses WHERE id=${ctx.businessId} FOR UPDATE`
    const replay = (yield* sql`SELECT id, version FROM marketing_strategy_versions WHERE request_key=${key} AND business_id=${ctx.businessId}`)[0]
    if (replay) return { strategyId: String(replay["id"]), version: Number(replay["version"]), reused: true }
    const approved = (yield* sql`SELECT version FROM marketing_strategy_versions WHERE business_id=${ctx.businessId} AND status='APPROVED'`)[0]
    // Written against the version that is approved now, so a newer approval is never overwritten unseen.
    if ((approved ? Number(approved["version"]) : null) !== input.basedOnVersion) return yield* refuse("StaleStrategy")
    if ((yield* sql`SELECT 1 FROM marketing_strategy_versions WHERE business_id=${ctx.businessId} AND status='PROPOSED'`)[0]) return yield* refuse("StrategyAlreadyWaiting")
    const next = Number((yield* sql`SELECT COALESCE(max(version),0)+1 AS v FROM marketing_strategy_versions WHERE business_id=${ctx.businessId}`)[0]!["v"])
    const rows = yield* sql`INSERT INTO marketing_strategy_versions(business_id,version,based_on_version,audience,positioning,offer,voice,avoid_phrases,priority_bets,budget_limit,rationale,proposed_by_actor,proposed_by_user_id,request_key)
      VALUES (${ctx.businessId},${next},${input.basedOnVersion},${input.audience.trim()},${input.positioning.trim()},${input.offer.trim()},${input.voice.trim()},
        ${avoid},${bets},${input.budgetLimit.trim()},${input.rationale.trim()},${actor},${ctx.userId},${key}) RETURNING id`
    return { strategyId: String(rows[0]!["id"]), version: next, reused: false }
  }))
})

export const strategyDeclarations: ReadonlyArray<ToolDeclaration> = [
  { name: "read_marketing_strategy", description: "Read the business's approved marketing strategy and any version waiting for the owner. It holds audience, positioning, offer, voice, phrases to avoid, priority bets and a planning budget limit. Read-only.", parametersJsonSchema: JSONSchema.make(Empty) },
  { name: "propose_marketing_strategy", description: "Propose a new strategy version for the owner to approve. Write the whole version against the approved one (basedOnVersion, null when none), from the business's approved facts, its own pages and what the owner said, with a rationale. One version waits at a time. A budget limit is planning context and never authorizes spend.", parametersJsonSchema: JSONSchema.make(Propose) },
]
export const dispatchStrategy = (ctx: ToolContext, name: string, raw: unknown) => Effect.gen(function*() {
  if (name === "read_marketing_strategy") {
    yield* Schema.decodeUnknown(Empty, { onExcessProperty: "error" })(raw)
    yield* scoped(ctx.accountId, ctx.businessId)
    const s = yield* strategyOf(ctx.businessId)
    return { summary: s.approved ? `Approved strategy version ${s.approved.version}${s.proposed ? `; version ${s.proposed.version} waits for the owner` : ""}` : s.proposed ? `No approved strategy; version ${s.proposed.version} waits for the owner` : "No marketing strategy saved yet", citations: [], data: s }
  }
  const data = yield* proposeStrategy(ctx, raw)
  return { summary: data.reused ? "Existing strategy proposal reused" : `Strategy version ${data.version} proposed for the owner to approve; nothing changed`, citations: [], data: { ...data, marketingStrategyId: data.strategyId } }
})

/** The version waiting for a person, for Needs you, with the approved one it would replace. */
export const pendingStrategies = (accountId: string, businessId: string) => Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const owned = (yield* sql`SELECT 1 FROM businesses WHERE id=${businessId} AND account_id=${accountId}`)[0]
  if (!owned) return []
  const s = yield* strategyOf(businessId)
  return s.proposed ? [{ ...s.proposed, replaces: s.approved }] : []
})

const failure = (e: unknown) => {
  if (typeof e === "object" && e !== null && "_tag" in e && e._tag === "NotAuthenticated") return json(401, { _tag: "NotAuthenticated" }, PRIVATE)
  if (e instanceof StrategyRefused) return json(409, { _tag: "StrategyRefused", reason: e.reason }, PRIVATE)
  if (e instanceof AgentNotInScope) return json(404, { _tag: "NotFound" }, PRIVATE)
  return json(503, { _tag: "StrategyUnavailable" }, PRIVATE)
}
export const strategyApi = (withSession: WithSession) => {
  const operator = operatorSessionFor(withSession)
  const route = <E, R>(run: (session: Session, businessId: string, id: string) => Effect.Effect<import("@effect/platform").HttpServerResponse.HttpServerResponse, E, R>) =>
    operator(session => Effect.gen(function*() {
      const { params } = yield* HttpRouter.RouteContext
      const businessId = params["id"] ?? "", id = params["strategyId"] ?? businessId
      if (decodeRouteId(businessId)._tag === "Left" || decodeRouteId(id)._tag === "Left") return yield* Effect.fail(new AgentNotInScope())
      yield* scoped(session.accountId, businessId)
      return yield* run(session, businessId, id)
    })).pipe(Effect.catchAll(failure))
  return HttpRouter.empty.pipe(
    HttpRouter.get("/api/businesses/:id/marketing-strategy", route((_session, businessId) => Effect.flatMap(strategyOf(businessId), s => json(200, s, PRIVATE)))),
    HttpRouter.post("/api/businesses/:id/marketing-strategy/:strategyId/approve", route((session, businessId, id) => Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      return yield* sql.withTransaction(Effect.gen(function*() {
        const row = (yield* sql`SELECT based_on_version FROM marketing_strategy_versions WHERE id=${id} AND business_id=${businessId} AND status='PROPOSED' FOR UPDATE`)[0]
        if (!row) return yield* refuse("AlreadyDecided")
        const approved = (yield* sql`SELECT version FROM marketing_strategy_versions WHERE business_id=${businessId} AND status='APPROVED' FOR UPDATE`)[0]
        if ((approved ? Number(approved["version"]) : null) !== (row["based_on_version"] === null ? null : Number(row["based_on_version"]))) return yield* refuse("StaleStrategy")
        yield* sql`UPDATE marketing_strategy_versions SET status='SUPERSEDED' WHERE business_id=${businessId} AND status='APPROVED'`
        yield* sql`UPDATE marketing_strategy_versions SET status='APPROVED', decided_by_user_id=${session.userId}, decided_at=now() WHERE id=${id}`
        return yield* json(200, { status: "APPROVED" }, PRIVATE)
      }))
    }))),
    HttpRouter.post("/api/businesses/:id/marketing-strategy/:strategyId/reject", route((session, businessId, id) => Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const rows = yield* sql`UPDATE marketing_strategy_versions SET status='REJECTED', decided_by_user_id=${session.userId}, decided_at=now()
        WHERE id=${id} AND business_id=${businessId} AND status='PROPOSED' RETURNING id`
      if (!rows.length) return yield* refuse("AlreadyDecided")
      return yield* json(200, { status: "REJECTED" }, PRIVATE)
    }))),
  )
}
