// Playbooks against a disposable PostgreSQL: OpenRecord's SEO, AEO and GEO
// playbooks are listed for everyone; an account saves, replaces and deletes
// its own, which no other account sees; command and built-in names are
// refused.
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

suite("playbooks (disposable PostgreSQL)", () => {
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
  it("lists built-in playbooks and keeps each account's own playbooks to itself", async () => {
    const f = await fixture(), other = await fixture()
    const h = web()
    try {
      const listed = await send(h, "/api/playbooks", { method: "GET", session: f.session })
      expect(listed.status).toBe(200)
      const names = (listed.json.playbooks as Array<{ name: string; area: string; builtIn: boolean }>).map(p => p.name)
      expect(names).toEqual(expect.arrayContaining(["seo-audit", "aeo-check", "geo-citations", "ai-crawlers", "weekly-review"]))
      expect(new Set((listed.json.playbooks as Array<{ area: string }>).map(p => p.area))).toEqual(new Set(["SEO", "AEO", "GEO", "Research", "Review"]))
      expect((await send(h, "/api/playbooks", { method: "GET" })).status).toBe(401)

      const save = (name: string, body: unknown, session = f.session, origin?: string) => send(h, `/api/playbooks/${name}`, { method: "PUT", session, body, ...(origin ? { origin } : {}) })
      expect((await save("monthly-seo", { title: "Monthly SEO report", prompt: "Monthly SEO report for {business}." }, f.session, "https://evil.example.test")).status).toBe(403)
      expect((await save("plan", { title: "x", prompt: "x" })).json._tag).toBe("NameTaken")
      expect((await save("seo-audit", { title: "x", prompt: "x" })).json._tag).toBe("NameTaken")
      expect((await save("Bad Name", { title: "x", prompt: "x" })).status).toBe(422)
      expect((await save("monthly-seo", { title: "", prompt: "x" })).status).toBe(422)
      const saved = await save("monthly-seo", { title: "Monthly SEO report", prompt: "Monthly SEO report for {business}." })
      expect(saved.status).toBe(200)
      expect(saved.json.playbooks).toContainEqual({ name: "monthly-seo", title: "Monthly SEO report", prompt: "Monthly SEO report for {business}.", area: "Saved", builtIn: false })
      // Saving the same name replaces it.
      expect((await save("monthly-seo", { title: "Monthly SEO", prompt: "Updated for {business}." })).json.playbooks.filter((p: { name: string }) => p.name === "monthly-seo")).toEqual([expect.objectContaining({ title: "Monthly SEO", prompt: "Updated for {business}." })])
      // Another account sees only the built-ins and cannot delete it.
      const theirs = (await send(h, "/api/playbooks", { method: "GET", session: other.session })).json.playbooks as Array<{ name: string }>
      expect(theirs.some(p => p.name === "monthly-seo")).toBe(false)
      expect((await send(h, "/api/playbooks/monthly-seo", { method: "DELETE", session: other.session })).status).toBe(404)
      const deleted = await send(h, "/api/playbooks/monthly-seo", { method: "DELETE", session: f.session })
      expect(deleted.status).toBe(200)
      expect((deleted.json.playbooks as Array<{ name: string }>).some(p => p.name === "monthly-seo")).toBe(false)
    } finally { await h.dispose() }
  })
})
