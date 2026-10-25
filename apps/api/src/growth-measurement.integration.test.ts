// W3 measurement integration evidence (no provider calls): operator CSV and
// GA4 daily imports bound to immutable definitions, digest replay, refusal
// table, conflict resolution, currency fail-closed behavior, database guards,
// and plan timing. Requires TEST_DATABASE_URL (same gate as other suites).
import { createHash, randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { HttpApp, HttpRouter } from "@effect/platform"
import { Effect, Layer, Redacted, Scope, Exit } from "effect"
import { PgClient } from "@effect/sql-pg"
import pg from "pg"
import type { GrowthMetricImport, GrowthOpportunity, GrowthPlanRead, GrowthSeries } from "@openrecord/contracts"
import type { Session } from "@openrecord/db"
import { AcquisitionRepositoryLive, AuthRepositoryLive, RecordRepositoryLive } from "@openrecord/db"
import { growthMeasurementApi } from "./growth-measurement-routes.js"
import { growthApi } from "./growth-routes.js"
import { requireSession, RepoLayers } from "./router.js"

const url = process.env["TEST_DATABASE_URL"] ?? ""
const digest = (text: string) => createHash("sha256").update(text, "utf8").digest("hex")
const ga4Product = { name: "TEST Measurement signup", websiteUrl: "https://signup.test", engagement: "DOGFOOD", category: "TEST SaaS", audience: "TEST operators", valueProposition: "TEST positioning", goalStatement: "Increase trial signups",
  metric: { conversionKind: "SIGNUP", label: "Trial signups", sourceKind: "GA4_AGGREGATE_EXPORT", sourceIdentity: "TEST GA4", eventName: "trial_signup", countingSemantics: "EVENT_COUNT", unit: "COUNT", currency: null, reportingTimeZone: "UTC", propertyRef: "TEST property" } }
const bookingProduct = { name: "TEST Booking service", websiteUrl: "https://booking.test", engagement: "CLIENT", category: "TEST services", audience: "TEST clients", valueProposition: "TEST positioning", goalStatement: "Increase bookings",
  metric: { conversionKind: "BOOKING", label: "Bookings", sourceKind: "OPERATOR_AGGREGATE_EXPORT", sourceIdentity: "TEST booking system", eventName: null, countingSemantics: "EVENT_COUNT", unit: "COUNT", currency: null, reportingTimeZone: "UTC", propertyRef: null } }
const currencyProduct = { name: "TEST Checkout product", websiteUrl: "https://checkout.test", engagement: "CLIENT", category: "TEST commerce", audience: "TEST buyers", valueProposition: "TEST positioning", goalStatement: "Increase revenue",
  metric: { conversionKind: "PURCHASE", label: "Revenue", sourceKind: "OPERATOR_AGGREGATE_EXPORT", sourceIdentity: "TEST shop", eventName: null, countingSemantics: "SUM", unit: "CURRENCY_MINOR", currency: "USD", reportingTimeZone: "UTC", propertyRef: null } }
const ga4Csv = `# GA4 export
date,session source,session medium,sessions,key events
2026-09-01,direct,(none),10,2
2026-09-01,google,organic,8,4
2026-09-02,direct,(none),7,3
`
const bookingCsv = `# booking system export
date,value
2026-09-01,5
2026-09-02,3
2026-09-04,7
`
const correctionCsv = `date,value
2026-09-01,9
`
const importBody = (csv: string, dateStart = "2026-09-01", dateEnd = "2026-09-05", provenance = "OPERATOR_SUPPLIED_EXPORT") => ({ provenance, dateStart, dateEnd, csv })
const planBody = (baselineStart: string, baselineEnd: string, observationStart: string, observationEnd: string, idempotencyKey: string = randomUUID()) =>
  ({ baselineStart, baselineEnd, observationStart, observationEnd, idempotencyKey })

const suite = url ? describe : describe.skip
suite("growth measurement HTTP, database guards and plans (no provider calls)", () => {
  let pool: pg.Pool, scope: Scope.CloseableScope
  const repos = Layer.mergeAll(
    RepoLayers.GrowthRepositoriesLive, RepoLayers.GrowthMeasurementRepositoryLive, RepoLayers.BusinessRepositoryLive,
    AuthRepositoryLive, RecordRepositoryLive, AcquisitionRepositoryLive,
  ).pipe(Layer.provideMerge(PgClient.layer({ url: Redacted.make(url) })))
  const web = HttpApp.toWebHandlerLayer(
    HttpRouter.concat(growthApi(run => Effect.flatMap(requireSession, ({ session }) => run(session))), growthMeasurementApi(run => Effect.flatMap(requireSession, ({ session }) => run(session)))), repos)
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url }); scope = await Effect.runPromise(Scope.make())
    await Effect.runPromise(Layer.buildWithScope(repos, scope))
  })
  afterAll(async () => { await web.dispose(); await Effect.runPromise(Scope.close(scope, Exit.void)); await pool.end() })
  const call = (method: string, path: string, cookie?: string, body?: unknown) => web.handler(new Request(`http://localhost${path}`, {
    method, headers: { "content-type": "application/json", ...(cookie ? { cookie: `or_session=${cookie}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }))
  const ok = async <T>(response: Promise<Response>): Promise<T> => {
    const r = await response
    if (r.status !== 200) throw new Error(`Expected 200, got ${r.status}: ${await r.text()}`)
    return await r.json() as T
  }
  const fixture = async (product: unknown) => {
    const accountId = String((await pool.query("INSERT INTO accounts(name) VALUES('TEST Measurement API') RETURNING id", [])).rows[0].id)
    const userId = String((await pool.query("INSERT INTO users(email,password_hash) VALUES($1,'TEST-only') RETURNING id", [`measurement-${randomUUID()}@example.test`])).rows[0].id)
    await pool.query("INSERT INTO account_users(account_id,user_id) VALUES($1,$2)", [accountId, userId])
    const cookie = String((await pool.query("INSERT INTO sessions(account_id,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour') RETURNING id", [accountId, userId])).rows[0].id)
    const register = await call("POST", "/api/growth/products", cookie, { ...(product as Record<string, unknown>), idempotencyKey: randomUUID() })
    if (register.status !== 200) throw new Error(`fixture product registration failed: ${register.status} ${await register.text()}`)
    const { profile } = await register.json() as { profile: { businessId: string; primaryGoal: { id: string; metricDefinition: { id: string } } } }
    return { session: { accountId, userId } satisfies Session, cookie, profile,
      businessId: profile.businessId, definitionId: profile.primaryGoal.metricDefinition.id,
      metricPath: `/api/growth/clients/${profile.businessId}/metrics/${profile.primaryGoal.metricDefinition.id}` }
  }
  const importMetric = (f: Awaited<ReturnType<typeof fixture>>, body: unknown) => ok<{ result: { import: GrowthMetricImport; coverage: { daysInRange: number; daysPresent: number; missingDays: number; firstValueDay: string | null; lastValueDay: string | null }; replayed: boolean } }>(call("POST", `${f.metricPath}/imports`, f.cookie, body)).then(r => r.result)
  const series = (f: Awaited<ReturnType<typeof fixture>>, start: string, end: string) => ok<{ series: GrowthSeries }>(call("GET", `${f.metricPath}/series?start=${start}&end=${end}`, f.cookie)).then(r => r.series)
  const createApprovedOpportunity = async (f: Awaited<ReturnType<typeof fixture>>) => {
    const creation = await ok<{ opportunity: GrowthOpportunity }>(call("POST", `/api/growth/clients/${f.businessId}/opportunities`, f.cookie, {
      goalId: f.profile.primaryGoal.id, title: "TEST booked follow-up", problemStatement: "Bookings unclear", audience: "TEST operators", buyerIntent: "Book services", targetUrl: null, source: "TEST fixture investigation",
      proposedChange: "Clarify booking flow", expectedMechanism: "Reduce uncertainty", assumptions: "Operators book", uncertainty: "No impact measured", baselineAvailability: "UNKNOWN",
      ownerUserId: f.session.userId, initialStatus: "PROPOSED", idempotencyKey: randomUUID(),
      evidence: [{ type: "OPERATOR_HYPOTHESIS", note: "TEST operator hypothesis" }] }))
    const approved = await ok<{ opportunity: GrowthOpportunity }>(call("POST", `/api/growth/clients/${f.businessId}/opportunities/${creation.opportunity.id}/approve`, f.cookie, { expectedStatus: "PROPOSED", expectedRevision: 1, idempotencyKey: randomUUID(), reason: "TEST human approval" }))
    return approved.opportunity
  }
  const attestedExecution = async (f: Awaited<ReturnType<typeof fixture>>, opportunityId: string, performedAt: string) => {
    const intervention = String((await pool.query(
      "INSERT INTO interventions(business_id,type,target,performed_at,actor,actor_id,notes,channel,assurance) VALUES($1,'SOURCE_UPDATED','/',$2,'HUMAN',$3,'TEST operator attested execution','WEBSITE','OPERATOR_ATTESTED') RETURNING id",
      [f.businessId, performedAt, f.session.userId])).rows[0].id)
    await pool.query("INSERT INTO growth_initiative_actions(intervention_id,opportunity_id,business_id,request_key,created_by_user_id) VALUES($1,$2,$3,$4,$5)",
      [intervention, opportunityId, f.businessId, randomUUID(), f.session.userId])
    return intervention
  }

  it("requires auth and hides measurement reads/writes from other accounts", async () => {
    const f = await fixture(ga4Product), other = await fixture(bookingProduct)
    expect((await call("GET", `${f.metricPath}/series?start=2026-09-01&end=2026-09-02`)).status).toBe(401)
    for (const [method, path, body] of [["GET", `${f.metricPath}/imports`, undefined], ["GET", `${f.metricPath}/series?start=2026-09-01&end=2026-09-02`, undefined],
      ["POST", `${f.metricPath}/imports`, importBody(bookingCsv, "2026-09-01", "2026-09-05")],
      ["GET", `/api/growth/clients/${f.businessId}/opportunities/${randomUUID()}/measurement-plan`, undefined]] as const) {
      const r = await call(method as "GET", path, other.cookie, body)
      expect(r.status).toBe(404)
      expect(await r.text()).not.toContain(f.definitionId)
    }
  })

  it("imports the operator booking CSV with coverage, replays the digest idempotently and preserves raw bytes", async () => {
    const f = await fixture(bookingProduct)
    const first = await importMetric(f, importBody(bookingCsv, "2026-09-01", "2026-09-05"))
    expect(first.replayed).toBe(false)
    expect(first.import).toMatchObject({ sourceKind: "OPERATOR_AGGREGATE_EXPORT", provenance: "OPERATOR_SUPPLIED_EXPORT", propertyRef: null, dateStart: "2026-09-01", dateEnd: "2026-09-05", timeZone: "UTC", rowCount: 3 })
    expect(first.import.rawDigest).toHaveLength(64)
    expect(first.coverage).toEqual({ daysInRange: 5, daysPresent: 3, missingDays: 2, firstValueDay: "2026-09-01", lastValueDay: "2026-09-04" })
    const replay = await importMetric(f, importBody(bookingCsv, "2026-09-01", "2026-09-05"))
    expect(replay.replayed).toBe(true); expect(replay.import.id).toBe(first.import.id)
    const conflicting = await call("POST", `${f.metricPath}/imports`, f.cookie, importBody(bookingCsv, "2026-09-01", "2026-09-06"))
    expect(conflicting.status).toBe(409)
    expect(((await conflicting.json()) as { reason?: string }).reason).toBe("IdempotencyConflict")
    const stored = await pool.query("SELECT raw_text,raw_digest FROM growth_metric_imports WHERE id=$1", [first.import.id])
    expect(String(stored.rows[0].raw_text)).toBe(bookingCsv)
    expect(String(stored.rows[0].raw_digest)).toBe(digest(bookingCsv))
    const list = await ok<{ imports: ReadonlyArray<GrowthMetricImport> }>(call("GET", `${f.metricPath}/imports`, f.cookie))
    expect(list.imports.map(i => i.id)).toEqual([first.import.id])
  })

  it("refuses malformed, negative, out-of-range, duplicate and cross-format payloads", async () => {
    const f = await fixture(bookingProduct)
    const refuse = async (csv: string, start = "2026-09-01", end = "2026-09-05", reason?: string) => {
      const r = await call("POST", `${f.metricPath}/imports`, f.cookie, importBody(csv, start, end))
      expect(r.status).toBe(422)
      const { reason: got } = await r.json() as { reason: string }
      if (reason) expect(got).toBe(reason)
      expect(got).toBeTruthy()
    }
    await refuse("date,value\n2026-09-01,-5\n", "2026-09-01", "2026-09-05", "InvalidValue")
    await refuse("day,total\n2026-09-01,5\n", "2026-09-01", "2026-09-05", "UnexpectedColumn")
    await refuse("date,value\n2026-09-10,5\n", "2026-09-01", "2026-09-05", "DateOutsideRange")
    await refuse("date,value\n2026-09-01,5\n2026-09-01,6\n", "2026-09-01", "2026-09-05", "DuplicateRow")
    await refuse("date,value\n2026-02-30,5\n", "2026-09-01", "2026-09-05", "InvalidDate")
    await refuse("date,value\n", "2026-09-05", "2026-09-01", "InvalidDateRange")
    const gaps = await call("POST", `${f.metricPath}/imports`, f.cookie, importBody("date,value\n2026-09-01,\n2026-09-02,2.5\n2026-09-03,+7\n"))
    expect(gaps.status).toBe(422)
    expect(((await gaps.json()) as { reason: string }).reason).toBe("InvalidValue")
    // A booking-style file against a GA4 metric is refused cross-format.
    const ga4 = await fixture(ga4Product)
    const cross = await call("POST", `${ga4.metricPath}/imports`, ga4.cookie, importBody(bookingCsv, "2026-09-01", "2026-09-05"))
    expect(cross.status).toBe(422)
    expect(((await cross.json()) as { reason: string }).reason).toBe("UnexpectedColumn")
    const missingKeyEvents = await call("POST", `${ga4.metricPath}/imports`, ga4.cookie, importBody("date,session source,session medium,sessions\n2026-09-01,direct,(none),5\n", "2026-09-01", "2026-09-02"))
    expect(((await missingKeyEvents.json()) as { reason: string }).reason).toBe("ConversionColumnMissing")
  })

  it("aggregates GA4 key events per day and leaves source/medium rows unstored", async () => {
    const f = await fixture(ga4Product)
    const result = await importMetric(f, importBody(ga4Csv, "2026-09-01", "2026-09-02"))
    expect(result.import.rowCount).toBe(2) // day aggregates, not 3 source rows
    expect(result.coverage).toEqual({ daysInRange: 2, daysPresent: 2, missingDays: 0, firstValueDay: "2026-09-01", lastValueDay: "2026-09-02" })
    const s = await series(f, "2026-09-01", "2026-09-02")
    expect(s.days.map(d => [d.day, d.value, d.origin, d.status])).toEqual([
      ["2026-09-01", 6, "REAL", "OK"], // 2+4 aggregated across source/medium rows
      ["2026-09-02", 3, "REAL", "OK"],
    ])
    expect(s.timeZone).toBe("UTC")
    expect(s.conflicts).toEqual([])
    const stored = await pool.query("SELECT count(*)::int AS n FROM growth_metric_rows WHERE import_id=$1", [result.import.id])
    expect(Number(stored.rows[0].n)).toBe(2)
  })

  it("reports series coverage per day and keeps conflicting corrective uploads visible", async () => {
    const f = await fixture(bookingProduct)
    await importMetric(f, importBody(bookingCsv, "2026-09-01", "2026-09-05"))
    await importMetric(f, importBody(correctionCsv, "2026-09-01", "2026-09-03"))
    await importMetric(f, importBody("date,value\n2026-09-01,1\n", "2026-09-01", "2026-09-01", "SYNTHETIC_FIXTURE"))
    const s = await series(f, "2026-09-01", "2026-09-06")
    expect(s.days.map(d => [d.day, d.value, d.origin, d.status])).toEqual([
      ["2026-09-01", 1, "SYNTHETIC", "CONFLICT"], // newest import resolves; disagreement stays listed
      ["2026-09-02", 3, "REAL", "OK"],
      ["2026-09-03", null, null, "MISSING"],
      ["2026-09-04", 7, "REAL", "OK"],
      ["2026-09-05", null, null, "MISSING"],
      ["2026-09-06", null, null, "UNAVAILABLE"],
    ])
    expect(s.conflicts).toEqual([{ day: "2026-09-01", values: [1, 5, 9] }])
    const outside = await series(f, "2026-10-01", "2026-10-03")
    expect(outside.days.every(d => d.status === "UNAVAILABLE")).toBe(true)
    expect((await call("GET", `${f.metricPath}/series?start=2026-09-05&end=2026-09-01`, f.cookie)).status).toBe(422)
    const tooLarge = await call("GET", `${f.metricPath}/series?start=2019-01-01&end=2021-01-01`, f.cookie)
    expect(((await tooLarge.json()) as { reason: string }).reason).toBe("SeriesRangeTooLarge")
  })

  it("fail-closes currency aggregation at the repository and the database guard", async () => {
    const f = await fixture(currencyProduct)
    const refused = await call("POST", `${f.metricPath}/imports`, f.cookie, importBody("date,value\n2026-09-01,1000\n", "2026-09-01", "2026-09-02"))
    expect(refused.status).toBe(409)
    expect(((await refused.json()) as { reason: string }).reason).toBe("CurrencyMeasurementRefused")
    await expect(pool.query(
      `INSERT INTO growth_metric_imports(business_id,metric_definition_id,source_kind,provenance,property_ref,date_start,date_end,time_zone,raw_text,raw_digest,row_count,imported_by_user_id)
       VALUES($1,$2,'OPERATOR_AGGREGATE_EXPORT','OPERATOR_SUPPLIED_EXPORT',NULL,'2026-09-01','2026-09-02','UTC','x',$3,0,$4)`,
      [f.businessId, f.definitionId, "a".repeat(64), f.session.userId])).rejects.toThrow(/SUM\/CURRENCY_MINOR aggregation is not implemented/)
    const rows = await pool.query("SELECT count(*)::int AS n FROM growth_metric_imports WHERE business_id=$1", [f.businessId])
    expect(Number(rows.rows[0].n)).toBe(0)
  })

  it("database guards refuse scope, timezone, property and range drift", async () => {
    const f = await fixture(ga4Product)
    const first = await importMetric(f, importBody(ga4Csv, "2026-09-01", "2026-09-02"))
    const attempt = (overrides: Record<string, unknown>) => pool.query(
      `INSERT INTO growth_metric_imports(business_id,metric_definition_id,source_kind,provenance,property_ref,date_start,date_end,time_zone,raw_text,raw_digest,row_count,imported_by_user_id)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [f.businessId, f.definitionId, overrides.sourceKind ?? "GA4_AGGREGATE_EXPORT", overrides.provenance ?? "OPERATOR_SUPPLIED_EXPORT",
        overrides.propertyRef ?? "TEST property", overrides.dateStart ?? "2026-10-01", overrides.dateEnd ?? "2026-10-02",
        overrides.timeZone ?? "UTC", "x", digest(`t${randomUUID()}`), 0, f.session.userId])
    await expect(attempt({ timeZone: "Europe/Berlin" })).rejects.toThrow(/import timezone mismatch/)
    await expect(attempt({ propertyRef: "OTHER property" })).rejects.toThrow(/import property reference mismatch/)
    await expect(attempt({ sourceKind: "OPERATOR_AGGREGATE_EXPORT" })).rejects.toThrow(/import source kind mismatch/)
    // Rows may exist only inside their import's declared day range.
    await expect(pool.query("INSERT INTO growth_metric_rows(import_id,business_id,day,value) VALUES($1,$2,'2026-09-05',1)",
      [first.import.id, f.businessId])).rejects.toThrow(/import row outside declared range/)
    // Append-only: edits are refused.
    await expect(pool.query("UPDATE growth_metric_imports SET row_count=99 WHERE id=$1", [first.import.id])).rejects.toThrow()
    // Rows cross businesses are impossible: the import pair key does not exist.
    const foreign = await fixture(bookingProduct)
    await expect(pool.query("INSERT INTO growth_metric_rows(import_id,business_id,day,value) VALUES($1,$2,'2026-10-01',1)",
      [first.import.id, foreign.businessId])).rejects.toThrow()
  })

  it("declares plans with corrected windows, replays them, and labels timing against linked executions", async () => {
    const f = await fixture(ga4Product)
    const opportunity = await createApprovedOpportunity(f)
    const planPath = `/api/growth/clients/${f.businessId}/opportunities/${opportunity.id}/measurement-plan`
    const declare = (body: unknown) => ok<{ plan: GrowthPlanRead }>(call("POST", planPath, f.cookie, body)).then(r => r.plan)
    const first = await declare(planBody("2026-08-20", "2026-08-26", "2026-09-01", "2026-09-07", randomUUID()))
    expect(first.timing).toBe("PRE_DECLARED")
    expect(first.firstLinkedExecutionAt).toBeNull()
    expect(first.plan.metricDefinition.id).toBe(f.definitionId)
    expect(first.plan.baselineStart).toBe("2026-08-20")
    expect(first.plan.observationEnd).toBe("2026-09-07")
    const key = first.plan.requestKey
    const replay = await declare(planBody("2026-08-20", "2026-08-26", "2026-09-01", "2026-09-07", key))
    expect(replay.plan.id).toBe(first.plan.id)
    const mismatch = await call("POST", planPath, f.cookie, planBody("2026-08-21", "2026-08-26", "2026-09-01", "2026-09-07", key))
    expect(mismatch.status).toBe(409)
    expect(((await mismatch.json()) as { reason: string }).reason).toBe("IdempotencyConflict")
    for (const windows of [planBody("2026-08-20", "2026-08-27", "2026-08-27", "2026-09-07"), planBody("2027-01-01", "2026-08-27", "2026-09-01", "2026-09-07")]) {
      expect((await call("POST", planPath, f.cookie, windows)).status).toBe(422)
    }
    // Link an operator-attested execution performed after the plan declaration.
    await attestedExecution(f, opportunity.id, new Date(Date.now() + 2000).toISOString())
    expect((await ok<{ plan: GrowthPlanRead }>(call("GET", planPath, f.cookie))).plan.timing).toBe("PRE_DECLARED")
    const firstLinked = (await ok<{ plan: GrowthPlanRead }>(call("GET", planPath, f.cookie))).plan.firstLinkedExecutionAt
    expect(firstLinked).not.toBeNull()
    await new Promise(r => setTimeout(r, 2200))
    const later = await declare(planBody("2026-09-10", "2026-09-11", "2026-09-12", "2026-09-13"))
    expect(later.timing).toBe("DECLARED_AFTER_EXECUTION")
    expect(later.plan.id).not.toBe(first.plan.id)
    const latest = await ok<{ plan: GrowthPlanRead }>(call("GET", planPath, f.cookie))
    expect(latest.plan.plan.id).toBe(later.plan.id)
    expect(latest.plan.timing).toBe("DECLARED_AFTER_EXECUTION")
  })

  it("refuses plans on unapproved initiatives, currency metrics and definition drift", async () => {
    const f = await fixture(ga4Product)
    const proposed = await ok<{ opportunity: GrowthOpportunity }>(call("POST", `/api/growth/clients/${f.businessId}/opportunities`, f.cookie, {
      goalId: f.profile.primaryGoal.id, title: "TEST unapproved", problemStatement: "x", audience: "x", buyerIntent: "x", targetUrl: null, source: "x",
      proposedChange: "x", expectedMechanism: "x", assumptions: "x", uncertainty: "x", baselineAvailability: "UNKNOWN",
      ownerUserId: f.session.userId, initialStatus: "PROPOSED", idempotencyKey: randomUUID(),
      evidence: [{ type: "OPERATOR_HYPOTHESIS", note: "TEST operator hypothesis" }] }))
    const planPath = `/api/growth/clients/${f.businessId}/opportunities/${proposed.opportunity.id}/measurement-plan`
    expect((await call("POST", planPath, f.cookie, planBody("2026-08-20", "2026-08-26", "2026-09-01", "2026-09-07"))).status).toBe(409)
    expect((await ok<{ plan: GrowthPlanRead | null }>(call("GET", planPath, f.cookie))).plan).toBeNull()
    const currency = await fixture(currencyProduct)
    const currencyOpportunity = await createApprovedOpportunity(currency)
    const currencyPlan = await call("POST", `/api/growth/clients/${currency.businessId}/opportunities/${currencyOpportunity.id}/measurement-plan`, currency.cookie,
      planBody("2026-08-20", "2026-08-26", "2026-09-01", "2026-09-07"))
    expect(currencyPlan.status).toBe(409)
    expect(((await currencyPlan.json()) as { reason: string }).reason).toBe("CurrencyMeasurementRefused")
    // Definition drift is refused by the guard on an approved initiative even
    // when the caller bypasses the repository with a foreign definition id.
    const approved = await createApprovedOpportunity(f)
    await expect(pool.query(
      `INSERT INTO growth_measurement_plans(opportunity_id,business_id,metric_definition_id,baseline_start,baseline_end,observation_start,observation_end,declared_by_user_id,request_key)
       VALUES($1,$2,$3,'2026-01-01','2026-01-02','2026-02-01','2026-02-02',$4,$5)`,
      [approved.id, f.businessId, randomUUID(), f.session.userId, randomUUID()])).rejects.toThrow(/plan metric mismatch/)
  })
})
