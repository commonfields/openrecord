// Connections in one list, and their health checks, against a stand-in
// Webflow: a working token checks OK, a token Webflow refuses marks the
// connection for reconnecting (and the agent stops being offered its tools),
// and an outage is recorded as a failure to check, not a revoked credential.
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { HttpApp } from "@effect/platform"
import { Effect, Layer, Redacted } from "effect"
import { PgClient } from "@effect/sql-pg"
import pg from "pg"
import { AuthRepositoryLive, GrowthGa4RepositoryLive, GrowthMeasurementRepositoryLive } from "@openrecord/db"
import { AdsProvider, adsConfigFromEnv } from "@openrecord/ads"
import { makeTokenCipher, parseCipherKeys } from "@openrecord/ga4"
import type { HttpTransport } from "@openrecord/representation"
import { RepoLayers, requireSession } from "./router.js"
import { WebflowHttp } from "./webflow.js"
import { connectionsApi, connectorStatuses } from "./connections.js"
import { connectionGaps } from "./agent-decision.js"

const url = process.env["TEST_DATABASE_URL"] ?? ""
const suite = url ? describe : describe.skip
const TOKEN = "wf_test_token_0123456789abcdef0123456789abcdef"
const SITE = "a".repeat(24)
const KEYS = `k1:${Buffer.alloc(32, 7).toString("base64")}`

suite("Connections and health checks (stand-in Webflow, no network)", () => {
  let pool: pg.Pool
  let webflow: "up" | "refused" | "down" = "up"
  let calls = 0
  const transport: HttpTransport = {
    lookup: async () => ["104.18.0.1"],
    fetch: async (raw, init) => {
      calls++
      const reply = (status: number, body?: unknown) => ({ status, headers: {}, body: new TextEncoder().encode(body === undefined ? "" : JSON.stringify(body)), peerIp: "104.18.0.1" })
      if (webflow === "down") return reply(503, { message: "maintenance" })
      if (webflow === "refused" || init.headers["authorization"] !== `Bearer ${TOKEN}`) return reply(401, { message: "secret detail" })
      return new URL(raw).pathname === `/v2/sites/${SITE}` ? reply(200, { id: SITE, displayName: "Cueup" }) : reply(404, {})
    },
  }
  const config = adsConfigFromEnv({ ADS_PROVIDER_STAND_IN_URL: "http://127.0.0.1:9/", GA4_TOKEN_ENCRYPTION_KEYS: KEYS })
  const cipher = makeTokenCipher(parseCipherKeys(KEYS)!)
  const repos = Layer.mergeAll(RepoLayers.BusinessRepositoryLive, AuthRepositoryLive, GrowthGa4RepositoryLive.pipe(Layer.provide(GrowthMeasurementRepositoryLive))).pipe(Layer.provideMerge(PgClient.layer({ url: Redacted.make(url) })))
  const layer = Layer.mergeAll(repos, Layer.succeed(AdsProvider, config), Layer.succeed(WebflowHttp, transport))
  const web = HttpApp.toWebHandlerLayer(connectionsApi(r => Effect.flatMap(requireSession, ({ session }) => r(session))), layer)
  const run = <A, E>(e: Effect.Effect<A, E, never>) => Effect.runPromise(e)
  beforeAll(() => { pool = new pg.Pool({ connectionString: url }) })
  afterAll(async () => { await web.dispose(); await pool.end() })

  const fixture = async () => {
    const accountId = String((await pool.query("INSERT INTO accounts(name) VALUES('TEST connections') RETURNING id")).rows[0].id)
    const userId = String((await pool.query("INSERT INTO users(email,password_hash) VALUES($1,'TEST') RETURNING id", [`conn-${randomUUID()}@example.test`])).rows[0].id)
    await pool.query("INSERT INTO account_users(account_id,user_id) VALUES($1,$2)", [accountId, userId])
    const businessId = String((await pool.query("INSERT INTO businesses(account_id,name) VALUES($1,'TEST Cueup') RETURNING id", [accountId])).rows[0].id)
    const cookie = String((await pool.query("INSERT INTO sessions(id,account_id,user_id,expires_at,token_digest) SELECT u,$1::uuid,$2::uuid,now()+interval '1 hour',encode(sha256(convert_to(u::text,'UTF8')),'hex') FROM gen_random_uuid() u RETURNING id", [accountId, userId])).rows[0].id)
    const call = (method: string, path = "", target = businessId) => web.handler(new Request(`http://localhost/api/businesses/${target}/connections${path}`, {
      method, headers: { "content-type": "application/json", cookie: `or_session=${cookie}` }, ...(method === "POST" ? { body: "{}" } : {}) }))
    const connectWebflow = () => pool.query(`INSERT INTO webflow_connections(business_id, account_id, site_id, site_name, site_url, domain_ids, token_ciphertext, token_last4, status, connected_by_user_id)
      VALUES ($1, $2, $3, 'Cueup', 'https://www.cueup.test', '[]', $4, $5, 'ACTIVE', $6)
      ON CONFLICT (business_id) DO UPDATE SET status = 'ACTIVE', token_ciphertext = EXCLUDED.token_ciphertext`,
      [businessId, accountId, SITE, cipher.encrypt(TOKEN, `webflow:${businessId}:token`), TOKEN.slice(-4), userId])
    const statuses = async () => (await (await call("GET")).json() as { connectors: Array<{ id: string; state: string; detail: string; accounts: Array<{ check: { result: string; reason: string | null } | null }> }> }).connectors
    const webflowOf = async () => (await statuses()).find(c => c.id === "webflow")!
    const ageChecks = () => pool.query("UPDATE connection_checks SET checked_at = checked_at - interval '5 minutes' WHERE account_id = $1", [accountId])
    return { accountId, businessId, call, connectWebflow, statuses, webflowOf, ageChecks }
  }

  it("lists every connector for the business with how to connect it and what is missing", async () => {
    const f = await fixture()
    const list = await f.statuses()
    expect(list.map(c => c.id)).toEqual(["google", "github", "wordpress", "webflow", "google_ads", "google_business", "meta", "stripe"])
    expect(list.find(c => c.id === "webflow")).toMatchObject({ state: "NOT_CONNECTED", method: "PASTE_KEY", detail: "Webflow is not connected." })
    // Nothing registers OpenRecord with Google or GitHub in this test, so nobody could connect them yet: said plainly, not as "not connected".
    expect(list.find(c => c.id === "google")).toMatchObject({ state: "UNAVAILABLE" })
    expect(list.find(c => c.id === "github")).toMatchObject({ state: "UNAVAILABLE" })
    expect(JSON.stringify(list)).not.toMatch(/·/)
    expect((await (await fixture()).call("GET")).status).toBe(200)
    expect((await web.handler(new Request(`http://localhost/api/businesses/${f.businessId}/connections`))).status).toBe(401)
  })

  it("checks a working connection, marks a refused one for reconnecting, and keeps an outage apart from both", async () => {
    const f = await fixture()
    await f.connectWebflow()
    expect((await run(connectionGaps(f.accountId, f.businessId).pipe(Effect.provide(layer)))).withheld.has("prepare_webflow_change")).toBe(false)

    webflow = "up"
    const checked = await (await f.call("POST", "/check")).json() as { checked: number }
    expect(checked.checked).toBe(1)
    expect(await f.webflowOf()).toMatchObject({ state: "READY", detail: "Connected as Cueup.", accounts: [{ check: { result: "OK", reason: null } }] })
    // A second check within the minute does not call Webflow again.
    const before = calls
    expect(((await (await f.call("POST", "/check")).json()) as { checked: number }).checked).toBe(0)
    expect(calls).toBe(before)

    // Webflow is down: a failure to check, not a revoked token. The connection stays usable.
    webflow = "down"; await f.ageChecks()
    await f.call("POST", "/check")
    const down = await f.webflowOf()
    expect(down).toMatchObject({ state: "READY", accounts: [{ check: { result: "FAILING", reason: "WebflowUNAVAILABLE" } }] })
    expect(down.detail).toContain("could not reach Webflow")
    expect((await pool.query("SELECT status FROM webflow_connections WHERE business_id = $1", [f.businessId])).rows[0].status).toBe("ACTIVE")
    expect((await pool.query("SELECT failures, last_ok_at IS NOT NULL AS ok_before FROM connection_checks WHERE connection_id = $1", [f.businessId])).rows[0]).toEqual({ failures: 1, ok_before: true })

    // Webflow refuses the token: the connection is marked, the person is asked to reconnect, and the agent is not offered its tools.
    webflow = "refused"; await f.ageChecks()
    await f.call("POST", "/check")
    expect(await f.webflowOf()).toMatchObject({ state: "NEEDS_RECONNECT", detail: "Webflow stopped accepting the saved key for Cueup. Connect it again." })
    expect((await pool.query("SELECT status FROM webflow_connections WHERE business_id = $1", [f.businessId])).rows[0].status).toBe("REVOKED")
    const gaps = await run(connectionGaps(f.accountId, f.businessId).pipe(Effect.provide(layer)))
    expect(gaps.withheld.has("prepare_webflow_change")).toBe(true)
    expect(gaps.note).toContain("must be connected again: Webflow")

    // Reconnected: the old refusal no longer describes it, and it is due for a check at once.
    webflow = "up"
    await f.connectWebflow()
    expect((await f.webflowOf()).accounts[0]!.check).toBeNull()
    await f.call("POST", "/check")
    expect(await f.webflowOf()).toMatchObject({ state: "READY", accounts: [{ check: { result: "OK" } }] })
    expect((await pool.query("SELECT failures FROM connection_checks WHERE connection_id = $1", [f.businessId])).rows[0].failures).toBe(0)
  })

  it("never shows one account's connections to another", async () => {
    const a = await fixture(), b = await fixture()
    await a.connectWebflow()
    const other = await run(connectorStatuses(b.accountId, a.businessId).pipe(Effect.provide(layer)))
    expect(other.find(c => c.id === "webflow")!.state).toBe("NOT_CONNECTED")
    // Another account's business is "not found" on the route.
    expect((await b.call("GET", "", a.businessId)).status).toBe(404)
  })
})
