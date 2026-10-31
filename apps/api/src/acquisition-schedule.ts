// Scheduled AI-answer tracking: approve once, measured every day or week,
// alerted when visibility drops.
//
// A person approves a schedule for one frozen question set: how often, how
// many samples per question, and the provider-call ceiling of each run. The
// server then starts one ordinary measurement batch per period through the
// same repository path as a manual batch, attributed to the person who
// approved it. If the question set's size no longer matches the approved
// ceiling, startBatch refuses and the schedule pauses until approved again,
// so a schedule can never spend more than was approved. A run never starts
// while the previous one is still collecting answers.
//
// When a run finishes it is compared with the run before it. If the share of
// answers that name the business, or that cite its own site, falls by at least
// the approved number of points (with enough answers on both sides to mean
// something), an alert is saved and, when the business has a growth goal, an
// investigation opens for the agent with the numbers as its first note. The
// alert says plainly that it comes from automatic name matching and citation
// owners, not human-reviewed findings, and that one run can be noise.
import { SqlClient } from "@effect/sql"
import { HttpRouter, HttpServerResponse } from "@effect/platform"
import { Cause, Config, Effect, Schedule, Schema } from "effect"
import { ACQ_MAX_ATTEMPTS_PER_CHECK, AcquisitionRefused, AcquisitionRepository, acquisitionView, type BatchMetrics, type Session } from "@openrecord/db"
import { RecordSurfaceConfig } from "@openrecord/config"
import { dispatchInvestigation } from "./agent-investigation-tools.js"
import { decode, json, operatorSessionFor, readJson, type WithSession } from "./record-routes.js"

export type Cadence = "DAILY" | "WEEKLY"
export const CADENCE_HOURS: Readonly<Record<Cadence, number>> = { DAILY: 24, WEEKLY: 24 * 7 }
/** Fewer answers than this on either side and a change says nothing. */
export const MIN_ANSWERS = 8

export type AlertKind = "BRAND_MENTIONS_DROPPED" | "OWN_CITATIONS_DROPPED"
export interface VisibilityDrop { readonly kind: AlertKind; readonly before: { n: number; d: number }; readonly after: { n: number; d: number } }
const pct = (f: { n: number; d: number }) => f.d ? (f.n / f.d) * 100 : 0

/** Drops of at least `points` percentage points between two finished runs, with enough answers on both sides. */
export function visibilityDrops(before: BatchMetrics, after: BatchMetrics, points: number): VisibilityDrop[] {
  const out: VisibilityDrop[] = []
  const check = (kind: AlertKind, b: { n: number; d: number }, a: { n: number; d: number }) => {
    if (b.d >= MIN_ANSWERS && a.d >= MIN_ANSWERS && pct(b) - pct(a) >= points) out.push({ kind, before: { n: b.n, d: b.d }, after: { n: a.n, d: a.d } })
  }
  check("BRAND_MENTIONS_DROPPED", before.candidateSamples, after.candidateSamples)
  check("OWN_CITATIONS_DROPPED", before.ownedCitationRate, after.ownedCitationRate)
  return out
}

const ALERT_TEXT: Readonly<Record<AlertKind, string>> = {
  BRAND_MENTIONS_DROPPED: "AI answers named the business less often",
  OWN_CITATIONS_DROPPED: "AI answers cited the business's own site less often",
}
const share = (f: { n: number; d: number }) => `${f.n} of ${f.d} answers (${Math.round(pct(f))}%)`
export const alertQuestion = (drop: VisibilityDrop) =>
  `${ALERT_TEXT[drop.kind]} in the latest scheduled measurement: ${share(drop.after)}, down from ${share(drop.before)}. Why, and what should change?`
const alertNote = (drop: VisibilityDrop, beforeBatch: string, afterBatch: string) =>
  `Scheduled tracking compared batch ${afterBatch} with batch ${beforeBatch}: ${share(drop.before)} before, ${share(drop.after)} after. ` +
  "These counts come from automatic exact-name matching and citation owners, not human-reviewed judgments, and a single run can be noise. " +
  "Next checks: read the two batches' answers and citations (read_acquisition_citations, compare_acquisition_batches), see whether competitors replaced the business, and whether the change repeats in the next run."

/** The provider-call ceiling of one run, which a person approves. */
export const runCeiling = (questions: number, samples: number) => questions * samples * ACQ_MAX_ATTEMPTS_PER_CHECK

// ---------------------------------------------------------------- scheduler

const log = (message: string, business: string, cause?: Cause.Cause<unknown>) =>
  Effect.logWarning(message).pipe(Effect.annotateLogs({ business, ...(cause ? { cause: Cause.pretty(cause).slice(0, 300) } : {}) }))

/** Opens the agent's investigation for a drop, under the business's growth goal. Null when there is no goal. */
const openInvestigation = (scope: { accountId: string; userId: string; businessId: string }, drop: VisibilityDrop, beforeBatch: string, afterBatch: string) => Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const goal = (yield* sql`SELECT primary_goal_id FROM growth_profiles WHERE business_id = ${scope.businessId}`)[0]?.["primary_goal_id"]
  if (typeof goal !== "string") return null
  const opened = yield* dispatchInvestigation(scope, "open_investigation", { goalId: goal, question: alertQuestion(drop) })
  const investigationId = String((opened.data as { investigationId: unknown }).investigationId)
  yield* dispatchInvestigation(scope, "record_investigation_note", { investigationId, kind: "OBSERVATION", note: alertNote(drop, beforeBatch, afterBatch) })
  return investigationId
})

/** Compares each schedule's newest finished run with the run before it, once. */
const compareFinishedRuns = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql`SELECT business_id, account_id, approved_by_user_id, last_batch_id, previous_batch_id, alert_drop_points FROM acq_schedules
    WHERE last_batch_id IS NOT NULL AND compared_batch_id IS DISTINCT FROM last_batch_id LIMIT 20`
  for (const r of rows) {
    const businessId = String(r["business_id"])
    yield* Effect.gen(function*() {
      const snapshot = yield* (yield* AcquisitionRepository).snapshot(businessId)
      if (!snapshot) return
      const batches = acquisitionView(snapshot).batches
      const last = batches.find(b => b.id === r["last_batch_id"])
      if (!last || last.metrics.pending > 0) return
      const previous = r["previous_batch_id"] ? batches.find(b => b.id === r["previous_batch_id"]) : undefined
      const scope = { accountId: String(r["account_id"]), userId: String(r["approved_by_user_id"]), businessId }
      for (const drop of previous && previous.metrics.pending === 0 ? visibilityDrops(previous.metrics, last.metrics, Number(r["alert_drop_points"])) : []) {
        const saved = yield* sql`INSERT INTO acq_alerts(business_id, kind, before_batch_id, after_batch_id, before_n, before_d, after_n, after_d)
          VALUES (${businessId}, ${drop.kind}, ${previous!.id}, ${last.id}, ${drop.before.n}, ${drop.before.d}, ${drop.after.n}, ${drop.after.d})
          ON CONFLICT (after_batch_id, kind) DO NOTHING RETURNING id`
        if (!saved[0]) continue
        const investigationId = yield* openInvestigation(scope, drop, previous!.id, last.id).pipe(
          Effect.catchAllCause(cause => log("tracking alert could not open an investigation", businessId, cause).pipe(Effect.as(null))))
        if (investigationId) yield* sql`UPDATE acq_alerts SET investigation_id = ${investigationId} WHERE id = ${String(saved[0]["id"])}`
      }
      yield* sql`UPDATE acq_schedules SET compared_batch_id = ${last.id}, updated_at = now() WHERE business_id = ${businessId}`
    }).pipe(Effect.catchAllCause(cause => log("tracking comparison failed", businessId, cause)))
  }
})

/** Starts every run that is due. A lease keeps two servers from starting the same run. */
const startDueRuns = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const surface = yield* RecordSurfaceConfig
  const due = yield* sql`UPDATE acq_schedules s SET lease_until = now() + interval '10 minutes', updated_at = now()
    WHERE s.business_id IN (SELECT business_id FROM acq_schedules WHERE enabled AND next_run_at <= now() AND (lease_until IS NULL OR lease_until < now())
      ORDER BY next_run_at LIMIT 5 FOR UPDATE SKIP LOCKED)
      AND EXISTS (SELECT 1 FROM account_users au WHERE au.account_id = s.account_id AND au.user_id = s.approved_by_user_id)
    RETURNING s.business_id, s.account_id, s.approved_by_user_id, s.set_id, s.cadence, s.samples, s.max_provider_calls, s.last_batch_id`
  for (const r of due) {
    const businessId = String(r["business_id"])
    yield* Effect.gen(function*() {
      const repo = yield* AcquisitionRepository
      const snapshot = yield* repo.snapshot(businessId)
      const running = snapshot && r["last_batch_id"] ? acquisitionView(snapshot).batches.find(b => b.id === r["last_batch_id"])?.metrics.pending ?? 0 : 0
      if (running > 0) {
        // The previous run is still collecting answers: look again in an hour.
        yield* sql`UPDATE acq_schedules SET next_run_at = now() + interval '1 hour', lease_until = NULL WHERE business_id = ${businessId}`
        return
      }
      const session: Session = { accountId: String(r["account_id"]), userId: String(r["approved_by_user_id"]) }
      const batch = yield* repo.startBatch(session, businessId, {
        setId: String(r["set_id"]), scope: "FULL", questionKeys: null, samples: Number(r["samples"]),
        provider: surface.provider, requestedModel: surface.provider === "gemini" ? surface.model : null,
        acknowledgedMaxProviderCalls: Number(r["max_provider_calls"]),
      }).pipe(Effect.catchIf((e): e is AcquisitionRefused => e instanceof AcquisitionRefused, e =>
        // Never spend outside what was approved: pause until a person approves again.
        sql`UPDATE acq_schedules SET enabled = false, paused_reason = ${e.reason.slice(0, 80)}, lease_until = NULL, updated_at = now() WHERE business_id = ${businessId}`.pipe(Effect.as(null))))
      if (!batch) return
      const hours = CADENCE_HOURS[r["cadence"] === "DAILY" ? "DAILY" : "WEEKLY"]
      yield* sql`UPDATE acq_schedules SET previous_batch_id = last_batch_id, last_batch_id = ${batch.id}, lease_until = NULL,
        next_run_at = GREATEST(next_run_at + make_interval(hours => ${hours}), now() + make_interval(hours => ${hours} / 2)), updated_at = now()
        WHERE business_id = ${businessId}`
    }).pipe(Effect.catchAllCause(cause => log("scheduled tracking run could not start", businessId, cause)))
  }
})

export const runScheduledTracking = Effect.gen(function*() {
  yield* compareFinishedRuns
  yield* startDueRuns
})

/** Every five minutes, after the server has started. */
export const trackingScheduler = runScheduledTracking.pipe(
  Effect.catchAllCause(cause => Effect.logWarning("scheduled tracking").pipe(Effect.annotateLogs({ cause: Cause.pretty(cause).slice(0, 300) }))),
  Effect.repeat(Schedule.spaced("5 minutes")),
)

// ---------------------------------------------------------------- HTTP

const Approve = Schema.Struct({
  setId: Schema.UUID,
  cadence: Schema.Literal("DAILY", "WEEKLY"),
  samples: Schema.Int.pipe(Schema.between(1, 5)),
  /** Must equal the run ceiling for this set and sample count, as shown to the person. */
  acknowledgedMaxProviderCalls: Schema.Int.pipe(Schema.positive()),
  alertDropPoints: Schema.optional(Schema.Int.pipe(Schema.between(5, 100))),
})
const Pause = Schema.Struct({ enabled: Schema.Boolean })

const readSchedule = (businessId: string) => Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const row = (yield* sql`SELECT set_id, cadence, samples, max_provider_calls, alert_drop_points, enabled, paused_reason, next_run_at, last_batch_id, approved_at, approved_by_user_id
    FROM acq_schedules WHERE business_id = ${businessId}`)[0]
  const alerts = yield* sql`SELECT id, kind, before_batch_id, after_batch_id, before_n, before_d, after_n, after_d, investigation_id, created_at
    FROM acq_alerts WHERE business_id = ${businessId} ORDER BY created_at DESC LIMIT 10`
  const rate = yield* Config.number("AGENT_MEASUREMENT_MAX_USD_PER_ATTEMPT").pipe(Config.withDefault(-1))
  const iso = (v: unknown) => v === null || v === undefined ? null : new Date(v as string | Date).toISOString()
  return {
    schedule: row ? {
      setId: String(row["set_id"]), cadence: row["cadence"] as Cadence, samples: Number(row["samples"]), maxProviderCalls: Number(row["max_provider_calls"]),
      estimatedMaxCostUsd: Number.isFinite(rate) && rate > 0 ? Math.ceil(Number(row["max_provider_calls"]) * rate * 100) / 100 : null,
      alertDropPoints: Number(row["alert_drop_points"]), enabled: row["enabled"] === true, pausedReason: row["paused_reason"] === null ? null : String(row["paused_reason"]),
      nextRunAt: iso(row["next_run_at"]), lastBatchId: row["last_batch_id"] === null ? null : String(row["last_batch_id"]), approvedAt: iso(row["approved_at"]),
    } : null,
    costPerAttemptUsd: Number.isFinite(rate) && rate > 0 ? rate : null,
    alerts: alerts.map(a => ({
      id: String(a["id"]), kind: a["kind"] as AlertKind, beforeBatchId: String(a["before_batch_id"]), afterBatchId: String(a["after_batch_id"]),
      before: { n: Number(a["before_n"]), d: Number(a["before_d"]) }, after: { n: Number(a["after_n"]), d: Number(a["after_d"]) },
      investigationId: a["investigation_id"] === null ? null : String(a["investigation_id"]), createdAt: iso(a["created_at"]),
    })),
  }
})

export const trackingScheduleApi = (withSession: WithSession) => {
  const operator = operatorSessionFor(withSession)
  const client = <E, R>(run: (session: Session, businessId: string) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
    operator((session: Session) => Effect.gen(function*() {
      const { params } = yield* HttpRouter.RouteContext
      const businessId = params["id"] ?? ""
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(businessId)) return yield* json(422, { _tag: "InvalidRequest" })
      const snapshot = yield* (yield* AcquisitionRepository).snapshot(businessId)
      const sql = yield* SqlClient.SqlClient
      const owned = yield* sql`SELECT 1 FROM businesses WHERE id = ${businessId} AND account_id = ${session.accountId}`
      if (!owned.length || !snapshot) return yield* json(404, { _tag: "ClientNotFound" })
      return yield* run(session, businessId)
    })).pipe(Effect.catchAll(e => json(typeof e === "object" && e !== null && "_tag" in e && e._tag === "NotAuthenticated" ? 401 : 500, { _tag: "TrackingUnavailable" })))
  return HttpRouter.empty.pipe(
    HttpRouter.get("/api/acquisition/clients/:id/schedule", client((_, businessId) => Effect.flatMap(readSchedule(businessId), body => json(200, body, { "cache-control": "no-store" })))),
    HttpRouter.put("/api/acquisition/clients/:id/schedule", client((session, businessId) => Effect.gen(function*() {
      const body = decode(Approve, yield* readJson)
      if (!body) return yield* json(422, { _tag: "InvalidRequest" })
      const snapshot = (yield* (yield* AcquisitionRepository).snapshot(businessId))!
      const set = snapshot.sets.find(s => s.id === body.setId)
      if (!set) return yield* json(404, { _tag: "QuestionSetNotFound" })
      // The person approves exactly the ceiling the server would spend each run.
      if (body.acknowledgedMaxProviderCalls !== runCeiling(set.questions.length, body.samples)) return yield* json(409, { _tag: "CeilingMismatch" })
      const sql = yield* SqlClient.SqlClient
      yield* sql`INSERT INTO acq_schedules(business_id, account_id, approved_by_user_id, set_id, cadence, samples, max_provider_calls, alert_drop_points, enabled, next_run_at)
        VALUES (${businessId}, ${session.accountId}, ${session.userId}, ${body.setId}, ${body.cadence}, ${body.samples}, ${body.acknowledgedMaxProviderCalls}, ${body.alertDropPoints ?? 15}, true, now())
        ON CONFLICT (business_id) DO UPDATE SET approved_by_user_id = EXCLUDED.approved_by_user_id, set_id = EXCLUDED.set_id, cadence = EXCLUDED.cadence,
          samples = EXCLUDED.samples, max_provider_calls = EXCLUDED.max_provider_calls, alert_drop_points = EXCLUDED.alert_drop_points,
          enabled = true, paused_reason = NULL, approved_at = now(), updated_at = now(),
          next_run_at = CASE WHEN acq_schedules.enabled THEN acq_schedules.next_run_at ELSE now() END`
      return yield* json(200, yield* readSchedule(businessId))
    }))),
    HttpRouter.post("/api/acquisition/clients/:id/schedule/enabled", client((_, businessId) => Effect.gen(function*() {
      const body = decode(Pause, yield* readJson)
      if (!body) return yield* json(422, { _tag: "InvalidRequest" })
      const sql = yield* SqlClient.SqlClient
      // Turning it back on keeps the approval; a schedule paused for a ceiling mismatch must be approved again.
      const updated = yield* sql`UPDATE acq_schedules SET enabled = ${body.enabled}, updated_at = now(),
          next_run_at = CASE WHEN ${body.enabled} AND next_run_at < now() THEN now() ELSE next_run_at END
        WHERE business_id = ${businessId} AND (${!body.enabled} OR paused_reason IS NULL) RETURNING business_id`
      if (!updated.length) return yield* json(409, { _tag: "ApprovalRequired" })
      return yield* json(200, yield* readSchedule(businessId))
    }))),
  )
}
