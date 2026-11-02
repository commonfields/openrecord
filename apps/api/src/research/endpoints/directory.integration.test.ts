// Providers generated from published API descriptions, against a disposable
// PostgreSQL: a public provider runs with no account and only on its own host;
// a provider stays unavailable until the business connects its own
// credential; two-part keys, prefixed header keys and required header
// parameters reach the provider as documented and never come back.
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
const TRELLO = "trellokey123456:ATTAtrellotoken7890"
const SOUND = "soundcloud-token-abcdef"

suite("generated directory providers (disposable PostgreSQL)", () => {
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
    const body = u.hostname === "trello.com" ? { id: "a1", type: "createCard", echo: u.search } : u.hostname === "api.ebay.com" ? { dealItems: [{ itemId: "1", title: "Rival kit" }] } : [{ id: "1", title: "Rival", description: "x" }]
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

  const run = (ctx: { accountId: string; userId: string; businessId: string }, capability: string, input: unknown) =>
    tool(ctx, "run_research", { capability, question: "What does this source say about the rival brand?", input })
  const connect = async (f: Awaited<ReturnType<typeof fixture>>, provider: string, credential: string) => {
    const web = HttpApp.toWebHandlerLayer(makeRouter(), layer as never)
    try {
      const r = await web.handler(new Request(`http://localhost/api/businesses/${f.businessId}/research-connections/${provider}`, {
        method: "PUT", headers: { cookie: `or_session=${f.session}`, "content-type": "application/json" }, body: JSON.stringify({ credential }) }))
      return { status: r.status, text: await r.text() }
    } finally { await web.dispose() }
  }
  const last = () => seen[seen.length - 1]!
  const headersOf = (i: { init: FetchInit }) => i.init.headers as Record<string, string>

  it("finds and runs generated capabilities, public ones with no account and only on the provider's host", async () => {
    const f = await fixture()
    const found = await tool(f.ctx, "find_research_capabilities", { need: "trello boards cards" })
    expect(found.right.data.capabilities.some((c: { id: string }) => c.id.startsWith("workspace.trello."))).toBe(true)
    const r = await run(f.ctx, "social.mastodon.api_v1_accounts_relationships", { id: "123" })
    expect(r.right.data).toMatchObject({ status: "OBSERVED", source: "CONNECTED_ACCOUNT" })
    expect(last().url.hostname).toBe("mastodon.social")
    expect(headersOf(last())["authorization"]).toBeUndefined()
  })

  it("keeps a provider off until connected, then sends a two-part key as documented and never returns it", async () => {
    const f = await fixture()
    const before = seen.length
    expect((await run(f.ctx, "workspace.trello.get_actions_by_id_action", { idAction: "a1" })).right.data).toMatchObject({ status: "NOT_AVAILABLE" })
    expect(seen.length).toBe(before)
    expect((await connect(f, "trello", "no-colon-here")).status).toBe(422)
    const saved = await connect(f, "trello", TRELLO)
    expect(saved.status).toBe(200)
    expect(saved.text).not.toContain("ATTAtrellotoken7890")
    const r = await run(f.ctx, "workspace.trello.get_actions_by_id_action", { idAction: "a1" })
    expect(r.right.data).toMatchObject({ status: "OBSERVED" })
    expect(last().url.toString()).toBe("https://trello.com/1/actions/a1?key=trellokey123456&token=ATTAtrellotoken7890")
    const out = JSON.stringify(r)
    expect(out).not.toContain("trellokey123456")
    expect(out).not.toContain("ATTAtrellotoken7890")
    expect(JSON.stringify((await pool.query("SELECT findings, coverage FROM research_observations WHERE business_id = $1", [f.businessId])).rows)).not.toContain("ATTAtrellotoken7890")
  })

  it("sends prefixed header keys and required header parameters, and refuses header values that could add a line", async () => {
    const f = await fixture()
    expect((await connect(f, "soundcloud", SOUND)).status).toBe(200)
    expect((await run(f.ctx, "audio.soundcloud.playlists", { q: "rival" })).right.data).toMatchObject({ status: "OBSERVED" })
    expect(headersOf(last())["authorization"]).toBe(`OAuth ${SOUND}`)
    expect((await connect(f, "ebay", "v1.ebay-app-token-123")).status).toBe(200)
    expect((await run(f.ctx, "commerce.ebay.get_deal_items", { "X-EBAY-C-MARKETPLACE-ID": "EBAY_US" })).right.data).toMatchObject({ status: "OBSERVED" })
    expect(headersOf(last())).toMatchObject({ "x-ebay-c-marketplace-id": "EBAY_US", authorization: "Bearer v1.ebay-app-token-123" })
    const sent = seen.length
    expect((await run(f.ctx, "commerce.ebay.get_deal_items", { "X-EBAY-C-MARKETPLACE-ID": "EBAY_US\r\nx-evil: 1" })).right.data).toMatchObject({ status: "INVALID_INPUT" })
    expect(seen.length).toBe(sent)
  })
})
