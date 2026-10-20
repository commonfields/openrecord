// W4 outcome evaluation integration evidence (no provider calls): software and
// service acceptance scenarios through HTTP on one evaluator, every negative
// scenario as INDETERMINATE with named reasons, account scoping, and proof that
// evaluation is a read (no growth or measurement rows are written). Plans are
// backdated with SQL only to simulate a plan declared weeks before the action;
// everything else goes through the operator HTTP routes. Requires
// TEST_DATABASE_URL (same gate as other suites).
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { HttpApp, HttpRouter } from "@effect/platform"
import { Effect, Exit, Layer, Redacted, Scope } from "effect"
import { PgClient } from "@effect/sql-pg"
import pg from "pg"
import type { GrowthOpportunity, GrowthOutcomeEvaluation } from "@openrecord/contracts"
import type { Session } from "@openrecord/db"
import { AcquisitionRepositoryLive, AuthRepositoryLive, RecordRepositoryLive } from "@openrecord/db"
import { growthMeasurementApi } from "./growth-measurement-routes.js"
import { growthApi } from "./growth-routes.js"
import { requireSession, RepoLayers } from "./router.js"

const url = process.env["TEST_DATABASE_URL"] ?? ""
const metricBase = { countingSemantics: "EVENT_COUNT", unit: "COUNT", currency: null }
const software = { name: "TEST Evaluation SaaS", websiteUrl: "https://saas.test", engagement: "DOGFOOD", category: "TEST SaaS", audience: "TEST teams", valueProposition: "TEST positioning", goalStatement: "Increase trial signups",
  metric: { conversionKind: "SIGNUP", label: "Trial signups", sourceKind: "GA4_AGGREGATE_EXPORT", sourceIdentity: "TEST GA4", eventName: "trial_signup", reportingTimeZone: "UTC", propertyRef: "TEST property", ...metricBase } }
const service = { name: "TEST Evaluation salon", websiteUrl: "https://salon.test", engagement: "CLIENT", category: "TEST services", audience: "TEST locals", valueProposition: "TEST positioning", goalStatement: "Increase bookings",
  metric: { conversionKind: "BOOKING", label: "Bookings", sourceKind: "OPERATOR_AGGREGATE_EXPORT", sourceIdentity: "TEST booking system", eventName: null, reportingTimeZone: "Asia/Makassar", propertyRef: null, ...metricBase } }
const currency = { ...service, name: "TEST Evaluation shop", goalStatement: "Increase revenue",
  metric: { ...service.metric, conversionKind: "PURCHASE", label: "Revenue", countingSemantics: "SUM", unit: "CURRENCY_MINOR", currency: "USD" } }

const days = (start: string, end: string) => {
  const out: string[] = []
  for (let ms = Date.parse(`${start}T00:00:00Z`); ms <= Date.parse(`${end}T00:00:00Z`); ms += 86_400_000) out.push(new Date(ms).toISOString().slice(0, 10))
  return out
}
// Baseline 09-01..09-07 at 4/day, action on 09-08, observation 09-09..09-15 at 6/day.
const valueFor = (day: string) => day <= "2026-09-07" ? 4 : 6
const operatorCsv = (skip: ReadonlyArray<string> = [], value = valueFor) =>
  `date,value\n${days("2026-09-01", "2026-09-15").filter(d => !skip.includes(d)).map(d => `${d},${value(d)}`).join("\n")}\n`
// GA4 rows are split across source/medium; W3 sums key events per day.
const ga4Csv = () => `# GA4 export\ndate,session source,session medium,sessions,key events\n${days("2026-09-01", "2026-09-15")
  .flatMap(d => [`${d},google,organic,20,${valueFor(d) - 1}`, `${d},direct,(none),5,1`]).join("\n")}\n`
const importBody = (csv: string, provenance = "OPERATOR_SUPPLIED_EXPORT", dateStart = "2026-09-01", dateEnd = "2026-09-15") => ({ provenance, dateStart, dateEnd, csv })

const suite = url ? describe : describe.skip
suite("growth outcome evaluation over HTTP (descriptive only, no provider calls)", () => {
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
  type Fixture = Awaited<ReturnType<typeof fixture>>
  const fixture = async (product: typeof software) => {
    const accountId = String((await pool.query("INSERT INTO accounts(name) VALUES('TEST Evaluation API') RETURNING id", [])).rows[0].id)
    const userId = String((await pool.query("INSERT INTO users(email,password_hash) VALUES($1,'TEST-only') RETURNING id", [`evaluation-${randomUUID()}@example.test`])).rows[0].id)
    await pool.query("INSERT INTO account_users(account_id,user_id) VALUES($1,$2)", [accountId, userId])
    const cookie = String((await pool.query("INSERT INTO sessions(account_id,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour') RETURNING id", [accountId, userId])).rows[0].id)
    const { profile } = await ok<{ profile: { businessId: string; primaryGoal: { id: string; metricDefinition: { id: string } } } }>(
      call("POST", "/api/growth/products", cookie, { ...product, idempotencyKey: randomUUID() }))
    return { session: { accountId, userId } satisfies Session, cookie, product, businessId: profile.businessId, goalId: profile.primaryGoal.id,
      definitionId: profile.primaryGoal.metricDefinition.id, base: `/api/growth/clients/${profile.businessId}` }
  }
  const approved = async (f: Fixture, title = "TEST initiative") => {
    const { opportunity } = await ok<{ opportunity: GrowthOpportunity }>(call("POST", `${f.base}/opportunities`, f.cookie, {
      goalId: f.goalId, title, problemStatement: "TEST problem", audience: "TEST audience", buyerIntent: "TEST intent", targetUrl: null, source: "TEST source",
      proposedChange: "TEST change", expectedMechanism: "TEST mechanism", assumptions: "TEST assumptions", uncertainty: "TEST uncertainty", baselineAvailability: "UNKNOWN",
      ownerUserId: f.session.userId, initialStatus: "PROPOSED", idempotencyKey: randomUUID(), evidence: [{ type: "OPERATOR_HYPOTHESIS", note: "TEST hypothesis" }] }))
    await ok(call("POST", `${f.base}/opportunities/${opportunity.id}/approve`, f.cookie, { expectedStatus: "PROPOSED", expectedRevision: 1, idempotencyKey: randomUUID(), reason: "TEST human approval" }))
    return opportunity.id
  }
  /** A plan declared on 2026-08-25, before any action: SQL only backdates `declared_at`. */
  const preDeclaredPlan = async (f: Fixture, opportunityId: string, declaredAt = "2026-08-25T00:00:00Z") => {
    await pool.query(`INSERT INTO growth_measurement_plans(opportunity_id,business_id,metric_definition_id,baseline_start,baseline_end,observation_start,observation_end,declared_by_user_id,request_key,declared_at)
      VALUES($1,$2,$3,'2026-09-01','2026-09-07','2026-09-09','2026-09-15',$4,$5,$6)`, [opportunityId, f.businessId, f.definitionId, f.session.userId, randomUUID(), declaredAt])
  }
  const execute = (f: Fixture, opportunityId: string, body: Record<string, unknown>) => ok(call("POST", `${f.base}/opportunities/${opportunityId}/executions`, f.cookie, {
    type: "SOURCE_UPDATED", channel: "WEBSITE", target: "https://saas.test/pricing", description: "TEST clarified the pricing page", performedAt: "2026-09-08T10:00:00Z", idempotencyKey: randomUUID(), ...body }))
  const importMetric = (f: Fixture, body: unknown) => ok(call("POST", `${f.base}/metrics/${f.definitionId}/imports`, f.cookie, body))
  const evaluate = (f: Fixture, opportunityId: string) => ok<{ evaluation: GrowthOutcomeEvaluation }>(call("GET", `${f.base}/opportunities/${opportunityId}/evaluation`, f.cookie)).then(r => r.evaluation)
  const codes = (e: GrowthOutcomeEvaluation) => e.reasons.map(r => r.code)
  const caveats = (e: GrowthOutcomeEvaluation) => e.caveats.map(c => c.code)

  it("software: approved website improvement, attested execution, GA4 signups, comparable real windows", async () => {
    const f = await fixture(software)
    const id = await approved(f)
    await preDeclaredPlan(f, id)
    await execute(f, id, {})
    await importMetric(f, importBody(ga4Csv()))
    const e = await evaluate(f, id)
    expect(e.status).toBe("COMPARABLE")
    expect(e.reasons).toEqual([])
    expect(e.interpretation).toBe("DESCRIPTIVE_ONLY")
    expect(e.goal).toMatchObject({ id: f.goalId, statement: "Increase trial signups", version: 1 })
    expect(e.metric).toMatchObject({ id: f.definitionId, label: "Trial signups", sourceKind: "GA4_AGGREGATE_EXPORT", eventName: "trial_signup", countingSemantics: "EVENT_COUNT", unit: "COUNT", timeZone: "UTC" })
    expect(e.plan).toMatchObject({ timing: "PRE_DECLARED", declarations: 1, baselineStart: "2026-09-01", observationEnd: "2026-09-15" })
    expect(e.baseline).toMatchObject({ days: 7, validDays: 7, coverage: 1, validTotal: 28, dailyMean: { total: 28, days: 7, value: 4 } })
    expect(e.observation).toMatchObject({ days: 7, validDays: 7, validTotal: 42, dailyMean: { value: 6 } })
    expect(e.comparison).toEqual({ basis: "TOTAL_AND_DAILY_MEAN", totalDifference: 14, dailyMeanDifference: 2, dailyMeanPercentChange: 50 })
    expect(e.initiative.decisions.map(d => d.status)).toEqual(["PROPOSED", "APPROVED"])
    expect(e.actions).toHaveLength(1)
    expect(e.actions[0]).toMatchObject({ type: "SOURCE_UPDATED", channel: "WEBSITE", performedAt: "2026-09-08T10:00:00.000Z", performedDay: "2026-09-08", phase: "BETWEEN_WINDOWS",
      assurance: "OPERATOR_ATTESTED", reference: "https://saas.test/pricing", association: "THIS_INITIATIVE", verification: null })
    expect(e.actions[0]!.recordedAt > e.actions[0]!.performedAt).toBe(true)
    expect(caveats(e)).toEqual(["OPERATOR_ATTESTED_ONLY"])
  })

  it("service: listing and email actions, operator booking CSV, comparable on the same evaluator in the metric time zone", async () => {
    const f = await fixture(service as unknown as typeof software)
    const id = await approved(f, "TEST listing refresh")
    await preDeclaredPlan(f, id)
    // 2026-09-07T20:00Z is 04:00 on 09-08 in Asia/Makassar: between the windows.
    await execute(f, id, { type: "LISTING_UPDATED", channel: "THIRD_PARTY_PROFILE", target: "TEST booking listing", description: "TEST refreshed listing photos", performedAt: "2026-09-07T20:00:00Z" })
    await execute(f, id, { type: "CAMPAIGN_SENT", channel: "EMAIL", target: "TEST September newsletter", description: "TEST sent booking reminder", performedAt: "2026-09-08T03:00:00Z" })
    await importMetric(f, importBody(operatorCsv()))
    const e = await evaluate(f, id)
    expect(e.status).toBe("COMPARABLE")
    expect(e.metric).toMatchObject({ label: "Bookings", sourceKind: "OPERATOR_AGGREGATE_EXPORT", timeZone: "Asia/Makassar" })
    expect(e.actions.map(a => [a.type, a.channel, a.performedDay, a.phase])).toEqual([
      ["LISTING_UPDATED", "THIRD_PARTY_PROFILE", "2026-09-08", "BETWEEN_WINDOWS"], ["CAMPAIGN_SENT", "EMAIL", "2026-09-08", "BETWEEN_WINDOWS"]])
    expect(e.comparison).toEqual({ basis: "TOTAL_AND_DAILY_MEAN", totalDifference: 14, dailyMeanDifference: 2, dailyMeanPercentChange: 50 })
    expect(caveats(e)).toEqual(["OPERATOR_ATTESTED_ONLY", "MULTIPLE_INITIATIVE_ACTIONS"])
  })

  it("missing days, conflicting imports and synthetic data are named and never counted", async () => {
    const f = await fixture(service as unknown as typeof software)
    const id = await approved(f)
    await preDeclaredPlan(f, id)
    await execute(f, id, { type: "LISTING_UPDATED", channel: "THIRD_PARTY_PROFILE", target: "TEST listing", performedAt: "2026-09-07T20:00:00Z" })
    await importMetric(f, importBody(operatorCsv(["2026-09-03", "2026-09-11"])))
    const missing = await evaluate(f, id)
    expect(missing.status).toBe("INDETERMINATE")
    expect(codes(missing)).toEqual(["MISSING_DAYS"])
    expect(missing.reasons[0]!.refs).toEqual(["2026-09-03", "2026-09-11"])
    expect(missing.baseline).toMatchObject({ validDays: 6, validTotal: 24, missingDays: ["2026-09-03"] })
    expect(missing.comparison).toBeNull()
    // A narrower corrective upload fills 09-03 but disagrees on 09-04.
    await importMetric(f, importBody("date,value\n2026-09-03,4\n2026-09-04,9\n", "OPERATOR_SUPPLIED_EXPORT", "2026-09-03", "2026-09-04"))
    // Synthetic fixture rows for the observation's missing day.
    await importMetric(f, importBody("date,value\n2026-09-11,6\n", "SYNTHETIC_FIXTURE", "2026-09-11", "2026-09-11"))
    const e = await evaluate(f, id)
    expect(codes(e)).toEqual(["CONFLICTING_DAYS", "SYNTHETIC_DAYS"])
    expect(e.reasons.find(r => r.code === "CONFLICTING_DAYS")!.refs).toEqual(["2026-09-04"])
    expect(e.reasons.find(r => r.code === "SYNTHETIC_DAYS")!.refs).toEqual(["2026-09-11"])
    expect(e.baseline).toMatchObject({ validDays: 6, conflicts: [{ day: "2026-09-04", values: [4, 9] }] })
    expect(e.observation).toMatchObject({ validDays: 6, validTotal: 36, syntheticDays: ["2026-09-11"] })
  })

  it("a later metric version is excluded, never mixed into the goal's version", async () => {
    const f = await fixture(service as unknown as typeof software)
    const id = await approved(f)
    await preDeclaredPlan(f, id)
    await execute(f, id, { type: "LISTING_UPDATED", channel: "THIRD_PARTY_PROFILE", target: "TEST listing", performedAt: "2026-09-07T20:00:00Z" })
    // The operator redefines the metric; the initiative keeps goal/metric v1.
    const { profile } = await ok<{ profile: { primaryGoal: { metricDefinition: { id: string; version: number } } } }>(call("PUT", f.base, f.cookie, {
      category: service.category, audience: service.audience, valueProposition: service.valueProposition, goalStatement: service.goalStatement,
      metric: { ...service.metric, label: "Bookings incl. walk-ins" }, idempotencyKey: randomUUID() }))
    expect(profile.primaryGoal.metricDefinition.version).toBe(2)
    await ok(call("POST", `${f.base}/metrics/${profile.primaryGoal.metricDefinition.id}/imports`, f.cookie, importBody(operatorCsv())))
    const e = await evaluate(f, id)
    expect(e.metric).toMatchObject({ id: f.definitionId, version: 1, label: "Bookings" })
    expect(codes(e)).toEqual(["UNAVAILABLE_DAYS"])
    expect(e.baseline).toMatchObject({ validDays: 0, validTotal: 0, dailyMean: null })
    expect(e.caveats.find(c => c.code === "OTHER_METRIC_VERSIONS_EXCLUDED")).toMatchObject({ refs: [profile.primaryGoal.metricDefinition.id] })
  })

  it("a plan declared after the execution and an action inside a window block the comparison", async () => {
    const f = await fixture(software)
    const late = await approved(f, "TEST late plan")
    await execute(f, late, {})
    await ok(call("POST", `${f.base}/opportunities/${late}/measurement-plan`, f.cookie, { baselineStart: "2026-09-01", baselineEnd: "2026-09-07", observationStart: "2026-09-09", observationEnd: "2026-09-15", idempotencyKey: randomUUID() }))
    await importMetric(f, importBody(ga4Csv()))
    const lateEval = await evaluate(f, late)
    expect(codes(lateEval)).toEqual(["PLAN_DECLARED_AFTER_EXECUTION"])
    expect(lateEval.plan?.timing).toBe("DECLARED_AFTER_EXECUTION")

    const inside = await approved(f, "TEST mid-window action")
    await preDeclaredPlan(f, inside)
    await execute(f, inside, { performedAt: "2026-09-12T10:00:00Z" })
    const insideEval = await evaluate(f, inside)
    expect(codes(insideEval)).toEqual(["EXECUTION_TIMING_INCOMPATIBLE"])
    expect(insideEval.actions.find(a => a.association === "THIS_INITIATIVE")!.phase).toBe("OBSERVATION")
  })

  it("overlapping initiatives and unlinked ledger entries stay visible without being credited", async () => {
    const f = await fixture(software)
    const id = await approved(f, "TEST primary")
    const other = await approved(f, "TEST overlapping campaign")
    await preDeclaredPlan(f, id)
    await execute(f, id, {})
    await execute(f, other, { type: "CAMPAIGN_SENT", channel: "EMAIL", target: "TEST promo email", performedAt: "2026-09-10T09:00:00Z" })
    // A legacy, unlinked ledger entry with no channel or assurance.
    const legacy = String((await pool.query("INSERT INTO interventions(business_id,type,target,performed_at,actor) VALUES($1,'KNOWLEDGE_BASE_UPDATED','TEST help center','2026-09-03T09:00:00Z','UNKNOWN') RETURNING id", [f.businessId])).rows[0].id)
    // Outside the planned period: not listed.
    await pool.query("INSERT INTO interventions(business_id,type,target,performed_at,actor) VALUES($1,'OTHER','TEST unrelated','2026-07-01T09:00:00Z','UNKNOWN')", [f.businessId])
    await importMetric(f, importBody(ga4Csv()))
    const e = await evaluate(f, id)
    expect(e.status).toBe("COMPARABLE")
    expect(e.actions.map(a => [a.association, a.phase, a.assurance])).toEqual([
      ["UNLINKED", "BASELINE", "UNSPECIFIED"], ["THIS_INITIATIVE", "BETWEEN_WINDOWS", "OPERATOR_ATTESTED"], ["OTHER_INITIATIVE", "OBSERVATION", "OPERATOR_ATTESTED"]])
    expect(e.actions[2]!.initiative).toEqual({ id: other, title: "TEST overlapping campaign" })
    expect(e.actions[0]).toMatchObject({ id: legacy, channel: null, actor: "UNKNOWN" })
    expect(caveats(e)).toEqual(["OPERATOR_ATTESTED_ONLY", "UNSPECIFIED_ASSURANCE", "OTHER_ACTIONS_IN_PERIOD"])
  })

  it("a correction stays attributed to its initiative and cannot hide an earlier action from plan timing", async () => {
    const f = await fixture(software)
    const id = await approved(f)
    await preDeclaredPlan(f, id)
    const original = (await execute(f, id, {}) as { opportunity: GrowthOpportunity }).opportunity.executions[0]!.id
    await importMetric(f, importBody(ga4Csv()))
    // Evidence-protocol corrections carry no channel or assurance.
    const correction = String((await pool.query(`INSERT INTO interventions(business_id,type,target,performed_at,actor,notes,supersedes_id,correction_reason)
      VALUES($1,'SOURCE_UPDATED','https://saas.test/pricing','2026-09-08T11:00:00Z','UNKNOWN','TEST corrected time',$2,'TEST time typo') RETURNING id`, [f.businessId, original])).rows[0].id)
    const e = await evaluate(f, id)
    expect(e.actions.map(a => [a.id, a.association, a.assurance])).toEqual([[correction, "THIS_INITIATIVE", "UNSPECIFIED"]])
    expect(codes(e)).toEqual([])
    expect(caveats(e)).toContain("UNSPECIFIED_ASSURANCE")
    // A second correction dated before the plan makes the plan late.
    await pool.query(`INSERT INTO interventions(business_id,type,target,performed_at,actor,supersedes_id,correction_reason)
      VALUES($1,'SOURCE_UPDATED','https://saas.test/pricing','2026-08-20T09:00:00Z','UNKNOWN',$2,'TEST actually earlier')`, [f.businessId, correction])
    const late = await evaluate(f, id)
    expect(late.plan?.timing).toBe("DECLARED_AFTER_EXECUTION")
    expect(codes(late)).toEqual(["PLAN_DECLARED_AFTER_EXECUTION", "EXECUTION_TIMING_INCOMPATIBLE"])
  })

  it("no plan, unapproved initiatives and currency metrics are indeterminate with reasons", async () => {
    const f = await fixture(software)
    const id = await approved(f)
    expect(codes(await evaluate(f, id))).toEqual(["NO_MEASUREMENT_PLAN", "NO_RECORDED_EXECUTION"])
    const shop = await fixture(currency as unknown as typeof software)
    const e = await evaluate(shop, await approved(shop))
    expect(codes(e)).toEqual(["CURRENCY_AGGREGATION_UNSUPPORTED", "NO_MEASUREMENT_PLAN", "NO_RECORDED_EXECUTION"])
    expect(e.metric).toMatchObject({ countingSemantics: "SUM", unit: "CURRENCY_MINOR", currency: "USD" })
    expect(e.baseline).toBeNull()
  })

  it("is account-scoped, operator-only, validated and read-only", async () => {
    const f = await fixture(software), other = await fixture(software)
    const id = await approved(f)
    await preDeclaredPlan(f, id)
    expect((await call("GET", `${f.base}/opportunities/${id}/evaluation`)).status).toBe(401)
    for (const path of [`${f.base}/opportunities/${id}/evaluation`, `${other.base}/opportunities/${id}/evaluation`, `${f.base}/opportunities/${randomUUID()}/evaluation`]) {
      const r = await call("GET", path, other.cookie)
      expect(r.status).toBe(404)
      expect(await r.text()).not.toContain(f.definitionId)
    }
    expect((await call("GET", `${f.base}/opportunities/not-a-uuid/evaluation`, f.cookie)).status).toBe(422)
    const tables = ["growth_metric_imports", "growth_metric_rows", "growth_measurement_plans", "growth_opportunity_events", "growth_initiative_actions", "interventions"]
    const counts = async () => Promise.all(tables.map(async t => Number((await pool.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n)))
    const before = await counts()
    const first = await evaluate(f, id), second = await evaluate(f, id)
    expect(await counts()).toEqual(before)
    expect({ ...first, evaluatedAt: "" }).toEqual({ ...second, evaluatedAt: "" })
  })
})
