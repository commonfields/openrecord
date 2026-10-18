import { createHash, randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Context, Effect, Exit, Layer, Redacted, Scope } from "effect"
import { PgClient } from "@effect/sql-pg"
import pg from "pg"
import { AgentProposalRepository, AgentProposalRepositoryLive, BusinessRepositoryLive, RecordRepository, RecordRepositoryLive, ObservationRepository, ObservationRepositoryLive, hostedMeasurementContext, buildClientReport, type Session } from "@openrecord/db"
import { dispatchDraftTool } from "./agent-drafts.js"
const url = process.env["TEST_DATABASE_URL"] ?? ""
const suite = url ? describe : describe.skip
suite("evidence-backed private drafts (TEST fixtures, no provider calls)", () => {
  type Services = AgentProposalRepository | RecordRepository | ObservationRepository | import("@openrecord/db").BusinessRepository
  let pool: pg.Pool, scope: Scope.CloseableScope, ctx: Context.Context<Services>
  const run = <A, E>(fx: Effect.Effect<A, E, Services>) => Effect.runPromise(Effect.provide(fx, ctx))
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url })
    scope = await Effect.runPromise(Scope.make())
    ctx = await Effect.runPromise(Layer.buildWithScope(Layer.mergeAll(AgentProposalRepositoryLive, RecordRepositoryLive, ObservationRepositoryLive, BusinessRepositoryLive).pipe(Layer.provideMerge(PgClient.layer({ url: Redacted.make(url) }))), scope))
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
    await run(dispatchDraftTool(f.session.accountId, f.session.userId, f.businessId, "prepare_client_report", {}))
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
    const synthetic = buildClientReport({ ...after, checks: [{ ...original, observation: { ...original.observation!, synthetic: true } }, ...after.checks.slice(1)] }, { start: new Date(Date.now()-86400000).toISOString(), end: new Date().toISOString() }, new Date().toISOString())!
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
})
