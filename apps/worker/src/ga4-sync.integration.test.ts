// W8 GA4 synchronization, worker side: the runner against the faithful local
// Google stand-in and PostgreSQL. Passing here is MOCK_ADAPTER_PASS: it shows
// the modeled provider behavior, not a live Google Analytics property.
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Context, Effect, Exit, Layer, Redacted, Scope } from "effect"
import { PgClient } from "@effect/sql-pg"
import pg from "pg"
import { GA4_OAUTH_CALLBACK_PATH, type GrowthMetricDefinitionInput } from "@openrecord/contracts"
import {
  GrowthEvaluationRepository, GrowthGa4Repository, GrowthMeasurementRepository, GrowthMeasurementRepositoryLive, GrowthReportRepository, GrowthRepositoriesLive,
  GrowthRepository, RecordRepository, RecordRepositoryLive, type Session,
} from "@openrecord/db"
import { authorizationUrl, exchangeCode, fixtureGa4Config, fixtureGa4Layer, fixtureGoogle, type FixtureDay } from "@openrecord/ga4"
import { Ga4SyncRunner, ga4BackoffSeconds, makeGa4SyncRunnerLive, type Ga4SyncRunnerOptions } from "./ga4-sync-runner.js"

const url = process.env["TEST_DATABASE_URL"] ?? ""
const CLIENT = { clientId: "fixture-client.apps.googleusercontent.com", clientSecret: "fixture-secret-DO-NOT-LEAK", redirectUri: `https://app.example.test${GA4_OAUTH_CALLBACK_PATH}` }
const P1 = "properties/111111"
const EVENT = "book_appointment"
const TZ = "Asia/Makassar"
const metric: GrowthMetricDefinitionInput = { conversionKind: "BOOKING", label: "Bookings", sourceKind: "GA4_AGGREGATE_EXPORT", sourceIdentity: "TEST GA4 property", eventName: EVENT,
  countingSemantics: "EVENT_COUNT", unit: "COUNT", currency: null, reportingTimeZone: TZ, propertyRef: P1 }
const days = (start: string, values: ReadonlyArray<number | null>): Record<string, FixtureDay> => Object.fromEntries(values.flatMap((v, i) => {
  const day = new Date(Date.parse(`${start}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10)
  return v === null ? [] : [[day, { keyEvents: v, eventCount: v + 2 }]]
}))

const suite = url ? describe : describe.skip
suite("GA4 sync runner against a local Google stand-in (MOCK_ADAPTER_PASS, TEST fixtures)", () => {
  type Repos = GrowthRepository | GrowthGa4Repository | GrowthMeasurementRepository | GrowthEvaluationRepository | GrowthReportRepository | RecordRepository
  let pool: pg.Pool, scope: Scope.CloseableScope, ctx: Context.Context<Repos>
  const run = async <A, E>(fx: Effect.Effect<A, E, Repos>): Promise<A> => {
    const r = await Effect.runPromise(Effect.either(Effect.provide(fx, ctx)))
    if (r._tag === "Left") throw r.left
    return r.right
  }
  const ga4 = <A>(f: (r: Context.Tag.Service<GrowthGa4Repository>) => Effect.Effect<A, any, never>) => run(Effect.flatMap(GrowthGa4Repository, r => f(r) as Effect.Effect<A, unknown, never>))
  const refusal = async (p: Promise<unknown>) => { try { await p } catch (e) { return (e as { reason?: string }).reason ?? String(e) } return "no refusal" }
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url }); scope = await Effect.runPromise(Scope.make())
    ctx = await Effect.runPromise(Layer.buildWithScope(Layer.mergeAll(GrowthRepositoriesLive, GrowthMeasurementRepositoryLive, RecordRepositoryLive).pipe(Layer.provide(PgClient.layer({ url: Redacted.make(url) }))), scope)) as unknown as Context.Context<Repos>
  })
  afterAll(async () => { await Effect.runPromise(Scope.close(scope, Exit.void)); await pool.end() })

  const setup = async (data: Record<string, FixtureDay> = days("2026-09-01", [3, 0, 5, 7, null, 2, 4, 6, 1, 3]), opts: { pageSizeCap?: number } = {}) => {
    const g = fixtureGoogle({
      ...CLIENT, ...(opts.pageSizeCap ? { pageSizeCap: opts.pageSizeCap } : {}),
      identities: [{ sub: "1001", email: "agency@example.test", properties: [P1] }],
      properties: [{ name: P1, displayName: "TEST Salon site", account: "accounts/10", accountDisplayName: "TEST Salon", timeZone: TZ,
        keyEvents: [{ eventName: EVENT, countingMethod: "ONCE_PER_EVENT" }], data: { [EVENT]: data } }],
    })
    const config = fixtureGa4Config(g, CLIENT)
    if (!config.configured) throw new Error("fixture config")
    const accountId = String((await pool.query("INSERT INTO accounts(name) VALUES('TEST ga4 worker') RETURNING id")).rows[0].id)
    const userId = String((await pool.query("INSERT INTO users(email,password_hash) VALUES($1,'TEST-only') RETURNING id", [`ga4-${randomUUID()}@example.test`])).rows[0].id)
    await pool.query("INSERT INTO account_users(account_id,user_id) VALUES($1,$2)", [accountId, userId])
    const session: Session = { accountId, userId }
    const profile = await run(Effect.flatMap(GrowthRepository, r => r.registerProduct(session, { name: "TEST Salon", websiteUrl: "https://salon.test", engagement: "CLIENT",
      category: "TEST services", audience: "TEST locals", valueProposition: "TEST positioning", goalStatement: "Increase bookings", metric, idempotencyKey: randomUUID() })))
    const definitionId = profile.primaryGoal.metricDefinition.id
    // What the OAuth callback does: consent, exchange, then store the sealed tokens.
    const verifier = randomUUID() + randomUUID()
    const callback = new URL(g.consent(authorizationUrl(config.oauth, { state: "s".repeat(43), codeVerifier: verifier }), { sub: "1001" }))
    const tokens = await exchangeCode(config.oauth, callback.searchParams.get("code")!, verifier)
    const connection = await ga4(r => r.saveAuthorization(session, null, { googleSubject: "1001", googleEmail: "agency@example.test", grantedScopes: tokens.grantedScopes,
      seal: id => ({ refreshCiphertext: config.cipher.encrypt(tokens.refreshToken!, `${id}:refresh`), accessCiphertext: config.cipher.encrypt(tokens.accessToken, `${id}:access`), accessExpiresAt: tokens.accessTokenExpiresAt }) }))
    const { binding } = await ga4(r => r.bind(session, profile.businessId, { connectionId: connection.id, property: P1, metricDefinitionId: definitionId, eventName: EVENT, idempotencyKey: randomUUID() },
      { propertyDisplayName: "TEST Salon site", propertyAccount: "accounts/10", propertyTimeZone: TZ, keyEventCountingMethod: "ONCE_PER_EVENT" }))
    const runner = async (opts: Ga4SyncRunnerOptions = {}) => {
      const layer = makeGa4SyncRunnerLive({ schedule: false, bindingIds: [binding.id], ...opts }).pipe(Layer.provide(fixtureGa4Layer(config)))
      const svc = await run(Effect.provide(Ga4SyncRunner, layer))
      return () => Effect.runPromise(svc.runOnce())
    }
    const sync = (start: string, end: string, kind: "BACKFILL" | "REFRESH" = "BACKFILL") => ga4(r => r.requestSync(session, profile.businessId, binding.id, { kind, dateStart: start, dateEnd: end, idempotencyKey: randomUUID() }))
    const series = (start: string, end: string) => run(Effect.flatMap(GrowthMeasurementRepository, r => r.series(accountId, profile.businessId, definitionId, start, end)))
    const imports = async () => (await pool.query("SELECT id, provenance, raw_text, row_count FROM growth_metric_imports WHERE business_id=$1 ORDER BY imported_at, id", [profile.businessId])).rows
    const job = async (id: string) => (await pool.query("SELECT status, last_error, attempt_count, not_before FROM growth_ga4_sync_jobs WHERE id=$1", [id])).rows[0]
    const runs = async () => (await pool.query("SELECT outcome, error_code, import_id FROM growth_ga4_sync_runs WHERE binding_id=$1 ORDER BY finished_at, id", [binding.id])).rows
    const now = (id: string) => pool.query("UPDATE growth_ga4_sync_jobs SET not_before=now() WHERE id=$1", [id])
    return { g, config, session, accountId, businessId: profile.businessId, goalId: profile.primaryGoal.id, definitionId, connection, binding, tokens, runner, sync, series, imports, job, runs, now }
  }

  it("records exact daily key-event counts with full provenance and never fabricates a missing day", async () => {
    const f = await setup()
    const { job } = await f.sync("2026-09-01", "2026-09-07")
    expect(await (await f.runner())()).toBe(true)
    expect(await f.job(job.id)).toMatchObject({ status: "SUCCEEDED", last_error: null })
    const s = await f.series("2026-09-01", "2026-09-07")
    expect(s.days.map(d => [d.day, d.value, d.status, d.origin, d.provider ?? null])).toEqual([
      ["2026-09-01", 3, "OK", "REAL", "GA4_DATA_API"], ["2026-09-02", 0, "OK", "REAL", "GA4_DATA_API"], ["2026-09-03", 5, "OK", "REAL", "GA4_DATA_API"],
      ["2026-09-04", 7, "OK", "REAL", "GA4_DATA_API"],
      // No row from Google for 2026-09-05: missing, not zero.
      ["2026-09-05", null, "MISSING", null, null],
      ["2026-09-06", 2, "OK", "REAL", "GA4_DATA_API"], ["2026-09-07", 4, "OK", "REAL", "GA4_DATA_API"],
    ])
    expect(s.timeZone).toBe(TZ)
    const [imp] = await f.imports()
    expect(imp).toMatchObject({ provenance: "AUTHENTICATED_PROVIDER_API", row_count: 6 })
    // Key events, never event counts (the fixture's eventCount is keyEvents + 2).
    const rows = (await pool.query("SELECT day::text, value FROM growth_metric_rows WHERE import_id=$1 ORDER BY day", [imp.id])).rows
    expect(rows.map(r => r.value)).toEqual([3, 0, 5, 7, 2, 4])
    const obs = (await pool.query("SELECT *, requested_start::text AS rs, requested_end::text AS re, observed_start::text AS os, observed_end::text AS oe FROM growth_ga4_observations WHERE import_id=$1", [imp.id])).rows[0]
    expect(obs).toMatchObject({ connection_id: f.connection.id, google_subject: "1001", property: P1, event_name: EVENT, provider_metric: "keyEvents", metric_definition_id: f.definitionId,
      metric_definition_version: 1, time_zone: TZ, subject_to_thresholding: false, supersedes_import_id: null })
    expect(obs.response_digest).toMatch(/^[a-f0-9]{64}$/)
    expect([obs.rs, obs.re, obs.os, obs.oe]).toEqual(["2026-09-01", "2026-09-07", "2026-09-01", "2026-09-07"])
    // The stored evidence is the request, Google's answer and digest: never a credential.
    const raw = String(imp.raw_text)
    expect(raw).toContain('"keyEvents"')
    for (const secret of [...f.g.issuedTokens, CLIENT.clientSecret]) expect(raw).not.toContain(secret)
    expect(await f.runs()).toMatchObject([{ outcome: "RECORDED", error_code: null, import_id: imp.id }])
  })

  it("is idempotent: the same answer is confirmed, not stored twice, including through an overlapping window", async () => {
    const f = await setup()
    const r = await f.runner()
    await f.sync("2026-09-01", "2026-09-07"); await r()
    await f.sync("2026-09-01", "2026-09-07"); await r()
    await f.sync("2026-09-03", "2026-09-06", "REFRESH"); await r()
    expect(await f.imports()).toHaveLength(1)
    expect((await f.runs()).map(x => x.outcome)).toEqual(["RECORDED", "UNCHANGED", "UNCHANGED"])
    const s = await f.series("2026-09-01", "2026-09-07")
    expect(s.conflicts).toEqual([])
    expect(s.revisions).toBeUndefined()
  })

  it("preserves historical provider revisions as revisions, not conflicts, while a different provenance class still conflicts", async () => {
    const f = await setup()
    const r = await f.runner()
    await f.sync("2026-09-01", "2026-09-07"); await r()
    f.g.setDay(P1, EVENT, "2026-09-04", { keyEvents: 9, eventCount: 11 })
    await f.sync("2026-09-01", "2026-09-07"); await r()
    f.g.setDay(P1, EVENT, "2026-09-04", { keyEvents: 10, eventCount: 12 })
    await f.sync("2026-09-04", "2026-09-04", "REFRESH"); await r()
    const all = await f.imports()
    expect(all).toHaveLength(3)
    // Every earlier answer is still on record.
    const values = (await pool.query("SELECT r.value FROM growth_metric_rows r JOIN growth_metric_imports i ON i.id=r.import_id WHERE i.business_id=$1 AND r.day='2026-09-04' ORDER BY i.imported_at, i.id", [f.businessId])).rows.map(x => x.value)
    expect(values).toEqual([7, 9, 10])
    const supersedes = (await pool.query("SELECT supersedes_import_id FROM growth_ga4_observations WHERE business_id=$1 ORDER BY collected_at, import_id", [f.businessId])).rows.map(x => x.supersedes_import_id)
    expect(supersedes).toEqual([null, all[0].id, all[1].id])
    let s = await f.series("2026-09-01", "2026-09-07")
    expect(s.days.find(d => d.day === "2026-09-04")).toMatchObject({ value: 10, status: "OK", origin: "REAL" })
    expect(s.conflicts).toEqual([])
    expect(s.revisions).toEqual([{ day: "2026-09-04", values: [7, 9, 10] }])
    // An operator export that disagrees with Google is a genuine conflict, kept visible.
    await run(Effect.flatMap(GrowthMeasurementRepository, m => m.importDaily(f.session, f.businessId, f.definitionId, {
      provenance: "OPERATOR_SUPPLIED_EXPORT", dateStart: "2026-09-01", dateEnd: "2026-09-01", csv: 'Date,Session source / medium,Sessions,Key events\n20260901,"google / organic",10,4\n' })))
    s = await f.series("2026-09-01", "2026-09-07")
    expect(s.conflicts).toEqual([{ day: "2026-09-01", values: [3, 4] }])
    expect(s.days[0]).toMatchObject({ status: "CONFLICT", value: 4 })
  })

  it("reads every page of a paginated answer", async () => {
    const f = await setup(days("2026-09-01", [1, 2, 3, 4, 5, 6, 7]), { pageSizeCap: 3 })
    await f.sync("2026-09-01", "2026-09-07"); await (await f.runner())()
    const s = await f.series("2026-09-01", "2026-09-07")
    expect(s.days.map(d => d.value)).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(f.g.reportCalls()).toBe(3)
  })

  it("recovers from outages with bounded backoff, and a failed attempt never erases what was recorded", async () => {
    const f = await setup()
    const r = await f.runner({ maxAttempts: 2 })
    await f.sync("2026-09-01", "2026-09-07"); await r()
    const before = await f.series("2026-09-01", "2026-09-07")
    f.g.setDay(P1, EVENT, "2026-09-01", { keyEvents: 30, eventCount: 30 })
    const { job } = await f.sync("2026-09-01", "2026-09-07")
    f.g.failNext(/runReport/, 503, "UNAVAILABLE", 2)
    await r()
    const queued = await f.job(job.id)
    expect(queued).toMatchObject({ status: "QUEUED", last_error: "PROVIDER_UNAVAILABLE", attempt_count: 1 })
    expect(new Date(queued.not_before).getTime()).toBeGreaterThan(Date.now() + 10_000)
    expect(await f.series("2026-09-01", "2026-09-07")).toEqual(before)
    await f.now(job.id); await r()
    expect(await f.job(job.id)).toMatchObject({ status: "FAILED", last_error: "PROVIDER_UNAVAILABLE" })
    expect(await f.series("2026-09-01", "2026-09-07")).toEqual(before)
    // A later request succeeds normally.
    await f.sync("2026-09-01", "2026-09-07"); await r()
    expect((await f.series("2026-09-01", "2026-09-01")).days[0]!.value).toBe(30)
    expect(ga4BackoffSeconds(1, null)).toBe(15)
    expect(ga4BackoffSeconds(10, null)).toBe(600)
  })

  it("waits for quota by the provider's hint, then gives up after a bounded number of attempts", async () => {
    const f = await setup()
    const r = await f.runner({ quotaMaxAttempts: 2 })
    const { job } = await f.sync("2026-09-01", "2026-09-07")
    f.g.failNext(/runReport/, 429, "RESOURCE_EXHAUSTED", 2, 900)
    await r()
    const waiting = await f.job(job.id)
    expect(waiting).toMatchObject({ status: "QUEUED", last_error: "QUOTA_EXHAUSTED" })
    expect(new Date(waiting.not_before).getTime()).toBeGreaterThan(Date.now() + 800_000)
    await f.now(job.id); await r()
    expect(await f.job(job.id)).toMatchObject({ status: "FAILED", last_error: "QUOTA_EXHAUSTED" })
    expect(await f.imports()).toHaveLength(0)
    expect((await f.runs()).map(x => [x.outcome, x.error_code])).toEqual([["RETRYING", "QUOTA_EXHAUSTED"], ["FAILED", "QUOTA_EXHAUSTED"]])
  })

  it("refreshes an expired access token and stores only the new ciphertext", async () => {
    const f = await setup()
    await pool.query("UPDATE growth_ga4_credentials SET access_expires_at=now()-interval '1 minute' WHERE connection_id=$1", [f.connection.id])
    const tokenCalls = () => f.g.calls.filter(c => c.path === "/token").length
    const before = tokenCalls()
    await f.sync("2026-09-01", "2026-09-07"); await (await f.runner())()
    expect(tokenCalls()).toBe(before + 1)
    expect(await f.imports()).toHaveLength(1)
    const creds = (await pool.query("SELECT refresh_ciphertext, access_ciphertext, access_expires_at > now() AS fresh FROM growth_ga4_credentials WHERE connection_id=$1", [f.connection.id])).rows[0]
    expect(creds.fresh).toBe(true)
    for (const secret of f.g.issuedTokens) expect(`${creds.refresh_ciphertext}${creds.access_ciphertext}`).not.toContain(secret)
  })

  it("suspends the connection when Google revokes the grant, and keeps every recorded observation", async () => {
    const f = await setup()
    const r = await f.runner()
    await f.sync("2026-09-01", "2026-09-07"); await r()
    const before = await f.series("2026-09-01", "2026-09-07")
    f.g.revokeIdentity("1001")
    const { job } = await f.sync("2026-09-01", "2026-09-07")
    await r()
    expect(await f.job(job.id)).toMatchObject({ status: "FAILED", last_error: "AUTHORIZATION_REVOKED" })
    const conn = await ga4(x => x.connection(f.accountId, f.connection.id))
    expect(conn).toMatchObject({ status: "REAUTHORIZATION_REQUIRED", statusReason: "AUTHORIZATION_REVOKED" })
    expect(await f.series("2026-09-01", "2026-09-07")).toEqual(before)
    expect(await refusal(f.sync("2026-09-01", "2026-09-07"))).toBe("Ga4ConnectionNotActive")
    const events = (await pool.query("SELECT kind FROM growth_ga4_connection_events WHERE connection_id=$1 ORDER BY created_at", [f.connection.id])).rows.map(x => x.kind)
    expect(events).toEqual(["CONNECTED", "AUTHORIZATION_FAILED"])
  })

  it("stops when the identity loses access, the property's time zone changes, or the event is no longer a key event", async () => {
    const lost = await setup()
    const { job } = await lost.sync("2026-09-01", "2026-09-07")
    lost.g.identity("1001")!.properties = []
    await (await lost.runner())()
    expect(await lost.job(job.id)).toMatchObject({ status: "FAILED", last_error: "PROPERTY_ACCESS_LOST" })

    const moved = await setup()
    const second = await moved.sync("2026-09-01", "2026-09-07")
    moved.g.property(P1)!.timeZone = "UTC"
    await (await moved.runner())()
    expect(await moved.job(second.job.id)).toMatchObject({ status: "FAILED", last_error: "PROPERTY_TIME_ZONE_CHANGED" })

    const unmarked = await setup()
    const third = await unmarked.sync("2026-09-01", "2026-09-07")
    unmarked.g.property(P1)!.keyEvents = []
    await (await unmarked.runner())()
    expect(await unmarked.job(third.job.id)).toMatchObject({ status: "FAILED", last_error: "KEY_EVENT_NOT_CONFIGURED" })
    for (const f of [lost, moved, unmarked]) expect(await f.imports()).toHaveLength(0)
  })

  it("records thresholded answers with their flag and refuses sampled ones", async () => {
    const f = await setup()
    f.g.property(P1)!.flags = { thresholded: true }
    await f.sync("2026-09-01", "2026-09-02"); await (await f.runner())()
    expect((await pool.query("SELECT subject_to_thresholding FROM growth_ga4_observations WHERE business_id=$1", [f.businessId])).rows[0].subject_to_thresholding).toBe(true)
    f.g.property(P1)!.flags = { sampled: true }
    const { job } = await f.sync("2026-09-03", "2026-09-04"); await (await f.runner())()
    expect(await f.job(job.id)).toMatchObject({ status: "FAILED", last_error: "RESPONSE_SAMPLED" })
  })

  it("concurrent workers and a crashed worker never duplicate evidence", async () => {
    const f = await setup()
    const a = await f.runner({ workerId: "worker-a" }), b = await f.runner({ workerId: "worker-b" })
    await f.sync("2026-09-01", "2026-09-07")
    const results = await Promise.all([a(), b()])
    expect(results.filter(Boolean)).toHaveLength(1)
    expect(await f.imports()).toHaveLength(1)
    // Only one open job per binding.
    await f.sync("2026-09-01", "2026-09-05")
    expect(await refusal(f.sync("2026-09-02", "2026-09-06"))).toBe("SyncAlreadyOpen")

    // Crash: worker A claimed and died. Its lease expires; worker B finishes the job.
    const crashed = await run(Effect.flatMap(GrowthGa4Repository, r => r.claimJob("worker-a", 120, [f.binding.id])))
    expect(crashed).not.toBeNull()
    await pool.query("UPDATE growth_ga4_sync_jobs SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [crashed!.id])
    f.g.setDay(P1, EVENT, "2026-09-02", { keyEvents: 8, eventCount: 8 })
    expect(await b()).toBe(true)
    expect(await f.job(crashed!.id)).toMatchObject({ status: "SUCCEEDED" })
    // The stale worker comes back and tries to record the same job: refused, nothing written.
    expect(await refusal(ga4(r => r.recordObservation(crashed!, "worker-a", { rawText: "{}", responseDigest: "a".repeat(64), rows: [], subjectToThresholding: false, quota: null })))).toBe("JobLeaseLost")
    expect(await f.imports()).toHaveLength(2)
  })

  it("schedules bounded refreshes of complete days only, once per interval", async () => {
    const f = await setup()
    expect(await ga4(r => r.scheduleDue({ intervalHours: 24, refreshDays: 3, limit: 10, onlyBindings: [f.binding.id] }))).toBe(1)
    expect(await ga4(r => r.scheduleDue({ intervalHours: 24, refreshDays: 3, limit: 10, onlyBindings: [f.binding.id] }))).toBe(0)
    const scheduled = (await pool.query("SELECT kind, date_start::text, date_end::text, requested_by_user_id FROM growth_ga4_sync_jobs WHERE binding_id=$1", [f.binding.id])).rows[0]
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date())
    const yesterday = new Date(Date.parse(`${today}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10)
    expect(scheduled).toMatchObject({ kind: "SCHEDULED", date_end: yesterday, requested_by_user_id: null })
    expect(scheduled.date_start).toBe(new Date(Date.parse(`${yesterday}T00:00:00Z`) - 2 * 86_400_000).toISOString().slice(0, 10))
    // The scheduled job runs; days Google reports nothing for stay missing.
    expect(await (await f.runner())()).toBe(true)
    expect((await f.runs())[0]).toMatchObject({ outcome: "RECORDED" })
    // Nothing is scheduled for a suspended connection.
    await ga4(r => r.suspend(f.connection.id, "AUTHORIZATION_REVOKED"))
    expect(await ga4(r => r.scheduleDue({ intervalHours: 0.0001, refreshDays: 3, limit: 10, onlyBindings: [f.binding.id] }))).toBe(0)
  })

  it("disconnect erases credentials, cancels queued work and keeps the evidence", async () => {
    const f = await setup()
    await f.sync("2026-09-01", "2026-09-07"); await (await f.runner())()
    const { job } = await f.sync("2026-09-01", "2026-09-03")
    const conn = await ga4(r => r.disconnect(f.session, f.connection.id, true))
    expect(conn).toMatchObject({ status: "DISCONNECTED", revocationConfirmed: true })
    expect((await pool.query("SELECT refresh_ciphertext, access_ciphertext FROM growth_ga4_credentials WHERE connection_id=$1", [f.connection.id])).rows[0]).toEqual({ refresh_ciphertext: null, access_ciphertext: null })
    expect(await f.job(job.id)).toMatchObject({ status: "CANCELLED", last_error: "CONNECTION_NOT_ACTIVE" })
    expect(await f.imports()).toHaveLength(1)
    // The database itself refuses credentials on a disconnected connection.
    await expect(pool.query("UPDATE growth_ga4_credentials SET refresh_ciphertext=$2 WHERE connection_id=$1", [f.connection.id, `v1.k.${"A".repeat(16)}.AAAA.${"A".repeat(22)}`])).rejects.toThrow(/holds no credentials/)
  })

  it("feeds W4 evaluations and W5 reports, and a published report stays byte-identical after later synchronization", async () => {
    const f = await setup(days("2026-09-01", [3, 4, 5, 6, 8, 9, 10]))
    const r = await f.runner()
    await f.sync("2026-09-01", "2026-09-07"); await r()
    const opp = await run(Effect.flatMap(GrowthRepository, g => g.create(f.session, f.businessId, "OPERATOR", { goalId: f.goalId, title: "TEST booking page clarity", problemStatement: "TEST unclear booking",
      audience: "TEST locals", buyerIntent: "Book", targetUrl: null, source: "TEST", proposedChange: "TEST clarify booking", expectedMechanism: "TEST", assumptions: "TEST", uncertainty: "TEST",
      baselineAvailability: "UNKNOWN", ownerUserId: f.session.userId, initialStatus: "PROPOSED", idempotencyKey: randomUUID(), evidence: [{ type: "OPERATOR_HYPOTHESIS", note: "TEST" }] })))
    await run(Effect.flatMap(GrowthRepository, g => g.decide(f.session, f.businessId, opp.id, "APPROVED", { expectedStatus: "PROPOSED", expectedRevision: 1, idempotencyKey: randomUUID(), reason: "TEST approve" })))
    // Declared before the work (the plan table is append-only, so the past declaration is inserted as it would have been).
    await pool.query(`INSERT INTO growth_measurement_plans(opportunity_id,business_id,metric_definition_id,baseline_start,baseline_end,observation_start,observation_end,declared_by_user_id,declared_at,request_key)
      VALUES($1,$2,$3,'2026-09-01','2026-09-03','2026-09-05','2026-09-07',$4,'2026-08-25T00:00:00Z',$5)`, [opp.id, f.businessId, f.definitionId, f.session.userId, randomUUID()])
    await run(Effect.flatMap(GrowthRepository, g => g.recordExecution(f.session, f.businessId, opp.id, { type: "SOURCE_UPDATED", channel: "WEBSITE", target: "TEST booking page",
      description: "TEST clarified the booking button", performedAt: "2026-09-04T03:00:00.000Z", idempotencyKey: randomUUID() })))
    const evaluation = await run(Effect.flatMap(GrowthEvaluationRepository, e => e.evaluate(f.accountId, f.businessId, opp.id)))
    expect(evaluation.reasons.map(x => x.code)).toEqual([])
    expect(evaluation.status).toBe("COMPARABLE")
    expect(evaluation.baseline).toMatchObject({ validDays: 3, validTotal: 12 })
    expect(evaluation.observation).toMatchObject({ validDays: 3, validTotal: 27 })
    expect(evaluation.limitations.join(" ")).toContain("read-only connection")
    expect(evaluation.limitations.join(" ")).not.toContain("Imported values are operator-supplied exports.")

    const preview = await run(Effect.flatMap(GrowthReportRepository, x => x.preview(f.accountId, f.businessId, opp.id)))
    const source = preview.snapshot.sources[0]!
    expect(source).toMatchObject({ provenance: "AUTHENTICATED_PROVIDER_API", observation: { provider: "GA4_DATA_API", connectionId: f.connection.id, property: P1, eventName: EVENT, providerMetric: "keyEvents", timeZone: TZ } })
    expect(JSON.stringify(preview.snapshot)).not.toContain("agency@example.test")
    const { report } = await run(Effect.flatMap(GrowthReportRepository, x => x.publish(f.session, f.businessId, opp.id, { idempotencyKey: randomUUID(), expectedLatestVersion: 0, evidenceDigest: preview.evidenceDigest, nextSteps: null })))
    const stored = async () => (await pool.query("SELECT snapshot_text, snapshot_digest FROM growth_reports WHERE id=$1", [report.id])).rows[0]
    const published = await stored()

    // Google revises a day after publication; the next sync records it.
    f.g.setDay(P1, EVENT, "2026-09-06", { keyEvents: 20, eventCount: 20 })
    await f.sync("2026-09-01", "2026-09-07"); await r()
    expect(await f.imports()).toHaveLength(2)
    expect(await stored()).toEqual(published)
    const reread = await run(Effect.flatMap(GrowthReportRepository, x => x.get(f.accountId, f.businessId, report.id)))
    expect(reread.snapshotDigest).toBe(published.snapshot_digest)
    // The next preview sees the revision, so publishing the old preview is refused.
    const next = await run(Effect.flatMap(GrowthReportRepository, x => x.preview(f.accountId, f.businessId, opp.id)))
    expect(next.evidenceDigest).not.toBe(preview.evidenceDigest)
    expect(next.snapshot.evaluation.caveats.map(c => c.code)).toContain("PROVIDER_REVISED_DAYS")
    expect(next.snapshot.evaluation.observation).toMatchObject({ validTotal: 38 })
  })
})
