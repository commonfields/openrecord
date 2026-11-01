// Scheduled AI answer tracking on the team's own AI subscriptions.
//
// A person approves the cadence, the connected models (up to three) and the
// exact number of questions asked per run. Each period the server asks the
// latest question set's questions on those models, as the person who
// approved it, through the same research path as ai.answers, so every run is
// a saved, dated observation. A run never asks more than was approved: when
// the question set or the models change, the schedule pauses until approved
// again. When the share of answers naming the business falls by at least the
// approved number of points between two runs (with enough answers on both
// sides), an investigation opens for the agent with the numbers.
import { SqlClient } from "@effect/sql"
import { HttpRouter, type HttpServerResponse } from "@effect/platform"
import { Cause, Effect, Option, Schedule, Schema } from "effect"
import { BusinessRepository, type Session } from "@openrecord/db"
import { dispatchInvestigation } from "../agent-investigation-tools.js"
import { decode, json, operatorSessionFor, readJson, type WithSession } from "../record-routes.js"
import { AnswerEngines, liveEngines, type Engine } from "./answers.js"
import { runResearch } from "./tools.js"

export const MAX_ASKS = 8
const MIN_ANSWERS = 4
const HOURS = { DAILY: 24, WEEKLY: 24 * 7 } as const
const engines = Effect.map(Effect.serviceOption(AnswerEngines), o => Option.getOrElse(o, () => liveEngines))

/** Questions a run asks from the latest question set, up to the per-run limit. */
const setQuestions = (businessId: string) => Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const r = (yield* sql`SELECT count(*)::int AS n FROM acq_questions q WHERE q.business_id = ${businessId}
    AND q.set_id = (SELECT id FROM acq_question_sets WHERE business_id = ${businessId} ORDER BY version DESC LIMIT 1)`)[0]
  return Math.min(Number(r?.["n"] ?? 0), MAX_ASKS)
})
export const asksFor = (questions: number, models: number) => Math.min(MAX_ASKS, questions * models)

const log = (message: string, business: string, cause?: Cause.Cause<unknown>) =>
  Effect.logWarning(message).pipe(Effect.annotateLogs({ business, ...(cause ? { cause: Cause.pretty(cause).slice(0, 300) } : {}) }))
const shareOf = (f: unknown) => { const s = (f as { summary?: { brandMentioned?: { n?: number; d?: number } } } | null)?.summary?.brandMentioned; return s && typeof s.n === "number" && typeof s.d === "number" ? { n: s.n, d: s.d } : null }

const pause = (businessId: string, reason: string) => Effect.flatMap(SqlClient.SqlClient, sql =>
  sql`UPDATE ai_answer_schedules SET enabled = false, paused_reason = ${reason}, lease_until = NULL, updated_at = now() WHERE business_id = ${businessId}`)

const openDropInvestigation = (scope: { accountId: string; userId: string; businessId: string }, before: { n: number; d: number }, after: { n: number; d: number }) => Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const goal = (yield* sql`SELECT primary_goal_id FROM growth_profiles WHERE business_id = ${scope.businessId}`)[0]?.["primary_goal_id"]
  if (typeof goal !== "string") return null
  const pct = (x: { n: number; d: number }) => Math.round((x.n / x.d) * 100)
  const opened = yield* dispatchInvestigation(scope, "open_investigation", { goalId: goal, question: `Why did the business appear in fewer AI answers on its subscriptions (${pct(before)}% to ${pct(after)}%)?` })
  const investigationId = String((opened.data as { investigationId: unknown }).investigationId)
  yield* dispatchInvestigation(scope, "record_investigation_note", { investigationId, kind: "OBSERVATION",
    note: `Scheduled AI answer tracking: named in ${before.n} of ${before.d} answers in the previous run and ${after.n} of ${after.d} in the latest. Automatic name matching on a small sample; one run can be noise. Compare with read_research_evidence and ai.visibility before concluding anything.` })
  return investigationId
})

/** Runs every due schedule. A lease keeps two servers from running the same one. */
export const runAnswerSchedules = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const due = yield* sql`UPDATE ai_answer_schedules s SET lease_until = now() + interval '20 minutes', updated_at = now()
    WHERE s.business_id IN (SELECT business_id FROM ai_answer_schedules WHERE enabled AND next_run_at <= now() AND (lease_until IS NULL OR lease_until < now())
      ORDER BY next_run_at LIMIT 3 FOR UPDATE SKIP LOCKED)
      AND EXISTS (SELECT 1 FROM account_users au WHERE au.account_id = s.account_id AND au.user_id = s.approved_by_user_id)
    RETURNING s.business_id, s.account_id, s.approved_by_user_id, s.cadence, s.engines, s.asks_per_run, s.alert_drop_points, s.last_observation_id`
  for (const r of due) {
    const businessId = String(r["business_id"])
    const ctx = { accountId: String(r["account_id"]), userId: String(r["approved_by_user_id"]), businessId }
    yield* Effect.gen(function*() {
      const approved = (r["engines"] as Array<{ instanceId: string; model: string }>) ?? []
      const available = yield* (yield* engines).list(ctx)
      if (!approved.every(a => available.some(e => e.instanceId === a.instanceId && e.model === a.model))) return yield* pause(businessId, "ENGINE_UNAVAILABLE")
      if (asksFor(yield* setQuestions(businessId), approved.length) !== Number(r["asks_per_run"])) return yield* pause(businessId, "QUESTIONS_CHANGED")
      const result = yield* runResearch(ctx, { capability: "ai.answers", question: "Scheduled AI answer tracking (approved schedule)", input: { engines: approved, runAt: new Date().toISOString() } })
      const data = result.data as { observationId?: string; status?: string; findings?: unknown }
      const hours = HOURS[r["cadence"] === "DAILY" ? "DAILY" : "WEEKLY"]
      if (!data.observationId || data.status !== "OBSERVED") {
        yield* sql`UPDATE ai_answer_schedules SET lease_until = NULL, next_run_at = now() + interval '6 hours', updated_at = now() WHERE business_id = ${businessId}`
        return
      }
      const previousId = r["last_observation_id"] ? String(r["last_observation_id"]) : null
      let alert: unknown = null
      if (previousId && previousId !== data.observationId) {
        const prev = (yield* sql`SELECT findings FROM research_observations WHERE id = ${previousId} AND business_id = ${businessId}`)[0]
        const before = shareOf(prev?.["findings"]), after = shareOf((yield* sql`SELECT findings FROM research_observations WHERE id = ${data.observationId}`)[0]?.["findings"])
        if (before && after && before.d >= MIN_ANSWERS && after.d >= MIN_ANSWERS && (before.n / before.d - after.n / after.d) * 100 >= Number(r["alert_drop_points"])) {
          const investigationId = yield* openDropInvestigation(ctx, before, after).pipe(Effect.catchAllCause(cause => log("answer tracking alert could not open an investigation", businessId, cause).pipe(Effect.as(null))))
          alert = { at: new Date().toISOString(), before, after, investigationId }
        }
      }
      yield* sql`UPDATE ai_answer_schedules SET previous_observation_id = last_observation_id, last_observation_id = ${data.observationId}, lease_until = NULL,
        last_alert = COALESCE(${alert === null ? null : JSON.stringify(alert)}::jsonb, last_alert),
        next_run_at = GREATEST(next_run_at + make_interval(hours => ${hours}), now() + make_interval(hours => ${hours} / 2)), updated_at = now()
        WHERE business_id = ${businessId}`
    }).pipe(Effect.catchAllCause(cause => log("scheduled answer tracking failed", businessId, cause)))
  }
})
/** Every ten minutes, after the server has started. */
export const answerScheduler = runAnswerSchedules.pipe(
  Effect.catchAllCause(cause => Effect.logWarning("scheduled answer tracking").pipe(Effect.annotateLogs({ cause: Cause.pretty(cause).slice(0, 300) }))),
  Effect.repeat(Schedule.spaced("10 minutes")),
)

// ---------------------------------------------------------------- HTTP

const EngineRef = Schema.Struct({ instanceId: Schema.UUID, model: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(120)) })
const Approve = Schema.Struct({
  cadence: Schema.Literal("DAILY", "WEEKLY"),
  engines: Schema.Array(EngineRef).pipe(Schema.minItems(1), Schema.maxItems(3)),
  /** Must equal the questions the server would ask each run, as shown to the person. */
  acknowledgedAsks: Schema.Int.pipe(Schema.between(1, MAX_ASKS)),
  alertDropPoints: Schema.optional(Schema.Int.pipe(Schema.between(5, 100))),
})
const Pause = Schema.Struct({ enabled: Schema.Boolean })

const status = (session: Session, businessId: string) => Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const r = (yield* sql`SELECT cadence, engines, asks_per_run, alert_drop_points, enabled, paused_reason, next_run_at, last_observation_id, last_alert, approved_at
    FROM ai_answer_schedules WHERE business_id = ${businessId}`)[0]
  const available: ReadonlyArray<Engine> = yield* (yield* engines).list({ accountId: session.accountId, userId: session.userId, businessId }).pipe(Effect.orElseSucceed(() => []))
  const iso = (v: unknown) => v ? new Date(v as string).toISOString() : null
  return {
    questions: yield* setQuestions(businessId), maxAsks: MAX_ASKS,
    engines: available.map(e => ({ instanceId: e.instanceId, model: e.model, label: e.label })),
    schedule: r ? { cadence: r["cadence"], engines: r["engines"], asksPerRun: Number(r["asks_per_run"]), alertDropPoints: Number(r["alert_drop_points"]), enabled: r["enabled"] === true,
      pausedReason: r["paused_reason"] ?? null, nextRunAt: iso(r["next_run_at"]), lastObservationId: r["last_observation_id"] ?? null, lastAlert: r["last_alert"] ?? null, approvedAt: iso(r["approved_at"]) } : null,
  }
})

export const answerScheduleApi = (withSession: WithSession) => {
  const operator = operatorSessionFor(withSession)
  const client = <E, R>(run: (session: Session, businessId: string) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
    operator((session: Session) => Effect.gen(function*() {
      const { params } = yield* HttpRouter.RouteContext
      const businessId = params["id"] ?? ""
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(businessId)) return yield* json(422, { _tag: "InvalidRequest" })
      if (!(yield* (yield* BusinessRepository).getScoped(session.accountId, businessId))) return yield* json(404, { _tag: "BusinessNotFound" })
      return yield* run(session, businessId)
    })).pipe(Effect.catchAll(e => json(typeof e === "object" && e !== null && "_tag" in e && e._tag === "NotAuthenticated" ? 401 : 500, { _tag: "AnswerTrackingUnavailable" })))
  return HttpRouter.empty.pipe(
    HttpRouter.get("/api/businesses/:id/ai-answer-schedule", client((session, businessId) => Effect.flatMap(status(session, businessId), body => json(200, body, { "cache-control": "no-store" })))),
    HttpRouter.put("/api/businesses/:id/ai-answer-schedule", client((session, businessId) => Effect.gen(function*() {
      const body = decode(Approve, yield* readJson)
      if (!body) return yield* json(422, { _tag: "InvalidRequest" })
      const available = yield* (yield* engines).list({ accountId: session.accountId, userId: session.userId, businessId })
      if (!body.engines.every(a => available.some(e => e.instanceId === a.instanceId && e.model === a.model))) return yield* json(409, { _tag: "EngineUnavailable" })
      const questions = yield* setQuestions(businessId)
      if (!questions) return yield* json(409, { _tag: "NoQuestionSet" })
      // The person approves exactly the questions the server will ask each run.
      if (body.acknowledgedAsks !== asksFor(questions, body.engines.length)) return yield* json(409, { _tag: "AsksMismatch", asks: asksFor(questions, body.engines.length) })
      const sql = yield* SqlClient.SqlClient
      yield* sql`INSERT INTO ai_answer_schedules(business_id, account_id, approved_by_user_id, cadence, engines, asks_per_run, alert_drop_points, enabled, next_run_at)
        VALUES (${businessId}, ${session.accountId}, ${session.userId}, ${body.cadence}, ${JSON.stringify(body.engines)}::jsonb, ${body.acknowledgedAsks}, ${body.alertDropPoints ?? 20}, true, now())
        ON CONFLICT (business_id) DO UPDATE SET approved_by_user_id = EXCLUDED.approved_by_user_id, cadence = EXCLUDED.cadence, engines = EXCLUDED.engines,
          asks_per_run = EXCLUDED.asks_per_run, alert_drop_points = EXCLUDED.alert_drop_points, enabled = true, paused_reason = NULL, approved_at = now(), updated_at = now(),
          next_run_at = CASE WHEN ai_answer_schedules.enabled THEN ai_answer_schedules.next_run_at ELSE now() END
        WHERE ai_answer_schedules.account_id = EXCLUDED.account_id`
      return yield* json(200, yield* status(session, businessId))
    }))),
    HttpRouter.post("/api/businesses/:id/ai-answer-schedule/enabled", client((session, businessId) => Effect.gen(function*() {
      const body = decode(Pause, yield* readJson)
      if (!body) return yield* json(422, { _tag: "InvalidRequest" })
      const sql = yield* SqlClient.SqlClient
      // Turning it back on keeps the approval; a schedule paused because something changed must be approved again.
      const updated = yield* sql`UPDATE ai_answer_schedules SET enabled = ${body.enabled}, updated_at = now(),
          next_run_at = CASE WHEN ${body.enabled} AND next_run_at < now() THEN now() ELSE next_run_at END
        WHERE business_id = ${businessId} AND account_id = ${session.accountId} AND (${!body.enabled} OR paused_reason IS NULL) RETURNING business_id`
      if (!updated.length) return yield* json(409, { _tag: "ApprovalRequired" })
      return yield* json(200, yield* status(session, businessId))
    }))),
  )
}
