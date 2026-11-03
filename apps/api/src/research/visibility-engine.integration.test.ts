// The SEO/AEO/GEO engine against a disposable PostgreSQL: citation targets
// from saved AI answers keep their status across runs, verification records
// whether a page names the business, rank history comes from saved
// results-page checks, and the schema kit uses approved facts only.
import { createHash, randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
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
import type { HttpTransport } from "@openrecord/representation"
import pg from "pg"
import { RepoLayers } from "../router.js"
import { ResearchHttp } from "./net.js"

const url = process.env["TEST_DATABASE_URL"] ?? ""
const suite = url ? describe : describe.skip

suite("visibility engine (disposable PostgreSQL)", () => {
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
  const seen: string[] = []
  const transport: HttpTransport = { lookup: async () => ["93.184.216.34"], fetch: async (raw, init) => {
    seen.push(raw)
    const u = new URL(raw)
    const html = u.pathname === "/robots.txt" ? "User-agent: *\nAllow: /" : (raw.includes("reviews.example") || (init as { servername?: string }).servername === "reviews.example") ? "<html><body><h1>Top dental tools</h1><p>1. Northstar Dental is great</p></body></html>" : "<html><body><p>Only Rival here</p></body></html>"
    return { status: 200, headers: { "content-type": u.pathname === "/robots.txt" ? "text/plain" : "text/html" }, body: new TextEncoder().encode(html), peerIp: "93.184.216.34" } } }
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
  const research = (ctx: { accountId: string; userId: string; businessId: string }, capability: string, input: unknown = {}) =>
    tool(ctx, "run_research", { capability, question: "Where should we earn mentions in AI answers?", input })
  const observe = (f: Awaited<ReturnType<typeof fixture>>, operation: string, subject: string, findings: unknown, daysAgo = 0) =>
    pool.query(`INSERT INTO research_observations(account_id, business_id, request_key, source, operation, subject, question, params, status, findings, coverage, requested_by_user_id, observed_at)
      VALUES ($1,$2,$3,'DERIVED',$4,$5,'TEST','{}'::jsonb,'OBSERVED',$6::jsonb,'{}'::jsonb,$7, now() - make_interval(days => $8))`, [f.accountId, f.businessId, createHash("sha256").update(randomUUID()).digest("hex"), operation, subject, JSON.stringify(findings), f.userId, daysAgo])

  it("builds citation targets, keeps their status, verifies mentions, and reports rank history", async () => {
    const f = await fixture(), other = await fixture()
    await pool.query("UPDATE businesses SET name = 'Northstar Dental' WHERE id = $1", [f.businessId])
    const cite = (url: string, owner = "OTHER") => ({ url, domain: new URL(url).hostname, owner, competitor: null, sourceType: "REVIEW_SITE" })
    const answer = (prompt: string, mentioned: boolean, urls: string[]) => ({ engine: "test", model: "m", prompt, answeredAt: new Date().toISOString(), text: "…", brandMentioned: mentioned, brandPosition: null,
      mentions: [{ brand: "Rival", role: "COMPETITOR", position: 1, negativeCue: false, sentence: "Rival" }], citations: urls.map(u => cite(u)) })
    await observe(f, "ai.answers", "ai answers", { answers: [answer("best dental software", false, ["https://reviews.example/top10", "https://forum.example/t"]), answer("dental tools", false, ["https://reviews.example/top10"]), answer("northstar", true, ["https://press.example/a"])] })

    const first = await research(f.ctx, "geo.citation_targets")
    expect(first.right.data).toMatchObject({ status: "OBSERVED", findings: { answersChecked: 3, targets: [
      expect.objectContaining({ url: "https://reviews.example/top10", citations: 2, competitors: ["Rival"], status: "TO_CONTACT" }), expect.objectContaining({ url: "https://forum.example/t", citations: 1 }) ] } })
    expect(JSON.stringify(first.right.data)).not.toContain("press.example")
    // The team pitches one; a later run keeps that status.
    expect((await research(f.ctx, "geo.update_target", { url: "https://reviews.example/top10", status: "PITCHED", note: "Emailed the editor" })).right.data).toMatchObject({ status: "OBSERVED" })
    expect((await research(f.ctx, "geo.update_target", { url: "https://nowhere.example/x", status: "PITCHED" })).right.data.status).toBe("NOT_FOUND")
    const again = await research(f.ctx, "geo.citation_targets")
    expect(again.right.data.findings.targets.find((t: { url: string }) => t.url === "https://reviews.example/top10")).toMatchObject({ status: "PITCHED", note: "Emailed the editor" })
    // Verification reads the pages and records whether the business is named.
    const verified = await research(f.ctx, "geo.verify_targets", { limit: 5 })
    expect(verified.right.data.findings.checked).toEqual(expect.arrayContaining([
      expect.objectContaining({ url: "https://reviews.example/top10", namesBusiness: true }), expect.objectContaining({ url: "https://forum.example/t", namesBusiness: false })]))
    expect((await pool.query("SELECT url, verified_mention FROM geo_targets WHERE business_id = $1 ORDER BY url", [f.businessId])).rows).toEqual([
      { url: "https://forum.example/t", verified_mention: false }, { url: "https://reviews.example/top10", verified_mention: true }])
    // Another business has none of it.
    expect((await research(other.ctx, "geo.verify_targets")).right.data.status).toBe("NO_TARGETS")

    // Rank history from saved results-page checks; not in the results is null, never a made-up position.
    await pool.query("INSERT INTO business_setups(business_id, website_url) VALUES ($1, 'https://northstar-dental.com') ON CONFLICT (business_id) DO UPDATE SET website_url = EXCLUDED.website_url", [f.businessId]).catch(() => undefined)
    await observe(f, "seo.serp", "dental software", { results: [{ position: 1, domain: "rival.example", url: "https://rival.example" }, { position: 7, domain: "northstar-dental.com", url: "https://northstar-dental.com/" }] }, 14)
    await observe(f, "seo.serp", "dental software", { results: [{ position: 1, domain: "rival.example", url: "https://rival.example" }] }, 7)
    await observe(f, "seo.serp", "dental software", { results: [{ position: 3, domain: "www.northstar-dental.com", url: "https://www.northstar-dental.com/" }] }, 0)
    const rank = await research(f.ctx, "seo.rank_history", { keyword: "Dental Software", domain: "northstar-dental.com" })
    expect(rank.right.data.findings).toMatchObject({ domain: "northstar-dental.com", change: 4, points: [expect.objectContaining({ position: 7 }), expect.objectContaining({ position: null }), expect.objectContaining({ position: 3 })] })
    expect((await research(f.ctx, "seo.rank_history", { keyword: "never checked", domain: "northstar-dental.com" })).right.data.status).toBe("NO_DATA")
  })

  it("builds the schema kit from approved facts only", async () => {
    const f = await fixture()
    expect((await research(f.ctx, "aeo.schema_kit")).right.data.status).toBe("NO_FACTS")
    await pool.query("INSERT INTO authoritative_facts(business_id, subject, predicate, value_text, value_type, valid_from) VALUES ($1,'TEST','monthly_price','$39','CURRENCY',now() - interval '1 day'), ($1,'TEST','old_price','$29','CURRENCY',now() - interval '9 days')", [f.businessId])
    await pool.query("UPDATE authoritative_facts SET status = 'RETIRED' WHERE business_id = $1 AND predicate = 'old_price'", [f.businessId])
    const kit = await research(f.ctx, "aeo.schema_kit")
    expect(kit.right.data).toMatchObject({ status: "OBSERVED", findings: { factsUsed: 1 } })
    expect(JSON.stringify(kit.right.data.findings.jsonLd)).toContain('"price":"39"')
    expect(JSON.stringify(kit.right.data)).not.toContain("$29")
  })
})
