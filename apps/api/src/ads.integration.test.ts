// Ad account connections over HTTP against a scripted Meta and Google Ads:
// sign-in with single-use state, tokens stored only as ciphertext, binding
// only an ad account the sign-in can read, tenancy, live performance and the
// agent's read_ad_performance tool, and disconnect. Passing here is a
// stand-in result, never a live platform result.
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { HttpApp, HttpRouter } from "@effect/platform"
import { Effect, Exit, Layer, Redacted, Scope } from "effect"
import { PgClient } from "@effect/sql-pg"
import pg from "pg"
import { AuthRepositoryLive, RecordRepositoryLive } from "@openrecord/db"
import { AdsProvider, adsConfigFromEnv } from "@openrecord/ads"
import { adsApi } from "./ads.js"
import { growthApi } from "./growth-routes.js"
import { readAdPerformance, readLocalProfile } from "./agent-ads-tools.js"
import { requireSession, RepoLayers } from "./router.js"

const url = process.env["TEST_DATABASE_URL"] ?? ""
const product = {
  name: "TEST Ads Salon", websiteUrl: "https://www.salon.test", engagement: "CLIENT", category: "TEST services", audience: "TEST locals", valueProposition: "TEST positioning", goalStatement: "Increase bookings",
  metric: { conversionKind: "BOOKING", label: "Bookings", sourceKind: "GA4_AGGREGATE_EXPORT", sourceIdentity: "TEST GA4 property", eventName: "book_appointment", reportingTimeZone: "UTC", propertyRef: "properties/111111", countingSemantics: "EVENT_COUNT", unit: "COUNT", currency: null },
}

const suite = url ? describe : describe.skip
suite("ad and listing connections over HTTP and for the agent (scripted Meta and Google)", () => {
  let pool: pg.Pool, scope: Scope.CloseableScope
  const repos = Layer.mergeAll(RepoLayers.GrowthRepositoriesLive, RepoLayers.BusinessRepositoryLive, AuthRepositoryLive, RecordRepositoryLive).pipe(Layer.provideMerge(PgClient.layer({ url: Redacted.make(url) })))
  const handlers: Array<{ dispose: () => Promise<void> }> = []
  beforeAll(async () => { pool = new pg.Pool({ connectionString: url }); scope = await Effect.runPromise(Scope.make()); await Effect.runPromise(Layer.buildWithScope(repos, scope)) })
  afterAll(async () => { for (const h of handlers) await h.dispose(); await Effect.runPromise(Scope.close(scope, Exit.void)); await pool.end() })

  const account = async () => {
    const accountId = String((await pool.query("INSERT INTO accounts(name) VALUES('TEST Ads') RETURNING id")).rows[0].id)
    const userId = String((await pool.query("INSERT INTO users(email,password_hash) VALUES($1,'TEST-only') RETURNING id", [`ads-${randomUUID()}@example.test`])).rows[0].id)
    await pool.query("INSERT INTO account_users(account_id,user_id) VALUES($1,$2)", [accountId, userId])
    const cookie = String((await pool.query("INSERT INTO sessions(account_id,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour') RETURNING id", [accountId, userId])).rows[0].id)
    return { accountId, userId, cookie }
  }
  type Acct = Awaited<ReturnType<typeof account>>

  it("signs in to Meta, binds only a readable ad account, reads performance, and disconnects", async () => {
    // A scripted Meta: one person who can read ad account 222, not 333.
    const graphCalls: string[] = []
    let permissions = [{ permission: "ads_read", status: "granted" }, { permission: "public_profile", status: "granted" }]
    const meta = async (input: string, init: RequestInit) => {
      graphCalls.push(`${init.method} ${input}`)
      const u = new URL(input)
      const body = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status })
      if (u.pathname.endsWith("/oauth/access_token")) return body(String(init.body).includes("fb_exchange_token") ? { access_token: "LONG-LIVED-SECRET", expires_in: 5_184_000 } : { access_token: "SHORT-SECRET", expires_in: 3600 })
      if (u.pathname.endsWith("/me")) return body({ id: "4242", name: "Agency Owner" })
      if (u.pathname.endsWith("/me/permissions")) return init.method === "DELETE" ? body({ success: true }) : body({ data: permissions })
      if (u.pathname.endsWith("/4242/permissions")) return body({ success: true })
      if (u.pathname.endsWith("/me/adaccounts")) return body({ data: [{ account_id: "222", name: "Salon Ads", currency: "USD", account_status: 1 }] })
      if (u.pathname.endsWith("/act_222/insights")) return u.searchParams.get("level") === "campaign"
        ? body({ data: [{ campaign_id: "9", campaign_name: "Spring promo", spend: "300", clicks: "120", impressions: "9000", actions: [{ action_type: "lead", value: "6" }] }] })
        : body({ data: [{ spend: "500", clicks: "200", impressions: "20000", actions: [{ action_type: "lead", value: "10" }] }] })
      return body({ error: { code: 100 } }, 400)
    }
    const config = adsConfigFromEnv({
      ADS_OAUTH_REDIRECT_URI: "https://api.example.test/api/ads/oauth/callback", APP_BASE_URL: "https://app.example.test",
      GA4_TOKEN_ENCRYPTION_KEYS: `k1:${Buffer.alloc(32, 7).toString("base64")}`, META_APP_ID: "1234", META_APP_SECRET: "APP-SECRET-DO-NOT-LEAK",
    }, meta as typeof fetch)
    const layer = Layer.provideMerge(Layer.succeed(AdsProvider, config), repos)
    const web = HttpApp.toWebHandlerLayer(HttpRouter.concat(
      growthApi(r => Effect.flatMap(requireSession, ({ session }) => r(session))),
      adsApi(r => Effect.flatMap(requireSession, ({ session }) => r(session)))), layer)
    handlers.push(web)
    const seen: string[] = []
    const call = async (acct: Acct, method: string, path: string, body?: unknown) => {
      const r = await web.handler(new Request(`http://localhost${path}`, { method, headers: { "content-type": "application/json", cookie: `or_session=${acct.cookie}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }))
      seen.push(await r.clone().text(), r.headers.get("location") ?? "")
      return r
    }
    const ok = async <T>(r: Promise<Response>): Promise<T> => { const x = await r; if (x.status !== 200) throw new Error(`Expected 200, got ${x.status}: ${await x.text()}`); return await x.json() as T }
    const a = await account(), b = await account()
    const business = async (acct: Acct) => (await ok<{ profile: { businessId: string } }>(call(acct, "POST", "/api/growth/products", { ...product, idempotencyKey: randomUUID() }))).profile.businessId
    const ba = await business(a), bb = await business(b)

    // Not connected yet: the agent says so instead of reporting zero.
    const before = await Effect.runPromise(readAdPerformance(a.accountId, ba, {}).pipe(Effect.provide(layer)))
    expect(before.data).toMatchObject({ status: "NOT_CONNECTED" })

    const status = await ok<{ providers: Record<string, { configured: boolean; reason?: string }> }>(call(a, "GET", `/api/ads/clients/${ba}`))
    expect(status.providers).toEqual({ meta: { configured: true }, google_ads: { configured: false, reason: "MISSING_APP" }, google_business: { configured: false, reason: "MISSING_APP" } })
    const { authorizationUrl } = await ok<{ authorizationUrl: string }>(call(a, "POST", "/api/ads/connect", { provider: "meta", businessId: ba }))
    const state = new URL(authorizationUrl).searchParams.get("state")!
    expect(new URL(authorizationUrl).searchParams.get("scope")).toBe("ads_read")
    // Another account cannot use this state.
    expect((await call(b, "GET", `/api/ads/oauth/callback?state=${state}&code=abc`)).headers.get("location")).toBe("https://app.example.test/clients?ads=state_invalid")
    const back = await call(a, "GET", `/api/ads/oauth/callback?state=${state}&code=abc`)
    expect(back.headers.get("location")).toBe(`https://app.example.test/businesses/${ba}/channels?ads=connected#ads`)
    // Single use.
    expect((await call(a, "GET", `/api/ads/oauth/callback?state=${state}&code=abc`)).headers.get("location")).toContain("state_invalid")

    const stored = (await pool.query("SELECT * FROM ad_connections WHERE account_id=$1", [a.accountId])).rows[0]
    expect(stored).toMatchObject({ provider: "meta", subject: "4242", display_name: "Agency Owner", status: "ACTIVE", granted_scopes: ["ads_read", "public_profile"] })
    expect(stored.access_ciphertext).toMatch(/^v1\./)
    expect(JSON.stringify(stored)).not.toContain("LONG-LIVED-SECRET")

    const { connections } = await ok<{ connections: Array<{ id: string; expiresAt: string | null }> }>(call(a, "GET", `/api/ads/clients/${ba}`))
    const connectionId = connections[0]!.id
    expect(connections[0]!.expiresAt).not.toBeNull()
    expect((await ok<{ accounts: unknown[] }>(call(a, "GET", `/api/ads/connections/${connectionId}/accounts`))).accounts).toEqual([{ externalId: "222", name: "Salon Ads", currency: "USD", active: true }])
    // Another account's connection and business are not found.
    expect((await call(b, "GET", `/api/ads/connections/${connectionId}/accounts`)).status).toBe(404)
    expect((await call(b, "POST", `/api/ads/clients/${bb}/bindings`, { connectionId, externalId: "222" })).status).toBe(404)
    // Only an account this sign-in can read is bound.
    expect((await call(a, "POST", `/api/ads/clients/${ba}/bindings`, { connectionId, externalId: "333" })).status).toBe(409)
    const { binding } = await ok<{ binding: { id: string; name: string } }>(call(a, "POST", `/api/ads/clients/${ba}/bindings`, { connectionId, externalId: "act_222" }))
    expect(binding.name).toBe("Salon Ads")

    const perf = await ok<{ accounts: Array<{ current: { totals: Record<string, number> }; topCampaigns: Array<{ name: string }> }> }>(call(a, "GET", `/api/ads/clients/${ba}/performance?days=28`))
    expect(perf.accounts[0]!.current.totals).toMatchObject({ spend: 500, clicks: 200, conversions: 10, costPerConversion: 50 })
    expect(perf.accounts[0]!.topCampaigns[0]!.name).toBe("Spring promo")
    const tool = await Effect.runPromise(readAdPerformance(a.accountId, ba, { days: 7 }).pipe(Effect.provide(layer)))
    expect(tool.summary).toContain("Meta Ads (Salon Ads), last 7 days: $500 spent, 200 clicks, 10 conversions")
    expect(tool.citations).toEqual([{ kind: "ad_account", id: "meta:222", text: "Meta Ads: Salon Ads" }])

    // A permission beyond ads_read is refused and revoked.
    permissions = [...permissions, { permission: "ads_management", status: "granted" }]
    const second = await ok<{ authorizationUrl: string }>(call(a, "POST", "/api/ads/connect", { provider: "meta", businessId: ba }))
    expect((await call(a, "GET", `/api/ads/oauth/callback?state=${new URL(second.authorizationUrl).searchParams.get("state")}&code=abc`)).headers.get("location")).toContain("ads=scope_refused")
    expect(graphCalls.some(c => c.startsWith("DELETE"))).toBe(true)

    // Disconnect removes tokens and ends the binding.
    await ok(call(a, "POST", `/api/ads/connections/${connectionId}/disconnect`))
    const gone = (await pool.query("SELECT status, access_ciphertext FROM ad_connections WHERE id=$1", [connectionId])).rows[0]
    expect(gone).toEqual({ status: "DISCONNECTED", access_ciphertext: null })
    expect((await ok<{ bindings: unknown[] }>(call(a, "GET", `/api/ads/clients/${ba}`))).bindings).toEqual([])

    // No response or redirect ever carried a token or the app secret; calls to Meta never put them in the URL.
    for (const text of seen) for (const secret of ["LONG-LIVED-SECRET", "SHORT-SECRET", "APP-SECRET-DO-NOT-LEAK"]) expect(text).not.toContain(secret)
    for (const c of graphCalls) expect(c).not.toMatch(/SECRET/)
    expect(graphCalls.every(c => !/ads_management|\/ads\b|\/campaigns\b/.test(c) || c.startsWith("GET"))).toBe(true)
  })

  it("signs in to Google Business Profile, keeps the refresh token encrypted, binds a location and reads it live", async () => {
    const O = "http://127.0.0.1:9"
    const idToken = (claims: Record<string, unknown>) => `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`
    let scope = "openid email https://www.googleapis.com/auth/business.manage"
    const google = async (input: string, init: RequestInit) => {
      const u = new URL(input)
      const body = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status })
      if (u.pathname === "/token") {
        const form = new URLSearchParams(String(init.body))
        if (form.get("grant_type") === "refresh_token") return body({ access_token: "REFRESHED-SECRET", expires_in: 3600, scope })
        expect(form.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43}$/)
        return body({ access_token: "GOOGLE-ACCESS-SECRET", refresh_token: "GOOGLE-REFRESH-SECRET", expires_in: 3600, scope,
          id_token: idToken({ iss: "https://accounts.google.com", aud: "gclient", sub: "777", email: "owner@salon.test", email_verified: true, exp: Math.floor(Date.now() / 1000) + 600 }) })
      }
      if (u.pathname === "/revoke") return body({})
      expect(init.method).toBe("GET")
      if (u.pathname === "/gbp/accounts/accounts") return body({ accounts: [{ name: "accounts/555" }] })
      if (u.pathname === "/gbp/information/accounts/555/locations") return body({ locations: [{ name: "locations/9001", title: "Salon Main", storefrontAddress: { locality: "Austin" } }] })
      if (u.pathname.endsWith(":fetchMultiDailyMetricsTimeSeries")) return body({ multiDailyMetricTimeSeries: [{ dailyMetricTimeSeries: [{ dailyMetric: "CALL_CLICKS", timeSeries: { datedValues: [{ value: "9" }] } }] }] })
      if (u.pathname.includes("/searchkeywords/")) return body({ error: { status: "PERMISSION_DENIED" } }, 403)
      if (u.pathname === "/gbp/reviews/accounts/555/locations/9001/reviews") return body({ averageRating: 4.8, totalReviewCount: 40, reviews: [] })
      return body({ error: { status: "NOT_FOUND" } }, 404)
    }
    const config = adsConfigFromEnv({
      ADS_OAUTH_REDIRECT_URI: "https://api.example.test/api/ads/oauth/callback", APP_BASE_URL: "https://app.example.test", ADS_PROVIDER_STAND_IN_URL: `${O}/`,
      GA4_TOKEN_ENCRYPTION_KEYS: `k1:${Buffer.alloc(32, 3).toString("base64")}`, GOOGLE_OAUTH_CLIENT_ID: "gclient", GOOGLE_OAUTH_CLIENT_SECRET: "GCLIENT-SECRET",
    }, google as typeof fetch)
    expect(config.googleBusiness.configured).toBe(true)
    const layer = Layer.provideMerge(Layer.succeed(AdsProvider, config), repos)
    const web = HttpApp.toWebHandlerLayer(HttpRouter.concat(
      growthApi(r => Effect.flatMap(requireSession, ({ session }) => r(session))),
      adsApi(r => Effect.flatMap(requireSession, ({ session }) => r(session)))), layer)
    handlers.push(web)
    const seen: string[] = []
    const call = async (acct: Acct, method: string, path: string, body?: unknown) => {
      const r = await web.handler(new Request(`http://localhost${path}`, { method, headers: { "content-type": "application/json", cookie: `or_session=${acct.cookie}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }))
      seen.push(await r.clone().text(), r.headers.get("location") ?? "")
      return r
    }
    const ok = async <T>(r: Promise<Response>): Promise<T> => { const x = await r; if (x.status !== 200) throw new Error(`Expected 200, got ${x.status}: ${await x.text()}`); return await x.json() as T }
    const a = await account()
    const ba = (await ok<{ profile: { businessId: string } }>(call(a, "POST", "/api/growth/products", { ...product, idempotencyKey: randomUUID() }))).profile.businessId

    const start = await ok<{ authorizationUrl: string }>(call(a, "POST", "/api/ads/connect", { provider: "google_business", businessId: ba }))
    const auth = new URL(start.authorizationUrl)
    expect(auth.searchParams.get("scope")).toBe("openid email https://www.googleapis.com/auth/business.manage")
    const back = await call(a, "GET", `/api/ads/oauth/callback?state=${auth.searchParams.get("state")}&code=gcode`)
    expect(back.headers.get("location")).toBe(`https://app.example.test/businesses/${ba}/channels?ads=connected#ads`)
    const stored = (await pool.query("SELECT * FROM ad_connections WHERE account_id=$1 AND provider='google_business'", [a.accountId])).rows[0]
    expect(stored).toMatchObject({ subject: "777", display_name: "owner@salon.test", status: "ACTIVE" })
    expect(stored.refresh_ciphertext).toMatch(/^v1\./)
    expect(JSON.stringify(stored)).not.toMatch(/SECRET/)

    const { accounts } = await ok<{ accounts: Array<{ externalId: string; name: string }> }>(call(a, "GET", `/api/ads/connections/${stored.id}/accounts`))
    expect(accounts).toEqual([{ externalId: "9001", name: "Salon Main · Austin", currency: null, active: true }])
    expect((await call(a, "POST", `/api/ads/clients/${ba}/bindings`, { connectionId: stored.id, externalId: "act_9001" })).status).toBe(422)
    await ok(call(a, "POST", `/api/ads/clients/${ba}/bindings`, { connectionId: stored.id, externalId: "9001" }))
    expect((await pool.query("SELECT parent_id FROM ad_account_bindings WHERE business_id=$1", [ba])).rows[0].parent_id).toBe("555")

    // An expired access token is refreshed with the stored refresh token.
    await pool.query("UPDATE ad_connections SET access_expires_at = now() - interval '1 hour' WHERE id=$1", [stored.id])
    const local = await ok<{ locations: Array<{ current: { totals: { calls: number } }; searchTerms: unknown; reviews: { averageRating: number } | null }> }>(call(a, "GET", `/api/ads/clients/${ba}/local?days=7`))
    expect(local.locations[0]!.current.totals.calls).toBe(9)
    // Search terms refused by Google don't hide the rest.
    expect(local.locations[0]!.searchTerms).toBeNull()
    expect(local.locations[0]!.reviews?.averageRating).toBe(4.8)
    const tool = await Effect.runPromise(readLocalProfile(a.accountId, ba, { days: 7 }).pipe(Effect.provide(layer)))
    expect(tool.summary).toContain("Salon Main · Austin, last 7 days: 9 calls")
    // The ad panel doesn't count the listing as an ad account.
    expect((await ok<{ accounts: unknown[] }>(call(a, "GET", `/api/ads/clients/${ba}/performance?days=7`))).accounts).toEqual([])

    // More than read access is refused and revoked.
    scope = "openid email https://www.googleapis.com/auth/business.manage https://www.googleapis.com/auth/adwords"
    const again = await ok<{ authorizationUrl: string }>(call(a, "POST", "/api/ads/connect", { provider: "google_business", businessId: ba }))
    expect((await call(a, "GET", `/api/ads/oauth/callback?state=${new URL(again.authorizationUrl).searchParams.get("state")}&code=gcode`)).headers.get("location")).toContain("ads=scope_refused")
    for (const text of seen) expect(text).not.toMatch(/SECRET/)
  })
})
