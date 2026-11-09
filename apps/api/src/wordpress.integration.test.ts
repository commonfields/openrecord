// The WordPress connector end to end against an in-memory WordPress: connect
// with a checked application password, the agent reads and prepares changes,
// a person approves and OpenRecord publishes, verifies and undoes; a page
// edited since preparation and an SEO plugin that ignores API writes are
// refused, not silently "published".
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { HttpApp } from "@effect/platform"
import { Effect, Layer, Redacted } from "effect"
import { PgClient } from "@effect/sql-pg"
import pg from "pg"
import { AuthRepositoryLive } from "@openrecord/db"
import { AdsProvider, adsConfigFromEnv } from "@openrecord/ads"
import type { HttpTransport } from "@openrecord/representation"
import { RepoLayers, requireSession } from "./router.js"
import { WebAccess, type WebAccessService } from "./web-access.js"
import { dispatchToolSpec } from "./agent-registry.js"
import { WordPressHttp, wordpressApi } from "./wordpress.js"
import { seedObjective } from "./objective-work.test-support.js"

const url = process.env["TEST_DATABASE_URL"] ?? ""
const suite = url ? describe : describe.skip
const PASSWORD = "abcd efgh ijkl mnop qrst uvwx"

/** An in-memory WordPress site with Yoast, one page, and switches for the edge cases. */
function fakeWordPress() {
  const state = { acceptSeoMeta: true, nextId: 100,
    posts: new Map<string, { id: number; title: string; content: string; meta: Record<string, string>; modified: string; status: string; type: string }>() }
  state.posts.set("pages/7", { id: 7, title: "Wedding DJs", content: "<p>Book a DJ.</p>", meta: { _yoast_wpseo_title: "", _yoast_wpseo_metadesc: "" }, modified: "2026-10-01T00:00:00", status: "publish", type: "pages" })
  const view = (p: { id: number; title: string; content: string; meta: Record<string, string>; modified: string; status: string; type: string }) =>
    ({ id: p.id, title: { raw: p.title, rendered: p.title }, content: { raw: p.content }, meta: p.meta, modified_gmt: p.modified, status: p.status, link: `https://cueup.test/${p.type}/${p.id}/` })
  const transport: HttpTransport = {
    lookup: async () => ["93.184.216.34"],
    fetch: async (raw, init) => {
      const u = new URL(raw), path = u.pathname.replace(/^\/wp-json/, "")
      const reply = (status: number, body: unknown) => ({ status, headers: {}, body: new TextEncoder().encode(JSON.stringify(body)), peerIp: "93.184.216.34" })
      if (path === "/" || path === "") return reply(200, { name: "Cueup", namespaces: ["wp/v2", "yoast/v1"] })
      if (init.headers["authorization"] !== `Basic ${Buffer.from(`ana:${PASSWORD.replace(/\s+/g, "")}`).toString("base64")}`) return reply(401, { code: "rest_not_logged_in", message: "secret" })
      if (path === "/wp/v2/users/me") return reply(200, { capabilities: { publish_pages: true, publish_posts: true, edit_others_pages: true, unfiltered_html: true } })
      const one = path.match(/^\/wp\/v2\/(pages|posts)\/(\d+)$/), list = path.match(/^\/wp\/v2\/(pages|posts)$/)
      if (one) {
        const p = state.posts.get(`${one[1]}/${one[2]}`)
        if (!p) return reply(404, {})
        if (init.method === "POST") {
          const b = JSON.parse(init.body ?? "{}") as { title?: string; content?: string; meta?: Record<string, string>; status?: string }
          if (b.title !== undefined) p.title = b.title
          if (b.content !== undefined) p.content = b.content
          if (b.status !== undefined) p.status = b.status
          if (b.meta && state.acceptSeoMeta) Object.assign(p.meta, b.meta)
          p.modified = new Date(Date.now() + state.nextId++).toISOString().slice(0, 19)
        }
        return reply(200, view(p))
      }
      if (list && init.method === "POST") {
        const b = JSON.parse(init.body ?? "{}") as { title: string; content: string; status: string }
        const p = { id: state.nextId++, title: b.title, content: b.content, meta: {}, modified: "2026-10-31T00:00:00", status: b.status, type: list[1]! }
        state.posts.set(`${list[1]}/${p.id}`, p)
        return reply(201, view(p))
      }
      if (list) return reply(200, [...state.posts.values()].filter(p => p.type === list[1]).map(p => ({ id: p.id, title: { rendered: p.title }, link: `https://cueup.test/${p.type}/${p.id}/`, modified_gmt: p.modified })))
      return reply(404, {})
    },
  }
  return { state, transport }
}

suite("WordPress connector (in-memory WordPress, no network)", () => {
  let pool: pg.Pool
  const wp = fakeWordPress()
  const live: WebAccessService = {
    fetch: async (u) => ({ requestedUrl: u, finalUrl: u, status: 200, contentType: "text/html", headers: {}, redirectChain: [], bytes: 1, failure: null, elapsedMs: 1,
      body: `<html><head><title>${[...wp.state.posts.values()].find(p => u.includes(`/${p.id}/`))?.title ?? ""}</title></head></html>` }) as never,
    search: null, render: null, provider: null,
  }
  const config = adsConfigFromEnv({ ADS_PROVIDER_STAND_IN_URL: "http://127.0.0.1:9/", GA4_TOKEN_ENCRYPTION_KEYS: `k1:${Buffer.alloc(32, 7).toString("base64")}` })
  const repos = Layer.mergeAll(RepoLayers.BusinessRepositoryLive, AuthRepositoryLive).pipe(Layer.provideMerge(PgClient.layer({ url: Redacted.make(url) })))
  const layer = Layer.mergeAll(repos, Layer.succeed(AdsProvider, config), Layer.succeed(WordPressHttp, wp.transport), Layer.succeed(WebAccess, live))
  const web = HttpApp.toWebHandlerLayer(wordpressApi(r => Effect.flatMap(requireSession, ({ session }) => r(session))), layer)
  const tool = (ctx: { accountId: string; userId: string; businessId: string }, name: string, args: unknown) =>
    Effect.runPromise(Effect.either(dispatchToolSpec(ctx, name, args).pipe(Effect.provide(layer)) as unknown as Effect.Effect<{ data: unknown }, unknown, never>))
  beforeAll(() => { pool = new pg.Pool({ connectionString: url }) })
  afterAll(async () => { await web.dispose(); await pool.end() })
  const fixture = async () => {
    const accountId = String((await pool.query("INSERT INTO accounts(name) VALUES('TEST wp') RETURNING id")).rows[0].id)
    const userId = String((await pool.query("INSERT INTO users(email,password_hash) VALUES($1,'TEST') RETURNING id", [`wp-${randomUUID()}@example.test`])).rows[0].id)
    await pool.query("INSERT INTO account_users(account_id,user_id) VALUES($1,$2)", [accountId, userId])
    const businessId = String((await pool.query("INSERT INTO businesses(account_id,name) VALUES($1,'TEST Cueup') RETURNING id", [accountId])).rows[0].id)
    const cookie = String((await pool.query("INSERT INTO sessions(account_id,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour') RETURNING id", [accountId, userId])).rows[0].id)
    const call = (method: string, path: string, body?: unknown, origin?: string) => web.handler(new Request(`http://localhost/api/businesses/${businessId}/wordpress${path}`, {
      method, headers: { "content-type": "application/json", cookie: `or_session=${cookie}`, ...(origin ? { origin } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }))
    return { accountId, userId, businessId, call, ctx: { accountId, userId, businessId } }
  }

  it("connects with a checked password, lets the agent prepare changes, and publishes, verifies and undoes only on approval", async () => {
    const f = await fixture()
    expect((await f.call("POST", "", { siteUrl: "https://cueup.test", username: "ana", appPassword: "wrong wrong wrong wrong" })).status).toBe(409)
    const connected = await (await f.call("POST", "", { siteUrl: "https://cueup.test/", username: "ana", appPassword: PASSWORD })).json() as { connection: Record<string, unknown> }
    expect(connected.connection).toMatchObject({ siteUrl: "https://cueup.test", seoPlugin: "YOAST", canAddScripts: true, last4: "uvwx", status: "ACTIVE" })
    expect(JSON.stringify(connected)).not.toContain("abcd")
    expect((await pool.query("SELECT password_ciphertext FROM wordpress_connections WHERE business_id = $1", [f.businessId])).rows[0].password_ciphertext).toMatch(/^v1\./)

    const listed = await tool(f.ctx, "read_wordpress_content", { postType: "pages" })
    expect(listed._tag === "Right" && listed.right.data).toMatchObject({ items: [{ postId: 7, title: "Wedding DJs" }] })
    const args = { kind: "UPDATE_COPY", postType: "pages", postId: 7, title: "Wedding DJs in Bali", rationale: "TEST clearer title" }
    const prepared = await tool(f.ctx, "prepare_wordpress_change", args)
    expect(prepared._tag).toBe("Right")
    const changeId = (prepared as { right: { data: { wordpressChangeId: string } } }).right.data.wordpressChangeId
    expect(((await tool(f.ctx, "prepare_wordpress_change", args)) as { right: { data: { wordpressChangeId: string } } }).right.data.wordpressChangeId).toBe(changeId)
    // No growth profile: the objective is unknown, so no lineage is recorded.
    const objectiveOf = async (id: string) => (await pool.query("SELECT objective_goal_id FROM wordpress_changes WHERE id=$1", [id])).rows[0].objective_goal_id
    expect(await objectiveOf(changeId)).toBeNull()
    expect(wp.state.posts.get("pages/7")!.title).toBe("Wedding DJs")

    expect((await f.call("POST", `/changes/${changeId}/approve`, {}, "https://hostile.example")).status).toBe(403)
    const other = await fixture()
    expect((await other.call("GET", `/changes/${changeId}`)).status).toBe(404)
    const approved = await (await f.call("POST", `/changes/${changeId}/approve`, {})).json() as { change: { status: string; liveCheck: { observed: boolean } } }
    expect(approved.change).toMatchObject({ status: "PUBLISHED", liveCheck: { observed: true } })
    expect(wp.state.posts.get("pages/7")!.title).toBe("Wedding DJs in Bali")
    expect((await f.call("POST", `/changes/${changeId}/approve`, {})).status).toBe(409)

    const undone = await (await f.call("POST", `/changes/${changeId}/undo`, {})).json() as { change: { status: string } }
    expect(undone.change.status).toBe("UNDONE")
    expect(wp.state.posts.get("pages/7")!.title).toBe("Wedding DJs")

    expect(await objectiveOf(changeId)).toBeNull()
    // Edited in WordPress after the change was prepared: refused, not overwritten.
    const goalId = await seedObjective(pool, f.businessId, f.userId, "More bookings")
    const stale = await tool(f.ctx, "prepare_wordpress_change", { kind: "ADD_FAQ", postType: "pages", postId: 7, faq: [{ question: "Do you travel?", answer: "Yes, across Bali." }], rationale: "TEST FAQ" })
    const staleId = (stale as { right: { data: { wordpressChangeId: string } } }).right.data.wordpressChangeId
    expect(await objectiveOf(staleId)).toBe(goalId)
    wp.state.posts.get("pages/7")!.content = "<p>Edited by a person in WordPress.</p>"
    wp.state.posts.get("pages/7")!.modified = "2026-10-31T09:00:00"
    expect((await f.call("POST", `/changes/${staleId}/approve`, {})).status).toBe(409)
    expect(wp.state.posts.get("pages/7")!.content).toBe("<p>Edited by a person in WordPress.</p>")
    expect((await (await f.call("GET", `/changes/${staleId}`)).json() as { change: { status: string; failure: string } }).change).toMatchObject({ status: "FAILED", failure: "ChangedSincePrepared" })

    // An SEO plugin that ignores API writes is reported, not called published.
    wp.state.acceptSeoMeta = false
    const seo = await tool(f.ctx, "prepare_wordpress_change", { kind: "SET_SEO", postType: "pages", postId: 7, seoDescription: "Book a wedding DJ in Bali", rationale: "TEST snippet" })
    const seoId = (seo as { right: { data: { wordpressChangeId: string } } }).right.data.wordpressChangeId
    expect((await f.call("POST", `/changes/${seoId}/approve`, {})).status).toBe(409)
    expect((await (await f.call("GET", `/changes/${seoId}`)).json() as { change: { status: string; failure: string } }).change).toMatchObject({ status: "FAILED", failure: "SeoNotWritable" })

    // A new post is published on approval and goes back to draft on undo.
    const created = await tool(f.ctx, "prepare_wordpress_change", { kind: "CREATE_POST", postType: "posts", title: "How to hire a wedding DJ", content: "<p>Guide.</p>", rationale: "TEST post" })
    const createdId = (created as { right: { data: { wordpressChangeId: string } } }).right.data.wordpressChangeId
    expect((await (await f.call("POST", `/changes/${createdId}/approve`, {})).json() as { change: { status: string } }).change.status).toBe("PUBLISHED")
    const newPost = [...wp.state.posts.values()].find(p => p.title === "How to hire a wedding DJ")!
    expect(newPost.status).toBe("publish")
    await f.call("POST", `/changes/${createdId}/undo`, {})
    expect(newPost.status).toBe("draft")
  })
})
