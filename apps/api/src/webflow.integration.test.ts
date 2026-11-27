// The Webflow connector end to end against an in-memory Webflow: connect with
// a checked site token, the agent reads and prepares changes, a person
// approves and OpenRecord publishes, verifies and undoes. A page or item
// edited since preparation, and a site holding someone else's unpublished
// edits, are refused, not silently published.
import { createHash, randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { HttpApp } from "@effect/platform"
import { Effect, Layer, Redacted } from "effect"
import { PgClient } from "@effect/sql-pg"
import pg from "pg"
import { AuthRepositoryLive, ClaimRepositoryLive, InterventionBindingRepositoryLive, InterventionRepositoryLive, ObservationRepositoryLive, ProductReadRepositoryLive, ReobservationIntentRepositoryLive } from "@openrecord/db"
import { AdsProvider, adsConfigFromEnv } from "@openrecord/ads"
import type { HttpTransport } from "@openrecord/representation"
import { RepoLayers, requireSession } from "./router.js"
import { WebAccess, type WebAccessService } from "./web-access.js"
import { dispatchToolSpec } from "./agent-registry.js"
import { WebflowHttp, webflowApi } from "./webflow.js"
import { connectionGaps } from "./agent-decision.js"

const url = process.env["TEST_DATABASE_URL"] ?? ""
const suite = url ? describe : describe.skip
const TOKEN = "wf_test_token_0123456789abcdef0123456789abcdef"
const SITE = "a".repeat(24), DOMAIN = "d".repeat(24), PAGE = "b".repeat(24), BLOG = "c".repeat(24), POST = "e".repeat(24)

/** An in-memory Webflow site: one page, one blog collection with one live post, and a clock. */
function fakeWebflow() {
  let t = Date.parse("2026-11-01T00:00:00Z")
  const tick = () => new Date(t += 120_000).toISOString()
  const state = {
    publishes: 0,
    site: { id: SITE, displayName: "Cueup", shortName: "cueup", lastUpdated: "2026-11-01T00:00:00.000Z", lastPublished: "2026-11-01T00:00:00.000Z", customDomains: [{ id: DOMAIN, url: "www.cueup.test" }] },
    page: { id: PAGE, title: "Pricing", slug: "pricing", seo: { title: "Pricing", description: "" }, lastUpdated: "2026-10-01T00:00:00.000Z", draft: false, archived: false, publishedPath: "/pricing" },
    livePageSeo: { title: "Pricing", description: "" },
    items: new Map<string, { id: string; fieldData: Record<string, string>; lastUpdated: string; lastPublished: string | null; isDraft: boolean; isArchived: boolean; live: boolean }>(),
    nextItem: 0x100,
  }
  state.items.set(POST, { id: POST, fieldData: { name: "Hello", slug: "hello", summary: "Old summary" }, lastUpdated: "2026-10-01T00:00:00.000Z", lastPublished: "2026-10-01T00:00:00.000Z", isDraft: false, isArchived: false, live: true })
  const collection = { id: BLOG, displayName: "Blog Posts", slug: "blog", fields: [
    { slug: "name", displayName: "Name", type: "PlainText", isRequired: true, isEditable: true },
    { slug: "slug", displayName: "Slug", type: "PlainText", isRequired: true, isEditable: true },
    { slug: "summary", displayName: "Summary", type: "PlainText", isRequired: false, isEditable: true },
  ] }
  const transport: HttpTransport = {
    lookup: async () => ["104.18.0.1"],
    fetch: async (raw, init) => {
      const path = new URL(raw).pathname.replace(/^\/v2/, "")
      const reply = (status: number, body?: unknown) => ({ status, headers: {}, body: new TextEncoder().encode(body === undefined ? "" : JSON.stringify(body)), peerIp: "104.18.0.1" })
      if (init.headers["authorization"] !== `Bearer ${TOKEN}`) return reply(401, { message: "secret detail" })
      const body = JSON.parse(init.body ?? "{}") as Record<string, any>
      if (path === "/sites") return reply(200, { sites: [state.site] })
      if (path === `/sites/${SITE}`) return reply(200, state.site)
      if (path === `/sites/${SITE}/pages`) return reply(200, { pages: [state.page] })
      if (path === `/sites/${SITE}/collections`) return reply(200, { collections: [{ id: BLOG, displayName: "Blog Posts", slug: "blog" }] })
      if (path === `/sites/${SITE}/publish` && init.method === "POST") {
        state.publishes++; state.livePageSeo = { ...state.page.seo }; state.site.lastPublished = tick(); return reply(202, {})
      }
      if (path === `/pages/${PAGE}`) {
        if (init.method === "PUT") { state.page.seo = { ...state.page.seo, ...body["seo"] }; state.page.lastUpdated = tick(); state.site.lastUpdated = state.page.lastUpdated }
        return reply(200, state.page)
      }
      if (path === `/collections/${BLOG}`) return reply(200, collection)
      if (path === `/collections/${BLOG}/items`) return reply(200, { items: [...state.items.values()] })
      if (path === `/collections/${BLOG}/items/live` && init.method === "POST") {
        const id = (state.nextItem++).toString(16).padStart(24, "0"), now = tick()
        const it = { id, fieldData: body["fieldData"], lastUpdated: now, lastPublished: now, isDraft: false, isArchived: false, live: true }
        state.items.set(id, it); return reply(202, it)
      }
      const one = path.match(/^\/collections\/[0-9a-f]{24}\/items\/([0-9a-f]{24})(\/live)?$/)
      if (one) {
        const it = state.items.get(one[1]!)
        if (!it || (one[2] && !it.live && init.method !== "PATCH")) return reply(404, {})
        if (init.method === "PATCH") { Object.assign(it.fieldData, body["fieldData"]); it.lastUpdated = it.lastPublished = tick(); it.live = true }
        if (init.method === "DELETE") { it.live = false; it.lastPublished = null; return reply(204) }
        return reply(200, it)
      }
      return reply(404, {})
    },
  }
  return { state, transport }
}

suite("Webflow connector (in-memory Webflow, no network)", () => {
  let pool: pg.Pool
  const wf = fakeWebflow()
  const live: WebAccessService = {
    fetch: async (u) => ({ requestedUrl: u, finalUrl: u, status: 200, contentType: "text/html", headers: {}, redirectChain: [], bytes: 1, failure: null, elapsedMs: 1,
      body: `<html><head><title>${wf.state.livePageSeo.title}</title><meta name="description" content="${wf.state.livePageSeo.description}"></head></html>` }) as never,
    search: null, render: null, provider: null,
  }
  const config = adsConfigFromEnv({ ADS_PROVIDER_STAND_IN_URL: "http://127.0.0.1:9/", GA4_TOKEN_ENCRYPTION_KEYS: `k1:${Buffer.alloc(32, 7).toString("base64")}` })
  const repos = Layer.mergeAll(RepoLayers.BusinessRepositoryLive, AuthRepositoryLive, ClaimRepositoryLive, InterventionRepositoryLive, InterventionBindingRepositoryLive, ProductReadRepositoryLive, ObservationRepositoryLive, ReobservationIntentRepositoryLive).pipe(Layer.provideMerge(PgClient.layer({ url: Redacted.make(url) })))
  const layer = Layer.mergeAll(repos, Layer.succeed(AdsProvider, config), Layer.succeed(WebflowHttp, wf.transport), Layer.succeed(WebAccess, live))
  const web = HttpApp.toWebHandlerLayer(webflowApi(r => Effect.flatMap(requireSession, ({ session }) => r(session))), layer)
  const tool = (ctx: { accountId: string; userId: string; businessId: string }, name: string, args: unknown) =>
    Effect.runPromise(Effect.either(dispatchToolSpec(ctx, name, args).pipe(Effect.provide(layer)) as unknown as Effect.Effect<{ data: any }, unknown, never>))
  const changeId = (r: Awaited<ReturnType<typeof tool>>) => (r as { right: { data: { webflowChangeId: string } } }).right.data.webflowChangeId
  beforeAll(() => { pool = new pg.Pool({ connectionString: url }) })
  afterAll(async () => { await web.dispose(); await pool.end() })
  const fixture = async () => {
    const accountId = String((await pool.query("INSERT INTO accounts(name) VALUES('TEST wf') RETURNING id")).rows[0].id)
    const userId = String((await pool.query("INSERT INTO users(email,password_hash) VALUES($1,'TEST') RETURNING id", [`wf-${randomUUID()}@example.test`])).rows[0].id)
    await pool.query("INSERT INTO account_users(account_id,user_id) VALUES($1,$2)", [accountId, userId])
    const businessId = String((await pool.query("INSERT INTO businesses(account_id,name) VALUES($1,'TEST Cueup') RETURNING id", [accountId])).rows[0].id)
    const cookie = String((await pool.query("INSERT INTO sessions(account_id,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour') RETURNING id", [accountId, userId])).rows[0].id)
    const call = (method: string, path: string, body?: unknown, origin?: string) => web.handler(new Request(`http://localhost/api/businesses/${businessId}/webflow${path}`, {
      method, headers: { "content-type": "application/json", cookie: `or_session=${cookie}`, ...(origin ? { origin } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }))
    return { accountId, userId, businessId, call, ctx: { accountId, userId, businessId } }
  }

  it("connects with a checked token, prepares page SEO, and publishes, verifies and undoes only on approval", async () => {
    const f = await fixture()
    expect((await run(connectionGaps(f.accountId, f.businessId))).withheld.has("prepare_webflow_change")).toBe(true)
    expect((await f.call("POST", "", { token: "wf_wrong_token_0123456789abcdef" })).status).toBe(409)
    const connected = await (await f.call("POST", "", { token: TOKEN })).json() as { connection: Record<string, unknown> }
    expect(connected.connection).toMatchObject({ siteId: SITE, siteName: "Cueup", siteUrl: "https://www.cueup.test", last4: TOKEN.slice(-4), status: "ACTIVE" })
    expect(JSON.stringify(connected)).not.toContain(TOKEN)
    expect((await pool.query("SELECT token_ciphertext FROM webflow_connections WHERE business_id = $1", [f.businessId])).rows[0].token_ciphertext).toMatch(/^v1\./)
    expect((await run(connectionGaps(f.accountId, f.businessId))).withheld.has("prepare_webflow_change")).toBe(false)

    const listed = await tool(f.ctx, "read_webflow_content", {})
    expect(listed._tag === "Right" && listed.right.data).toMatchObject({ pages: [{ pageId: PAGE, title: "Pricing", path: "/pricing" }], collections: [{ collectionId: BLOG }] })
    const args = { kind: "SET_PAGE_SEO", pageId: PAGE, seoDescription: "Plans from $9 a month, cancel any time", rationale: "TEST empty description" }
    const id = changeId(await tool(f.ctx, "prepare_webflow_change", args))
    expect(changeId(await tool(f.ctx, "prepare_webflow_change", args))).toBe(id)
    expect(wf.state.page.seo.description).toBe("")

    expect((await f.call("POST", `/changes/${id}/approve`, {}, "https://hostile.example")).status).toBe(403)
    expect((await (await fixture()).call("GET", `/changes/${id}`)).status).toBe(404)
    const approved = await (await f.call("POST", `/changes/${id}/approve`, {})).json() as { change: Record<string, unknown> }
    expect(approved.change).toMatchObject({ status: "PUBLISHED", publishedLink: "https://www.cueup.test/pricing", liveCheck: { observed: true } })
    expect(wf.state.publishes).toBe(1)
    expect(wf.state.livePageSeo.description).toBe("Plans from $9 a month, cancel any time")
    expect((await f.call("POST", `/changes/${id}/approve`, {})).status).toBe(409)

    const undone = await (await f.call("POST", `/changes/${id}/undo`, {})).json() as { change: { status: string } }
    expect(undone.change.status).toBe("UNDONE")
    expect(wf.state.livePageSeo.description).toBe("")

    // Someone edited the site in Webflow and has not published: approving would push their work live too.
    const pending = changeId(await tool(f.ctx, "prepare_webflow_change", { kind: "SET_PAGE_SEO", pageId: PAGE, seoTitle: "Pricing and plans", rationale: "TEST title" }))
    wf.state.site.lastUpdated = new Date(Date.parse(wf.state.site.lastPublished) + 3_600_000).toISOString()
    const publishes = wf.state.publishes
    expect((await f.call("POST", `/changes/${pending}/approve`, {})).status).toBe(409)
    expect((await (await f.call("GET", `/changes/${pending}`)).json() as { change: Record<string, unknown> }).change).toMatchObject({ status: "FAILED", failure: "SiteHasUnpublishedEdits" })
    expect(wf.state.publishes).toBe(publishes)
    expect(wf.state.page.seo.title).toBe("Pricing")
  })

  it("updates and creates CMS items live, refusing an item edited since it was prepared", async () => {
    const f = await fixture()
    await f.call("POST", "", { token: TOKEN })
    const read = await tool(f.ctx, "read_webflow_content", { collectionId: BLOG, itemId: POST })
    expect(read._tag === "Right" && read.right.data).toMatchObject({ live: true, unpublishedEdits: false, text: { name: "Hello", summary: "Old summary" } })

    const slug = await tool(f.ctx, "prepare_webflow_change", { kind: "UPDATE_CMS_ITEM", collectionId: BLOG, itemId: POST, fields: { slug: "x" }, rationale: "TEST" })
    expect(slug._tag === "Left" && (slug.left as { reason: string }).reason).toBe("SlugChange")

    const id = changeId(await tool(f.ctx, "prepare_webflow_change", { kind: "UPDATE_CMS_ITEM", collectionId: BLOG, itemId: POST, fields: { summary: "A clearer summary" }, rationale: "TEST summary" }))
    expect((await (await f.call("POST", `/changes/${id}/approve`, {})).json() as { change: { status: string } }).change.status).toBe("PUBLISHED")
    expect(wf.state.items.get(POST)!.fieldData["summary"]).toBe("A clearer summary")
    await f.call("POST", `/changes/${id}/undo`, {})
    expect(wf.state.items.get(POST)!.fieldData["summary"]).toBe("Old summary")

    const stale = changeId(await tool(f.ctx, "prepare_webflow_change", { kind: "UPDATE_CMS_ITEM", collectionId: BLOG, itemId: POST, fields: { summary: "Another" }, rationale: "TEST stale" }))
    const post = wf.state.items.get(POST)!
    post.fieldData["summary"] = "Edited by a person in Webflow"; post.lastUpdated = post.lastPublished = new Date(Date.parse(post.lastUpdated) + 1000).toISOString()
    expect((await f.call("POST", `/changes/${stale}/approve`, {})).status).toBe(409)
    expect(post.fieldData["summary"]).toBe("Edited by a person in Webflow")
    expect((await (await f.call("GET", `/changes/${stale}`)).json() as { change: Record<string, unknown> }).change).toMatchObject({ status: "FAILED", failure: "ChangedSincePrepared" })

    const created = changeId(await tool(f.ctx, "prepare_webflow_change", { kind: "CREATE_CMS_ITEM", collectionId: BLOG, fields: { name: "How to hire a wedding DJ", summary: "A guide" }, rationale: "TEST post" }))
    const published = await (await f.call("POST", `/changes/${created}/approve`, {})).json() as { change: { status: string; itemId: string } }
    expect(published.change.status).toBe("PUBLISHED")
    const newItem = wf.state.items.get(published.change.itemId)!
    expect(newItem).toMatchObject({ live: true, fieldData: { slug: "how-to-hire-a-wedding-dj" } })
    await f.call("POST", `/changes/${created}/undo`, {})
    expect(newItem.live).toBe(false)
    expect(wf.state.items.has(newItem.id)).toBe(true)
  })

  const run = <A>(effect: Effect.Effect<A, unknown, import("@effect/sql").SqlClient.SqlClient>) =>
    Effect.runPromise(effect.pipe(Effect.provide(Layer.mergeAll(PgClient.layer({ url: Redacted.make(url) }), Layer.succeed(AdsProvider, config)))))

  it("a change made to fix a wrong AI answer records the fix and queues its re-check once it is live", async () => {
    const f = await fixture()
    await f.call("POST", "", { token: TOKEN })
    wf.state.site.lastUpdated = wf.state.site.lastPublished
    const question = String((await pool.query("INSERT INTO buyer_questions(business_id,prompt) VALUES($1,'How much does Cueup cost?') RETURNING id", [f.businessId])).rows[0].id)
    const run = String((await pool.query("INSERT INTO check_runs(business_id,question_id,provider,status) VALUES ($1,$2,'gemini','SUCCEEDED') RETURNING id", [f.businessId, question])).rows[0].id)
    const raw = JSON.stringify({ answer: "Cueup costs $49 a month.", fixture: randomUUID() }), digest = createHash("sha256").update(raw).digest("hex")
    const evidence = String((await pool.query("INSERT INTO raw_evidence(digest,content_text) VALUES ($1,$2) RETURNING id", [digest, raw])).rows[0].id)
    const observation = String((await pool.query(`INSERT INTO observations(business_id,check_run_id,provider,collected_at,answer_text,retrieval_mode,raw_evidence_id,raw_digest,synthetic)
      VALUES ($1,$2,'gemini',now()-interval '1 day','Cueup costs $49 a month.','unknown',$3,$4,false) RETURNING id`, [f.businessId, run, evidence, digest])).rows[0].id)
    const claimId = String((await pool.query("INSERT INTO candidate_claims(business_id,observation_id,text) VALUES ($1,$2,'Costs $49 a month') RETURNING id", [f.businessId, observation])).rows[0].id)
    await pool.query("INSERT INTO human_judgments(business_id,claim_id,verdict) VALUES ($1,$2,'CONTRADICTED')", [f.businessId, claimId])

    const other = await fixture()
    await other.call("POST", "", { token: TOKEN })
    expect((await tool(other.ctx, "prepare_webflow_change", { kind: "SET_PAGE_SEO", pageId: PAGE, seoTitle: "x", rationale: "TEST", claimId }))._tag).toBe("Left")

    const id = changeId(await tool(f.ctx, "prepare_webflow_change", { kind: "SET_PAGE_SEO", pageId: PAGE, seoDescription: "Cueup plans start at $9 a month", rationale: "TEST state the real price", claimId }))
    expect((await pool.query("SELECT count(*)::int n FROM intervention_issues WHERE issue_id=$1", [claimId])).rows[0].n).toBe(0)
    const approved = await (await f.call("POST", `/changes/${id}/approve`, {})).json() as { change: { status: string; claimId: string }; fix: { recorded: boolean; recheck: string; interventionId: string } }
    expect(approved.change).toMatchObject({ status: "PUBLISHED", claimId })
    expect(approved.fix).toMatchObject({ recorded: true, recheck: "QUEUED" })
    const action = (await pool.query("SELECT i.type, i.target FROM interventions i JOIN intervention_issues ii ON ii.intervention_id=i.id WHERE ii.issue_id=$1", [claimId])).rows
    expect(action).toEqual([{ type: "SOURCE_UPDATED", target: "https://www.cueup.test/pricing" }])
    expect((await pool.query("SELECT intervention_id FROM reobservation_intents WHERE issue_id=$1", [claimId])).rows).toEqual([{ intervention_id: approved.fix.interventionId }])
  })
})
