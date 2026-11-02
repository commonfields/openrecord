// Live AI traffic feeds against a disposable PostgreSQL: a person creates a
// feed and sees its token once; the host's log drain posts records in the
// common formats (JSON lines, a host drain's nested request records, a CDN's
// HTTP request fields, text access logs, gzip); only daily aggregates per AI
// agent and page are kept, inside the feed's business; a wrong or revoked
// token is refused; the agent reads the result as ai.traffic_live.
import { randomUUID } from "node:crypto"
import { gzipSync } from "node:zlib"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { HttpApp } from "@effect/platform"
import { Effect, Layer, Redacted } from "effect"
import { dispatchToolSpec } from "../agent-registry.js"
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
import { makeRouter, RepoLayers } from "../router.js"
import { ResearchHttp } from "./net.js"

const url = process.env["TEST_DATABASE_URL"] ?? ""
const suite = url ? describe : describe.skip

suite("live AI traffic feeds (disposable PostgreSQL)", () => {
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

  const tool = (ctx: { accountId: string; userId: string; businessId: string }, name: string, args: unknown): Promise<any> =>
    Effect.runPromise(Effect.either(Effect.provide(dispatchToolSpec(ctx, name, args) as never, layer) as Effect.Effect<unknown, unknown>))
  const web = () => HttpApp.toWebHandlerLayer(makeRouter(), layer as never)
  const send = async (h: ReturnType<typeof web>, path: string, init: { method?: string; session?: string; token?: string; origin?: string; body?: unknown }) => {
    const r = await h.handler(new Request(`http://localhost${path}`, { method: init.method ?? "POST",
      headers: { ...(init.session ? { cookie: `or_session=${init.session}` } : {}), ...(init.token ? { authorization: `Bearer ${init.token}` } : {}), ...(init.origin ? { origin: init.origin } : {}), ...(init.body === undefined ? {} : { "content-type": "application/json" }) },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) }))
    const text = await r.text()
    return { status: r.status, text, json: text ? JSON.parse(text) : null }
  }
  const drain = async (h: ReturnType<typeof web>, feed: string, token: string | null, body: string | Buffer, extra: Record<string, string> = {}) => {
    const r = await h.handler(new Request(`http://localhost/api/ai-traffic/feeds/${feed}${extra["query"] ?? ""}`, { method: "POST",
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(extra["encoding"] ? { "content-encoding": extra["encoding"] } : {}) }, body }))
    return { status: r.status, json: await r.json() as any }
  }
  const today = new Date().toISOString().slice(0, 10)
  const ms = Date.now()

  it("ingests AI crawler and referral traffic from a log drain as daily aggregates only", async () => {
    const f = await fixture(), other = await fixture()
    const h = web()
    try {
      const created = await send(h, `/api/businesses/${f.businessId}/ai-traffic-feeds`, { session: f.session, body: { label: "Production host" } })
      expect(created.status).toBe(201)
      const { id, token } = created.json as { id: string; token: string }
      expect(token).toMatch(/^orf_/)
      expect(created.json.url).toMatch(new RegExp(`/api/ai-traffic/feeds/${id}$`))
      expect((await send(h, `/api/businesses/${f.businessId}/ai-traffic-feeds`, { method: "GET", session: f.session })).text).not.toContain(token)

      // Refused without the right token; nothing stored.
      expect((await drain(h, id, null, "{}")).status).toBe(401)
      expect((await drain(h, id, "orf_wrongwrongwrongwrongwrong", "{}")).status).toBe(401)
      // A drain's empty verification request.
      expect((await drain(h, id, token, "")).json).toEqual({ received: 0 })

      // Plain JSON lines, a host drain's nested records, a CDN's request fields and a text access log line.
      const ndjson = [
        JSON.stringify({ timestamp: ms, proxy: { path: "/pricing?utm=x", userAgent: ["Mozilla/5.0 (compatible; GPTBot/1.2; +https://openai.com/gptbot)"], referer: "", statusCode: 200, clientIp: "203.0.113.9" } }),
        JSON.stringify({ timestamp: ms, proxy: { path: "/pricing", userAgent: ["Mozilla/5.0 AppleWebKit/537.36; ChatGPT-User/1.0"], statusCode: 403 } }),
        JSON.stringify({ EdgeStartTimestamp: ms * 1e6, ClientRequestURI: "/blog/guide", ClientRequestUserAgent: "Mozilla/5.0", ClientRequestReferer: "https://chatgpt.com/", EdgeResponseStatus: 200, ClientIP: "198.51.100.7" }),
        JSON.stringify({ time: new Date(ms).toISOString(), path: "/", status: 200, user_agent: "Mozilla/5.0 Safari", referrer: "https://www.google.com/" }),
        "not a log line",
      ].join("\n")
      expect((await drain(h, id, token, ndjson)).json).toEqual({ received: 5, recognized: 4, unrecognized: 1, aiEvents: 3 })
      // Gzip, a JSON array and ?token= for drains that cannot set headers.
      const arr = JSON.stringify([{ timestamp: ms, proxy: { path: "/pricing", userAgent: ["PerplexityBot/1.0"], statusCode: 200 } }])
      expect((await drain(h, id, null, gzipSync(arr), { encoding: "gzip", query: `?token=${token}` })).json).toMatchObject({ recognized: 1, aiEvents: 1 })
      const line = `203.0.113.5 - - [${new Date(ms).toUTCString().slice(5, 16).replace(/ /g, "/")}:10:00:00 +0000] "GET /pricing HTTP/1.1" 200 512 "-" "ClaudeBot/1.0"`
      expect((await drain(h, id, token, line)).json).toMatchObject({ recognized: 1, aiEvents: 1 })

      // Only aggregates: no IP address, query string or raw line anywhere.
      const rows = (await pool.query("SELECT to_char(day, 'YYYY-MM-DD') AS day, event, name, path, requests::int, ok::int, blocked::int FROM ai_traffic_daily WHERE business_id = $1 ORDER BY event, name", [f.businessId])).rows
      expect(rows).toEqual([
        { day: today, event: "CRAWLER", name: "ChatGPT-User", path: "/pricing", requests: 1, ok: 0, blocked: 1 },
        { day: today, event: "CRAWLER", name: "ClaudeBot", path: "/pricing", requests: 1, ok: 1, blocked: 0 },
        { day: today, event: "CRAWLER", name: "GPTBot", path: "/pricing", requests: 1, ok: 1, blocked: 0 },
        { day: today, event: "CRAWLER", name: "PerplexityBot", path: "/pricing", requests: 1, ok: 1, blocked: 0 },
        { day: today, event: "REFERRAL", name: "ChatGPT", path: "/blog/guide", requests: 1, ok: 1, blocked: 0 },
      ])
      const all = JSON.stringify((await pool.query("SELECT * FROM ai_traffic_daily")).rows)
      for (const leaked of ["203.0.113", "198.51.100", "utm="]) expect(all).not.toContain(leaked)

      // The agent reads it; another business sees nothing.
      const live = await tool(f.ctx, "run_research", { capability: "ai.traffic_live", question: "Which AI crawlers read our pricing page this month?", input: { days: 7 } })
      expect(live.right.data).toMatchObject({ status: "OBSERVED", findings: { crawlers: expect.arrayContaining([expect.objectContaining({ name: "GPTBot", owner: "OpenAI", requests: 1 })]),
        referrals: [expect.objectContaining({ assistant: "ChatGPT", visits: 1 })] } })
      expect((await tool(other.ctx, "run_research", { capability: "ai.traffic_live", question: "Which AI crawlers read our pricing page this month?", input: { days: 7 } })).right.data).toMatchObject({ status: "NO_DATA" })

      // Revoked: refused.
      expect((await send(h, `/api/businesses/${f.businessId}/ai-traffic-feeds/${id}`, { method: "DELETE", session: f.session })).status).toBe(200)
      expect((await drain(h, id, token, ndjson)).status).toBe(401)
    } finally { await h.dispose() }
  })
})
