// Shared chats against a disposable PostgreSQL: only the conversation's
// owner can share it; the public view shows authors, text and citation labels
// and never reasoning, tool internals, attachment contents or helper-session
// messages; it follows later messages; revoking or expiry ends it.
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

suite("shared chats (disposable PostgreSQL)", () => {
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
  it("shares a conversation read-only without its internals, and ends the link on revoke or expiry", async () => {
    const f = await fixture(), other = await fixture()
    const h = web()
    try {
      const messages = [
        { role: "user", text: "Why do AI answers get our price wrong?", attachments: [{ name: "pricing.csv", type: "text/csv", text: "SECRET-ROW internal margin 42%" }] },
        { role: "agent", text: "Two answers cite an old directory listing that says $49.", citations: [{ kind: "web", id: "https://directory.example/rival", text: "Old directory listing" }],
          activity: [{ kind: "thought", text: "PRIVATE-THOUGHT considering the margin file", ms: 10 }, { kind: "tool", tool: "read_web_page", text: "PRIVATE-TOOL fetched page" }],
          toolCalls: [{ tool: "read_web_page", summary: "PRIVATE-TOOL-SUMMARY" }] },
        { role: "agent", text: "HELPER-INTERNAL result from a helper", origin: { kind: "result", title: "helper" } },
      ]
      const conv = String((await pool.query("INSERT INTO agent_conversations(account_id, business_id, user_id, messages) VALUES ($1,$2,$3,$4::jsonb) RETURNING id",
        [f.accountId, f.businessId, f.userId, JSON.stringify(messages)])).rows[0].id)
      const base = `/api/businesses/${f.businessId}/agent/conversations/${conv}/shares`
      expect((await send(h, `/api/businesses/${other.businessId}/agent/conversations/${conv}/shares`, { session: other.session, body: {} })).status).toBe(404)
      expect((await send(h, base, { session: other.session, body: {} })).status).toBe(404)
      expect((await send(h, base, { session: f.session, body: {}, origin: "https://evil.example.test" })).status).toBe(403)
      const created = await send(h, base, { session: f.session, body: { days: 7 } })
      expect(created.status).toBe(201)
      const token = created.json.token as string
      expect(created.json.path).toBe(`/shared/${token}`)
      expect((await send(h, base, { method: "GET", session: f.session })).text).not.toContain(token)

      const view = await send(h, `/api/shared/chats/${token}`, { method: "GET" })
      expect(view.status).toBe(200)
      expect(view.json.messages).toEqual([
        { role: "user", text: "Why do AI answers get our price wrong?", citations: [], files: ["pricing.csv"] },
        { role: "agent", text: "Two answers cite an old directory listing that says $49.", citations: [{ kind: "web", text: "Old directory listing" }], files: [] },
      ])
      for (const hidden of ["SECRET-ROW", "PRIVATE-THOUGHT", "PRIVATE-TOOL", "HELPER-INTERNAL", f.accountId, f.userId, conv]) expect(view.text).not.toContain(hidden)
      // Later messages appear.
      await pool.query("UPDATE agent_conversations SET messages = messages || $2::jsonb WHERE id = $1", [conv, JSON.stringify([{ role: "user", text: "And how do we fix it?" }])])
      expect((await send(h, `/api/shared/chats/${token}`, { method: "GET" })).json.messages.at(-1)).toMatchObject({ role: "user", text: "And how do we fix it?" })
      // Unknown, revoked or expired links show nothing.
      expect((await send(h, "/api/shared/chats/orc_" + "x".repeat(43), { method: "GET" })).status).toBe(404)
      const revoked = await send(h, `${base}/${created.json.id}`, { method: "DELETE", session: f.session })
      expect(revoked.status).toBe(200)
      expect((await send(h, `/api/shared/chats/${token}`, { method: "GET" })).status).toBe(404)
      const second = await send(h, base, { session: f.session, body: {} })
      await pool.query("UPDATE agent_chat_shares SET created_at = now() - interval '2 days', expires_at = now() - interval '1 day' WHERE id = $1", [second.json.id])
      expect((await send(h, `/api/shared/chats/${second.json.token}`, { method: "GET" })).status).toBe(404)
    } finally { await h.dispose() }
  })
})
