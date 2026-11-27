// The treg catalog as a research source, against a disposable PostgreSQL and a
// scripted treg: nothing works until the business connects its own treg
// token; search shows treg's endpoints beside OpenRecord's with price and
// whether OpenRecord will run them; a data read runs through the relay with
// the token on the server only, and what it cost is saved with the answer; an
// action, a team-published tool or a call above the price ceiling never runs.
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
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
import { dispatchToolSpec } from "../agent-registry.js"
import { makeRouter, RepoLayers } from "../router.js"
import { ResearchHttp } from "./net.js"

const url = process.env["TEST_DATABASE_URL"] ?? ""
const suite = url ? describe : describe.skip
const TOKEN = "treg_" + "t".repeat(43)
const ads = adsConfigFromEnv({ ADS_PROVIDER_STAND_IN_URL: "http://127.0.0.1:9/", GA4_TOKEN_ENCRYPTION_KEYS: `k1:${Buffer.alloc(32, 9).toString("base64")}` })

/** treg's catalog as the scripted relay sees it. */
const ENTRIES: Record<string, Record<string, unknown>> = {
  "bravesearch.web.search.news": { id: "bravesearch.web.search.news", provider: "bravesearch", provider_display: "Brave", name: "Search the news",
    method: "GET", kind: "data", cost: { usd: 0.005, type: "per_call", currency: "USD", per: 1000 }, input: { queryParams: { q: { type: "string" } } } },
  "postiz.social.publish": { id: "postiz.social.publish", provider: "postiz", name: "Publish a social post", summary: "Publishes", method: "POST", kind: "action", cost: { usd: 0.01, type: "call" } },
  "someteam.backlinks": { id: "someteam.backlinks", provider: "someteam", name: "A team's backlink tool", summary: "Hub", method: "POST", kind: "hub", cost: { usd: 0.01, type: "call" } },
  "pricey.web.backlinks.full": { id: "pricey.web.backlinks.full", provider: "pricey", name: "Full backlink export", method: "GET", kind: "data", cost: { usd: 3, type: "per_call", currency: "USD" } },
  "metered.web.backlinks.full": { id: "metered.web.backlinks.full", method: "GET", kind: "data", cost: { usd: 0.02, type: "per_result", currency: "USD" } },
  "write.web.disguised": { id: "write.web.disguised", method: "POST", kind: "data", cost: { usd: 0.02, type: "per_call", currency: "USD" } },
}

suite("treg catalog as a research source (disposable PostgreSQL, scripted treg)", () => {
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
  const sent: Array<{ url: URL; init: FetchInit }> = []
  let balanceLeft = true
  const transport: HttpTransport = { lookup: async () => ["216.24.57.1"], fetch: async (raw, init) => {
    const u = new URL(raw)
    sent.push({ url: u, init })
    const reply = (status: number, body: unknown, headers: Record<string, string> = {}) => ({ status, headers, body: new TextEncoder().encode(JSON.stringify(body)), peerIp: "216.24.57.1" })
    if (u.pathname.startsWith("/catalog/") && init.headers["x-treg-token"]) return reply(400, { error: "catalog does not need a token" })
    if (u.pathname === "/catalog/search") return reply(200, { query: u.searchParams.get("q"), results: Object.values(ENTRIES) })
    const entry = /^\/catalog\/endpoints\/(.+)$/.exec(u.pathname)
    if (entry) return ENTRIES[decodeURIComponent(entry[1]!)] ? reply(200, { endpoint: ENTRIES[decodeURIComponent(entry[1]!)], siblings: [] }) : reply(404, { error: "unknown endpoint" })
    const call = /^\/call\/(.+)$/.exec(u.pathname)
    if (call && init.headers["x-treg-token"] !== TOKEN) return reply(401, { error: "unknown token" })
    if (call) return balanceLeft
      ? reply(200, { results: [{ title: "Rival in the news", echoed: TOKEN }] }, { "x-treg-cost-micro": "5000", "x-treg-call-id": "call_1" })
      : reply(402, { error: "insufficient_balance" })
    return reply(404, {})
  } }
  const layer = Layer.mergeAll(repos, Layer.succeed(ResearchHttp, transport), Layer.succeed(AdsProvider, ads))
  const tool = (ctx: { accountId: string; userId: string; businessId: string }, name: string, args: unknown): Promise<any> =>
    Effect.runPromise(Effect.either(Effect.provide(dispatchToolSpec(ctx, name, args) as never, layer) as Effect.Effect<unknown, unknown>))
  beforeAll(() => { pool = new pg.Pool({ connectionString: url }) })
  afterAll(async () => { await pool.end() })
  const fixture = async () => {
    const accountId = String((await pool.query("INSERT INTO accounts(name) VALUES('TEST treg') RETURNING id")).rows[0].id)
    const userId = String((await pool.query("INSERT INTO users(email,password_hash) VALUES($1,'TEST') RETURNING id", [`treg-${randomUUID()}@example.test`])).rows[0].id)
    await pool.query("INSERT INTO account_users(account_id,user_id) VALUES($1,$2)", [accountId, userId])
    const businessId = String((await pool.query("INSERT INTO businesses(account_id,name) VALUES($1,'TEST Dental') RETURNING id", [accountId])).rows[0].id)
    const session = String((await pool.query("INSERT INTO sessions(account_id,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour') RETURNING id", [accountId, userId])).rows[0].id)
    return { accountId, userId, businessId, session, ctx: { accountId, userId, businessId } }
  }

  it("searches and runs treg's data reads on the business's own token, and never runs an action", async () => {
    const f = await fixture()
    const web = HttpApp.toWebHandlerLayer(makeRouter(), layer as never)
    try {
      const research = (capability: string, input: unknown) => tool(f.ctx, "run_research", { capability, question: "What does rival's backlink profile look like?", input })
      const news = { endpointId: "bravesearch.web.search.news", query: { q: "rival.test" } }
      // Nothing until treg is connected, and nothing is sent.
      expect((await research("treg.call", news)).right.data).toMatchObject({ status: "NOT_AVAILABLE" })
      expect(sent).toHaveLength(0)
      const connect = (credential: string) => web.handler(new Request(`http://localhost/api/businesses/${f.businessId}/research-connections/treg`, {
        method: "PUT", headers: { cookie: `or_session=${f.session}`, "content-type": "application/json" }, body: JSON.stringify({ credential }) }))
      expect((await connect("not-a-treg-token")).status).toBe(422)
      expect((await connect(TOKEN)).status).toBe(200)

      // Research search shows treg's matches beside OpenRecord's, each with its price and whether it runs.
      const found = (await tool(f.ctx, "find_research_capabilities", { need: "backlinks of a domain" })).right.data
      const listed = new Map((found.treg.endpoints as Array<{ endpointId: string; runnable: boolean; priceUsd: number }>).map(e => [e.endpointId, e]))
      expect(listed.get(news.endpointId)).toMatchObject({ runnable: true, priceUsd: 0.005 })
      for (const id of ["postiz.social.publish", "someteam.backlinks", "pricey.web.backlinks.full"]) expect(listed.get(id)?.runnable).toBe(false)
      expect((await research("treg.endpoint", { endpointId: news.endpointId })).right.data).toMatchObject({
        findings: { parameters: { queryParams: { q: { type: "string" } } } },
      })

      // A data read runs through the relay with the token on the server only; its cost is saved with the answer.
      const r = await research("treg.call", news)
      expect(r.right.data).toMatchObject({ status: "OBSERVED", source: "CONNECTED_ACCOUNT", coverage: { provider: "treg", charged: "$0.0050", callId: "call_1" } })
      const relayed = sent.find(s => s.url.pathname === `/call/${news.endpointId}`)!
      expect(relayed.init.method).toBe("GET")
      expect(relayed.init.headers["x-treg-route-max-cost"]).toBe("0.25")
      expect(relayed.url.hostname).toBe("treg.to")
      expect(relayed.url.searchParams.get("q")).toBe("rival.test")
      expect(relayed.init.headers["idempotency-key"]).toBe(r.right.data.observationId)
      expect((await research("treg.call", news)).right.data).toMatchObject({ observationId: r.right.data.observationId, reused: true })
      expect(sent.filter(s => s.url.pathname.startsWith("/call/"))).toHaveLength(1)
      expect(JSON.stringify(r)).not.toContain(TOKEN)
      expect(JSON.stringify((await pool.query("SELECT findings, coverage, params FROM research_observations WHERE business_id = $1", [f.businessId])).rows)).not.toContain(TOKEN)

      // Actions, tools another team published and calls above the price ceiling are refused before any call.
      for (const endpointId of ["postiz.social.publish", "someteam.backlinks", "pricey.web.backlinks.full", "metered.web.backlinks.full", "write.web.disguised"]) {
        const calls = sent.filter(s => s.url.pathname.startsWith("/call/")).length
        expect((await research("treg.call", { endpointId })).right.data).toMatchObject({ status: "NOT_A_READ" })
        expect(sent.filter(s => s.url.pathname.startsWith("/call/")).length).toBe(calls)
      }
      // An empty treg balance is said plainly.
      balanceLeft = false
      expect((await research("treg.call", { ...news, query: { q: "other.test" } })).right.data).toMatchObject({ status: "BALANCE_EXHAUSTED" })
    } finally { await web.dispose() }
  })
})
