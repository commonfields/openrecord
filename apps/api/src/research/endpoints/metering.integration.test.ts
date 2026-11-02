// Research call metering against a disposable PostgreSQL: whose credential
// serves a call (the business's own, a public route, or OpenRecord's platform
// account), the price taken from the account's research credit before a
// platform call and returned when it fails, the refusal with balance and price
// when the credit does not cover it, and the audit log of every call.
import { randomUUID } from "node:crypto"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { HttpApp } from "@effect/platform"
import { Effect, Layer, Redacted } from "effect"
import { PgClient } from "@effect/sql-pg"
import { AdsProvider, adsConfigFromEnv } from "@openrecord/ads"
import {
  GrowthRepositoriesLive, AgentProposalRepositoryLive,
  AuthRepositoryLive, DiscoveryMatchRepositoryLive, DiscoveryObservationRepositoryLive,
  EvidenceLineageRepositoryLive, InterventionBindingRepositoryLive, InterventionRepositoryLive,
  RecordRepositoryLive, AcquisitionRepositoryLive, SourceTargetRepositoryLive,
} from "@openrecord/db"
import type { FetchInit, HttpTransport } from "@openrecord/representation"
import pg from "pg"
import { dispatchToolSpec } from "../../agent-registry.js"
import { makeRouter, RepoLayers } from "../../router.js"
import { ResearchHttp } from "../net.js"

const url = process.env["TEST_DATABASE_URL"] ?? ""
const suite = url ? describe : describe.skip
const PLATFORM = "platform@openrecord.test:platform-secret-123"
const OWN = "agency@example.test:own-secret-456"

suite("research call metering (disposable PostgreSQL)", () => {
  let pool: pg.Pool
  const repos = Layer.mergeAll(
    RepoLayers.SetupRepositoryLive, GrowthRepositoriesLive, AgentProposalRepositoryLive,
    AuthRepositoryLive, RecordRepositoryLive, AcquisitionRepositoryLive,
    InterventionRepositoryLive, InterventionBindingRepositoryLive, SourceTargetRepositoryLive,
    EvidenceLineageRepositoryLive, DiscoveryObservationRepositoryLive, DiscoveryMatchRepositoryLive,
    RepoLayers.AssayRepositoryLive,
    RepoLayers.AssayReviewRepositoryLive,
    RepoLayers.BusinessRepositoryLive,
    RepoLayers.FactRepositoryLive,
    RepoLayers.QuestionRepositoryLive,
    RepoLayers.CheckRunRepositoryLive,
    RepoLayers.ObservationRepositoryLive,
    RepoLayers.ClaimRepositoryLive,
    RepoLayers.JudgmentRepositoryLive,
    RepoLayers.ReobservationIntentRepositoryLive,
    RepoLayers.ReobservationRepositoryLive,
    RepoLayers.ProductReadRepositoryLive,
    RepoLayers.DiscoveryScopeRepositoryLive,
    RepoLayers.DiscoveryRunRepositoryLive,
    RepoLayers.DiscoveryFrontierRepositoryLive,
    RepoLayers.SiteTargetRepositoryLive,
    RepoLayers.SiteRunRepositoryLive,
    RepoLayers.SitePageObservationRepositoryLive,
    RepoLayers.SiteFindingRepositoryLive,
    RepoLayers.SiteFindingEventRepositoryLive,
    RepoLayers.SiteFixProposalRepositoryLive,
    RepoLayers.SiteMutationRepositoryLive,
    RepoLayers.SiteVerificationRepositoryLive,
    RepoLayers.SiteOperatorEventRepositoryLive,
    RepoLayers.SiteGscRepositoryLive,
    RepoLayers.GrowthMeasurementRepositoryLive,
  ).pipe(
    Layer.provideMerge(PgClient.layer({ url: Redacted.make(url) })),
  )
  const seen: Array<{ url: URL; init: FetchInit }> = []
  let upstream = 200
  const serp = { status_code: 20000, tasks: [{ status_code: 20000, result: [{ items: [{ type: "organic", rank_group: 1, domain: "rival.com", url: "https://rival.com/", title: "Rival" }] }] }] }
  const apple = { results: [{ trackId: 1, trackName: "Rival", userRatingCount: 10 }] }
  const transport: HttpTransport = { lookup: async () => ["93.184.216.34"], fetch: async (raw, init) => {
    const u = new URL(raw); seen.push({ url: u, init })
    const body = u.hostname === "api.dataforseo.com" ? serp : apple
    return { status: u.hostname === "api.dataforseo.com" ? upstream : 200, headers: {}, body: new TextEncoder().encode(JSON.stringify(body)), peerIp: "93.184.216.34" } } }
  const ads = adsConfigFromEnv({ GA4_TOKEN_ENCRYPTION_KEYS: `k1:${Buffer.alloc(32, 5).toString("base64")}` })
  const layer = Layer.mergeAll(repos, Layer.succeed(ResearchHttp, transport), Layer.succeed(AdsProvider, ads))
  const tool = (ctx: { accountId: string; userId: string; businessId: string }, name: string, args: unknown): Promise<any> =>
    Effect.runPromise(Effect.either(Effect.provide(dispatchToolSpec(ctx, name, args) as never, layer) as Effect.Effect<unknown, unknown>))
  beforeAll(() => { pool = new pg.Pool({ connectionString: url }) })
  afterAll(async () => { await pool.end() })
  const fixture = async () => {
    const accountId = String((await pool.query("INSERT INTO accounts(name) VALUES('TEST connections') RETURNING id")).rows[0].id)
    const userId = String((await pool.query("INSERT INTO users(email,password_hash) VALUES($1,'TEST') RETURNING id", [`conn-${randomUUID()}@example.test`])).rows[0].id)
    await pool.query("INSERT INTO account_users(account_id,user_id) VALUES($1,$2)", [accountId, userId])
    const businessId = String((await pool.query("INSERT INTO businesses(account_id,name) VALUES($1,'TEST Dental') RETURNING id", [accountId])).rows[0].id)
    const session = String((await pool.query("INSERT INTO sessions(account_id,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour') RETURNING id", [accountId, userId])).rows[0].id)
    return { accountId, userId, businessId, session, ctx: { accountId, userId, businessId } }
  }

  const env = { key: process.env["OPENRECORD_SEO_DATA_CREDENTIAL"], prices: process.env["RESEARCH_PRICES_MICRO"] }
  afterEach(() => {
    upstream = 200
    if (env.key === undefined) delete process.env["OPENRECORD_SEO_DATA_CREDENTIAL"]; else process.env["OPENRECORD_SEO_DATA_CREDENTIAL"] = env.key
    if (env.prices === undefined) delete process.env["RESEARCH_PRICES_MICRO"]; else process.env["RESEARCH_PRICES_MICRO"] = env.prices
  })
  const serpRun = (ctx: { accountId: string; userId: string; businessId: string }, keyword: string) =>
    tool(ctx, "run_research", { capability: "seo.serp", question: "Who ranks for this buyer search right now?", input: { keyword } })
  const credit = async (accountId: string, micro: number) =>
    pool.query("INSERT INTO research_credit_entries(account_id, kind, amount_micro, note) VALUES ($1, 'TOPUP', $2, 'TEST')", [accountId, micro])
  const authOf = (i: number) => String((seen[i]!.init.headers as Record<string, string>)["authorization"])
  const basic = (s: string) => `Basic ${Buffer.from(s).toString("base64")}`

  it("serves a priced endpoint on the platform account only with credit, charges it, and refunds a failed call", async () => {
    process.env["OPENRECORD_SEO_DATA_CREDENTIAL"] = PLATFORM
    process.env["RESEARCH_PRICES_MICRO"] = "seo.serp=5000"
    const f = await fixture()
    // No credit: refused before anything is sent, with the balance and the price.
    const before = seen.length
    const poor = await serpRun(f.ctx, "dentist near me")
    expect(poor.right.data).toMatchObject({ status: "INSUFFICIENT_BALANCE", balanceMicro: 0, estimatedCostMicro: 5000 })
    expect(seen.length).toBe(before)
    // With credit: served on the platform credential, charged once, recorded.
    await credit(f.accountId, 12_000)
    const ok = await serpRun(f.ctx, "emergency dentist")
    expect(ok.right.data).toMatchObject({ status: "OBSERVED", coverage: { servedBy: expect.stringMatching(/OpenRecord's own provider account/), cost: "$0.0050" } })
    expect(authOf(seen.length - 1)).toBe(basic(PLATFORM))
    expect(JSON.stringify(ok)).not.toContain("platform-secret-123")
    // The same request on the same day reuses the saved result: no second call, no second charge.
    const sent = seen.length
    expect((await serpRun(f.ctx, "emergency dentist")).right.data).toMatchObject({ status: "OBSERVED", reused: true })
    expect(seen.length).toBe(sent)
    // A failed paid call is refunded.
    upstream = 500
    expect((await serpRun(f.ctx, "teeth whitening")).right.data).toMatchObject({ status: "UNAVAILABLE" })
    const calls = (await pool.query("SELECT credential_source, status, failure, cost_micro FROM research_calls WHERE account_id = $1 ORDER BY started_at", [f.accountId])).rows
    expect(calls).toEqual([
      { credential_source: "PLATFORM", status: "SUCCEEDED", failure: null, cost_micro: "5000" },
      { credential_source: "PLATFORM", status: "FAILED", failure: "UNAVAILABLE", cost_micro: "5000" },
    ])
    const ledger = (await pool.query("SELECT kind, amount_micro FROM research_credit_entries WHERE account_id = $1 ORDER BY created_at, kind", [f.accountId])).rows
    expect(ledger.map(r => [r.kind, Number(r.amount_micro)])).toEqual([["TOPUP", 12000], ["CHARGE", -5000], ["CHARGE", -5000], ["REFUND", 5000]])
    // The agent sees the credit and what was spent.
    const c = await tool(f.ctx, "read_research_credit", {})
    expect(c.right.data).toMatchObject({ balanceMicro: 7000, balance: "$0.0070", last30Days: { calls: 2, paidCalls: 2, spentMicro: 5000 } })
    expect(c.right.data.calls[0]).toMatchObject({ endpoint: "seo.serp", servedBy: "PLATFORM", status: "FAILED", refunded: true })
    // Credit for one account is not another's.
    const other = await fixture()
    expect((await serpRun(other.ctx, "emergency dentist")).right.data).toMatchObject({ status: "INSUFFICIENT_BALANCE", balanceMicro: 0 })
  })

  it("prefers the business's own connection, never metered, and never serves an unpriced endpoint on the platform account", async () => {
    process.env["OPENRECORD_SEO_DATA_CREDENTIAL"] = PLATFORM
    process.env["RESEARCH_PRICES_MICRO"] = "seo.serp=5000"
    const f = await fixture()
    // Unpriced endpoint: unavailable even though the platform credential exists.
    const before = seen.length
    expect((await tool(f.ctx, "run_research", { capability: "seo.backlinks", question: "How strong is rival.com's link profile?", input: { domain: "rival.com" } })).right.data).toMatchObject({ status: "NOT_AVAILABLE" })
    expect(seen.length).toBe(before)
    // The business connects its own account: its credential is used and nothing is charged.
    const web = HttpApp.toWebHandlerLayer(makeRouter(), layer as never)
    try {
      const put = await web.handler(new Request(`http://localhost/api/businesses/${f.businessId}/research-connections/seo_data`, {
        method: "PUT", headers: { cookie: `or_session=${f.session}`, "content-type": "application/json" }, body: JSON.stringify({ credential: OWN }) }))
      expect(put.status).toBe(200)
      const own = await serpRun(f.ctx, "family dentist")
      expect(own.right.data).toMatchObject({ status: "OBSERVED", coverage: { servedBy: "the business's own connection" } })
      expect(own.right.data.coverage.cost).toBeUndefined()
      expect(authOf(seen.length - 1)).toBe(basic(OWN))
      expect((await tool(f.ctx, "run_research", { capability: "seo.backlinks", question: "How strong is rival.com's link profile?", input: { domain: "rival.com" } })).right.data.status).not.toBe("NOT_AVAILABLE")
      // Public endpoints are recorded and never charged.
      expect((await tool(f.ctx, "run_research", { capability: "apps.apple.search", question: "Which apps compete with rival in the store?", input: { term: "rival dental" } })).right.data).toMatchObject({ status: "OBSERVED" })
      const rows = (await pool.query("SELECT endpoint, credential_source, cost_micro FROM research_calls WHERE account_id = $1 ORDER BY started_at", [f.accountId])).rows
      expect(rows).toEqual(expect.arrayContaining([{ endpoint: "seo.serp", credential_source: "BUSINESS", cost_micro: "0" }, { endpoint: "apps.apple.search", credential_source: "PUBLIC", cost_micro: "0" }]))
      expect(Number((await pool.query("SELECT count(*) FROM research_credit_entries WHERE account_id = $1", [f.accountId])).rows[0].count)).toBe(0)
      // The credit page shows the balance, this business's calls and what the platform offers at which price.
      const page = await web.handler(new Request(`http://localhost/api/businesses/${f.businessId}/research-credit`, { headers: { cookie: `or_session=${f.session}` } }))
      expect(page.status).toBe(200)
      const json = await page.json() as { balanceMicro: number; calls: unknown[]; offered: Array<{ endpoint: string; priceMicro: number }> }
      expect(json.balanceMicro).toBe(0)
      expect(json.calls.length).toBeGreaterThanOrEqual(3)
      expect(json.offered).toEqual([expect.objectContaining({ endpoint: "seo.serp", priceMicro: 5000 })])
      expect(JSON.stringify(json)).not.toContain("secret")
    } finally { await web.dispose() }
  })

  it("lets only one of two concurrent paid calls spend the last of the credit", async () => {
    process.env["OPENRECORD_SEO_DATA_CREDENTIAL"] = PLATFORM
    process.env["RESEARCH_PRICES_MICRO"] = "seo.serp=5000"
    const f = await fixture()
    await credit(f.accountId, 5000)
    const both = await Promise.all([serpRun(f.ctx, "dentist open sunday"), serpRun(f.ctx, "dentist open saturday")])
    expect(both.map(r => r.right.data.status).sort()).toEqual(["INSUFFICIENT_BALANCE", "OBSERVED"])
    expect(Number((await pool.query("SELECT sum(amount_micro) AS b FROM research_credit_entries WHERE account_id = $1", [f.accountId])).rows[0].b)).toBe(0)
  })

  it("keeps a paid provider off with no platform credential configured", async () => {
    delete process.env["OPENRECORD_SEO_DATA_CREDENTIAL"]
    process.env["RESEARCH_PRICES_MICRO"] = "seo.serp=5000"
    const f = await fixture()
    await credit(f.accountId, 1_000_000)
    const before = seen.length
    expect((await serpRun(f.ctx, "dentist near me")).right.data).toMatchObject({ status: "NOT_AVAILABLE" })
    expect(seen.length).toBe(before)
  })
})
