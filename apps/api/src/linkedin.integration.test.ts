// LinkedIn posts as account actions, against a scripted LinkedIn: prepared
// without posting, published once on approval and read back, never posted
// twice after an interruption, failed when LinkedIn holds other text, read
// back with page statistics, undone by deleting, and scoped to the account.
// Passing here is a stand-in result, never a live platform result.
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { HttpApp, HttpRouter } from "@effect/platform"
import { Effect, Either, Exit, Layer, Redacted, Scope } from "effect"
import { PgClient } from "@effect/sql-pg"
import pg from "pg"
import { AuthRepositoryLive, RecordRepositoryLive } from "@openrecord/db"
import { AdsProvider, adsConfigFromEnv } from "@openrecord/ads"
import { accountActionsApi, approveAction, carryOutAction, dispatchAccountAction } from "./account-actions.js"
import { adsApi } from "./ads.js"
import { claimAgentWorkById, executeAgentWorkWith } from "./agent-work-queue.js"
import { requireSession, RepoLayers } from "./router.js"

const url = process.env["TEST_DATABASE_URL"] ?? ""
const suite = url ? describe : describe.skip
const PAGE = "urn:li:organization:4242", PERSON = "urn:li:person:aB3_x-9"

suite("LinkedIn posts (scripted LinkedIn)", () => {
  let pool: pg.Pool, scope: Scope.CloseableScope
  const repos = Layer.mergeAll(RepoLayers.GrowthRepositoriesLive, RepoLayers.BusinessRepositoryLive, AuthRepositoryLive, RecordRepositoryLive).pipe(Layer.provideMerge(PgClient.layer({ url: Redacted.make(url) })))
  const handlers: Array<{ dispose: () => Promise<void> }> = []
  beforeAll(async () => { pool = new pg.Pool({ connectionString: url }); scope = await Effect.runPromise(Scope.make()); await Effect.runPromise(Layer.buildWithScope(repos, scope)) })
  afterAll(async () => { for (const h of handlers) await h.dispose(); await Effect.runPromise(Scope.close(scope, Exit.void)); await pool.end() })

  it("prepares, publishes once on approval, reads results back, and undoes by deleting", async () => {
    // Scripted LinkedIn: the posts it holds.
    const posts = new Map<string, { author: string; commentary: string }>()
    let next = 7000, garble = false
    const writes: string[] = []
    const linkedin = async (input: string, init: RequestInit) => {
      const u = new URL(input), method = init.method ?? "GET", h = init.headers as Record<string, string>
      expect(h["authorization"]).toBe("Bearer ACCESS-SECRET")
      expect(h["linkedin-version"]).toBe("202611")
      expect(h["x-restli-protocol-version"]).toBe("2.0.0")
      const one = /^\/linkedin\/rest\/posts\/(.+)$/.exec(u.pathname)
      if (u.pathname === "/linkedin/rest/posts" && method === "POST") {
        const body = JSON.parse(String(init.body)) as { author: string; commentary: string; visibility: string }
        expect(body.visibility).toBe("PUBLIC")
        const urn = `urn:li:share:${next++}`
        posts.set(urn, { author: body.author, commentary: garble ? "Something else" : body.commentary })
        writes.push(`POST ${body.author}`)
        return new Response("", { status: 201, headers: { "x-restli-id": urn } })
      }
      if (one && method === "GET") {
        const p = posts.get(decodeURIComponent(one[1]!))
        return p ? new Response(JSON.stringify({ author: p.author, commentary: p.commentary, lifecycleState: "PUBLISHED" }), { status: 200 }) : new Response("{}", { status: 404 })
      }
      if (one && method === "DELETE") {
        expect(h["x-restli-method"]).toBe("DELETE")
        writes.push(`DELETE ${decodeURIComponent(one[1]!)}`)
        posts.delete(decodeURIComponent(one[1]!))
        return new Response(null, { status: 204 })
      }
      if (u.pathname === "/linkedin/rest/organizationalEntityShareStatistics") {
        expect(u.searchParams.get("organizationalEntity")).toBe(PAGE)
        const shares = /shares=List\(([^)]*)\)/.exec(decodeURIComponent(u.search))?.[1]?.split(",") ?? []
        return new Response(JSON.stringify({ elements: shares.map(share => ({ share, organizationalEntity: PAGE,
          totalShareStatistics: { impressionCount: 1200, uniqueImpressionsCount: 900, clickCount: 40, likeCount: 25, commentCount: 4, shareCount: 3, engagement: 0.06 } })) }), { status: 200 })
      }
      return new Response(JSON.stringify({ status: 404 }), { status: 404 })
    }
    const config = adsConfigFromEnv({
      ADS_OAUTH_REDIRECT_URI: "https://api.example.test/api/ads/oauth/callback", APP_BASE_URL: "https://app.example.test", ADS_PROVIDER_STAND_IN_URL: "http://127.0.0.1:9/",
      GA4_TOKEN_ENCRYPTION_KEYS: `k1:${Buffer.alloc(32, 5).toString("base64")}`, LINKEDIN_CLIENT_ID: "lclient", LINKEDIN_CLIENT_SECRET: "LCLIENT-SECRET", LINKEDIN_ORGANIZATIONS: "1",
    }, linkedin as typeof fetch)
    expect(config.linkedin.configured).toBe(true)
    const layer = Layer.provideMerge(Layer.succeed(AdsProvider, config), repos)
    const web = HttpApp.toWebHandlerLayer(HttpRouter.concat(HttpRouter.empty, accountActionsApi(r => Effect.flatMap(requireSession, ({ session }) => r(session)))), layer)
    handlers.push(web)
    const run = <A, E>(fx: Effect.Effect<A, E, unknown>) => Effect.runPromise((fx as Effect.Effect<A, E, never>).pipe(Effect.provide(layer)))

    const account = async () => {
      const accountId = String((await pool.query("INSERT INTO accounts(name) VALUES('TEST LinkedIn') RETURNING id")).rows[0].id)
      const userId = String((await pool.query("INSERT INTO users(email,password_hash) VALUES($1,'TEST-only') RETURNING id", [`linkedin-${randomUUID()}@example.test`])).rows[0].id)
      await pool.query("INSERT INTO account_users(account_id,user_id) VALUES($1,$2)", [accountId, userId])
      const cookie = String((await pool.query("INSERT INTO sessions(id,account_id,user_id,expires_at,token_digest) SELECT u,$1::uuid,$2::uuid,now()+interval '1 hour',encode(sha256(convert_to(u::text,'UTF8')),'hex') FROM gen_random_uuid() u RETURNING id", [accountId, userId])).rows[0].id)
      const business = String((await pool.query("INSERT INTO businesses(account_id,name) VALUES($1,'TEST LinkedIn Co') RETURNING id", [accountId])).rows[0].id)
      return { accountId, userId, cookie, business }
    }
    const a = await account(), other = await account()
    const call = (acct: typeof a, method: string, path: string) =>
      web.handler(new Request(`http://localhost${path}`, { method, headers: { "content-type": "application/json", cookie: `or_session=${acct.cookie}` }, ...(method === "GET" ? {} : { body: "{}" }) }))

    // The business's LinkedIn: one sign-in (an alphanumeric member id), its page and its own profile.
    const connection = String((await pool.query(`INSERT INTO ad_connections(account_id, provider, subject, display_name, granted_scopes, connected_by_user_id)
      VALUES ($1,'linkedin','aB3_x-9','Sam Lee',$2,$3) RETURNING id`, [a.accountId, ["openid", "profile", "w_member_social", "w_organization_social", "r_organization_social", "rw_organization_admin"], a.userId])).rows[0].id)
    await pool.query("UPDATE ad_connections SET access_ciphertext=$1, access_expires_at=now()+interval '50 days' WHERE id=$2", [config.cipher!.encrypt("ACCESS-SECRET", `ads:${connection}:access`), connection])
    for (const [externalId, name] of [[PAGE, "LinkedIn Co"], [PERSON, "Sam Lee (profile)"]] as const) {
      await pool.query("INSERT INTO ad_account_bindings(account_id, business_id, connection_id, provider, external_id, name, bound_by_user_id) VALUES ($1,$2,$3,'linkedin',$4,$5,$6)",
        [a.accountId, a.business, connection, externalId, name, a.userId])
    }
    const ctx = { accountId: a.accountId, userId: a.userId, businessId: a.business }
    const agent = (name: string, args: unknown) => Effect.runPromise(Effect.either(dispatchAccountAction(ctx, name, args)).pipe(Effect.provide(layer)))

    // Where it can post.
    const authors = Either.getOrThrow(await agent("read_linkedin_posts", {}))
    expect((authors.data as { authors: Array<{ author: string; kind: string }> }).authors).toEqual(expect.arrayContaining([
      expect.objectContaining({ author: PAGE, kind: "PAGE" }), expect.objectContaining({ author: PERSON, kind: "PROFILE" })]))

    // Two places to post: the author must be named.
    const text = "We cut setup to 10 minutes (from 2 days). #Launch @everyone, try it: openrecord.example"
    const ambiguous = await agent("prepare_account_action", { kind: "PUBLISH_POST", post: text, rationale: "Announce the faster setup." })
    expect(Either.isLeft(ambiguous) && ambiguous.left).toMatchObject({ reason: "AccountAmbiguous" })
    const prepared = Either.getOrThrow(await agent("prepare_account_action", { kind: "PUBLISH_POST", author: PAGE, post: text, rationale: "Announce the faster setup." }))
    const id = String((prepared.data as { accountActionId: string }).accountActionId)
    expect(writes).toEqual([])
    expect((await call(other, "GET", `/api/businesses/${a.business}/account-actions/${id}`)).status).toBe(404)

    // Approved twice at once: posted once, read back as approved.
    const approvals = await Promise.all([0, 1].map(() => call(a, "POST", `/api/businesses/${a.business}/account-actions/${id}/approve`)))
    expect(approvals.map(r => r.status).sort()).toEqual([200, 409])
    const done = await approvals.find(r => r.status === 200)!.json() as { action: { status: string; result: { resourceName: string; url: string } } }
    expect(done.action.status).toBe("DONE")
    expect(done.action.result.url).toBe(`https://www.linkedin.com/feed/update/${done.action.result.resourceName}/`)
    expect(writes).toEqual([`POST ${PAGE}`])
    // Sent as LinkedIn's format: no stray mention, the hashtag kept.
    const stored = posts.get(done.action.result.resourceName)!
    expect(stored.commentary).toContain("\\(from 2 days\\)")
    expect(stored.commentary).toContain("{hashtag|\\#|Launch}")
    expect(stored.commentary).toContain("\\@everyone")

    // How it did: page posts carry results.
    const results = Either.getOrThrow(await agent("read_linkedin_posts", {}))
    expect((results.data as { posts: Array<Record<string, unknown>> }).posts[0]).toMatchObject({
      post: done.action.result.resourceName, author: PAGE, text, results: { impressions: 1200, clicks: 40, likes: 25, comments: 4, shares: 3, engagement: 0.06 } })

    // A profile post publishes, and says plainly that LinkedIn gives it no results.
    const profile = Either.getOrThrow(await agent("prepare_account_action", { kind: "PUBLISH_POST", author: PERSON, post: "A note from the founder.", rationale: "Founder voice." }))
    const profileId = String((profile.data as { accountActionId: string }).accountActionId)
    expect((await call(a, "POST", `/api/businesses/${a.business}/account-actions/${profileId}/approve`)).status).toBe(200)
    const both = (Either.getOrThrow(await agent("read_linkedin_posts", {})).data as { posts: Array<{ author: string; results: unknown; resultsNote: string }> }).posts
    expect(both.find(p => p.author === PERSON)).toMatchObject({ results: null, resultsNote: expect.stringContaining("no statistics") })

    // Undo deletes the page post; a second undo is refused.
    const undo = await call(a, "POST", `/api/businesses/${a.business}/account-actions/${id}/undo`)
    expect(undo.status).toBe(200)
    expect((await undo.json() as { action: { status: string } }).action.status).toBe("UNDONE")
    expect(posts.has(done.action.result.resourceName)).toBe(false)
    expect((await call(a, "POST", `/api/businesses/${a.business}/account-actions/${id}/undo`)).status).toBe(409)

    // A post someone already deleted on LinkedIn is simply undone.
    const profilePost = String((await pool.query("SELECT result->>'resourceName' AS urn FROM account_actions WHERE id=$1", [profileId])).rows[0].urn)
    posts.delete(profilePost)
    const before = writes.length
    expect((await call(a, "POST", `/api/businesses/${a.business}/account-actions/${profileId}/undo`)).status).toBe(200)
    expect(writes.length).toBe(before)

    // LinkedIn holding other text than approved: FAILED, with what was seen.
    garble = true
    const odd = Either.getOrThrow(await agent("prepare_account_action", { kind: "PUBLISH_POST", author: PAGE, post: "Second post.", rationale: "Follow-up." }))
    const oddId = String((odd.data as { accountActionId: string }).accountActionId)
    const refused = await call(a, "POST", `/api/businesses/${a.business}/account-actions/${oddId}/approve`)
    expect(await refused.json()).toMatchObject({ reason: "NotStoredAsApproved" })
    garble = false

    // An interrupted attempt that may have posted is reported as unknown, never posted again.
    const again = Either.getOrThrow(await agent("prepare_account_action", { kind: "PUBLISH_POST", author: PAGE, post: "Third post.", rationale: "Follow-up." }))
    const againId = String((again.data as { accountActionId: string }).accountActionId)
    const job = (await run(approveAction({ accountId: a.accountId, userId: a.userId }, a.business, againId)))!
    await pool.query("UPDATE account_actions SET write_attempted_at=now() WHERE id=$1", [againId])
    const sent = writes.length
    await run(executeAgentWorkWith((await run(claimAgentWorkById(job)))!, () => carryOutAction(a.accountId, a.business, againId)))
    expect((await pool.query("SELECT status, failure FROM account_actions WHERE id=$1", [againId])).rows[0]).toEqual({ status: "FAILED", failure: "OutcomeUnknown" })
    expect(writes.length).toBe(sent)
  })
  it("signs in, checks the granted scopes, lists pages and profile, and binds one", async () => {
    let grant = "openid,profile,w_member_social,w_organization_social,r_organization_social,rw_organization_admin"
    const foreign: string[] = []
    const linkedin = async (input: string, init: RequestInit) => {
      const u = new URL(input)
      if (!u.pathname.startsWith("/linkedin/")) foreign.push(u.pathname)
      if (u.pathname === "/linkedin/oauth/accessToken") {
        const form = new URLSearchParams(String(init.body))
        expect(form.get("client_secret")).toBe("LCLIENT-SECRET")
        expect(form.get("code")).toBe("abc")
        return new Response(JSON.stringify({ access_token: "LONG-LIVED-SECRET", expires_in: 5184000, scope: grant }), { status: 200 })
      }
      if (u.pathname === "/linkedin/v2/userinfo") return new Response(JSON.stringify({ sub: "aB3_x-9", name: "Sam Lee" }), { status: 200 })
      if (u.pathname === "/linkedin/rest/organizationAcls") return new Response(JSON.stringify({ elements: [{ organization: PAGE, role: "ADMINISTRATOR", state: "APPROVED" }] }), { status: 200 })
      if (u.pathname === "/linkedin/rest/organizations/4242") return new Response(JSON.stringify({ localizedName: "LinkedIn Co" }), { status: 200 })
      return new Response("{}", { status: 404 })
    }
    const config = adsConfigFromEnv({
      ADS_OAUTH_REDIRECT_URI: "https://api.example.test/api/ads/oauth/callback", APP_BASE_URL: "https://app.example.test", ADS_PROVIDER_STAND_IN_URL: "http://127.0.0.1:9/",
      GA4_TOKEN_ENCRYPTION_KEYS: `k1:${Buffer.alloc(32, 6).toString("base64")}`, LINKEDIN_CLIENT_ID: "lclient", LINKEDIN_CLIENT_SECRET: "LCLIENT-SECRET", LINKEDIN_ORGANIZATIONS: "1",
    }, linkedin as typeof fetch)
    const layer = Layer.provideMerge(Layer.succeed(AdsProvider, config), repos)
    const web = HttpApp.toWebHandlerLayer(HttpRouter.concat(HttpRouter.empty, adsApi(r => Effect.flatMap(requireSession, ({ session }) => r(session)))), layer)
    handlers.push(web)
    const accountId = String((await pool.query("INSERT INTO accounts(name) VALUES('TEST LinkedIn sign-in') RETURNING id")).rows[0].id)
    const userId = String((await pool.query("INSERT INTO users(email,password_hash) VALUES($1,'TEST-only') RETURNING id", [`li-signin-${randomUUID()}@example.test`])).rows[0].id)
    await pool.query("INSERT INTO account_users(account_id,user_id) VALUES($1,$2)", [accountId, userId])
    const cookie = String((await pool.query("INSERT INTO sessions(id,account_id,user_id,expires_at,token_digest) SELECT u,$1::uuid,$2::uuid,now()+interval '1 hour',encode(sha256(convert_to(u::text,'UTF8')),'hex') FROM gen_random_uuid() u RETURNING id", [accountId, userId])).rows[0].id)
    const business = String((await pool.query("INSERT INTO businesses(account_id,name) VALUES($1,'TEST LinkedIn sign-in') RETURNING id", [accountId])).rows[0].id)
    const call = (method: string, path: string, body?: unknown) => web.handler(new Request(`http://localhost${path}`, {
      method, headers: { "content-type": "application/json", cookie: `or_session=${cookie}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }))
    const signIn = async () => {
      const { authorizationUrl } = await (await call("POST", "/api/ads/connect", { provider: "linkedin", businessId: business })).json() as { authorizationUrl: string }
      const u = new URL(authorizationUrl)
      expect(u.pathname).toBe("/linkedin/oauth/authorization")
      expect(u.searchParams.get("scope")).toBe("openid profile w_member_social w_organization_social r_organization_social rw_organization_admin")
      return (await call("GET", `/api/ads/oauth/callback?state=${u.searchParams.get("state")}&code=abc`)).headers.get("location")
    }

    // A grant with a scope OpenRecord never asked for is refused and nothing is stored.
    grant = "openid,profile,w_member_social,r_ads"
    expect(await signIn()).toContain("ads=scope_refused")
    expect((await pool.query("SELECT count(*)::int AS n FROM ad_connections WHERE account_id=$1", [accountId])).rows[0].n).toBe(0)

    grant = "openid,profile,w_member_social,w_organization_social,r_organization_social,rw_organization_admin"
    expect(await signIn()).toBe(`https://app.example.test/businesses/${business}/channels?ads=connected#ads`)
    const stored = (await pool.query("SELECT * FROM ad_connections WHERE account_id=$1", [accountId])).rows[0]
    expect(stored).toMatchObject({ provider: "linkedin", subject: "aB3_x-9", display_name: "Sam Lee", status: "ACTIVE", refresh_ciphertext: null })
    expect(JSON.stringify(stored)).not.toContain("LONG-LIVED-SECRET")

    const status = await (await call("GET", `/api/ads/clients/${business}`)).json() as { providers: Record<string, { configured: boolean }>; connections: Array<{ id: string; expiresAt: string | null }> }
    expect(status.providers["linkedin"]).toEqual({ configured: true })
    expect(status.connections[0]!.expiresAt).not.toBeNull()
    const connectionId = status.connections[0]!.id
    const { accounts } = await (await call("GET", `/api/ads/connections/${connectionId}/accounts`)).json() as { accounts: Array<{ externalId: string; name: string }> }
    expect(accounts.map(x => [x.externalId, x.name])).toEqual([[PAGE, "LinkedIn Co"], [PERSON, "Sam Lee (profile)"]])
    const bound = await call("POST", `/api/ads/clients/${business}/bindings`, { connectionId, externalId: PAGE })
    expect(bound.status).toBe(200)
    expect((await bound.json() as { binding: { externalId: string; name: string } }).binding).toMatchObject({ externalId: PAGE, name: "LinkedIn Co" })
    // An author this sign-in cannot post for is refused.
    expect((await call("POST", `/api/ads/clients/${business}/bindings`, { connectionId, externalId: "urn:li:organization:999" })).status).toBe(409)
    // Disconnecting never sends the LinkedIn token anywhere else.
    expect((await call("POST", `/api/ads/connections/${connectionId}/disconnect`, {})).status).toBe(200)
    expect((await pool.query("SELECT status, access_ciphertext FROM ad_connections WHERE id=$1", [connectionId])).rows[0]).toEqual({ status: "DISCONNECTED", access_ciphertext: null })
    expect(foreign).toEqual([])
  })
})
