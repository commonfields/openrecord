import { createHash } from "node:crypto"
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
import { AuthRepositoryLive, ClaimRepositoryLive, InterventionBindingRepositoryLive, InterventionRepositoryLive, ObservationRepositoryLive, ProductReadRepositoryLive, ReobservationIntentRepositoryLive } from "@openrecord/db"
import { AdsProvider, adsConfigFromEnv } from "@openrecord/ads"
import type { HttpTransport } from "@openrecord/representation"
import { RepoLayers, requireSession } from "./router.js"
import { WebAccess, type WebAccessService } from "./web-access.js"
import { dispatchToolSpec } from "./agent-registry.js"
import { WordPressHttp, approveChange, carryOutChange, wordpressApi } from "./wordpress.js"
import { claimAgentWorkById, executeAgentWorkWith, reconcileAgentWork } from "./agent-work-queue.js"
import { seedObjective } from "./objective-work.test-support.js"

const url = process.env["TEST_DATABASE_URL"] ?? ""
const suite = url ? describe : describe.skip
const PASSWORD = "abcd efgh ijkl mnop qrst uvwx"

/** An in-memory WordPress site with Yoast, one page, and switches for the edge cases. */
function fakeWordPress() {
  const state = { acceptSeoMeta: true, nextId: 100, writes: 0,
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
          state.writes++
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
        state.writes++
        const b = JSON.parse(init.body ?? "{}") as { title: string; content: string; status: string }
        const p = { id: state.nextId++, title: b.title, content: b.content, meta: {}, modified: "2026-10-31T00:00:00", status: b.status, type: list[1]! }
        state.posts.set(`${list[1]}/${p.id}`, p)
        return reply(201, view(p))
      }
      if (list && u.searchParams.get("context") === "edit") return reply(200, [...state.posts.values()].filter(p => p.type === list[1]).map(view))
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
  const repos = Layer.mergeAll(RepoLayers.BusinessRepositoryLive, AuthRepositoryLive, ClaimRepositoryLive, InterventionRepositoryLive, InterventionBindingRepositoryLive, ProductReadRepositoryLive, ObservationRepositoryLive, ReobservationIntentRepositoryLive).pipe(Layer.provideMerge(PgClient.layer({ url: Redacted.make(url) })))
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
    // published_at is written by the publish statement itself, after the read-back.
    const times = (await pool.query("SELECT decided_at, published_at FROM wordpress_changes WHERE id=$1", [changeId])).rows[0]
    expect(times.published_at).toBeInstanceOf(Date)
    expect(times.published_at.getTime()).toBeGreaterThanOrEqual(times.decided_at.getTime())
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

  it("a change made to fix a wrong AI answer records the fix and queues its re-check once it is live", async () => {
    const f = await fixture()
    await f.call("POST", "", { siteUrl: "https://cueup.test/", username: "ana", appPassword: PASSWORD })
    const question = String((await pool.query("INSERT INTO buyer_questions(business_id,prompt) VALUES($1,'Does Cueup play weddings?') RETURNING id", [f.businessId])).rows[0].id)
    const run = String((await pool.query("INSERT INTO check_runs(business_id,question_id,provider,status) VALUES ($1,$2,'gemini','SUCCEEDED') RETURNING id", [f.businessId, question])).rows[0].id)
    const raw = JSON.stringify({ answer: "Cueup does not play weddings.", fixture: randomUUID() }), digest = createHash("sha256").update(raw).digest("hex")
    const evidence = String((await pool.query("INSERT INTO raw_evidence(digest,content_text) VALUES ($1,$2) RETURNING id", [digest, raw])).rows[0].id)
    const observation = String((await pool.query(`INSERT INTO observations(business_id,check_run_id,provider,collected_at,answer_text,retrieval_mode,raw_evidence_id,raw_digest,synthetic)
      VALUES ($1,$2,'gemini',now()-interval '1 day','Cueup does not play weddings.','unknown',$3,$4,false) RETURNING id`, [f.businessId, run, evidence, digest])).rows[0].id)
    const claimId = String((await pool.query("INSERT INTO candidate_claims(business_id,observation_id,text) VALUES ($1,$2,'Does not play weddings') RETURNING id", [f.businessId, observation])).rows[0].id)
    await pool.query("INSERT INTO human_judgments(business_id,claim_id,verdict) VALUES ($1,$2,'CONTRADICTED')", [f.businessId, claimId])

    // Another business's issue cannot be named.
    const other = await fixture()
    const foreign = await tool(other.ctx, "prepare_wordpress_change", { kind: "UPDATE_COPY", postType: "pages", postId: 7, title: "x", rationale: "TEST", claimId })
    expect(foreign._tag).toBe("Left")

    const prepared = await tool(f.ctx, "prepare_wordpress_change", { kind: "UPDATE_COPY", postType: "pages", postId: 7, title: "Wedding DJs for every wedding", rationale: "TEST say we play weddings", claimId })
    const changeId = (prepared as { right: { data: { wordpressChangeId: string } } }).right.data.wordpressChangeId
    expect((await pool.query("SELECT claim_id FROM wordpress_changes WHERE id=$1", [changeId])).rows[0].claim_id).toBe(claimId)
    // Nothing is recorded before the person approves.
    expect((await pool.query("SELECT count(*)::int n FROM intervention_issues WHERE issue_id=$1", [claimId])).rows[0].n).toBe(0)

    const approved = await (await f.call("POST", `/changes/${changeId}/approve`, {})).json() as { change: { status: string; claimId: string }; fix: { recorded: boolean; recheck: string; interventionId: string } }
    expect(approved.change).toMatchObject({ status: "PUBLISHED", claimId })
    expect(approved.fix).toMatchObject({ recorded: true, recheck: "QUEUED" })
    const action = (await pool.query("SELECT i.type, i.target FROM interventions i JOIN intervention_issues ii ON ii.intervention_id=i.id WHERE ii.issue_id=$1", [claimId])).rows
    expect(action).toEqual([{ type: "SOURCE_UPDATED", target: "https://cueup.test/pages/7/" }])
    const intent = (await pool.query("SELECT intervention_id FROM reobservation_intents WHERE issue_id=$1", [claimId])).rows
    expect(intent).toEqual([{ intervention_id: approved.fix.interventionId }])
  })

  it("finishes a publish cut off part way from what the site holds, and never writes twice", async () => {
    const f = await fixture()
    await f.call("POST", "", { siteUrl: "https://cueup.test/", username: "ana", appPassword: PASSWORD })
    wp.state.posts.set("pages/8", { id: 8, title: "Pricing", content: "<p>Plans.</p>", meta: {}, modified: "2026-10-02T00:00:00", status: "publish", type: "pages" })
    const session = { accountId: f.accountId, userId: f.userId }
    const run = <A, E>(fx: Effect.Effect<A, E, unknown>) => Effect.runPromise((fx as Effect.Effect<A, E, never>).pipe(Effect.provide(layer)))
    const prepare = async (args: Record<string, unknown>) => ((await tool(f.ctx, "prepare_wordpress_change", args)) as { right: { data: { wordpressChangeId: string } } }).right.data.wordpressChangeId
    const status = async (id: string) => (await pool.query("SELECT status, failure, published_post_id::int AS published_post_id FROM wordpress_changes WHERE id=$1", [id])).rows[0]
    /** The worker's run of a queued publish job after a restart. */
    const resume = async (job: string, id: string) => {
      const claimed = await run(claimAgentWorkById(job))
      if (!claimed) throw new Error("publish job not queued")
      await run(executeAgentWorkWith(claimed, () => carryOutChange(f.accountId, f.businessId, id)))
    }

    // The process stopped after WordPress took the write but before it was recorded.
    const update = await prepare({ kind: "UPDATE_COPY", postType: "pages", postId: 8, title: "Pricing and plans", rationale: "TEST clearer title" })
    const job = (await run(approveChange(session, f.businessId, update)))!
    expect(await status(update)).toMatchObject({ status: "PUBLISHING" })
    Object.assign(wp.state.posts.get("pages/8")!, { title: "Pricing and plans", modified: "2026-11-27T00:00:00" })
    const before = wp.state.writes
    await resume(job, update)
    expect(await status(update)).toMatchObject({ status: "PUBLISHED", published_post_id: 8 })
    expect(wp.state.writes).toBe(before)

    // A new post an earlier attempt sent is adopted, never created a second time.
    const created = await prepare({ kind: "CREATE_POST", postType: "posts", title: "Hiring a DJ for a small wedding", content: "<p>Short guide.</p>", rationale: "TEST post" })
    const createJob = (await run(approveChange(session, f.businessId, created)))!
    await pool.query("UPDATE wordpress_changes SET write_attempted_at=now() WHERE id=$1", [created])
    wp.state.posts.set("posts/300", { id: 300, title: "Hiring a DJ for a small wedding", content: "<p>Short guide.</p>", meta: {}, modified: "2026-11-27T00:00:00", status: "publish", type: "posts" })
    const beforeCreate = wp.state.writes
    await resume(createJob, created)
    expect(await status(created)).toMatchObject({ status: "PUBLISHED", published_post_id: 300 })
    expect(wp.state.writes).toBe(beforeCreate)
    expect([...wp.state.posts.values()].filter(p => p.title === "Hiring a DJ for a small wedding")).toHaveLength(1)

    // One that cannot be found is reported as unknown, and nothing is created.
    const lost = await prepare({ kind: "CREATE_POST", postType: "posts", title: "A post that never arrived", content: "<p>Lost.</p>", rationale: "TEST post" })
    const lostJob = (await run(approveChange(session, f.businessId, lost)))!
    await pool.query("UPDATE wordpress_changes SET write_attempted_at=now() WHERE id=$1", [lost])
    await resume(lostJob, lost)
    expect(await status(lost)).toMatchObject({ status: "FAILED", failure: "OutcomeUnknown" })
    expect([...wp.state.posts.values()].some(p => p.title === "A post that never arrived")).toBe(false)

    // A publish job cut off mid-run goes back on the queue instead of being left interrupted.
    const cut = await prepare({ kind: "UPDATE_COPY", postType: "pages", postId: 8, title: "Plans and pricing", rationale: "TEST another title" })
    const cutJob = (await run(approveChange(session, f.businessId, cut)))!
    await run(claimAgentWorkById(cutJob))
    await pool.query("UPDATE agent_work_jobs SET execution_started_at=now(), attempt_count=1, lease_until=now()-interval '1 second' WHERE job_id=$1", [cutJob])
    await run(reconcileAgentWork)
    expect((await pool.query("SELECT status, execution_started_at FROM agent_work_jobs WHERE job_id=$1", [cutJob])).rows[0]).toEqual({ status: "QUEUED", execution_started_at: null })
    await resume(cutJob, cut)
    expect(await status(cut)).toMatchObject({ status: "PUBLISHED" })
    expect(wp.state.posts.get("pages/8")!.title).toBe("Plans and pricing")
  })
})
