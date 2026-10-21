// Ga4SyncRunner (W8): claims one durable GA4 sync job and reads one bounded
// window of daily key-event counts through the binding's authorized, read-only
// connection.
//
// Rules this file enforces:
//  - Authority is re-proved per attempt: the binding is still the active one,
//    the connection is still ACTIVE, the property is still readable by the
//    authorized identity, its time zone still equals the definition's, and the
//    event is still a key event. Anything else stops the job with a stable code.
//  - A rejected refresh token (invalid_grant) or a second 401 suspends the
//    connection (REAUTHORIZATION_REQUIRED). Nothing already recorded changes.
//  - Quota (429 / RESOURCE_EXHAUSTED) waits for the provider's hint or backs
//    off exponentially up to an hour; outages back off up to ten minutes. Both
//    are bounded, then the job fails. There is no unbounded polling.
//  - Recording is one transaction and idempotent: an identical answer becomes
//    an UNCHANGED confirmation, never a second copy of the evidence.
//  - Logs carry ids and codes only. Tokens are decrypted in memory for the
//    duration of one call and never logged or persisted in plaintext.
import { Context, Duration, Effect, Layer, Option } from "effect"
import type { SqlError } from "@effect/sql/SqlError"
import { GrowthGa4Repository, GrowthGa4Refused, type Ga4ClaimedJob, type Ga4JobWork, type RowDecodeError } from "@openrecord/db"
import { canonicalJson, ga4LatestCompleteDay, GA4_REFRESH_DAYS, type Ga4SyncErrorCode } from "@openrecord/contracts"
import {
  Ga4Error, Ga4Provider, getProperty, keyEventReportBody, listKeyEvents, observationDigest, observationEvidence, parseKeyEventReport,
  refreshAccessToken, runReport, type Ga4ProviderConfig, type Ga4ReportPage,
} from "@openrecord/ga4"

export class Ga4SyncRunner extends Context.Tag("Ga4SyncRunner")<
  Ga4SyncRunner,
  { readonly runOnce: () => Effect.Effect<boolean, SqlError | RowDecodeError> }
>() {}

export interface Ga4SyncRunnerOptions {
  readonly workerId?: string
  readonly leaseSeconds?: number
  /** Attempts for outages before the job fails. */
  readonly maxAttempts?: number
  /** Attempts for quota exhaustion before the job fails. */
  readonly quotaMaxAttempts?: number
  /** Tests sharing a database claim and schedule only their own bindings. */
  readonly bindingIds?: ReadonlyArray<string>
  /** Scheduled refreshes; false disables them. */
  readonly schedule?: { readonly intervalHours: number; readonly refreshDays: number; readonly limit: number } | false
  readonly now?: () => number
}
export const GA4_IMPORT_SCHEMA = "openrecord.ga4-import/v1"
const MAX_REPORT_PAGES = 5
const ACCESS_TOKEN_MARGIN_MS = 60_000

/** Outages back off from 15 s to 10 min; quota follows Google's hint or backs off from 60 s to 1 h. */
export const ga4BackoffSeconds = (attempt: number, error: Ga4Error | null): number => {
  const n = Math.max(0, attempt - 1)
  if (error?.kind === "QUOTA") return Math.min(3600, Math.max(error.retryAfterSeconds ?? 0, 60 * 2 ** n))
  return Math.min(600, 15 * 2 ** n)
}

type Outcome = { readonly done: true } | { readonly retry: number; readonly code: Ga4SyncErrorCode; readonly quota?: Record<string, unknown> | null } | { readonly fail: Ga4SyncErrorCode }
const DONE: Outcome = { done: true }
const fail = (code: Ga4SyncErrorCode): Outcome => ({ fail: code })

export const makeGa4SyncRunnerLive = (opts: Ga4SyncRunnerOptions = {}) => Layer.effect(Ga4SyncRunner, Effect.gen(function*() {
  const repo = yield* GrowthGa4Repository
  const config: Ga4ProviderConfig = Option.getOrElse(yield* Effect.serviceOption(Ga4Provider), () => ({ configured: false as const, reason: "MISSING_CLIENT" as const }))
  const workerId = opts.workerId ?? `ga4-worker-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  const leaseSeconds = opts.leaseSeconds ?? 120
  const maxAttempts = opts.maxAttempts ?? 5
  const quotaMaxAttempts = opts.quotaMaxAttempts ?? 8
  const now = opts.now ?? (() => Date.now())
  const fromEnv = (name: string, fallback: number, max: number) => { const n = Number(process.env[name]); return Number.isFinite(n) && n > 0 && n <= max ? n : fallback }
  const schedule = opts.schedule === false ? null : opts.schedule ?? {
    intervalHours: fromEnv("GA4_SYNC_INTERVAL_HOURS", 24, 168), refreshDays: fromEnv("GA4_REFRESH_DAYS", GA4_REFRESH_DAYS, 30), limit: 50,
  }
  let lastScheduledAt = 0
  const log = (message: string, extra: Record<string, unknown> = {}) => Effect.logInfo(message).pipe(Effect.annotateLogs({ component: "ga4-sync-runner", ...extra }))
  const call = <A>(f: () => Promise<A>) => Effect.tryPromise({
    try: f,
    catch: e => e instanceof Ga4Error ? e : new Ga4Error({ kind: "UNAVAILABLE", status: null, providerCode: null, retryAfterSeconds: null }),
  }).pipe(Effect.either)

  const sync = (job: Ga4ClaimedJob, work: Ga4JobWork): Effect.Effect<Outcome, SqlError | RowDecodeError | GrowthGa4Refused> => Effect.gen(function*() {
    if (!config.configured) return fail("NOT_CONFIGURED")
    const { binding, credentials } = work
    if (!work.bindingActive || !work.importerIsMember) return fail("BINDING_INACTIVE")
    if (credentials.status !== "ACTIVE") return fail("CONNECTION_NOT_ACTIVE")
    if (job.dateEnd > ga4LatestCompleteDay(now(), binding.propertyTimeZone)) return fail("RANGE_NOT_COMPLETE")
    const connectionId = credentials.connectionId
    const suspend = (reason: Ga4SyncErrorCode) => repo.suspend(connectionId, reason).pipe(
      Effect.zipRight(log("ga4 connection suspended", { connectionId, reason })), Effect.as(fail("AUTHORIZATION_REVOKED")))

    // Access token: cached ciphertext while valid, otherwise a refresh.
    let accessToken: string | null = null
    if (credentials.accessCiphertext && credentials.accessExpiresAt !== null && credentials.accessExpiresAt - ACCESS_TOKEN_MARGIN_MS > now()) {
      accessToken = config.cipher.decrypt(credentials.accessCiphertext, `${connectionId}:access`)
    }
    const refresh = (): Effect.Effect<string | Outcome, SqlError | RowDecodeError | GrowthGa4Refused> => Effect.gen(function*() {
      const refreshToken = credentials.refreshCiphertext ? config.cipher.decrypt(credentials.refreshCiphertext, `${connectionId}:refresh`) : null
      if (!refreshToken) return yield* suspend("AUTHORIZATION_REVOKED")
      const refreshed = yield* call(() => refreshAccessToken(config.oauth, refreshToken, now()))
      if (refreshed._tag === "Left") {
        if (refreshed.left.kind === "AUTH" || refreshed.left.kind === "INVALID") return yield* suspend("AUTHORIZATION_REVOKED")
        return transient(refreshed.left)
      }
      yield* repo.storeAccessToken(connectionId, config.cipher.encrypt(refreshed.right.accessToken, `${connectionId}:access`), refreshed.right.accessTokenExpiresAt)
      return refreshed.right.accessToken
    })
    const transient = (e: Ga4Error): Outcome => {
      if (e.kind === "QUOTA") return job.attemptCount >= quotaMaxAttempts ? fail("QUOTA_EXHAUSTED") : { retry: ga4BackoffSeconds(job.attemptCount, e), code: "QUOTA_EXHAUSTED" }
      if (e.kind === "UNAVAILABLE") return job.attemptCount >= maxAttempts ? fail("PROVIDER_UNAVAILABLE") : { retry: ga4BackoffSeconds(job.attemptCount, e), code: "PROVIDER_UNAVAILABLE" }
      if (e.kind === "FORBIDDEN" || e.kind === "NOT_FOUND") return fail("PROPERTY_ACCESS_LOST")
      if (e.kind === "INVALID") return fail("PROVIDER_REJECTED")
      return fail("RESPONSE_UNEXPECTED")
    }
    if (accessToken === null) {
      const got = yield* refresh()
      if (typeof got !== "string") return got
      accessToken = got
    }
    // One provider call; a 401 gets exactly one refresh, a second 401 suspends.
    let refreshedOnce = false
    const authorized = <A>(f: (token: string) => Promise<A>): Effect.Effect<A | Outcome, SqlError | RowDecodeError | GrowthGa4Refused> => Effect.gen(function*() {
      const first = yield* call(() => f(accessToken!))
      if (first._tag === "Right") return first.right
      if (first.left.kind !== "AUTH") return transient(first.left)
      if (refreshedOnce) return yield* suspend("AUTHORIZATION_REVOKED")
      refreshedOnce = true
      const got = yield* refresh()
      if (typeof got !== "string") return got
      accessToken = got
      const second = yield* call(() => f(accessToken!))
      if (second._tag === "Right") return second.right
      if (second.left.kind === "AUTH") return yield* suspend("AUTHORIZATION_REVOKED")
      return transient(second.left)
    })
    const isOutcome = (v: unknown): v is Outcome => typeof v === "object" && v !== null && ("done" in v || "retry" in v || "fail" in v)

    const property = yield* authorized(token => getProperty(config.api, token, binding.property))
    if (isOutcome(property)) return property
    if (property.timeZone !== binding.propertyTimeZone) return fail("PROPERTY_TIME_ZONE_CHANGED")
    const keyEvents = yield* authorized(token => listKeyEvents(config.api, token, binding.property))
    if (isOutcome(keyEvents)) return keyEvents
    if (!keyEvents.some(k => k.eventName === binding.eventName)) return fail("KEY_EVENT_NOT_CONFIGURED")

    const request = { property: binding.property, eventName: binding.eventName, dateStart: job.dateStart, dateEnd: job.dateEnd }
    const pages: Ga4ReportPage[] = []
    const bodies: string[] = []
    for (let page = 0; page < MAX_REPORT_PAGES; page++) {
      const offset = pages.reduce((n, p) => n + p.rows.length, 0)
      const answer = yield* authorized(token => runReport(config.api, token, binding.property, keyEventReportBody(request, offset)))
      if (isOutcome(answer)) return answer
      const parsed = parseKeyEventReport(answer.json, request, binding.propertyTimeZone)
      if (!parsed.ok) return fail(parsed.reason)
      pages.push(parsed.page)
      bodies.push(answer.text)
      const collected = offset + parsed.page.rows.length
      if (collected >= parsed.page.rowCount || parsed.page.rows.length === 0) break
      if (page === MAX_REPORT_PAGES - 1) return fail("RESPONSE_UNEXPECTED")
    }
    const evidence = observationEvidence(request, pages)
    const days = evidence.response.rows.map(r => r.day)
    if (new Set(days).size !== days.length) return fail("RESPONSE_UNEXPECTED")
    const responseDigest = observationDigest(evidence)
    // Stored verbatim as the import's raw text: request, normalized answer and Google's own response bodies. No credential is in any of them.
    const rawText = canonicalJson({ schema: GA4_IMPORT_SCHEMA, jobId: job.id, bindingId: binding.id, connectionId, evidence, responseDigest, providerResponses: bodies })
    const recorded = yield* repo.recordObservation(job, workerId, {
      rawText, responseDigest, rows: evidence.response.rows.map(r => ({ day: r.day, value: r.keyEvents })),
      subjectToThresholding: evidence.response.subjectToThresholding, quota: pages[pages.length - 1]?.quota ?? null,
    })
    yield* log("ga4 sync recorded", { jobId: job.id, bindingId: binding.id, outcome: recorded.outcome, days: days.length })
    return DONE
  })

  const runOnce = (): Effect.Effect<boolean, SqlError | RowDecodeError> => Effect.gen(function*() {
    const job = yield* repo.claimJob(workerId, leaseSeconds, opts.bindingIds).pipe(Effect.catchTag("GrowthGa4Refused", () => Effect.succeed(null)))
    if (!job) {
      if (schedule && now() - lastScheduledAt >= 60_000) {
        lastScheduledAt = now()
        const queued = yield* repo.scheduleDue({ ...schedule, ...(opts.bindingIds ? { onlyBindings: opts.bindingIds } : {}) }).pipe(Effect.catchTag("GrowthGa4Refused", () => Effect.succeed(0)))
        if (queued > 0) yield* log("ga4 scheduled syncs queued", { count: queued })
      }
      return false
    }
    const outcome = yield* repo.work(job).pipe(
      Effect.flatMap(work => sync(job, work)),
      Effect.catchTag("GrowthGa4Refused", e => Effect.succeed<Outcome>(e.reason === "JobLeaseLost" ? DONE : fail(e.reason === "BindingInactive" || e.reason === "BindingAuthorNotMember" ? "BINDING_INACTIVE" : e.reason === "Ga4ConnectionNotActive" ? "CONNECTION_NOT_ACTIVE" : "RESPONSE_UNEXPECTED"))),
    )
    const settle = "fail" in outcome
      ? repo.failJob(job, workerId, outcome.fail).pipe(Effect.zipLeft(log("ga4 sync failed", { jobId: job.id, code: outcome.fail })))
      : "retry" in outcome ? repo.retryJob(job, workerId, outcome.retry, outcome.code, outcome.quota ?? null) : Effect.void
    yield* settle.pipe(Effect.catchTag("GrowthGa4Refused", () => Effect.void))
    return true
  }).pipe(Effect.timeout(Duration.seconds(300)), Effect.catchTag("TimeoutException", () => Effect.succeed(false)))

  return { runOnce }
}))
export const Ga4SyncRunnerLive = makeGa4SyncRunnerLive()
