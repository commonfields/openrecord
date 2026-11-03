// Usage against a disposable PostgreSQL: the account's agent turns,
// research calls and AI answer checks for a period, inside the account only;
// unknown token counts stay unknown and only priced models get an estimate.
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { HttpApp } from "@effect/platform"
import { Layer, Redacted } from "effect"
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
import { makeRouter, RepoLayers } from "./router.js"
import { ResearchHttp } from "./research/net.js"

const url = process.env["TEST_DATABASE_URL"] ?? ""
const suite = url ? describe : describe.skip

suite("usage (disposable PostgreSQL)", () => {
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
  const transport: HttpTransport = { lookup: async () => ["93.184.216.34"], fetch: async (raw, init) => {
    const u = new URL(raw); seen.push({ url: u, init })
    const body = { results: [{ trackId: 1, trackName: "Rival Dental", userRatingCount: 10 }] }
    return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify(body)), peerIp: "93.184.216.34" } } }
  const ads = adsConfigFromEnv({ GA4_TOKEN_ENCRYPTION_KEYS: `k1:${Buffer.alloc(32, 5).toString("base64")}` })
  const layer = Layer.mergeAll(repos, Layer.succeed(ResearchHttp, transport), Layer.succeed(AdsProvider, ads))
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

  const web = () => HttpApp.toWebHandlerLayer(makeRouter(), layer as never)
  const send = async (h: ReturnType<typeof web>, path: string, init: { method?: string; session?: string; token?: string; origin?: string; body?: unknown }) => {
    const r = await h.handler(new Request(`http://localhost${path}`, { method: init.method ?? "POST",
      headers: { ...(init.session ? { cookie: `or_session=${init.session}` } : {}), ...(init.token ? { authorization: `Bearer ${init.token}` } : {}), ...(init.origin ? { origin: init.origin } : {}), ...(init.body === undefined ? {} : { "content-type": "application/json" }) },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) }))
    const text = await r.text()
    return { status: r.status, text, json: text ? JSON.parse(text) : null }
  }
  it("totals the account's usage by model, business and day, and estimates only priced models", async () => {
    const f = await fixture(), other = await fixture()
    const prior = process.env["AGENT_TOKEN_PRICES"]
    process.env["AGENT_TOKEN_PRICES"] = "priced-model=1/10"
    const h = web()
    try {
      const add = (account: string, business: string | null, model: string, tokens: [number | null, number | null, number | null], tools: number) =>
        pool.query("INSERT INTO agent_usage(account_id, business_id, provider, model, model_steps, tool_calls, prompt_tokens, output_tokens, total_tokens) VALUES ($1,$2,'hosted',$3,2,$4,$5,$6,$7)",
          [account, business, model, tools, tokens[0], tokens[1], tokens[2]])
      await add(f.accountId, f.businessId, "priced-model", [1_000_000, 100_000, 1_100_000], 3)
      await add(f.accountId, f.businessId, "priced-model", [1_000_000, 100_000, 1_100_000], 1)
      await add(f.accountId, null, "subscription-model", [null, null, null], 2)
      await add(other.accountId, other.businessId, "priced-model", [5, 5, 10], 1)
      await pool.query("INSERT INTO research_calls(account_id, business_id, endpoint, provider, credential_source, status, cost_micro, finished_at) VALUES ($1,$2,'seo.serp','seo_data','PLATFORM','SUCCEEDED',5000,now()),($1,$2,'apps.apple.search','apple','PUBLIC','FAILED',0,now())", [f.accountId, f.businessId])
      const r = await send(h, "/api/usage?days=30", { method: "GET", session: f.session })
      expect(r.status).toBe(200)
      expect(r.json.agent).toMatchObject({ turns: 3, promptTokens: 2_000_000, outputTokens: 200_000, totalTokens: 2_200_000, toolCalls: 6, turnsWithoutTokenCounts: 1, unpricedTurns: 1 })
      expect(r.json.agent.estimatedUsd).toBeCloseTo(4)
      expect(r.json.byModel).toEqual(expect.arrayContaining([
        expect.objectContaining({ model: "priced-model", turns: 2, priced: true }),
        expect.objectContaining({ model: "subscription-model", turns: 1, priced: false, estimatedUsd: null, totalTokens: null }),
      ]))
      expect(r.json.byBusiness).toEqual(expect.arrayContaining([expect.objectContaining({ businessId: f.businessId, turns: 2 }), expect.objectContaining({ businessId: null, name: "General chat", turns: 1 })]))
      expect(r.json.daily.at(-1)).toMatchObject({ turns: 3 })
      expect(r.json.research).toMatchObject({ calls: 2, byProvider: expect.arrayContaining([expect.objectContaining({ provider: "seo_data", paidCalls: 1, chargedUsd: 0.005 }), expect.objectContaining({ provider: "apple", failed: 1 })]) })
      expect(r.json.research.chargedUsd).toBeCloseTo(0.005)
      // Another account sees only its own.
      expect((await send(h, "/api/usage?days=30", { method: "GET", session: other.session })).json.agent.turns).toBe(1)
      expect((await send(h, "/api/usage?days=0", { method: "GET", session: f.session })).status).toBe(422)
      expect((await send(h, "/api/usage", { method: "GET" })).status).toBe(401)
    } finally { await h.dispose(); if (prior === undefined) delete process.env["AGENT_TOKEN_PRICES"]; else process.env["AGENT_TOKEN_PRICES"] = prior }
  })
})
