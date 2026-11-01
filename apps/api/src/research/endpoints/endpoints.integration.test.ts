// Research data connections and catalog endpoints against a disposable
// PostgreSQL: a business connects its own provider credential, which is
// stored encrypted and never returned; endpoints that need it stay
// unavailable until then; the credential is injected on the server only and
// scrubbed from results; another account can neither see nor use it.
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
import { dispatchToolSpec } from "../../agent-registry.js"
import { makeRouter, RepoLayers } from "../../router.js"
import { ResearchHttp } from "../net.js"

const url = process.env["TEST_DATABASE_URL"] ?? ""
const suite = url ? describe : describe.skip
const KEY = "AIza" + "S".repeat(35)

suite("research connections and endpoints (disposable PostgreSQL)", () => {
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
    const body = u.pathname.endsWith("/youtube/v3/channels")
      ? { items: [{ id: "UC1234567890123456789012", snippet: { title: "Rival" }, statistics: { subscriberCount: "500", viewCount: "9000", videoCount: "12" } }], nextPageToken: `https://www.googleapis.com/x?key=${u.searchParams.get("key")}` }
      : u.hostname === "itunes.apple.com" ? { results: [{ trackId: 1, trackName: "Rival", userRatingCount: 10 }] } : {}
    return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify(body)), peerIp: "93.184.216.34" } } }
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

  it("connects a business's own key encrypted, uses it only on the server, and keeps it inside the business", async () => {
    const f = await fixture(), other = await fixture()
    const web = HttpApp.toWebHandlerLayer(makeRouter(), layer as never)
    const call = (method: string, path: string, session: string, body?: unknown, origin?: string) => web.handler(new Request(`http://localhost${path}`, {
      method, headers: { cookie: `or_session=${session}`, ...(origin ? { origin } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }))
    const base = `/api/businesses/${f.businessId}/research-connections`
    try {
      const run = (ctx = f.ctx) => tool(ctx, "run_research", { capability: "social.youtube.channel", question: "How big is rival's YouTube audience?", input: { handle: "@rival" } })
      // Not connected: unavailable, nothing sent.
      expect((await run()).right.data).toMatchObject({ status: "NOT_AVAILABLE" })
      expect(seen).toHaveLength(0)
      // Public endpoints need nothing.
      expect((await tool(f.ctx, "run_research", { capability: "apps.apple.search", question: "Which apps compete with rival in the store?", input: { term: "rival dental" } })).right.data).toMatchObject({ status: "OBSERVED", source: "PUBLIC_API" })
      expect((await call("PUT", `${base}/google_api`, f.session, { credential: KEY }, "https://hostile.example.test")).status).toBe(403)
      expect((await call("PUT", `${base}/google_api`, f.session, { credential: "not-a-google-key" })).status).toBe(422)
      expect((await call("PUT", `${base}/unknown_provider`, f.session, { credential: KEY })).status).toBe(404)
      expect((await call("PUT", `${base}/google_api`, other.session, { credential: KEY })).status).toBe(404)
      const saved = await call("PUT", `${base}/google_api`, f.session, { credential: KEY })
      const text = await saved.text()
      expect(saved.status).toBe(200)
      expect(text).not.toContain(KEY)
      expect(JSON.parse(text).providers.find((p: { id: string }) => p.id === "google_api")).toMatchObject({ connected: true, hint: "SSSS" })
      const stored = (await pool.query("SELECT credential_ciphertext FROM research_connections WHERE business_id = $1 AND provider = 'google_api'", [f.businessId])).rows[0].credential_ciphertext as string
      expect(stored.startsWith("v1.")).toBe(true)
      expect(stored).not.toContain(KEY)
      // Connected: the key goes to the provider's host only, and never comes back.
      const r = await run()
      expect(r.right.data).toMatchObject({ status: "OBSERVED", source: "CONNECTED_ACCOUNT", findings: { subscribers: 500 } })
      const yt = seen.find(s => s.url.pathname.endsWith("/youtube/v3/channels"))!
      expect(yt.url.hostname).toBe("www.googleapis.com")
      expect(yt.url.searchParams.get("key")).toBe(KEY)
      expect(JSON.stringify(r)).not.toContain(KEY)
      expect(JSON.stringify((await pool.query("SELECT findings, coverage, params FROM research_observations WHERE business_id = $1", [f.businessId])).rows)).not.toContain(KEY)
      // Another business cannot use it; a ciphertext copied there does not decrypt.
      expect((await run(other.ctx)).right.data).toMatchObject({ status: "NOT_AVAILABLE" })
      await pool.query("INSERT INTO research_connections(business_id, account_id, provider, credential_ciphertext, credential_hint, status, connected_by_user_id) VALUES ($1,$2,'google_api',$3,'SSSS','ACTIVE',$4)",
        [other.businessId, other.accountId, stored, other.userId])
      expect((await run(other.ctx)).right.data).toMatchObject({ status: "NOT_AVAILABLE" })
      // Revoked: unavailable again, ciphertext gone.
      expect((await call("DELETE", `${base}/google_api`, f.session)).status).toBe(200)
      expect((await pool.query("SELECT status, credential_ciphertext FROM research_connections WHERE business_id = $1", [f.businessId])).rows[0]).toEqual({ status: "REVOKED", credential_ciphertext: null })
      // Revoked means no more reads, even a repeat; evidence saved while connected stays readable.
      expect((await run()).right.data).toMatchObject({ status: "NOT_AVAILABLE" })
      expect((await tool(f.ctx, "read_research_evidence", { subject: "@rival" })).right.data.observations).toEqual([expect.objectContaining({ capability: "social.youtube.channel", status: "OBSERVED" })])
      expect((await tool(f.ctx, "run_research", { capability: "social.youtube.channel", question: "And the other channel?", input: { handle: "@another" } })).right.data).toMatchObject({ status: "NOT_AVAILABLE" })
    } finally { await web.dispose() }
  })

  it("keeps Google endpoints unavailable until the business connects Google on Channels", async () => {
    const f = await fixture()
    const before = seen.length
    for (const capability of ["analytics.report", "search.console.query", "local.reviews", "ads.meta.campaigns"]) {
      const input = capability === "analytics.report" ? { property: "123456", metrics: ["sessions"] } : capability === "search.console.query" ? { siteUrl: "sc-domain:rival.com" } : capability === "ads.meta.campaigns" ? { account: "1234567" } : { account: "123", location: "456" }
      expect((await tool(f.ctx, "run_research", { capability, question: "What does our own Google data say?", input })).right.data).toMatchObject({ status: "NOT_AVAILABLE" })
    }
    expect(seen.length).toBe(before)
    const frame = await tool(f.ctx, "cross_source_marketing_investigation", { objective: "Understand our own search and local performance" })
    expect(frame.right.data.research.unavailable.map((u: { capability: string }) => u.capability)).toEqual(expect.arrayContaining([expect.stringMatching(/^google_analytics \(\d+ capabilities\)$/), expect.stringMatching(/^stripe \(263 capabilities\)$/)]))
  })

  it("keeps a paid provider off until the business connects its own account", async () => {
    const f = await fixture()
    const before = seen.length
    const r = await tool(f.ctx, "run_research", { capability: "seo.ranked_keywords", question: "Which keywords bring rival.com search traffic?", input: { domain: "rival.com" } })
    expect(r.right.data).toMatchObject({ status: "NOT_AVAILABLE", recovery: expect.stringMatching(/SEO data/) })
    expect(seen.length).toBe(before)
  })
})
