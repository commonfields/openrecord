// OpenRecord's MCP server against a disposable PostgreSQL: a person creates a
// grant for one business and sees its token once; an outside agent
// initializes, lists only the tools its permissions allow, and calls them as
// that person for that business only; proposals need work:propose; a revoked
// or unknown token, or a browser page from another site, gets nothing.
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

suite("MCP server (disposable PostgreSQL)", () => {
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
  let n = 0
  const rpc = (h: ReturnType<typeof web>, token: string, method: string, params?: unknown, origin?: string) =>
    send(h, "/mcp", { token, ...(origin ? { origin } : {}), body: { jsonrpc: "2.0", id: ++n, method, ...(params === undefined ? {} : { params }) } })

  it("serves a business's tools to an outside agent under a grant, within its permissions and business", async () => {
    const f = await fixture(), other = await fixture()
    const h = web()
    try {
      const base = `/api/businesses/${f.businessId}/mcp-grants`
      expect((await send(h, base, { session: f.session, body: { label: "Codex", permissions: ["root"] } })).status).toBe(422)
      expect((await send(h, `/api/businesses/${f.businessId}/mcp-grants`, { session: other.session, body: { label: "x", permissions: ["evidence:read"] } })).status).toBe(404)
      const created = await send(h, base, { session: f.session, body: { label: "Codex on my laptop", permissions: ["evidence:read", "research:run"], days: 7 } })
      expect(created.status).toBe(201)
      const token = created.json.token as string
      expect(token).toMatch(/^orm_/)
      expect(created.json.endpoint).toMatch(/^http:\/\/localhost(:\d+)?\/mcp$/)
      const listed = await send(h, base, { method: "GET", session: f.session })
      expect(listed.text).not.toContain(token)
      expect(listed.json.grants[0]).toMatchObject({ label: "Codex on my laptop", active: true, hint: token.slice(-4) })
      expect(JSON.stringify((await pool.query("SELECT * FROM mcp_grants WHERE business_id = $1", [f.businessId])).rows)).not.toContain(token)

      // Protocol: initialize, notifications, ping.
      const init = await rpc(h, token, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } })
      expect(init.json.result).toMatchObject({ protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "openrecord" } })
      expect(init.json.result.instructions).toMatch(/cannot approve/)
      expect((await send(h, "/mcp", { token, body: { jsonrpc: "2.0", method: "notifications/initialized" } })).status).toBe(202)
      expect((await rpc(h, token, "ping")).json.result).toEqual({})
      expect((await rpc(h, token, "resources/list")).json.error.code).toBe(-32601)

      // Only permitted tools are listed: reads and research, no proposals, nothing that starts agent work.
      const tools = (await rpc(h, token, "tools/list")).json.result.tools as Array<{ name: string; inputSchema: { type?: string }; annotations: { readOnlyHint: boolean } }>
      const names = tools.map(t => t.name)
      expect(names).toEqual(expect.arrayContaining(["read_business_truth", "find_research_capabilities", "run_research"]))
      expect(names).not.toContain("propose_check_run")
      expect(names.some(n => /delegate|message_session|cancel_task|approve|publish/.test(n))).toBe(false)
      expect(tools.find(t => t.name === "run_research")!.annotations.readOnlyHint).toBe(false)

      // Calls run as the grant's person, for the grant's business only.
      const found = await rpc(h, token, "tools/call", { name: "find_research_capabilities", arguments: { need: "app store listings" } })
      expect(found.json.result.isError).toBe(false)
      expect(JSON.parse(found.json.result.content[0].text).provenance).toMatch(/untrusted/)
      const ran = await rpc(h, token, "tools/call", { name: "run_research", arguments: { capability: "apps.apple.search", question: "Which apps compete with us in the store?", input: { term: "rival dental" } } })
      expect(ran.json.result.structuredContent.data).toMatchObject({ status: "OBSERVED" })
      const obs = (await pool.query("SELECT business_id, requested_by_user_id FROM research_observations WHERE operation = 'apps.apple.search' AND business_id = $1", [f.businessId])).rows
      expect(obs).toEqual([{ business_id: f.businessId, requested_by_user_id: f.userId }])
      expect((await pool.query("SELECT count(*)::int AS n FROM research_observations WHERE business_id = $1", [other.businessId])).rows[0].n).toBe(0)
      // A tool outside the grant is refused, and bad input is a tool error, not a crash.
      expect((await rpc(h, token, "tools/call", { name: "propose_check_run", arguments: { questionId: randomUUID() } })).json.result).toMatchObject({ isError: true })
      expect((await rpc(h, token, "tools/call", { name: "run_research", arguments: { capability: 5 } })).json.result).toMatchObject({ isError: true })

      // A browser page from another site is refused; a missing or revoked token gets nothing.
      expect((await rpc(h, token, "tools/list", undefined, "https://evil.example.test")).status).toBe(403)
      expect((await send(h, "/mcp", { body: { jsonrpc: "2.0", id: 1, method: "tools/list" } })).status).toBe(401)
      expect((await send(h, `${base}/${created.json.id}`, { method: "DELETE", session: f.session })).status).toBe(200)
      expect((await rpc(h, token, "tools/list")).status).toBe(401)
    } finally { await h.dispose() }
  })

  it("lists proposal tools only under work:propose", async () => {
    const f = await fixture()
    const h = web()
    try {
      const token = (await send(h, `/api/businesses/${f.businessId}/mcp-grants`, { session: f.session, body: { label: "Planner", permissions: ["work:propose"] } })).json.token as string
      const names = ((await rpc(h, token, "tools/list")).json.result.tools as Array<{ name: string }>).map(t => t.name)
      expect(names).toContain("propose_check_run")
      expect(names).not.toContain("run_research")
    } finally { await h.dispose() }
  })
})
