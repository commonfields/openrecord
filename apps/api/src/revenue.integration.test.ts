// Stripe revenue over HTTP against a scripted Stripe: a full secret key is
// refused before any call, a restricted key is checked then kept only as
// ciphertext, revenue is read live for the agent and the page, a key Stripe
// stops accepting is marked for reconnection, and disconnect removes the key.
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { HttpApp, HttpRouter } from "@effect/platform"
import { Effect, Exit, Layer, Redacted, Scope } from "effect"
import { PgClient } from "@effect/sql-pg"
import pg from "pg"
import { AuthRepositoryLive, RecordRepositoryLive } from "@openrecord/db"
import { AdsProvider, adsConfigFromEnv } from "@openrecord/ads"
import { growthApi } from "./growth-routes.js"
import { revenueApi } from "./revenue.js"
import { readRevenue } from "./agent-ads-tools.js"
import { requireSession, RepoLayers } from "./router.js"

const url = process.env["TEST_DATABASE_URL"] ?? ""
const product = {
  name: "TEST Revenue Shop", websiteUrl: "https://www.shop.test", engagement: "CLIENT", category: "TEST goods", audience: "TEST buyers", valueProposition: "TEST value", goalStatement: "More orders",
  metric: { conversionKind: "PURCHASE", label: "Orders", sourceKind: "GA4_AGGREGATE_EXPORT", sourceIdentity: "TEST GA4 property", eventName: "purchase", reportingTimeZone: "UTC", propertyRef: "properties/222222", countingSemantics: "EVENT_COUNT", unit: "COUNT", currency: null },
}
const KEY = `rk_live_${"Q".repeat(30)}KEY9`

const suite = url ? describe : describe.skip
suite("Stripe revenue over HTTP and for the agent (scripted Stripe)", () => {
  let pool: pg.Pool, scope: Scope.CloseableScope
  const repos = Layer.mergeAll(RepoLayers.GrowthRepositoriesLive, RepoLayers.BusinessRepositoryLive, AuthRepositoryLive, RecordRepositoryLive).pipe(Layer.provideMerge(PgClient.layer({ url: Redacted.make(url) })))
  const handlers: Array<{ dispose: () => Promise<void> }> = []
  beforeAll(async () => { pool = new pg.Pool({ connectionString: url }); scope = await Effect.runPromise(Scope.make()); await Effect.runPromise(Layer.buildWithScope(repos, scope)) })
  afterAll(async () => { for (const h of handlers) await h.dispose(); await Effect.runPromise(Scope.close(scope, Exit.void)); await pool.end() })

  it("refuses secret keys, keeps a checked restricted key encrypted, reads revenue, and handles a revoked key", async () => {
    let accepted = true
    const stripeCalls: string[] = []
    const stripe = async (input: string, init: RequestInit) => {
      stripeCalls.push(`${init.method} ${input}`)
      const auth = (init.headers as Record<string, string>)["authorization"]
      const body = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status })
      if (!accepted || auth !== `Bearer ${KEY}`) return body({ error: { type: "invalid_request_error", message: "Invalid API Key provided: rk_live_****" } }, 401)
      const u = new URL(input)
      if (u.pathname.endsWith("/account")) return body({ id: "acct_123ABC", settings: { dashboard: { display_name: "Shop Co" } } })
      if (u.pathname.endsWith("/customers")) return body({ data: [{ id: "cus_new" }], has_more: false })
      return body({ data: [{ id: "ch_1", status: "succeeded", paid: true, amount: 25000, amount_refunded: 5000, currency: "usd", customer: "cus_1" }], has_more: false })
    }
    const config = adsConfigFromEnv({ ADS_PROVIDER_STAND_IN_URL: "http://127.0.0.1:9/", GA4_TOKEN_ENCRYPTION_KEYS: `k1:${Buffer.alloc(32, 5).toString("base64")}` }, stripe as typeof fetch)
    expect(config.stripe.configured).toBe(true)
    const layer = Layer.provideMerge(Layer.succeed(AdsProvider, config), repos)
    const web = HttpApp.toWebHandlerLayer(HttpRouter.concat(growthApi(r => Effect.flatMap(requireSession, ({ session }) => r(session))), revenueApi(r => Effect.flatMap(requireSession, ({ session }) => r(session)))), layer)
    handlers.push(web)
    const accountId = String((await pool.query("INSERT INTO accounts(name) VALUES('TEST revenue') RETURNING id")).rows[0].id)
    const userId = String((await pool.query("INSERT INTO users(email,password_hash) VALUES($1,'TEST') RETURNING id", [`rev-${randomUUID()}@example.test`])).rows[0].id)
    await pool.query("INSERT INTO account_users(account_id,user_id) VALUES($1,$2)", [accountId, userId])
    const cookie = String((await pool.query("INSERT INTO sessions(account_id,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour') RETURNING id", [accountId, userId])).rows[0].id)
    const seen: string[] = []
    const call = async (method: string, path: string, body?: unknown) => {
      const r = await web.handler(new Request(`http://localhost${path}`, { method, headers: { "content-type": "application/json", cookie: `or_session=${cookie}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }))
      seen.push(await r.clone().text())
      return r
    }
    const reason = async (r: Promise<Response>) => ((await (await r).json()) as { reason?: string }).reason
    const businessId = ((await (await call("POST", "/api/growth/products", { ...product, idempotencyKey: randomUUID() })).json()) as { profile: { businessId: string } }).profile.businessId
    const tool = () => Effect.runPromise(readRevenue(accountId, businessId, { days: 28 }).pipe(Effect.provide(layer)))

    expect((await tool()).data).toMatchObject({ status: "NOT_CONNECTED" })
    // A full secret key is refused before Stripe is ever called.
    expect(await reason(call("POST", `/api/revenue/clients/${businessId}/stripe`, { key: `sk_live_${"Z".repeat(30)}` }))).toBe("SecretKeyRefused")
    expect(stripeCalls).toEqual([])
    expect(await reason(call("POST", `/api/revenue/clients/${businessId}/stripe`, { key: `rk_live_${"W".repeat(30)}` }))).toBe("KeyInvalid")
    const connected = await call("POST", `/api/revenue/clients/${businessId}/stripe`, { key: KEY })
    expect(connected.status).toBe(200)
    expect(((await connected.json()) as { connection: unknown }).connection).toMatchObject({ displayName: "Shop Co", livemode: true, last4: "KEY9", status: "ACTIVE" })
    const row = (await pool.query("SELECT * FROM revenue_connections WHERE business_id=$1", [businessId])).rows[0]
    expect(row.key_ciphertext).toMatch(/^v1\./)
    expect(JSON.stringify(row)).not.toContain(KEY)

    const perf = ((await (await call("GET", `/api/revenue/clients/${businessId}/performance?days=28`)).json()) as { revenue: { current: { totals: { byCurrency: unknown[]; payingCustomers: number; newCustomers: number } } } }).revenue
    expect(perf.current.totals).toMatchObject({ byCurrency: [{ currency: "USD", net: 200, orders: 1 }], payingCustomers: 1, newCustomers: 1 })
    expect((await tool()).summary).toContain("Stripe (Shop Co), last 28 days: $200 from 1 order, 1 paying customer")

    // The business deletes the key in Stripe: the next read marks it for reconnection.
    accepted = false
    expect((await tool()).data).toMatchObject({ status: "RECONNECT_REQUIRED" })
    expect((await pool.query("SELECT status FROM revenue_connections WHERE id=$1", [row.id])).rows[0].status).toBe("REVOKED")

    await call("POST", `/api/revenue/clients/${businessId}/stripe/disconnect`)
    expect((await pool.query("SELECT status, key_ciphertext FROM revenue_connections WHERE id=$1", [row.id])).rows[0]).toEqual({ status: "DISCONNECTED", key_ciphertext: null })
    expect(stripeCalls.every(c => c.startsWith("GET "))).toBe(true)
    for (const text of seen) expect(text).not.toContain(KEY)
  })
})
