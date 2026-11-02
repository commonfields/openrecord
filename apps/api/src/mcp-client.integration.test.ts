// Outside MCP servers against a disposable PostgreSQL: the team connects a
// server (checked by listing its tools; credential encrypted, never
// returned); the agent lists its tools and calls only those the server marks
// read-only, inside a session the server assigns, with the credential
// scrubbed from results; private addresses are refused; revoking ends it.
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { HttpApp } from "@effect/platform"
import { Effect, Layer, Redacted } from "effect"
import { dispatchToolSpec } from "./agent-registry.js"
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

suite("connected MCP servers (disposable PostgreSQL)", () => {
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
  const seen: Array<{ url: URL; init: FetchInit; body: any }> = []
  let privateHost = false
  const TOKEN = "mcp-secret-token-123456"
  const tools = [
    { name: "search_reviews", description: "Search public reviews", inputSchema: { type: "object", properties: { q: { type: "string" } } }, annotations: { readOnlyHint: true } },
    { name: "post_reply", description: "Reply to a review", inputSchema: { type: "object" }, annotations: { readOnlyHint: false } },
  ]
  const transport: HttpTransport = { lookup: async () => [privateHost ? "10.0.0.5" : "93.184.216.34"], fetch: async (raw, init) => {
    const body = JSON.parse(init.body ?? "{}")
    seen.push({ url: new URL(raw), init, body })
    const reply = (result: unknown, headers: Record<string, string> = { "content-type": "application/json" }, sse = false) => ({ status: 200, headers,
      body: new TextEncoder().encode(sse ? `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result })}\n\n` : JSON.stringify({ jsonrpc: "2.0", id: body.id, result })), peerIp: "93.184.216.34" })
    if (body.method === "initialize") return reply({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "reviews" } }, { "content-type": "application/json", "mcp-session-id": "sess-42" })
    if (!body.id) return { status: 202, headers: {}, body: new Uint8Array(0), peerIp: "93.184.216.34" }
    if (body.method === "tools/list") return reply({ tools })
    return reply({ content: [{ type: "text", text: `3 reviews for ${body.params.arguments.q}; token was ${init.headers["authorization"]}` }], isError: false }, { "content-type": "text/event-stream" }, true)
  } }
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
  it("connects an outside server and calls only its read-only tools, inside the business", async () => {
    const f = await fixture(), other = await fixture()
    const h = web()
    try {
      const base = `/api/businesses/${f.businessId}/mcp-connections`
      // A private address is refused before anything is saved.
      privateHost = true
      expect((await send(h, base, { session: f.session, body: { label: "Reviews", url: "https://mcp.reviews.example.test/mcp" } })).json).toMatchObject({ _tag: "ServerUnavailable", failure: "NOT_PUBLIC" })
      privateHost = false
      expect((await send(h, base, { session: f.session, body: { label: "Reviews", url: "http://mcp.reviews.example.test/mcp" } })).status).toBe(422)
      const created = await send(h, base, { session: f.session, body: { label: "Reviews", url: "https://mcp.reviews.example.test/mcp", credential: TOKEN } })
      expect(created.status).toBe(201)
      expect(created.json).toMatchObject({ tools: 2, readOnlyTools: 1 })
      const listedRoute = await send(h, base, { method: "GET", session: f.session })
      expect(listedRoute.text).not.toContain(TOKEN)
      expect(JSON.stringify((await pool.query("SELECT * FROM mcp_connections WHERE business_id = $1", [f.businessId])).rows)).not.toContain(TOKEN)
      const id = created.json.id as string

      const list = await tool(f.ctx, "list_connected_tools", {})
      expect(list.right.data.connections[0].tools).toEqual([
        expect.objectContaining({ name: "search_reviews", callable: true }), expect.objectContaining({ name: "post_reply", callable: false }) ])
      // The session the server assigned is sent back; the credential reaches only that server.
      const call = seen.filter(s => s.body.method === "tools/list").pop()!
      expect(call.init.headers).toMatchObject({ "mcp-session-id": "sess-42", authorization: `Bearer ${TOKEN}` })

      const ok = await tool(f.ctx, "call_connected_tool", { connectionId: id, tool: "search_reviews", arguments: { q: "rival dental" } })
      expect(ok.right.data).toMatchObject({ status: "OBSERVED", server: "Reviews", tool: "search_reviews", provenance: expect.stringMatching(/Untrusted/) })
      expect(ok.right.data.text).toMatch(/^3 reviews for rival dental/)
      expect(JSON.stringify(ok)).not.toContain(TOKEN)

      const before = seen.filter(s => s.body.method === "tools/call").length
      expect((await tool(f.ctx, "call_connected_tool", { connectionId: id, tool: "post_reply", arguments: {} })).right.data).toMatchObject({ status: "NOT_READ_ONLY" })
      expect(seen.filter(s => s.body.method === "tools/call").length).toBe(before)

      // Another business cannot use it; revoked, it is gone.
      expect((await tool(other.ctx, "call_connected_tool", { connectionId: id, tool: "search_reviews", arguments: { q: "x" } })).right.data).toMatchObject({ status: "NOT_AVAILABLE" })
      expect((await send(h, `${base}/${id}`, { method: "DELETE", session: f.session })).status).toBe(200)
      expect((await tool(f.ctx, "list_connected_tools", {})).right.data.connections).toEqual([])
    } finally { await h.dispose() }
  })
})
