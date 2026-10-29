// The weekly growth brief. Once a week per business (and whenever someone asks
// for one), the agent reads what changed, what was done and what it changed,
// and writes a short brief with the one thing to do next, saved as an idea
// waiting for approval. Each brief is written in its own chat, so the person
// can ask follow-up questions there. It runs on the model the person last used
// for this business, falling back to the hosted model.
import { randomUUID } from "node:crypto"
import { HttpRouter, HttpServerResponse } from "@effect/platform"
import { SqlClient } from "@effect/sql"
import { Cause, Effect, Schedule, Schema } from "effect"
import { BusinessRepository, type Session } from "@openrecord/db"
import { decodeRouteId, type HarnessSelection } from "@openrecord/contracts"
import { sendSessionTurn } from "./agent-sessions.js"
import { businessWebsite } from "./agent-web-tools.js"
import { decode, json, operatorSessionFor, readJson, type WithSession } from "./record-routes.js"

export const BRIEF_INTERVAL_DAYS = 7
const PRIVATE = { "cache-control": "no-store" }

export const BRIEF_PROMPT = (today: string) => `Write this week's growth brief for this business (today is ${today}). It is for the owner: plain words, in their language.

First read: read_results, read_search_performance (28 days), read_ad_performance (28 days), read_acquisition_overview, read_ai_referral_evidence and read_open_issues. Some may say not connected; don't treat that as zero.

Then write the brief in Markdown, under 300 words, with exactly these three parts:

**What changed**: up to three bullets. Each gives the number, the period it's compared with, and what it means for the business. Only what the evidence shows.

**Do this next**: exactly one action, the most valuable thing to do this week, why it matters, and how we'll know it worked. If it's a new idea, save it with propose_growth_opportunity so it waits for approval; if a saved idea already covers it, name that one instead. Never save more than one.

**What we did and what it changed**: from read_results, what was done and how the metric moved before and after, or when that will be known. If nothing has been approved yet, say so in one line.

End with one line naming the single connection that would make next week's brief sharper, only if something important is not connected. Never claim a change caused a result; say what moved and what else could explain it.`

type Scope = { readonly accountId: string; readonly userId: string; readonly businessId: string }
export interface Brief {
  readonly id: string; readonly status: "RUNNING" | "READY" | "FAILED"; readonly trigger: "SCHEDULE" | "MANUAL"
  readonly text: string | null; readonly decisions: ReadonlyArray<{ type: string; id: string }>; readonly conversationId: string | null
  readonly provider: string | null; readonly model: string | null; readonly failure: string | null
  readonly startedAt: string; readonly finishedAt: string | null
}
const toBrief = (r: Record<string, unknown>): Brief => ({
  id: String(r["id"]), status: r["status"] as Brief["status"], trigger: r["trigger"] as Brief["trigger"], text: (r["text"] as string | null) ?? null,
  decisions: (r["decisions"] ?? []) as Brief["decisions"], conversationId: (r["conversation_id"] as string | null) ?? null,
  provider: (r["provider"] as string | null) ?? null, model: (r["model"] as string | null) ?? null, failure: (r["failure"] as string | null) ?? null,
  startedAt: new Date(r["started_at"] as string).toISOString(), finishedAt: r["finished_at"] ? new Date(r["finished_at"] as string).toISOString() : null,
})

/** The model this person last used for this business, if any. */
export const lastSelection = (scope: Scope) => Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql`SELECT m->'inference' AS inference FROM agent_conversations c, jsonb_array_elements(c.messages) WITH ORDINALITY AS e(m, i)
    WHERE c.account_id = ${scope.accountId} AND c.user_id = ${scope.userId} AND c.business_id = ${scope.businessId}
      AND m->>'role' = 'agent' AND m->'inference' ? 'instanceId' ORDER BY c.updated_at DESC, i DESC LIMIT 1`
  const inf = rows[0]?.["inference"] as { instanceId?: string; requestedModel?: string; reasoningEffort?: HarnessSelection["reasoningEffort"] } | undefined
  return inf?.instanceId && inf.requestedModel ? { instanceId: inf.instanceId, model: inf.requestedModel, ...(inf.reasoningEffort ? { reasoningEffort: inf.reasoningEffort } : {}) } as HarnessSelection : undefined
})

/** Runs the brief's turn: the session runtime in production, a fixture in tests. */
export type BriefSender<R> = (scope: Scope, body: { readonly message: string; readonly requestId: string; readonly conversationId: string; readonly revision: number; readonly selection: HarnessSelection | undefined }) => Effect.Effect<unknown, unknown, R>
export const production: BriefSender<Effect.Effect.Context<ReturnType<typeof sendSessionTurn>>> = (scope, body) => sendSessionTurn(scope, body)

const dayLabel = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })

/**
 * Starts a brief and returns it at once; the agent writes it in the
 * background. If one is already being written for this business, that one is
 * returned instead.
 */
export const startBrief = <R = Effect.Effect.Context<ReturnType<typeof sendSessionTurn>>>(scope: Scope, trigger: Brief["trigger"], sender: BriefSender<R> = production as unknown as BriefSender<R>) => Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const running = yield* sql`SELECT * FROM growth_briefs WHERE business_id = ${scope.businessId} AND status = 'RUNNING'`
  if (running[0]) return toBrief(running[0])
  const now = new Date()
  const conversationId = randomUUID()
  const inserted = yield* sql.withTransaction(Effect.gen(function*() {
    // Its own chat, kept out of the business's default chat, titled so it is easy to find.
    yield* sql`INSERT INTO agent_conversations(id, account_id, business_id, user_id, archived_at, last_reply)
      VALUES (${conversationId}, ${scope.accountId}, ${scope.businessId}, ${scope.userId}, now(), ${JSON.stringify({ title: `Weekly brief · ${dayLabel(now)}` })}::jsonb)`
    return yield* sql`INSERT INTO growth_briefs(account_id, business_id, user_id, trigger, conversation_id)
      VALUES (${scope.accountId}, ${scope.businessId}, ${scope.userId}, ${trigger}, ${conversationId})
      ON CONFLICT (business_id) WHERE status = 'RUNNING' DO NOTHING RETURNING *`
  }))
  if (!inserted[0]) return toBrief((yield* sql`SELECT * FROM growth_briefs WHERE business_id = ${scope.businessId} AND status = 'RUNNING'`)[0]!)
  const brief = toBrief(inserted[0])
  yield* Effect.forkDaemon(writeBrief(scope, brief.id, conversationId, now, sender))
  return brief
})

const writeBrief = <R>(scope: Scope, briefId: string, conversationId: string, now: Date, sender: BriefSender<R>) => Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const message = BRIEF_PROMPT(now.toISOString().slice(0, 10))
  const send = (selection: HarnessSelection | undefined) => sender(scope, { message, requestId: randomUUID(), conversationId, revision: 0, selection })
  const selection = yield* lastSelection(scope)
  // The person's own model first; the hosted model if that one is gone.
  let result: import("effect").Either.Either<unknown, unknown> = yield* send(selection).pipe(Effect.either)
  if (result._tag === "Left" && selection) result = yield* send(undefined).pipe(Effect.either)
  if (result._tag === "Left") {
    const e = result.left as { _tag?: string; reason?: string }
    const failure = e._tag === "AgentModelError" ? `MODEL_${e.reason ?? "UNAVAILABLE"}` : "FAILED"
    yield* sql`UPDATE growth_briefs SET status = 'FAILED', failure = ${failure.slice(0, 40)}, finished_at = now() WHERE id = ${briefId}`
    return
  }
  const reply = result.right as { reply?: unknown; decisions?: unknown; provider?: unknown; requestedModel?: unknown }
  const text = typeof reply.reply === "string" ? reply.reply.slice(0, 16000) : ""
  yield* text
    ? sql`UPDATE growth_briefs SET status = 'READY', text = ${text}, decisions = ${JSON.stringify(Array.isArray(reply.decisions) ? reply.decisions.slice(0, 5) : [])}::jsonb,
        provider = ${typeof reply.provider === "string" ? reply.provider : null}, model = ${typeof reply.requestedModel === "string" ? reply.requestedModel : null}, finished_at = now() WHERE id = ${briefId}`
    : sql`UPDATE growth_briefs SET status = 'FAILED', failure = 'EMPTY', finished_at = now() WHERE id = ${briefId}`
}).pipe(
  Effect.catchAllCause(cause => Effect.gen(function*() {
    yield* Effect.logWarning("growth brief failed").pipe(Effect.annotateLogs({ brief: briefId, cause: Cause.pretty(cause).slice(0, 500) }))
    const sql = yield* SqlClient.SqlClient
    yield* sql`UPDATE growth_briefs SET status = 'FAILED', failure = 'FAILED', finished_at = now() WHERE id = ${briefId} AND status = 'RUNNING'`
  }).pipe(Effect.ignore)),
)

/** Turns the brief on for a business the first time someone opens it; the first one is written right away. */
const ensureSchedule = (scope: Scope) => Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql`INSERT INTO growth_brief_schedules(business_id, account_id, user_id, next_run_at)
    VALUES (${scope.businessId}, ${scope.accountId}, ${scope.userId}, now()) ON CONFLICT (business_id) DO NOTHING`
  const row = (yield* sql`SELECT enabled, next_run_at FROM growth_brief_schedules WHERE business_id = ${scope.businessId}`)[0]!
  return { enabled: row["enabled"] === true, nextRunAt: new Date(row["next_run_at"] as string).toISOString() }
})

/**
 * Writes every brief that is due. Runs every few minutes in the server; a
 * lease means only one server process takes each business, and a failed run
 * waits for next week rather than retrying in a loop.
 */
export const runDueBriefs = <R = Effect.Effect.Context<ReturnType<typeof sendSessionTurn>>>(sender: BriefSender<R> = production as unknown as BriefSender<R>) => Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const due = yield* sql`UPDATE growth_brief_schedules s SET lease_until = now() + interval '20 minutes',
      next_run_at = GREATEST(s.next_run_at + make_interval(days => ${BRIEF_INTERVAL_DAYS}), now() + interval '1 day'), updated_at = now()
    WHERE s.business_id IN (SELECT business_id FROM growth_brief_schedules WHERE enabled AND next_run_at <= now() AND (lease_until IS NULL OR lease_until < now())
      ORDER BY next_run_at LIMIT 5 FOR UPDATE SKIP LOCKED)
      AND EXISTS (SELECT 1 FROM account_users au WHERE au.account_id = s.account_id AND au.user_id = s.user_id)
    RETURNING s.business_id, s.account_id, s.user_id`
  for (const r of due) {
    yield* startBrief({ accountId: String(r["account_id"]), userId: String(r["user_id"]), businessId: String(r["business_id"]) }, "SCHEDULE", sender).pipe(
      Effect.catchAllCause(cause => Effect.logWarning("growth brief could not start").pipe(Effect.annotateLogs({ business: String(r["business_id"]), cause: Cause.pretty(cause).slice(0, 300) }))))
  }
  return due.length
})

/** Every five minutes, after the server has started. */
export const briefScheduler = runDueBriefs().pipe(
  Effect.catchAllCause(cause => Effect.logWarning("growth brief scheduler").pipe(Effect.annotateLogs({ cause: Cause.pretty(cause).slice(0, 300) }))),
  Effect.repeat(Schedule.spaced("5 minutes")),
)

const ScheduleInput = Schema.Struct({ enabled: Schema.Boolean })

export const briefApi = (withSession: WithSession) => {
  const operator = operatorSessionFor(withSession)
  const business = <E, R>(run: (scope: Scope) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
    operator((session: Session) => Effect.gen(function*() {
      const { params } = yield* HttpRouter.RouteContext
      const businessId = params["id"] ?? ""
      if (decodeRouteId(businessId)._tag === "Left") return yield* json(422, { _tag: "InvalidRequest" }, PRIVATE)
      if (!(yield* (yield* BusinessRepository).getScoped(session.accountId, businessId))) return yield* json(404, { _tag: "BusinessNotFound" }, PRIVATE)
      return yield* run({ accountId: session.accountId, userId: session.userId, businessId })
    })).pipe(Effect.catchAll(e => typeof e === "object" && e !== null && "_tag" in e && e._tag === "NotAuthenticated"
      ? json(401, { _tag: "NotAuthenticated" }, PRIVATE) : json(500, { _tag: "BriefRequestFailed" }, PRIVATE)))
  return HttpRouter.empty.pipe(
    HttpRouter.get("/api/businesses/:id/brief", business(scope => Effect.gen(function*() {
      const schedule = { ...(yield* ensureSchedule(scope)) }
      const sql = yield* SqlClient.SqlClient
      let rows = yield* sql`SELECT * FROM growth_briefs WHERE business_id = ${scope.businessId} AND account_id = ${scope.accountId} ORDER BY started_at DESC LIMIT 2`
      // The very first brief starts the moment someone opens it; after that the week decides.
      if (!rows.length && schedule.enabled) {
        yield* sql`UPDATE growth_brief_schedules SET next_run_at = now() + make_interval(days => ${BRIEF_INTERVAL_DAYS}), updated_at = now() WHERE business_id = ${scope.businessId}`
        yield* startBrief(scope, "SCHEDULE")
        rows = yield* sql`SELECT * FROM growth_briefs WHERE business_id = ${scope.businessId} AND account_id = ${scope.accountId} ORDER BY started_at DESC LIMIT 2`
        schedule.nextRunAt = new Date(Date.now() + BRIEF_INTERVAL_DAYS * 86_400_000).toISOString()
      }
      const latest = rows[0] ? toBrief(rows[0]) : null
      // While a new one is being written, the last finished one stays readable.
      const previous = latest?.status !== "READY" && rows[1] ? toBrief(rows[1]) : null
      // Without a goal the agent can't save or measure ideas, so Today offers to finish setup.
      const goal = yield* sql`SELECT 1 FROM growth_goals g JOIN businesses b ON b.id = g.business_id WHERE g.business_id = ${scope.businessId} AND b.account_id = ${scope.accountId} LIMIT 1`
      return yield* json(200, { brief: latest, previous: previous?.status === "READY" ? previous : null, schedule, hasGoal: goal.length > 0, website: yield* businessWebsite(scope.businessId) }, PRIVATE)
    }))),
    HttpRouter.post("/api/businesses/:id/brief/run", business(scope => Effect.gen(function*() {
      return yield* json(200, { brief: yield* startBrief(scope, "MANUAL") }, PRIVATE)
    }))),
    HttpRouter.post("/api/businesses/:id/brief/schedule", business(scope => Effect.gen(function*() {
      const input = decode(ScheduleInput, yield* readJson)
      if (!input) return yield* json(422, { _tag: "InvalidRequest" }, PRIVATE)
      yield* ensureSchedule(scope)
      const sql = yield* SqlClient.SqlClient
      yield* sql`UPDATE growth_brief_schedules SET enabled = ${input.enabled}, updated_at = now(),
        next_run_at = CASE WHEN ${input.enabled} AND next_run_at < now() THEN now() + make_interval(days => ${BRIEF_INTERVAL_DAYS}) ELSE next_run_at END
        WHERE business_id = ${scope.businessId}`
      return yield* json(200, { schedule: yield* ensureSchedule(scope) }, PRIVATE)
    }))),
  )
}
