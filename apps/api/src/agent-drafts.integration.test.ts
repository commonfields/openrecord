import { createHash, randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { Context, Effect, Exit, Layer, Redacted, Scope } from "effect"
import { PgClient } from "@effect/sql-pg"
import pg from "pg"
import { AcquisitionRepository, AcquisitionRepositoryLive, AgentProposalRepository, AgentProposalRepositoryLive, BusinessRepositoryLive, RecordRepository, RecordRepositoryLive, ObservationRepository, ObservationRepositoryLive, hostedMeasurementContext, buildClientReport, acquisitionView, REFERRAL_REPORT_SECTIONS, type Ga4ImportMeta, type Session } from "@openrecord/db"
import { dispatchDraftTool } from "./agent-drafts.js"
const url = process.env["TEST_DATABASE_URL"] ?? ""
const suite = url ? describe : describe.skip
suite("evidence-backed private drafts (TEST fixtures, no provider calls)", () => {
  type Services = AcquisitionRepository | AgentProposalRepository | RecordRepository | ObservationRepository | import("@openrecord/db").BusinessRepository
  let pool: pg.Pool, scope: Scope.CloseableScope, ctx: Context.Context<Services>
  const run = <A, E>(fx: Effect.Effect<A, E, Services>) => Effect.runPromise(Effect.provide(fx, ctx))
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url })
    scope = await Effect.runPromise(Scope.make())
    ctx = await Effect.runPromise(Layer.buildWithScope(Layer.mergeAll(AcquisitionRepositoryLive, AgentProposalRepositoryLive, RecordRepositoryLive, ObservationRepositoryLive, BusinessRepositoryLive).pipe(Layer.provideMerge(PgClient.layer({ url: Redacted.make(url) }))), scope))
  })
  afterAll(async () => { await Effect.runPromise(Scope.close(scope, Exit.succeed(undefined))); await pool.end() })
  const fixture = async () => {
    const accountId = (await pool.query("INSERT INTO accounts(name) VALUES ('TEST agent reports') RETURNING id")).rows[0].id as string
    const userId = (await pool.query("INSERT INTO users(email,password_hash) VALUES ($1,'TEST-only') RETURNING id", [`draft-${randomUUID()}@example.test`])).rows[0].id as string
    await pool.query("INSERT INTO account_users(account_id,user_id) VALUES ($1,$2)", [accountId, userId])
    const session: Session = { accountId, userId }
    const client = await run(Effect.flatMap(RecordRepository, r => r.createClient(session, { name: "TEST report client", websiteUrl: "https://example.test", engagement: "FIXTURE" })))
    const businessId = client.businessId
    const item = await run(Effect.flatMap(RecordRepository, r => r.saveSlot(session, businessId, { slot: 1, subject: "TEST client", predicate: "Breakfast included", valueText: "Yes", valueType: "TEXT", sourceUrl: "https://example.test/rooms", question: "Is breakfast included?", validFrom: "2026-01-01T00:00:00.000Z" })))
    await run(Effect.flatMap(RecordRepository, r => r.approveItem(session, businessId, item.id)))
    return { session, businessId, item }
  }
  const snapshot = (businessId: string) => run(Effect.flatMap(RecordRepository, r => r.snapshot(businessId)))
  const proposals = (f: Awaited<ReturnType<typeof fixture>>) => run(Effect.flatMap(AgentProposalRepository, r => r.listByBusiness(f.session.accountId, f.businessId, null)))
  const prepareReport = async (f: Awaited<ReturnType<typeof fixture>>, input: { start?: string } = {}) => {
    // Select a report end after both clocks. Docker's DB clock can run slightly
    // ahead of the host under load; do not turn that into missing fixture runs.
    const { rows } = await pool.query<{ now: Date }>("SELECT clock_timestamp() AS now")
    const end = new Date(Math.max(Date.now(), rows[0]!.now.getTime()) + 1000)
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(end)
    try { return await run(dispatchDraftTool(f.session.accountId, f.session.userId, f.businessId, "prepare_client_report", { ...input, end: end.toISOString() })) }
    finally { vi.useRealTimers() }
  }

  it("saves reproducible reports and action hypotheses without publishing, execution or private notes", async () => {
    const f = await fixture()
    const batch = await run(Effect.flatMap(RecordRepository, r => r.startRun(f.session, f.businessId, { kind: null, provider: "gemini", requestedModel: "gemini-2.5-flash", samples: 5 })))
    const checks = (await snapshot(f.businessId))!.checks.filter(c => c.runId === batch.id)
    for (const [i, check] of checks.entries()) {
      await pool.query("UPDATE check_runs SET status='RUNNING', started_at=now(), heartbeat_at=now() WHERE id=$1", [check.id])
      const text = "TEST breakfast costs 20 euros"
      const raw = JSON.stringify({ text, fixture: randomUUID() })
      const at = new Date().toISOString()
      const obs = await run(Effect.flatMap(ObservationRepository, r => r.create({ businessId: f.businessId, checkRunId: check.id, provider: "gemini", requestedModel: "gemini-2.5-flash", observedModel: "gemini-2.5-flash", collectedAt: at,
        answerText: text, retrievalMode: "PROVIDER_GROUNDING", modelVersion: "gemini-2.5-flash", retrievalTool: "google_search", requestParameters: { tools: ["google_search"] }, rawResponse: JSON.parse(raw),
        rawDigest: createHash("sha256").update(raw).digest("hex"), rawBytesHex: Buffer.from(raw).toString("hex"), rawContentType: "application/json", providerMetadata: null, synthetic: false, completeRun: true,
        measurementContext: hostedMeasurementContext({ businessId: f.businessId, questionId: check.questionId, checkRunId: check.id, prompt: f.item.question.prompt, provider: "gemini", requestedModel: "gemini-2.5-flash", observedModel: "gemini-2.5-flash", observedAt: at }), citations: [] })))
      if (i < 4) await run(Effect.flatMap(RecordRepository, r => r.judge(f.session, f.businessId, { observationId: obs.id, decision: i === 0 ? "CONTRADICTS" : i === 3 ? "UNKNOWN" : "MATCHES", note: "PRIVATE_REVIEW_SENTINEL", claim: null })))
    }
    await prepareReport(f)
    const report = (await proposals(f)).find(p => p.kind === "PREPARE_CLIENT_REPORT")!
    expect(report.payload!.text).toContain("5 attempted, 5 successful")
    expect(report.payload!.text).toContain("Human review: 4 of 5")
    expect(report.payload!.text).toContain("1 reviewed contradictions, 2 reviewed matches and 1 unknown")
    expect(JSON.stringify(report.payload)).not.toContain("PRIVATE_REVIEW_SENTINEL")
    expect(report.payload!.text).toContain("No completed agency work")
    expect(report.payload!.text).toContain("not been published or delivered")
    expect(createHash("sha256").update(report.payload!.evidenceJson).digest("hex")).toBe(report.payload!.evidenceDigest)
    await expect(pool.query("UPDATE agent_proposals SET payload = '{}'::jsonb WHERE id=$1", [report.id])).rejects.toThrow(/immutable/)
    const approve = () => run(Effect.flatMap(AgentProposalRepository, r => r.approve(f.session.accountId, f.businessId, report.id, f.session.userId, null)))
    expect(await approve()).toMatchObject({ proposal: { status: "APPROVED" }, checkRunId: null })
    expect(await approve()).toMatchObject({ proposal: { status: "APPROVED" }, checkRunId: null })
    await run(dispatchDraftTool(f.session.accountId, f.session.userId, f.businessId, "draft_source_action", { slot: 1, proposedAction: "Clarify the published breakfast policy", assumptions: ["The linked page remains under agency control"], uncertainty: "No causal effect is established", verificationPlan: "Operator records publication, then requests a comparable re-check" }))
    const action = (await proposals(f)).find(p => p.kind === "DRAFT_SOURCE_ACTION")!
    expect(action.payload!.references.filter(c => c.kind === "observation")).toHaveLength(5)
    expect(await run(Effect.flatMap(AgentProposalRepository, r => r.approve(f.session.accountId, f.businessId, action.id, f.session.userId, null)))).toMatchObject({ proposal: { status: "APPROVED" }, checkRunId: null })
    await run(dispatchDraftTool(f.session.accountId, f.session.userId, f.businessId, "draft_source_action", { slot: 1, proposedAction: "Clarify the published policy", assumptions: [], uncertainty: "Unknown effect", verificationPlan: "Re-check after recorded work" }))
    const stale = (await proposals(f)).find(p => p.kind === "DRAFT_SOURCE_ACTION" && p.status === "PROPOSED")!
    const edited = await run(Effect.flatMap(RecordRepository, r => r.saveSlot(f.session, f.businessId, { slot: 1, subject: "TEST client", predicate: "Breakfast included", valueText: "No", valueType: "TEXT", sourceUrl: "https://example.test/rooms", question: f.item.question.prompt, validFrom: "2026-01-01T00:00:00.000Z" })))
    await run(Effect.flatMap(RecordRepository, r => r.approveItem(f.session, f.businessId, edited.id)))
    await expect(run(Effect.flatMap(AgentProposalRepository, r => r.approve(f.session.accountId, f.businessId, stale.id, f.session.userId, null)))).rejects.toThrow()
    await run(Effect.flatMap(AgentProposalRepository, r => r.reject(f.session.accountId, f.businessId, stale.id, f.session.userId)))
    const previous = (await proposals(f)).find(p => p.id === report.id)!
    expect(previous.payload!.evidenceDigest).toBe(report.payload!.evidenceDigest)
    const after = (await snapshot(f.businessId))!
    expect(after.actions).toHaveLength(0)
    expect(after.share).toBeNull()
    expect(after.checks).toHaveLength(5)
    const original = after.checks[0]!
    const reportAt = report.payload!.generatedAt
    const synthetic = buildClientReport({ ...after, checks: [{ ...original, observation: { ...original.observation!, synthetic: true } }, ...after.checks.slice(1)] }, { start: new Date(Date.parse(reportAt)-86400000).toISOString(), end: reportAt }, reportAt)!
    expect(synthetic.text).toContain("1 synthetic and excluded")
    expect(synthetic.text).toContain("of 4 eligible real answers")
  })
  it("refuses foreign evidence, action drafts without observations and excess arguments", async () => {
    const a = await fixture(), b = await fixture()
    await expect(run(dispatchDraftTool(b.session.accountId, b.session.userId, a.businessId, "prepare_client_report", {}))).rejects.toThrow()
    await expect(run(dispatchDraftTool(a.session.accountId, a.session.userId, a.businessId, "prepare_client_report", { publish: true }))).rejects.toThrow()
    await expect(run(dispatchDraftTool(a.session.accountId, a.session.userId, a.businessId, "draft_source_action", { slot: 1, proposedAction: "Publish", assumptions: [], uncertainty: "Unknown", verificationPlan: "Check" }))).rejects.toThrow()
    expect(await proposals(a)).toHaveLength(0)
  })
  it("adds distinct recommendation, referral, conversion and limitation sections to private reports without composite scores or sharing", async () => {
    const f = await fixture()
    const meta = { dataOrigin: "GA4_EXPORT" as const, propertyRef: "TEST property", dateStart: "2026-10-01", dateEnd: "2026-10-07", timeZone: "UTC", attributionBasis: "SESSION_SOURCE_MEDIUM" as const, conversionEvent: null }
    const importCsv = (m: Partial<Ga4ImportMeta>, csv: string) => run(Effect.flatMap(AcquisitionRepository, r => r.importReferrals(f.session, f.businessId, { ...meta, ...m }, csv)))
    await importCsv({ dataOrigin: "SYNTHETIC_FIXTURE" }, "date,session source,session medium,sessions\n20261002,chatgpt.com,referral,777\n")
    const unmeasured = await importCsv({}, "date,session source,session medium,sessions\n20261002,chatgpt.com,referral,10\n20261003,claude.ai,referral,5\n20261004,(direct),(none),100\n")
    const signup = await importCsv({ dateStart: "2026-10-08", dateEnd: "2026-10-14", conversionEvent: "sign_up" }, "date,session source,session medium,sessions,key events\n20261008,chatgpt.com,referral,12,2\n20261009,claude.ai,referral,7,3\n20261009,(direct),(none),100,4\n")
    const set = await run(Effect.flatMap(AcquisitionRepository, r => r.createQuestionSet(f.session, f.businessId, { basis: "FIXTURE", category: "TEST hotels", target: { name: "TEST client", aliases: [], domains: ["example.test"], matchCase: false, ambiguity: null }, competitors: [{ name: "TEST competitor", aliases: [], domains: ["competitor.test"], matchCase: false, ambiguity: null }], questions: [{ group: "CATEGORY_DISCOVERY", prompt: "Which TEST hotel should I consider?" }] })))
    const batch = await run(Effect.flatMap(AcquisitionRepository, r => r.startBatch(f.session, f.businessId, { setId: set.id, scope: "FULL", questionKeys: null, samples: 5, provider: "gemini", requestedModel: "gemini-fixture", acknowledgedMaxProviderCalls: 20 })))
    const check = (await pool.query<{ id: string; question_id: string }>("SELECT id, question_id FROM check_runs WHERE acq_batch_id=$1 ORDER BY acq_sample LIMIT 1", [batch.id])).rows[0]!
    await pool.query("UPDATE check_runs SET status='RUNNING', started_at=now(), heartbeat_at=now(), attempt_count=1 WHERE id=$1", [check.id])
    const text = "TEST client and TEST competitor are options.", at = new Date().toISOString()
    const raw = JSON.stringify({ text, fixture: randomUUID() })
    const observation = await run(Effect.flatMap(ObservationRepository, r => r.create({ businessId: f.businessId, checkRunId: check.id, provider: "gemini", requestedModel: "gemini-fixture", observedModel: "gemini-fixture", collectedAt: at,
      answerText: text, retrievalMode: "PROVIDER_GROUNDING", modelVersion: "gemini-fixture", retrievalTool: "google_search", requestParameters: { tools: ["google_search"] }, rawResponse: JSON.parse(raw),
      rawDigest: createHash("sha256").update(raw).digest("hex"), rawBytesHex: Buffer.from(raw).toString("hex"), rawContentType: "application/json", providerMetadata: null, synthetic: false, completeRun: true,
      measurementContext: hostedMeasurementContext({ businessId: f.businessId, questionId: check.question_id, checkRunId: check.id, prompt: set.questions[0]!.prompt, provider: "gemini", requestedModel: "gemini-fixture", observedModel: "gemini-fixture", observedAt: at }),
      citations: [{ uri: "https://example.test/rooms", title: "TEST evidence", position: 1, attributed: true }] })))
    await run(Effect.flatMap(AcquisitionRepository, r => r.judge(f.session, f.businessId, { observationId: observation.id, mention: "MENTIONED", recommendation: "RECOMMENDED", note: "PRIVATE_ACQ_NOTE" })))
    await prepareReport(f, { start: "2026-10-01T00:00:00.000Z" })
    const report = (await proposals(f)).find(p => p.kind === "PREPARE_CLIENT_REPORT")!
    const parts = report.payload!.text.split("\n\n")
    const headings = REFERRAL_REPORT_SECTIONS.map(h => parts.indexOf(h))
    expect(headings.every(i => i > 0)).toBe(true)
    expect([...headings].sort((a, b) => a - b)).toEqual(headings)
    const body = (k: number) => parts.slice(headings[k]! + 1, headings[k + 1]).join("\n")
    const acq = acquisitionView((await run(Effect.flatMap(AcquisitionRepository, r => r.snapshot(f.businessId))))!)
    expect(body(0)).toContain(`Recommended in ${acq.batches[0]!.metrics.recommendationRate.n} of ${acq.batches[0]!.metrics.recommendationRate.d} reviewed answers`)
    expect(body(0)).toContain("5 planned samples, 4 pending, 1 provider attempts")
    expect(body(0)).toContain("TEST competitor: 1 of 1")
    expect(body(0)).toContain("https://example.test/rooms")
    expect(report.payload!.references).toContainEqual({ kind: "observation", id: observation.id, text: "Acquisition answer evidence" })
    expect(report.payload!.evidenceJson).toContain(observation.rawDigest)
    expect(JSON.stringify(report.payload)).not.toContain("PRIVATE_ACQ_NOTE")
    expect(body(1)).toMatch(/15 AI-attributed sessions out of 115 reported sessions/)
    expect(body(1)).toMatch(/19 AI-attributed sessions out of 119 reported sessions/)
    expect(body(1)).toMatch(/1 synthetic referral import is excluded/)
    expect(body(2)).toMatch(/no conversion event configured; conversions are not measured\. Signups: not measured/)
    expect(body(2)).toMatch(/configured event "sign_up", 5 events from AI-attributed sessions \(ChatGPT: 2; Claude: 3\)\. Signups: 5/)
    expect(body(3)).toMatch(/does not claim that any answer produced a visit/)
    expect(report.payload!.text).not.toContain("777")
    expect([body(0), body(1), body(2)].join("\n")).not.toMatch(/score|caused|led to|resulted in|uplift|ROI\b/i)
    expect(report.payload!.text).toContain("does not prove that the edit caused")
    expect(report.payload!.references.filter(r => r.kind === "referral_import").map(r => r.id).sort()).toEqual([unmeasured.importId, signup.importId].sort())
    expect(report.payload!.evidenceJson).toContain(signup.importId)
    expect(createHash("sha256").update(report.payload!.evidenceJson).digest("hex")).toBe(report.payload!.evidenceDigest)
    expect((await snapshot(f.businessId))!.share).toBeNull()
    expect((await snapshot(f.businessId))!.actions).toHaveLength(0)
  })

})
