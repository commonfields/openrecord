// read_ai_referral_evidence over the real acquisition repository and harness.
// Disposable PostgreSQL TEST fixtures. No provider calls, no live model.
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Context, Effect, Exit, Layer, Redacted, Scope } from "effect"
import { PgClient } from "@effect/sql-pg"
import pg from "pg"
import {
  AcquisitionRepository, AcquisitionRepositoryLive, AgentProposalRepositoryLive, BusinessRepositoryLive, DiscoveryScopeRepositoryLive, FactRepositoryLive,
  ProductReadRepositoryLive, QuestionRepositoryLive, RecordRepository, RecordRepositoryLive, SIGNUPS_NOT_MEASURED, acquisitionReport, acquisitionView, type Ga4ImportMeta, type Session,
} from "@openrecord/db"
import { runAgentTool, type AgentToolDeps } from "./agent-tools.js"

const url = process.env["TEST_DATABASE_URL"] ?? ""
const suite = url ? describe : describe.skip
const meta = { dataOrigin: "GA4_EXPORT" as const, propertyRef: "TEST property", dateStart: "2026-10-01", dateEnd: "2026-10-07", timeZone: "UTC", attributionBasis: "SESSION_SOURCE_MEDIUM" as const, conversionEvent: null }

suite("AI referral evidence tool (TEST fixtures, no provider calls)", () => {
  let pool: pg.Pool, scope: Scope.CloseableScope, ctx: Context.Context<AgentToolDeps>
  const run = <A, E>(fx: Effect.Effect<A, E, AgentToolDeps>) => Effect.runPromise(Effect.provide(fx, ctx))
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url }); scope = await Effect.runPromise(Scope.make())
    ctx = await Effect.runPromise(Layer.buildWithScope(Layer.mergeAll(AcquisitionRepositoryLive, AgentProposalRepositoryLive, BusinessRepositoryLive, DiscoveryScopeRepositoryLive, FactRepositoryLive,
      ProductReadRepositoryLive, QuestionRepositoryLive, RecordRepositoryLive).pipe(Layer.provideMerge(PgClient.layer({ url: Redacted.make(url) }))), scope))
  })
  afterAll(async () => { await Effect.runPromise(Scope.close(scope, Exit.succeed(undefined))); await pool.end() })
  const fixture = async () => {
    const accountId = (await pool.query("INSERT INTO accounts(name) VALUES ('TEST referral agent') RETURNING id")).rows[0].id as string
    const userId = (await pool.query("INSERT INTO users(email,password_hash) VALUES ($1,'TEST-only') RETURNING id", [`agent-ref-${randomUUID()}@example.test`])).rows[0].id as string
    await pool.query("INSERT INTO account_users(account_id,user_id) VALUES ($1,$2)", [accountId, userId])
    const session: Session = { accountId, userId }
    const { businessId } = await run(Effect.flatMap(RecordRepository, r => r.createClient(session, { name: "TEST Supportly", websiteUrl: "https://supportly.test", engagement: "FIXTURE" })))
    const importCsv = (m: Partial<Ga4ImportMeta>, csv: string) =>
      run(Effect.flatMap(AcquisitionRepository, r => r.importReferrals(session, businessId, { ...meta, ...m }, csv)))
    return { session, businessId, importCsv }
  }
  const tool = (accountId: string, businessId: string, input: unknown = {}) => run(Effect.either(runAgentTool(accountId, businessId, "read_ai_referral_evidence", input)))
  const ok = async (accountId: string, businessId: string, input: unknown = {}) => {
    const out = await tool(accountId, businessId, input)
    if (out._tag === "Left") throw new Error(`tool refused: ${String(out.left)}`)
    return out.right as { summary: string; citations: ReadonlyArray<{ kind: string; id: string }>; data: Record<string, any> }
  }

  it("reads scoped real imports, excludes synthetic imports and matches the acquisition read model", async () => {
    const f = await fixture()
    expect((await ok(f.session.accountId, f.businessId)).data).toMatchObject({ state: "REFERRAL_DATA_UNAVAILABLE", signups: SIGNUPS_NOT_MEASURED, imports: [] })
    const synthetic = await f.importCsv({ dataOrigin: "SYNTHETIC_FIXTURE" }, "date,session source,session medium,sessions\n20261002,chatgpt.com,referral,777\n")
    expect((await ok(f.session.accountId, f.businessId)).data).toMatchObject({ state: "REFERRAL_DATA_UNAVAILABLE", syntheticImportsExcluded: 1 })
    expect((await tool(f.session.accountId, f.businessId, { importId: synthetic.importId }))._tag).toBe("Left")
    const real = await f.importCsv({ conversionEvent: "sign_up" },
      "date,session source,session medium,sessions,key events\n20261001,chatgpt.com,referral,12,2\n20261002,claude.ai,referral,4,1\n20261003,gemini.google.com,referral,3,0\n20261003,google,organic,200,9\n")
    const read = await ok(f.session.accountId, f.businessId)
    const snapshot = (await run(Effect.flatMap(AcquisitionRepository, r => r.snapshot(f.businessId))))!
    const model = acquisitionView(snapshot).referrals.find(r => r.id === real.importId)!
    expect(acquisitionReport(snapshot).referrals.imports.map(r => r.id)).toEqual([real.importId])
    const e = read.data["evidence"]
    expect(e.importId).toBe(real.importId)
    expect(e.importDigest).toBe(model.rawDigest)
    expect(e.sessions).toEqual({ aiAttributed: model.aiSessions, totalReported: model.totalSessions })
    expect(e.configuredConversions.total).toBe(model.signups)
    expect(e.signups).toBe(model.signups)
    expect(e.aiReferralSources.map((s: { assistant: string; sessions: number; configuredConversions: number }) => [s.assistant, s.sessions, s.configuredConversions]))
      .toEqual(model.bySource.map(s => [s.assistant, s.sessions, s.conversions]))
    expect(e).toMatchObject({ dataOrigin: "GA4_EXPORT", propertyRef: "TEST property", period: { start: "2026-10-01", end: "2026-10-07", timeZone: "UTC" }, attributionBasis: "SESSION_SOURCE_MEDIUM",
      sessions: { aiAttributed: 19, totalReported: 219 }, signups: 3, sessionLeaders: [{ assistant: "ChatGPT", count: 12 }] })
    expect(read.data).toMatchObject({ realImports: 1, syntheticImportsExcluded: 1 })
    expect(read.citations).toEqual([{ kind: "referral_import", id: real.importId, text: "GA4 export 2026-10-01 to 2026-10-07" }])
    const serialized = JSON.stringify(read)
    expect(serialized).not.toContain("777")
    expect(serialized).not.toContain("20261001")
    expect(serialized).not.toMatch(/raw_text|rawText|"rows"/)
  })

  it("keeps unknown signups unknown, non-signup events distinct, and compares only matching periods", async () => {
    const f = await fixture()
    const first = await f.importCsv({}, "date,session source,session medium,sessions\n20261002,chatgpt.com,referral,10\n20261003,perplexity.ai,referral,5\n")
    const none = await ok(f.session.accountId, f.businessId)
    expect(none.data["evidence"]).toMatchObject({ signups: SIGNUPS_NOT_MEASURED, configuredConversions: { availability: "NOT_CONFIGURED", total: null } })
    expect(JSON.stringify(none.data)).not.toMatch(/"signups":0/)
    const second = await f.importCsv({ dateStart: "2026-10-08", dateEnd: "2026-10-14" }, "date,session source,session medium,sessions\n20261008,chatgpt.com,referral,14\n20261009,claude.ai,referral,2\n")
    expect((await ok(f.session.accountId, f.businessId, { importId: second.importId, beforeImportId: first.importId })).data["comparison"])
      .toMatchObject({ state: "DESCRIPTIVE_PERIODS", aiAttributedSessionDelta: 1, configuredConversionDelta: null })
    const purchase = await f.importCsv({ dateStart: "2026-10-15", dateEnd: "2026-10-21", conversionEvent: "purchase" }, "date,session source,session medium,sessions,key events\n20261015,chatgpt.com,referral,10,2\n")
    const p = await ok(f.session.accountId, f.businessId, { importId: purchase.importId, beforeImportId: second.importId })
    expect(p.data).toMatchObject({ evidence: { signups: SIGNUPS_NOT_MEASURED, configuredConversions: { event: "purchase", total: 2 } }, comparison: { state: "NOT_COMPARABLE", reasons: ["conversion event changed"], aiAttributedSessionDelta: null } })
    expect(p.citations.map(c => c.id)).toEqual([purchase.importId, second.importId])
  })

  it("refuses cross-tenant reads of businesses and imports", async () => {
    const a = await fixture(), b = await fixture()
    const imported = await a.importCsv({}, "date,session source,session medium,sessions\n20261002,chatgpt.com,referral,10\n")
    expect((await tool(b.session.accountId, a.businessId))._tag).toBe("Left")
    const left = await tool(b.session.accountId, a.businessId)
    if (left._tag === "Left") expect((left.left as { _tag: string })._tag).toBe("AgentNotInScope")
    expect((await tool(b.session.accountId, b.businessId, { importId: imported.importId }))._tag).toBe("Left")
    expect((await tool(a.session.accountId, a.businessId, { importId: randomUUID() }))._tag).toBe("Left")
    expect((await tool(a.session.accountId, a.businessId, { importId: imported.importId, publish: true }))._tag).toBe("Left")
    expect((await ok(b.session.accountId, b.businessId)).data).toMatchObject({ state: "REFERRAL_DATA_UNAVAILABLE", imports: [] })
  })
})
