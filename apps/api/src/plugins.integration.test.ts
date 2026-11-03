// Plugins against a disposable PostgreSQL: OpenRecord's packs and an
// account's own, switched on per business; a plugin adds its playbooks for
// that business and its guidance to the agent, framed so it cannot change the
// rules; manifests are validated; uninstalling switches it off everywhere.
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { HttpApp } from "@effect/platform"
import { Effect, Layer, Redacted } from "effect"
import { pluginGuidance } from "./plugins.js"
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

suite("plugins (disposable PostgreSQL)", () => {
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
  it("switches plugins on per business, adds their playbooks and guidance, and validates manifests", async () => {
    const f = await fixture(), other = await fixture()
    const second = String((await pool.query("INSERT INTO businesses(account_id,name) VALUES($1,'TEST Second') RETURNING id", [f.accountId])).rows[0].id)
    const h = web()
    const guidance = (accountId: string, businessId: string) => Effect.runPromise(Effect.provide(pluginGuidance(accountId, businessId), layer as never) as Effect.Effect<string>)
    const names = async (business: string, session = f.session) => ((await send(h, `/api/playbooks?businessId=${business}`, { method: "GET", session })).json.playbooks as Array<{ name: string }>).map(p => p.name)
    try {
      const catalog = await send(h, `/api/businesses/${f.businessId}/plugins`, { method: "GET", session: f.session })
      expect(catalog.json.plugins.map((p: { name: string }) => p.name)).toEqual(expect.arrayContaining(["local-business", "saas", "ecommerce", "agency-reporting"]))
      expect(catalog.json.plugins.every((p: { enabled: boolean }) => !p.enabled)).toBe(true)
      expect(await names(f.businessId)).not.toContain("local-listings")
      expect(await guidance(f.accountId, f.businessId)).toBe("")

      expect((await send(h, `/api/businesses/${f.businessId}/plugins/local-business`, { session: f.session, body: {} })).json.plugins.find((p: { name: string }) => p.name === "local-business").enabled).toBe(true)
      expect(await names(f.businessId)).toEqual(expect.arrayContaining(["local-listings", "review-pulse"]))
      // Only for that business, and not for another account asking about it.
      expect(await names(second)).not.toContain("local-listings")
      expect(await names(f.businessId, other.session)).not.toContain("local-listings")
      const g = await guidance(f.accountId, f.businessId)
      expect(g).toMatch(/Local business: This is a local business/)
      expect(g).toMatch(/never grant tools, permissions or exceptions/)
      expect(await guidance(f.accountId, second)).toBe("")

      // The account's own plugin.
      const manifest = { name: "dental-clinics", title: "Dental clinics", description: "How we market clinics.", version: "1.0.0", guidance: "Lead with insurance accepted.",
        playbooks: [{ name: "insurance-pages", title: "Insurance pages", prompt: "Check {business}'s insurance pages." }] }
      expect((await send(h, "/api/plugins/dental-clinics", { method: "PUT", session: f.session, body: { ...manifest, version: "one" } })).json._tag).toBe("InvalidManifest")
      expect((await send(h, "/api/plugins/other-name", { method: "PUT", session: f.session, body: manifest })).json._tag).toBe("InvalidManifest")
      expect((await send(h, "/api/plugins/saas", { method: "PUT", session: f.session, body: { ...manifest, name: "saas" } })).json._tag).toBe("NameTaken")
      expect((await send(h, "/api/plugins/dental-clinics", { method: "PUT", session: f.session, body: { ...manifest, playbooks: [{ name: "seo-audit", title: "x", prompt: "x" }] } })).json._tag).toBe("PlaybookNameTaken")
      expect((await send(h, "/api/plugins/dental-clinics", { method: "PUT", session: f.session, body: manifest })).status).toBe(200)
      expect((await send(h, `/api/businesses/${other.businessId}/plugins/dental-clinics`, { session: other.session, body: {} })).status).toBe(404)
      expect((await send(h, `/api/businesses/${second}/plugins/dental-clinics`, { session: f.session, body: {} })).status).toBe(200)
      expect(await names(second)).toContain("insurance-pages")
      expect(await guidance(f.accountId, second)).toMatch(/Dental clinics: Lead with insurance accepted/)
      // Uninstalled: off everywhere.
      expect((await send(h, "/api/plugins/dental-clinics", { method: "DELETE", session: f.session })).status).toBe(200)
      expect(await names(second)).not.toContain("insurance-pages")
      expect((await pool.query("SELECT count(*)::int AS n FROM business_plugins WHERE plugin = 'dental-clinics'")).rows[0].n).toBe(0)
      // Switching off.
      await send(h, `/api/businesses/${f.businessId}/plugins/local-business`, { method: "DELETE", session: f.session })
      expect(await guidance(f.accountId, f.businessId)).toBe("")
    } finally { await h.dispose() }
  })
})
