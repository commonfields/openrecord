// Search Console over HTTP against the local Google stand-in: the scope on the
// shared Google connection, return to Channels after consent, binding only a
// site the connection can read, tenancy, live performance windows, and the
// agent's read_search_performance tool. Passing here is MOCK_ADAPTER_PASS,
// never a live Google result.
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { HttpApp, HttpRouter } from "@effect/platform"
import { Effect, Exit, Layer, Redacted, Scope } from "effect"
import { PgClient } from "@effect/sql-pg"
import pg from "pg"
import { GA4_OAUTH_CALLBACK_PATH, GA4_READONLY_SCOPE, searchConsoleWindows, type SearchPerformance } from "@openrecord/contracts"
import { AuthRepositoryLive, RecordRepositoryLive } from "@openrecord/db"
import { fixtureGa4Config, fixtureGa4Layer, fixtureGoogle } from "@openrecord/ga4"
import { growthGa4Api } from "./growth-ga4-routes.js"
import { growthApi } from "./growth-routes.js"
import { searchConsoleApi } from "./search-console-routes.js"
import { readSearchPerformance } from "./agent-search-tools.js"
import { requireSession, RepoLayers } from "./router.js"

const url = process.env["TEST_DATABASE_URL"] ?? ""
const CLIENT = { clientId: "fixture-client.apps.googleusercontent.com", clientSecret: "fixture-secret-DO-NOT-LEAK", redirectUri: `https://app.example.test${GA4_OAUTH_CALLBACK_PATH}` }
const APP = "https://app.example.test"
const SITE = "sc-domain:salon.test", OTHER = "https://other.test/"
const product = {
  name: "TEST SC Salon", websiteUrl: "https://www.salon.test", engagement: "CLIENT", category: "TEST services", audience: "TEST locals", valueProposition: "TEST positioning", goalStatement: "Increase bookings",
  metric: { conversionKind: "BOOKING", label: "Bookings", sourceKind: "GA4_AGGREGATE_EXPORT", sourceIdentity: "TEST GA4 property", eventName: "book_appointment", reportingTimeZone: "UTC", propertyRef: "properties/111111", countingSemantics: "EVENT_COUNT", unit: "COUNT", currency: null },
}

const suite = url ? describe : describe.skip
suite("Search Console over HTTP and for the agent (local Google stand-in)", () => {
  let pool: pg.Pool, scope: Scope.CloseableScope
  const repos = Layer.mergeAll(RepoLayers.GrowthRepositoriesLive, RepoLayers.BusinessRepositoryLive, AuthRepositoryLive, RecordRepositoryLive).pipe(Layer.provideMerge(PgClient.layer({ url: Redacted.make(url) })))
  const handlers: Array<{ dispose: () => Promise<void> }> = []
  beforeAll(async () => { pool = new pg.Pool({ connectionString: url }); scope = await Effect.runPromise(Scope.make()); await Effect.runPromise(Layer.buildWithScope(repos, scope)) })
  afterAll(async () => { for (const h of handlers) await h.dispose(); await Effect.runPromise(Scope.close(scope, Exit.void)); await pool.end() })

  const account = async () => {
    const accountId = String((await pool.query("INSERT INTO accounts(name) VALUES('TEST SC API') RETURNING id")).rows[0].id)
    const userId = String((await pool.query("INSERT INTO users(email,password_hash) VALUES($1,'TEST-only') RETURNING id", [`sc-${randomUUID()}@example.test`])).rows[0].id)
    await pool.query("INSERT INTO account_users(account_id,user_id) VALUES($1,$2)", [accountId, userId])
    const cookie = String((await pool.query("INSERT INTO sessions(account_id,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour') RETURNING id", [accountId, userId])).rows[0].id)
    return { accountId, userId, cookie }
  }
  type Acct = Awaited<ReturnType<typeof account>>
  const { current, previous } = searchConsoleWindows(Date.now(), 7)
  const days = (window: { start: string }, clicks: number, impressions: number, position: number) => Object.fromEntries(Array.from({ length: 7 }, (_, i) =>
    [new Date(Date.parse(`${window.start}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10), { clicks, impressions, position }]))

  const setup = async () => {
    const g = fixtureGoogle({
      ...CLIENT,
      identities: [{ sub: "1001", email: "agency@example.test", properties: [], sites: [{ siteUrl: SITE }, { siteUrl: OTHER, permissionLevel: "siteFullUser" }, { siteUrl: "https://unverified.test/", permissionLevel: "siteUnverifiedUser" }] }],
      properties: [],
      sites: [
        { siteUrl: SITE, days: { ...days(previous, 5, 100, 12), ...days(current, 10, 200, 8) },
          queries: [{ key: "salon near me", clicks: 40, impressions: 600, position: 6 }, { key: "best haircut", clicks: 30, impressions: 800, position: 9 }],
          pages: [{ key: "https://www.salon.test/", clicks: 60, impressions: 1000, position: 7 }] },
        { siteUrl: OTHER, days: {} },
      ],
    })
    const config = fixtureGa4Config(g, { ...CLIENT, appBaseUrl: APP })
    const layer = Layer.provideMerge(fixtureGa4Layer(config), repos)
    const web = HttpApp.toWebHandlerLayer(HttpRouter.concat(HttpRouter.concat(
      growthApi(r => Effect.flatMap(requireSession, ({ session }) => r(session))),
      growthGa4Api(r => Effect.flatMap(requireSession, ({ session }) => r(session)))),
      searchConsoleApi(r => Effect.flatMap(requireSession, ({ session }) => r(session)))), layer)
    handlers.push(web)
    const bodies: string[] = []
    const call = async (acct: Acct | null, method: string, path: string, body?: unknown) => {
      const response = await web.handler(new Request(`http://localhost${path}`, { method, headers: { "content-type": "application/json", ...(acct ? { cookie: `or_session=${acct.cookie}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }))
      bodies.push(await response.clone().text(), response.headers.get("location") ?? "")
      return response
    }
    const ok = async <T>(r: Promise<Response>): Promise<T> => { const x = await r; if (x.status !== 200) throw new Error(`Expected 200, got ${x.status}: ${await x.text()}`); return await x.json() as T }
    const refusal = async (r: Promise<Response>) => { const x = await r; const j = await x.json().catch(() => ({})) as { reason?: string; _tag?: string }; return { status: x.status, reason: j.reason ?? j._tag } }
    const a = await account(), b = await account()
    const business = async (acct: Acct) => (await ok<{ profile: { businessId: string } }>(call(acct, "POST", "/api/growth/products", { ...product, idempotencyKey: randomUUID() }))).profile.businessId
    const ba = await business(a), bb = await business(b)
    const connect = async (acct: Acct, businessId: string, grantScopes?: ReadonlyArray<string>, connectionId: string | null = null) => {
      const { authorizationUrl } = await ok<{ authorizationUrl: string }>(call(acct, "POST", "/api/growth/ga4/connect", { businessId, connectionId, returnTo: "CHANNELS" }))
      const back = new URL(g.consent(authorizationUrl, { sub: "1001", ...(grantScopes ? { grantScopes } : {}) }))
      return (await call(acct, "GET", `${back.pathname}${back.search}`)).headers.get("location") ?? ""
    }
    const tool = (acct: Acct, businessId: string, input: { days?: 7 | 28 | 90 } = {}) =>
      Effect.runPromise(readSearchPerformance(acct.accountId, businessId, input).pipe(Effect.provide(layer), Effect.either))
    return { g, call, ok, refusal, a, b, ba, bb, connect, tool, bodies }
  }

  it("connects Search Console on the shared Google connection and returns to Channels", async () => {
    const s = await setup()
    expect(await s.connect(s.a, s.ba)).toBe(`${APP}/businesses/${s.ba}/channels?google=connected#search-console`)
    const status = await s.ok<{ configured: boolean; binding: null; connections: Array<{ id: string; searchConsole: boolean }> }>(s.call(s.a, "GET", `/api/growth/clients/${s.ba}/search-console`))
    expect(status).toMatchObject({ configured: true, binding: null, connections: [{ googleEmail: "agency@example.test", status: "ACTIVE", searchConsole: true }] })
    // Unverified sites are never offered; a domain property covering the website is marked.
    const { sites } = await s.ok<{ sites: Array<{ siteUrl: string; matchesWebsite: boolean }> }>(s.call(s.a, "GET", `/api/growth/clients/${s.ba}/search-console/sites?connectionId=${status.connections[0]!.id}`))
    expect(sites).toEqual([{ siteUrl: OTHER, permissionLevel: "siteFullUser", matchesWebsite: false }, { siteUrl: SITE, permissionLevel: "siteOwner", matchesWebsite: true }])
  })

  it("binds only a site the connection can read, inside the account, and reads live performance windows", async () => {
    const s = await setup()
    await s.connect(s.a, s.ba)
    const connectionId = (await s.ok<{ connections: Array<{ id: string }> }>(s.call(s.a, "GET", `/api/growth/clients/${s.ba}/search-console`))).connections[0]!.id
    const path = `/api/growth/clients/${s.ba}/search-console`
    expect(await s.refusal(s.call(s.a, "GET", `${path}/performance?days=28`))).toEqual({ status: 409, reason: "SearchConsoleNotBound" })
    expect(await s.refusal(s.call(s.a, "POST", `${path}/binding`, { connectionId, siteUrl: "https://unverified.test/" }))).toEqual({ status: 409, reason: "SiteNotAccessible" })
    expect(await s.refusal(s.call(s.a, "POST", `${path}/binding`, { connectionId, siteUrl: "not a site" }))).toEqual({ status: 422, reason: "InvalidRequest" })
    // Another account can use neither the connection nor the business.
    expect((await s.refusal(s.call(s.b, "POST", `/api/growth/clients/${s.bb}/search-console/binding`, { connectionId, siteUrl: SITE }))).status).toBe(404)
    expect((await s.refusal(s.call(s.b, "GET", `${path}`))).status).toBe(404)
    const { binding } = await s.ok<{ binding: { id: string; siteUrl: string } }>(s.call(s.a, "POST", `${path}/binding`, { connectionId, siteUrl: SITE }))
    expect(binding).toMatchObject({ siteUrl: SITE, permissionLevel: "siteOwner", businessId: s.ba })
    expect((await s.ok<{ binding: { id: string } }>(s.call(s.a, "POST", `${path}/binding`, { connectionId, siteUrl: SITE }))).binding.id).toBe(binding.id)

    expect(await s.refusal(s.call(s.a, "GET", `${path}/performance?days=30`))).toEqual({ status: 422, reason: "InvalidRequest" })
    const { performance } = await s.ok<{ performance: SearchPerformance }>(s.call(s.a, "GET", `${path}/performance?days=7`))
    expect(performance).toMatchObject({
      siteUrl: SITE, days: 7,
      current: { ...current, totals: { clicks: 70, impressions: 1400, ctr: 0.05, position: 8 } },
      previous: { ...previous, totals: { clicks: 35, impressions: 700, ctr: 0.05, position: 12 } },
      topQueries: [{ key: "salon near me", clicks: 40 }, { key: "best haircut", clicks: 30 }],
      topPages: [{ key: "https://www.salon.test/", clicks: 60 }],
    })
    // Rebinding ends the old binding in the same transaction; history stays.
    await s.ok(s.call(s.a, "POST", `${path}/binding`, { connectionId, siteUrl: OTHER }))
    expect((await pool.query("SELECT site_url, ended_at IS NULL AS active FROM search_console_bindings WHERE business_id=$1 ORDER BY created_at", [s.ba])).rows)
      .toEqual([{ site_url: SITE, active: false }, { site_url: OTHER, active: true }])
    await expect(pool.query("DELETE FROM search_console_bindings WHERE business_id=$1", [s.ba])).rejects.toThrow(/keep their history/)
    await s.ok(s.call(s.a, "POST", `${path}/binding/end`, {}))
    expect((await s.ok<{ binding: null }>(s.call(s.a, "GET", path))).binding).toBeNull()
    for (const secret of [...s.g.issuedTokens, CLIENT.clientSecret]) expect(s.bodies.join("\n")).not.toContain(secret)
  })

  it("refuses a site read without the Search Console scope, and the database refuses broader scopes", async () => {
    const s = await setup()
    await s.connect(s.a, s.ba, ["openid", "email", GA4_READONLY_SCOPE])
    const status = await s.ok<{ connections: Array<{ id: string; searchConsole: boolean }> }>(s.call(s.a, "GET", `/api/growth/clients/${s.ba}/search-console`))
    expect(status.connections).toMatchObject([{ searchConsole: false }])
    expect(await s.refusal(s.call(s.a, "GET", `/api/growth/clients/${s.ba}/search-console/sites?connectionId=${status.connections[0]!.id}`))).toEqual({ status: 409, reason: "SearchConsoleScopeMissing" })
    await expect(pool.query("UPDATE growth_ga4_connections SET granted_scopes=ARRAY['openid','https://www.googleapis.com/auth/webmasters'] WHERE id=$1", [status.connections[0]!.id])).rejects.toThrow(/granted_scopes_check/)
  })

  it("gives the agent search performance, and says plainly when it is not connected", async () => {
    const s = await setup()
    expect(await s.tool(s.a, s.ba)).toMatchObject({ _tag: "Right", right: { summary: "Search Console is not connected for this business", data: { status: "NOT_CONNECTED" } } })
    expect(await s.tool(s.b, s.ba)).toMatchObject({ _tag: "Left", left: { _tag: "AgentNotInScope" } })
    await s.connect(s.a, s.ba)
    const connectionId = (await s.ok<{ connections: Array<{ id: string }> }>(s.call(s.a, "GET", `/api/growth/clients/${s.ba}/search-console`))).connections[0]!.id
    await s.ok(s.call(s.a, "POST", `/api/growth/clients/${s.ba}/search-console/binding`, { connectionId, siteUrl: SITE }))
    const read = await s.tool(s.a, s.ba, { days: 7 })
    expect(read).toMatchObject({ _tag: "Right", right: {
      summary: "Search Console, last 7 days: 70 clicks, 1,400 impressions (clicks +100% vs the previous 7 days)",
      citations: [{ kind: "search_console", id: s.ba }],
      data: { site: SITE, topQueries: [{ key: "salon near me" }, { key: "best haircut" }] },
    } })
    // Revoked at Google: the connection is suspended and the agent is told to reconnect.
    s.g.revokeIdentity("1001")
    await pool.query("UPDATE growth_ga4_credentials SET access_ciphertext=NULL, access_expires_at=NULL WHERE connection_id=$1", [connectionId])
    expect(await s.tool(s.a, s.ba, { days: 7 })).toMatchObject({ _tag: "Right", right: { data: { status: "RECONNECT_REQUIRED" } } })
  })
})
