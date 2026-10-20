// W5 client report integration evidence (no provider calls): software and
// service acceptance workflows end to end over HTTP, frozen snapshots that
// later imports cannot change, versioned corrections, idempotent and
// concurrent publication, share revocation, cross-account isolation and the
// database guards that keep published reports append-only. Plans are
// backdated with SQL only to simulate a plan declared before the action.
// Requires TEST_DATABASE_URL (same gate as other suites).
import { createHash, randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { HttpApp, HttpRouter } from "@effect/platform"
import { Effect, Exit, Layer, Redacted, Scope } from "effect"
import { PgClient } from "@effect/sql-pg"
import pg from "pg"
import type { GrowthOpportunity, GrowthReport, GrowthReportPreview, GrowthReportPublishResult, GrowthReportShare, GrowthReportSummary, PublicGrowthReport } from "@openrecord/contracts"
import type { Session } from "@openrecord/db"
import { AcquisitionRepositoryLive, AuthRepositoryLive, RecordRepositoryLive } from "@openrecord/db"
import { growthMeasurementApi } from "./growth-measurement-routes.js"
import { growthReportApi } from "./growth-report-routes.js"
import { growthApi } from "./growth-routes.js"
import { requireSession, RepoLayers } from "./router.js"

const url = process.env["TEST_DATABASE_URL"] ?? ""
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex")
const metricBase = { countingSemantics: "EVENT_COUNT", unit: "COUNT", currency: null }
const software = { name: "TEST Fixture SaaS", websiteUrl: "https://saas.test", engagement: "DOGFOOD", category: "TEST SaaS", audience: "TEST teams", valueProposition: "TEST positioning", goalStatement: "Increase trial signups",
  metric: { conversionKind: "SIGNUP", label: "Trial signups", sourceKind: "GA4_AGGREGATE_EXPORT", sourceIdentity: "TEST GA4 property", eventName: "trial_signup", reportingTimeZone: "UTC", propertyRef: "TEST property", ...metricBase } }
const service = { name: "TEST Fixture Salon", websiteUrl: "https://salon.test", engagement: "CLIENT", category: "TEST services", audience: "TEST locals", valueProposition: "TEST positioning", goalStatement: "Increase bookings",
  metric: { conversionKind: "BOOKING", label: "Bookings", sourceKind: "OPERATOR_AGGREGATE_EXPORT", sourceIdentity: "TEST booking system", eventName: null, reportingTimeZone: "Asia/Makassar", propertyRef: null, ...metricBase } }

const days = (start: string, end: string) => {
  const out: string[] = []
  for (let ms = Date.parse(`${start}T00:00:00Z`); ms <= Date.parse(`${end}T00:00:00Z`); ms += 86_400_000) out.push(new Date(ms).toISOString().slice(0, 10))
  return out
}
const step = (before: number, after: number) => (day: string) => day <= "2026-09-07" ? before : after
const operatorCsv = (value = step(4, 6), skip: ReadonlyArray<string> = []) =>
  `date,value\n${days("2026-09-01", "2026-09-15").filter(d => !skip.includes(d)).map(d => `${d},${value(d)}`).join("\n")}\n`
const ga4Csv = () => `# GA4 export\ndate,session source,session medium,sessions,key events\n${days("2026-09-01", "2026-09-15")
  .flatMap(d => [`${d},google,organic,20,${step(4, 6)(d) - 1}`, `${d},direct,(none),5,1`]).join("\n")}\n`
const importBody = (csv: string, provenance = "OPERATOR_SUPPLIED_EXPORT", dateStart = "2026-09-01", dateEnd = "2026-09-15") => ({ provenance, dateStart, dateEnd, csv })

const suite = url ? describe : describe.skip
suite("growth client reports over HTTP (immutable snapshots, revocable shares, no provider calls)", () => {
  let pool: pg.Pool, scope: Scope.CloseableScope
  const repos = Layer.mergeAll(
    RepoLayers.GrowthRepositoriesLive, RepoLayers.GrowthMeasurementRepositoryLive, RepoLayers.BusinessRepositoryLive,
    AuthRepositoryLive, RecordRepositoryLive, AcquisitionRepositoryLive,
  ).pipe(Layer.provideMerge(PgClient.layer({ url: Redacted.make(url) })))
  const web = HttpApp.toWebHandlerLayer(HttpRouter.concat(HttpRouter.concat(
    growthApi(run => Effect.flatMap(requireSession, ({ session }) => run(session))),
    growthMeasurementApi(run => Effect.flatMap(requireSession, ({ session }) => run(session)))),
    growthReportApi(run => Effect.flatMap(requireSession, ({ session }) => run(session)))), repos)
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
  const refusal = async (response: Promise<Response>) => { const r = await response; return { status: r.status, reason: ((await r.json()) as { reason?: string }).reason } }
  type Fixture = Awaited<ReturnType<typeof fixture>>
  const fixture = async (product: typeof software | typeof service) => {
    const accountId = String((await pool.query("INSERT INTO accounts(name) VALUES('TEST Report API') RETURNING id", [])).rows[0].id)
    const userId = String((await pool.query("INSERT INTO users(email,password_hash) VALUES($1,'TEST-only') RETURNING id", [`report-${randomUUID()}@example.test`])).rows[0].id)
    await pool.query("INSERT INTO account_users(account_id,user_id) VALUES($1,$2)", [accountId, userId])
    const cookie = String((await pool.query("INSERT INTO sessions(account_id,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour') RETURNING id", [accountId, userId])).rows[0].id)
    const { profile } = await ok<{ profile: { businessId: string; primaryGoal: { id: string; metricDefinition: { id: string } } } }>(
      call("POST", "/api/growth/products", cookie, { ...product, idempotencyKey: randomUUID() }))
    return { session: { accountId, userId } satisfies Session, cookie, businessId: profile.businessId, goalId: profile.primaryGoal.id,
      definitionId: profile.primaryGoal.metricDefinition.id, base: `/api/growth/clients/${profile.businessId}` }
  }
  const opportunity = async (f: Fixture, title: string, approve = true) => {
    const { opportunity: o } = await ok<{ opportunity: GrowthOpportunity }>(call("POST", `${f.base}/opportunities`, f.cookie, {
      goalId: f.goalId, title, problemStatement: "TEST visitors cannot see pricing", audience: "TEST audience", buyerIntent: "TEST intent", targetUrl: null, source: "TEST source",
      proposedChange: "TEST publish a clear pricing explainer", expectedMechanism: "TEST mechanism", assumptions: "TEST internal assumption", uncertainty: "TEST internal uncertainty", baselineAvailability: "UNKNOWN",
      ownerUserId: f.session.userId, initialStatus: "PROPOSED", idempotencyKey: randomUUID(), evidence: [{ type: "OPERATOR_HYPOTHESIS", note: "TEST internal hypothesis note" }] }))
    if (approve) await ok(call("POST", `${f.base}/opportunities/${o.id}/approve`, f.cookie, { expectedStatus: "PROPOSED", expectedRevision: 1, idempotencyKey: randomUUID(), reason: "TEST internal approval reason" }))
    return o.id
  }
  const plan = (f: Fixture, opportunityId: string, declaredAt = "2026-08-25T00:00:00Z") => pool.query(
    `INSERT INTO growth_measurement_plans(opportunity_id,business_id,metric_definition_id,baseline_start,baseline_end,observation_start,observation_end,declared_by_user_id,request_key,declared_at)
      VALUES($1,$2,$3,'2026-09-01','2026-09-07','2026-09-09','2026-09-15',$4,$5,$6)`, [opportunityId, f.businessId, f.definitionId, f.session.userId, randomUUID(), declaredAt])
  const execute = (f: Fixture, opportunityId: string, body: Record<string, unknown> = {}) => ok(call("POST", `${f.base}/opportunities/${opportunityId}/executions`, f.cookie, {
    type: "SOURCE_UPDATED", channel: "WEBSITE", target: "https://saas.test/pricing", description: "TEST internal execution note", performedAt: "2026-09-08T10:00:00Z", idempotencyKey: randomUUID(), ...body }))
  const importMetric = (f: Fixture, body: unknown) => ok(call("POST", `${f.base}/metrics/${f.definitionId}/imports`, f.cookie, body))
  const review = (f: Fixture, opportunityId: string, conclusion: string, reason: string) =>
    ok(call("POST", `${f.base}/opportunities/${opportunityId}/review`, f.cookie, { expectedStatus: "APPROVED", expectedRevision: 2, idempotencyKey: randomUUID(), reason, conclusion }))
  const preview = (f: Fixture, opportunityId: string) => ok<{ preview: GrowthReportPreview }>(call("GET", `${f.base}/opportunities/${opportunityId}/report-preview`, f.cookie)).then(r => r.preview)
  const publishBody = (p: GrowthReportPreview, nextSteps: string | null = null, idempotencyKey: string = randomUUID()) => ({ idempotencyKey, expectedLatestVersion: p.latestVersion, evidenceDigest: p.evidenceDigest, nextSteps })
  const publish = (f: Fixture, opportunityId: string, body: unknown) => call("POST", `${f.base}/opportunities/${opportunityId}/reports`, f.cookie, body)
  const share = (f: Fixture, reportId: string) => ok<{ share: GrowthReportShare }>(call("POST", `${f.base}/reports/${reportId}/share`, f.cookie)).then(r => r.share)
  const open = async (publicId: string) => {
    const r = await call("GET", `/api/public/growth-reports/${publicId}`)
    return { status: r.status, headers: r.headers, text: await r.text() }
  }
  const storedText = async (reportId: string) => String((await pool.query("SELECT snapshot_text FROM growth_reports WHERE id=$1", [reportId])).rows[0].snapshot_text)

  it("software: website initiative, attested execution, GA4 signups, comparable evaluation, human KEEP, frozen shared report", async () => {
    const f = await fixture(software)
    const id = await opportunity(f, "TEST pricing explainer")
    await plan(f, id)
    await execute(f, id)
    await importMetric(f, importBody(ga4Csv()))
    await review(f, id, "KEEP", "TEST keep the explainer and re-check next month")
    const p = await preview(f, id)
    expect(p.latestVersion).toBe(0)
    expect(p.snapshot.publication).toBeNull()
    expect(p.snapshot.evaluation.status).toBe("COMPARABLE")
    expect(p.snapshot.review).toMatchObject({ conclusion: "KEEP", reason: "TEST keep the explainer and re-check next month" })
    expect(p.snapshot.sources).toHaveLength(1)
    const published = await ok<GrowthReportPublishResult>(publish(f, id, publishBody(p, "TEST re-check signups in October")))
    expect(published.replayed).toBe(false)
    const report = published.report
    expect(report).toMatchObject({ version: 1, status: "COMPARABLE", supersedesId: null, superseded: false, evidenceDigest: p.evidenceDigest })
    expect(report.snapshot.publication).toEqual({ version: 1, publishedAt: report.publishedAt, supersedesReportId: null })
    expect(report.snapshot.generatedAt).toBe(report.publishedAt)
    expect(report.snapshot.nextSteps).toBe("TEST re-check signups in October")
    // The exact W4 evaluation is embedded verbatim.
    expect(report.snapshot.evaluation.comparison).toEqual({ basis: "TOTAL_AND_DAILY_MEAN", totalDifference: 14, dailyMeanDifference: 2, dailyMeanPercentChange: 50 })
    // The stored text is the canonical snapshot and the database verified its digest.
    const text = await storedText(report.id)
    expect(sha(text)).toBe(report.snapshotDigest)
    expect(JSON.parse(text)).toEqual(report.snapshot)
    const s = await share(f, report.id)
    expect(s.publicId).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect((await share(f, report.id)).publicId).toBe(s.publicId)
    const view = await open(s.publicId)
    expect(view.status).toBe(200)
    expect(view.headers.get("cache-control")).toBe("no-store")
    expect(view.headers.get("x-robots-tag")).toBe("noindex, nofollow")
    expect(view.headers.get("referrer-policy")).toBe("no-referrer")
    const pub = (JSON.parse(view.text) as { report: PublicGrowthReport }).report
    expect(pub).toMatchObject({ version: 1, status: "COMPARABLE", superseded: false, business: { name: "TEST Fixture SaaS" }, review: { conclusion: "KEEP" }, nextSteps: "TEST re-check signups in October" })
    expect(pub.actions).toEqual([expect.objectContaining({ assurance: "OPERATOR_ATTESTED", association: "THIS_INITIATIVE", channel: "WEBSITE", type: "SOURCE_UPDATED" })])
    expect(pub.caveats.map(c => c.code)).toEqual(["OPERATOR_ATTESTED_ONLY"])
    expect(pub.evidence).toMatchObject({ reportId: report.id, snapshotDigest: report.snapshotDigest, planId: p.snapshot.evaluation.plan!.id })
    expect(pub.evidence.sources[0]!.rawDigest).toHaveLength(64)
    // Never in the client view: user ids, internal notes, approval reasons, raw files, internal hypotheses.
    for (const hidden of [f.session.userId, f.session.accountId, "TEST internal", "session source", "google,organic"]) expect(view.text).not.toContain(hidden)
    const operatorView = await call("GET", `${f.base}/reports/${report.id}`, f.cookie)
    expect(operatorView.headers.get("cache-control")).toBe("no-store")
  })

  it("service: listing and email records, operator CSV, no review yet, same contract and no invented decision", async () => {
    const f = await fixture(service)
    const id = await opportunity(f, "TEST listing and newsletter")
    await plan(f, id)
    await execute(f, id, { type: "LISTING_UPDATED", channel: "THIRD_PARTY_PROFILE", target: "TEST booking listing", performedAt: "2026-09-07T20:00:00Z" })
    await execute(f, id, { type: "CAMPAIGN_SENT", channel: "EMAIL", target: "TEST September newsletter", performedAt: "2026-09-08T03:00:00Z" })
    await importMetric(f, importBody(operatorCsv()))
    const p = await preview(f, id)
    const { report } = await ok<GrowthReportPublishResult>(publish(f, id, publishBody(p)))
    expect(report.snapshot.review).toBeNull()
    expect(report.snapshot.nextSteps).toBeNull()
    const pub = (JSON.parse((await open((await share(f, report.id)).publicId)).text) as { report: PublicGrowthReport }).report
    expect(pub.status).toBe("COMPARABLE")
    expect(pub.review).toBeNull()
    expect(pub.metric).toMatchObject({ label: "Bookings", sourceKind: "OPERATOR_AGGREGATE_EXPORT", timeZone: "Asia/Makassar", unit: "COUNT" })
    expect(pub.actions.map(a => [a.type, a.channel, a.assurance])).toEqual([["LISTING_UPDATED", "THIRD_PARTY_PROFILE", "OPERATOR_ATTESTED"], ["CAMPAIGN_SENT", "EMAIL", "OPERATOR_ATTESTED"]])
    expect(pub.caveats.map(c => c.code)).toEqual(["OPERATOR_ATTESTED_ONLY", "MULTIPLE_INITIATIVE_ACTIONS"])
  })

  it("an indeterminate report publishes truthfully, a later import never changes it, and a correction is a new version", async () => {
    const f = await fixture(service)
    const id = await opportunity(f, "TEST listing refresh")
    await plan(f, id)
    await execute(f, id, { type: "LISTING_UPDATED", channel: "THIRD_PARTY_PROFILE", target: "TEST listing", performedAt: "2026-09-07T20:00:00Z" })
    await importMetric(f, importBody(operatorCsv(step(4, 6), ["2026-09-11"])))
    const p1 = await preview(f, id)
    expect(p1.snapshot.evaluation.status).toBe("INDETERMINATE")
    const v1 = (await ok<GrowthReportPublishResult>(publish(f, id, publishBody(p1)))).report
    expect(v1.snapshot.evaluation.reasons.map(r => r.code)).toEqual(["MISSING_DAYS"])
    expect(v1.snapshot.evaluation.comparison).toBeNull()
    const link = (await share(f, v1.id)).publicId
    const before = { text: await storedText(v1.id), public: (await open(link)).text }
    // New evidence arrives after publication.
    await importMetric(f, importBody("date,value\n2026-09-11,6\n", "OPERATOR_SUPPLIED_EXPORT", "2026-09-11", "2026-09-11"))
    expect(await storedText(v1.id)).toBe(before.text)
    expect((await open(link)).text).toBe(before.public)
    const p2 = await preview(f, id)
    expect(p2.snapshot.evaluation.status).toBe("COMPARABLE")
    expect(p2.evidenceDigest).not.toBe(p1.evidenceDigest)
    expect(p2.latestVersion).toBe(1)
    // Publishing against the old preview or the old version is refused.
    expect(await refusal(publish(f, id, { ...publishBody(p2), evidenceDigest: p1.evidenceDigest }))).toEqual({ status: 409, reason: "ReportEvidenceChanged" })
    expect(await refusal(publish(f, id, publishBody(p1)))).toEqual({ status: 409, reason: "StaleReport" })
    const v2 = (await ok<GrowthReportPublishResult>(publish(f, id, publishBody(p2, "TEST corrected after the missing day arrived")))).report
    expect(v2).toMatchObject({ version: 2, supersedesId: v1.id, status: "COMPARABLE" })
    expect(v2.snapshot.sources).toHaveLength(2)
    const list = await ok<{ reports: GrowthReportSummary[] }>(call("GET", `${f.base}/opportunities/${id}/reports`, f.cookie))
    expect(list.reports.map(r => [r.version, r.superseded, r.status, r.share?.status ?? null])).toEqual([[2, false, "COMPARABLE", null], [1, true, "INDETERMINATE", "ACTIVE"]])
    // The old link still shows exactly version 1, now marked superseded.
    const old = (JSON.parse((await open(link)).text) as { report: PublicGrowthReport }).report
    expect(old).toMatchObject({ version: 1, status: "INDETERMINATE", superseded: true })
    expect(old.reasons.map(r => r.code)).toEqual(["MISSING_DAYS"])
  })

  it("preserves conflicting, synthetic-only, late-plan, unrelated-activity and zero-baseline limitations in the published report", async () => {
    const f = await fixture(service)
    const late = await opportunity(f, "TEST late plan")
    const other = await opportunity(f, "TEST unrelated promotion")
    await execute(f, late, { type: "LISTING_UPDATED", channel: "THIRD_PARTY_PROFILE", target: "TEST listing", performedAt: "2026-09-07T20:00:00Z" })
    await plan(f, late, "2026-09-10T00:00:00Z")
    await execute(f, other, { type: "CAMPAIGN_SENT", channel: "EMAIL", target: "TEST promo", performedAt: "2026-09-10T03:00:00Z" })
    await importMetric(f, importBody(operatorCsv(step(4, 6), days("2026-09-09", "2026-09-15"))))
    await importMetric(f, importBody(operatorCsv(() => 5, days("2026-09-01", "2026-09-08")), "SYNTHETIC_FIXTURE", "2026-09-09", "2026-09-15"))
    await importMetric(f, importBody("date,value\n2026-09-02,9\n", "OPERATOR_SUPPLIED_EXPORT", "2026-09-02", "2026-09-02"))
    const p = await preview(f, late)
    const { report } = await ok<GrowthReportPublishResult>(publish(f, late, publishBody(p)))
    const pub = (JSON.parse((await open((await share(f, report.id)).publicId)).text) as { report: PublicGrowthReport }).report
    expect(pub.status).toBe("INDETERMINATE")
    expect(pub.reasons.map(r => r.code)).toEqual(["PLAN_DECLARED_AFTER_EXECUTION", "CONFLICTING_DAYS", "SYNTHETIC_DAYS"])
    expect(pub.plan?.timing).toBe("DECLARED_AFTER_EXECUTION")
    expect(pub.observation?.syntheticDays).toHaveLength(7)
    expect(pub.caveats.map(c => c.code)).toContain("OTHER_ACTIONS_IN_PERIOD")
    expect(pub.actions.find(a => a.association === "OTHER_INITIATIVE")).toMatchObject({ initiativeTitle: "TEST unrelated promotion", assurance: "OPERATOR_ATTESTED" })
    expect(pub.comparison).toBeNull()

    const zero = await fixture(service)
    const z = await opportunity(zero, "TEST first listing")
    await plan(zero, z)
    await execute(zero, z, { type: "LISTING_UPDATED", channel: "THIRD_PARTY_PROFILE", target: "TEST listing", performedAt: "2026-09-07T20:00:00Z" })
    await importMetric(zero, importBody(operatorCsv(step(0, 2))))
    const zp = await preview(zero, z)
    const zr = (await ok<GrowthReportPublishResult>(publish(zero, z, publishBody(zp)))).report
    expect(zr.snapshot.evaluation.comparison).toMatchObject({ dailyMeanPercentChange: null, totalDifference: 14 })
    expect(zr.snapshot.evaluation.caveats.map(c => c.code)).toContain("ZERO_BASELINE")
  })

  it("replays repeated publication, rejects conflicting request identities, and serializes concurrent attempts", async () => {
    const f = await fixture(software)
    const id = await opportunity(f, "TEST concurrent publish")
    await plan(f, id)
    await execute(f, id)
    await importMetric(f, importBody(ga4Csv()))
    const p = await preview(f, id)
    const key = randomUUID()
    const same = await Promise.all([1, 2, 3].map(() => publish(f, id, publishBody(p, "TEST next", key)).then(r => r.json() as Promise<GrowthReportPublishResult>)))
    expect(new Set(same.map(r => r.report.id)).size).toBe(1)
    expect(same.filter(r => !r.replayed)).toHaveLength(1)
    const replay = await ok<GrowthReportPublishResult>(publish(f, id, publishBody(p, "TEST next", key)))
    expect(replay).toMatchObject({ replayed: true, report: { id: same[0]!.report.id, version: 1 } })
    expect(await refusal(publish(f, id, publishBody(p, "TEST different next steps", key)))).toEqual({ status: 409, reason: "IdempotencyConflict" })
    const p2 = await preview(f, id)
    const racing = await Promise.all([1, 2, 3].map(() => publish(f, id, publishBody(p2))))
    expect(racing.map(r => r.status).sort()).toEqual([200, 409, 409])
    const rows = await pool.query("SELECT version FROM growth_reports WHERE opportunity_id=$1 ORDER BY version", [id])
    expect(rows.rows.map(r => r.version)).toEqual([1, 2])
    expect(await refusal(publish(f, id, { ...publishBody(p2), extra: true }))).toEqual({ status: 422, reason: undefined })
  })

  it("revoked and unknown links are indistinguishable, and other accounts cannot see or manage reports", async () => {
    const f = await fixture(software), other = await fixture(software)
    const id = await opportunity(f, "TEST share lifecycle")
    await plan(f, id)
    await execute(f, id)
    await importMetric(f, importBody(ga4Csv()))
    const { report } = await ok<GrowthReportPublishResult>(publish(f, id, publishBody(await preview(f, id))))
    const first = await share(f, report.id)
    expect((await open(first.publicId)).status).toBe(200)
    await ok(call("POST", `${f.base}/reports/${report.id}/share/revoke`, f.cookie))
    const revoked = await open(first.publicId), unknown = await open("A".repeat(43)), malformed = await open("not-a-capability")
    for (const r of [revoked, unknown, malformed]) {
      expect(r.status).toBe(404)
      expect(r.text).toBe(revoked.text)
      expect(r.headers.get("cache-control")).toBe("no-store")
    }
    const second = await share(f, report.id)
    expect(second.publicId).not.toBe(first.publicId)
    expect((await open(first.publicId)).status).toBe(404)
    expect((await open(second.publicId)).status).toBe(200)

    expect((await call("GET", `${f.base}/opportunities/${id}/report-preview`)).status).toBe(401)
    for (const [method, path, body] of [
      ["GET", `${f.base}/opportunities/${id}/report-preview`, undefined], ["GET", `${f.base}/opportunities/${id}/reports`, undefined],
      ["POST", `${f.base}/opportunities/${id}/reports`, { idempotencyKey: randomUUID(), expectedLatestVersion: 1, evidenceDigest: report.evidenceDigest, nextSteps: null }],
      ["GET", `${f.base}/reports/${report.id}`, undefined], ["POST", `${f.base}/reports/${report.id}/share`, undefined], ["POST", `${f.base}/reports/${report.id}/share/revoke`, undefined],
      ["GET", `${other.base}/reports/${report.id}`, undefined], ["POST", `${other.base}/reports/${report.id}/share/revoke`, undefined],
    ] as const) {
      const r = await call(method, path, other.cookie, body)
      expect(r.status).toBe(404)
      expect(await r.text()).not.toContain(report.snapshotDigest)
    }
    expect((await open(second.publicId)).status).toBe(200)
    expect((await call("GET", `${f.base}/reports/not-a-uuid`, f.cookie)).status).toBe(422)
  })

  it("refuses unapproved initiatives, never mutates evidence, and the database keeps reports append-only", async () => {
    const f = await fixture(software)
    const proposed = await opportunity(f, "TEST still proposed", false)
    const pp = await preview(f, proposed)
    expect(pp.snapshot.evaluation.reasons.map(r => r.code)).toContain("INITIATIVE_NOT_APPROVED")
    expect(await refusal(publish(f, proposed, publishBody(pp)))).toEqual({ status: 409, reason: "ReportInitiativeNotApproved" })

    const id = await opportunity(f, "TEST guarded")
    await plan(f, id)
    await execute(f, id)
    await importMetric(f, importBody(ga4Csv()))
    const tables = ["growth_metric_imports", "growth_metric_rows", "growth_measurement_plans", "growth_opportunity_events", "growth_initiative_actions", "interventions"]
    const counts = async () => Promise.all(tables.map(async t => Number((await pool.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n)))
    const before = await counts()
    const { report } = await ok<GrowthReportPublishResult>(publish(f, id, publishBody(await preview(f, id))))
    expect(await counts()).toEqual(before)
    const s = await share(f, report.id)
    const fails = async (statement: string, params: unknown[] = []) => { await expect(pool.query(statement, params)).rejects.toThrow() }
    await fails("UPDATE growth_reports SET evaluation_status='COMPARABLE' WHERE id=$1", [report.id])
    await fails("DELETE FROM growth_reports WHERE id=$1", [report.id])
    await fails("TRUNCATE growth_reports CASCADE")
    await fails("DELETE FROM growth_report_shares WHERE id=$1", [s.id])
    // A tampered snapshot or a skipped version cannot be inserted directly.
    const text = await storedText(report.id)
    const tampered = text.replace('"status":"COMPARABLE"', '"status":"INDETERMINATE"')
    const insert = (snapshotText: string, digest: string, version: number, supersedes: string | null) => pool.query(
      `INSERT INTO growth_reports(business_id,opportunity_id,version,supersedes_id,evaluation_status,snapshot_text,snapshot_digest,evidence_digest,published_by_user_id,published_at,request_key,request_fingerprint)
       VALUES($1,$2,$3,$4,'COMPARABLE',$5,$6,$7,$8,now(),$9,$7)`, [f.businessId, id, version, supersedes, snapshotText, digest, report.evidenceDigest, f.session.userId, randomUUID()])
    await expect(insert(tampered, report.snapshotDigest, 2, report.id)).rejects.toThrow(/report digest mismatch/)
    await expect(insert(text, report.snapshotDigest, 2, report.id)).rejects.toThrow(/report identity mismatch/)
    await pool.query("UPDATE growth_report_shares SET status='REVOKED', revoked_by_user_id=$2 WHERE id=$1", [s.id, f.session.userId])
    await fails("UPDATE growth_report_shares SET status='ACTIVE', revoked_by_user_id=NULL, revoked_at=NULL WHERE id=$1", [s.id])
    expect(await storedText(report.id)).toBe(text)
    const stored = await ok<{ report: GrowthReport }>(call("GET", `${f.base}/reports/${report.id}`, f.cookie))
    expect(stored.report.snapshotDigest).toBe(report.snapshotDigest)
  })
})
