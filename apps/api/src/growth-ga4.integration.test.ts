// W8 GA4 connection over HTTP against the local Google stand-in: the OAuth
// authorization-code flow (state, PKCE, exact redirect, single use, scopes,
// identity), property authorization, tenancy, sync requests, disconnect, and
// that no token, code or client secret ever appears in a response.
// Passing here is MOCK_ADAPTER_PASS, never a live Google result.
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { HttpApp, HttpRouter } from "@effect/platform"
import { Effect, Exit, Layer, Redacted, Scope } from "effect"
import { PgClient } from "@effect/sql-pg"
import pg from "pg"
import { GA4_OAUTH_CALLBACK_PATH, GA4_READONLY_SCOPE, SEARCH_CONSOLE_READONLY_SCOPE, type Ga4Binding, type Ga4Connection } from "@openrecord/contracts"
import { AuthRepositoryLive, RecordRepositoryLive } from "@openrecord/db"
import { fixtureGa4Config, fixtureGa4Layer, fixtureGoogle } from "@openrecord/ga4"
import { growthGa4Api } from "./growth-ga4-routes.js"
import { growthApi } from "./growth-routes.js"
import { requireSession, RepoLayers } from "./router.js"

const url = process.env["TEST_DATABASE_URL"] ?? ""
const CLIENT = { clientId: "fixture-client.apps.googleusercontent.com", clientSecret: "fixture-secret-DO-NOT-LEAK", redirectUri: `https://app.example.test${GA4_OAUTH_CALLBACK_PATH}` }
const APP = "https://app.example.test"
const P1 = "properties/111111", P2 = "properties/222222", P3 = "properties/333333"
const product = (propertyRef: string, eventName = "book_appointment", timeZone = "Asia/Makassar") => ({
  name: "TEST GA4 Salon", websiteUrl: "https://salon.test", engagement: "CLIENT", category: "TEST services", audience: "TEST locals", valueProposition: "TEST positioning", goalStatement: "Increase bookings",
  metric: { conversionKind: "BOOKING", label: "Bookings", sourceKind: "GA4_AGGREGATE_EXPORT", sourceIdentity: "TEST GA4 property", eventName, reportingTimeZone: timeZone, propertyRef, countingSemantics: "EVENT_COUNT", unit: "COUNT", currency: null },
})

const suite = url ? describe : describe.skip
suite("GA4 connection over HTTP (OAuth, property authorization, tenancy; local Google stand-in)", () => {
  let pool: pg.Pool, scope: Scope.CloseableScope
  const repos = Layer.mergeAll(RepoLayers.GrowthRepositoriesLive, RepoLayers.BusinessRepositoryLive, AuthRepositoryLive, RecordRepositoryLive).pipe(Layer.provideMerge(PgClient.layer({ url: Redacted.make(url) })))
  const handlers: Array<{ dispose: () => Promise<void> }> = []
  beforeAll(async () => { pool = new pg.Pool({ connectionString: url }); scope = await Effect.runPromise(Scope.make()); await Effect.runPromise(Layer.buildWithScope(repos, scope)) })
  afterAll(async () => { for (const h of handlers) await h.dispose(); await Effect.runPromise(Scope.close(scope, Exit.void)); await pool.end() })

  const account = async () => {
    const accountId = String((await pool.query("INSERT INTO accounts(name) VALUES('TEST GA4 API') RETURNING id")).rows[0].id)
    const userId = String((await pool.query("INSERT INTO users(email,password_hash) VALUES($1,'TEST-only') RETURNING id", [`ga4-${randomUUID()}@example.test`])).rows[0].id)
    await pool.query("INSERT INTO account_users(account_id,user_id) VALUES($1,$2)", [accountId, userId])
    const cookie = String((await pool.query("INSERT INTO sessions(account_id,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour') RETURNING id", [accountId, userId])).rows[0].id)
    return { accountId, userId, cookie }
  }
  type Acct = Awaited<ReturnType<typeof account>>
  const setup = async (opts: { configured?: boolean } = {}) => {
    const g = fixtureGoogle({
      ...CLIENT,
      identities: [{ sub: "1001", email: "agency@example.test", properties: [P1, P2] }, { sub: "2002", email: "someone@example.test", properties: [P3] }],
      properties: [
        { name: P1, displayName: "TEST Salon site", account: "accounts/10", accountDisplayName: "TEST Salon", timeZone: "Asia/Makassar", keyEvents: [{ eventName: "book_appointment", countingMethod: "ONCE_PER_EVENT" }], data: {} },
        { name: P2, displayName: "TEST Clinic", account: "accounts/20", accountDisplayName: "TEST Clinic", timeZone: "UTC", keyEvents: [{ eventName: "book_appointment", countingMethod: "ONCE_PER_SESSION" }], data: {} },
        { name: P3, displayName: "TEST Not yours", account: "accounts/30", accountDisplayName: "TEST Other", timeZone: "Asia/Makassar", keyEvents: [{ eventName: "book_appointment", countingMethod: "ONCE_PER_EVENT" }], data: {} },
      ],
    })
    const config = opts.configured === false ? { configured: false as const, reason: "MISSING_CLIENT" as const } : fixtureGa4Config(g, { ...CLIENT, appBaseUrl: APP })
    const web = HttpApp.toWebHandlerLayer(HttpRouter.concat(growthApi(r => Effect.flatMap(requireSession, ({ session }) => r(session))), growthGa4Api(r => Effect.flatMap(requireSession, ({ session }) => r(session)))),
      Layer.provideMerge(fixtureGa4Layer(config), repos))
    handlers.push(web)
    const bodies: string[] = []
    const call = async (acct: Acct | null, method: string, path: string, body?: unknown) => {
      const response = await web.handler(new Request(`http://localhost${path}`, { method, headers: { "content-type": "application/json", ...(acct ? { cookie: `or_session=${acct.cookie}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }))
      const text = await response.clone().text()
      bodies.push(text, response.headers.get("location") ?? "")
      return response
    }
    const ok = async <T>(r: Promise<Response>): Promise<T> => { const x = await r; if (x.status !== 200) throw new Error(`Expected 200, got ${x.status}: ${await x.text()}`); return await x.json() as T }
    const refusal = async (r: Promise<Response>) => { const x = await r; const j = await x.json().catch(() => ({})) as { reason?: string; _tag?: string }; return { status: x.status, reason: j.reason ?? j._tag } }
    const a = await account(), b = await account()
    const business = async (acct: Acct, propertyRef = P1, eventName?: string, tz?: string) => (await ok<{ profile: { businessId: string; primaryGoal: { metricDefinition: { id: string } } } }>(
      call(acct, "POST", "/api/growth/products", { ...product(propertyRef, eventName, tz), idempotencyKey: randomUUID() }))).profile
    const pa = await business(a), pb = await business(b)
    /** The browser round trip: start, consent at Google, land on the callback. Returns the redirect target. */
    const authorize = async (acct: Acct, businessId: string, consent: { sub?: string; grantScopes?: ReadonlyArray<string>; deny?: boolean } = {}, connectionId: string | null = null, callbackAs: Acct = acct) => {
      const { authorizationUrl } = await ok<{ authorizationUrl: string }>(call(acct, "POST", "/api/growth/ga4/connect", { businessId, connectionId }))
      const back = new URL(g.consent(authorizationUrl, { sub: consent.sub ?? "1001", ...(consent.grantScopes ? { grantScopes: consent.grantScopes } : {}), ...(consent.deny ? { deny: true } : {}) }))
      const landed = await call(callbackAs, "GET", `${back.pathname}${back.search}`)
      return { status: landed.status, location: landed.headers.get("location") ?? "", callbackPath: `${back.pathname}${back.search}`, authorizationUrl }
    }
    const connections = async (acct: Acct) => (await ok<{ configured: boolean; connections: Ga4Connection[] }>(call(acct, "GET", "/api/growth/ga4/connections"))).connections
    return { g, call, ok, refusal, a, b, pa, pb, authorize, connections, bodies, business }
  }

  it("connects through Google with state, PKCE and the exact redirect URI, recording the authorizing identity separately", async () => {
    const s = await setup()
    const flow = await s.authorize(s.a, s.pa.businessId)
    expect(flow.status).toBe(303)
    expect(flow.location).toBe(`${APP}/clients/${s.pa.businessId}/growth-measurement?ga4=connected`)
    const q = new URL(flow.authorizationUrl).searchParams
    expect(q.get("redirect_uri")).toBe(CLIENT.redirectUri)
    expect(q.get("code_challenge_method")).toBe("S256")
    expect(q.get("scope")).toBe(`openid email ${GA4_READONLY_SCOPE} ${SEARCH_CONSOLE_READONLY_SCOPE}`)
    const [conn] = await s.connections(s.a)
    expect(conn).toMatchObject({ accountId: s.a.accountId, googleEmail: "agency@example.test", status: "ACTIVE", grantedScopes: ["email", GA4_READONLY_SCOPE, "openid", SEARCH_CONSOLE_READONLY_SCOPE].sort() })
    // Ciphertext only at rest; the state's plaintext is never stored.
    const creds = (await pool.query("SELECT refresh_ciphertext, access_ciphertext FROM growth_ga4_credentials WHERE connection_id=$1", [conn!.id])).rows[0]
    expect(String(creds.refresh_ciphertext)).toMatch(/^v1\./)
    for (const secret of s.g.issuedTokens) expect(`${creds.refresh_ciphertext}${creds.access_ciphertext}`).not.toContain(secret)
    const state = q.get("state")!
    expect((await pool.query("SELECT count(*)::int AS n FROM growth_ga4_oauth_states WHERE state_sha256=$1 OR verifier_ciphertext LIKE $2", [state, `%${state}%`])).rows[0].n).toBe(0)
    // The same callback again: the state is single use.
    const replay = await s.call(s.a, "GET", flow.callbackPath)
    expect(replay.headers.get("location")).toBe(`${APP}/clients?ga4=state_reused`)
  })

  it("refuses a forged, foreign or expired state and a denied consent without storing anything", async () => {
    const s = await setup()
    const forged = await s.call(s.a, "GET", `${GA4_OAUTH_CALLBACK_PATH}?state=${"x".repeat(43)}&code=4/forged`)
    expect(forged.headers.get("location")).toBe(`${APP}/clients?ga4=state_invalid`)
    const garbage = await s.call(s.a, "GET", `${GA4_OAUTH_CALLBACK_PATH}?state=short&code=4/forged`)
    expect(garbage.headers.get("location")).toBe(`${APP}/clients?ga4=state_invalid`)
    // Account B lands on A's callback (login CSRF / session swap): refused as invalid.
    const crossed = await s.authorize(s.a, s.pa.businessId, {}, null, s.b)
    expect(crossed.location).toBe(`${APP}/clients?ga4=state_invalid`)
    // Expired.
    const { authorizationUrl } = await s.ok<{ authorizationUrl: string }>(s.call(s.a, "POST", "/api/growth/ga4/connect", { businessId: s.pa.businessId }))
    const back = new URL(s.g.consent(authorizationUrl, { sub: "1001" }))
    await pool.query("ALTER TABLE growth_ga4_oauth_states DISABLE TRIGGER growth_ga4_oauth_state_guard")
    await pool.query("UPDATE growth_ga4_oauth_states SET created_at=now()-interval '20 minutes', expires_at=now()-interval '10 minutes' WHERE account_id=$1 AND consumed_at IS NULL", [s.a.accountId])
    await pool.query("ALTER TABLE growth_ga4_oauth_states ENABLE TRIGGER growth_ga4_oauth_state_guard")
    expect((await s.call(s.a, "GET", `${back.pathname}${back.search}`)).headers.get("location")).toBe(`${APP}/clients?ga4=state_expired`)
    // Denied at Google.
    expect((await s.authorize(s.a, s.pa.businessId, { deny: true })).location).toBe(`${APP}/clients/${s.pa.businessId}/growth-measurement?ga4=consent_denied`)
    expect(await s.connections(s.a)).toEqual([])
    // Starting a connection for another account's business is not found.
    expect(await s.refusal(s.call(s.a, "POST", "/api/growth/ga4/connect", { businessId: s.pb.businessId }))).toEqual({ status: 404, reason: "GrowthNotFound" })
    // Signed out on the callback.
    expect((await s.call(null, "GET", `${GA4_OAUTH_CALLBACK_PATH}?state=${"y".repeat(43)}`)).headers.get("location")).toBe(`${APP}/?ga4=signin_required`)
  })

  it("refuses broader or missing Analytics scopes, revoking what Google issued", async () => {
    const s = await setup()
    const broad = await s.authorize(s.a, s.pa.businessId, { grantScopes: ["openid", "email", GA4_READONLY_SCOPE, "https://www.googleapis.com/auth/analytics.edit"] })
    expect(broad.location).toContain("ga4=scope_refused")
    const narrow = await s.authorize(s.a, s.pa.businessId, { grantScopes: ["openid", "email"] })
    expect(narrow.location).toContain("ga4=scope_refused")
    expect(await s.connections(s.a)).toEqual([])
    expect(s.g.calls.filter(c => c.path === "/revoke")).toHaveLength(2)
  })

  it("re-authorizes only the same Google identity", async () => {
    const s = await setup()
    await s.authorize(s.a, s.pa.businessId)
    const [conn] = await s.connections(s.a)
    const other = await s.authorize(s.a, s.pa.businessId, { sub: "2002" }, conn!.id)
    expect(other.location).toContain("ga4=identity_mismatch")
    const same = await s.authorize(s.a, s.pa.businessId, {}, conn!.id)
    expect(same.location).toContain("ga4=reconnected")
    expect(await s.connections(s.a)).toHaveLength(1)
    expect((await pool.query("SELECT kind FROM growth_ga4_connection_events WHERE connection_id=$1 ORDER BY created_at", [conn!.id])).rows.map(r => r.kind)).toEqual(["CONNECTED", "REAUTHORIZED"])
  })

  it("lists only properties the authorized identity can read and binds only those, to the exact definition", async () => {
    const s = await setup()
    await s.authorize(s.a, s.pa.businessId)
    const [conn] = await s.connections(s.a)
    const listed = await s.ok<{ properties: Array<{ property: string }> }>(s.call(s.a, "GET", `/api/growth/ga4/connections/${conn!.id}/properties`))
    expect(listed.properties.map(p => p.property).sort()).toEqual([P1, P2])
    expect((await s.ok<{ keyEvents: unknown[] }>(s.call(s.a, "GET", `/api/growth/ga4/connections/${conn!.id}/properties/111111/key-events`))).keyEvents).toEqual([{ eventName: "book_appointment", countingMethod: "ONCE_PER_EVENT" }])
    const defId = s.pa.primaryGoal.metricDefinition.id
    const bind = (over: Record<string, unknown> = {}, businessId = s.pa.businessId) => s.call(s.a, "POST", `/api/growth/clients/${businessId}/ga4/bindings`, { connectionId: conn!.id, property: P1, metricDefinitionId: defId, eventName: "book_appointment", idempotencyKey: randomUUID(), ...over })
    // A property the identity cannot read is refused, even when the definition names it.
    const p3 = await s.business(s.a, P3)
    expect(await s.refusal(bind({ property: P3, metricDefinitionId: p3.primaryGoal.metricDefinition.id }, p3.businessId))).toEqual({ status: 409, reason: "PropertyNotAccessible" })
    expect(await s.refusal(bind({ property: P2 }))).toEqual({ status: 409, reason: "PropertyDiffersFromDefinition" })
    expect(await s.refusal(bind({ eventName: "purchase" }))).toEqual({ status: 409, reason: "KeyEventDiffersFromDefinition" })
    const utc = await s.business(s.a, P1, "book_appointment", "UTC")
    expect(await s.refusal(bind({ metricDefinitionId: utc.primaryGoal.metricDefinition.id }, utc.businessId))).toEqual({ status: 409, reason: "PropertyTimeZoneDiffersFromDefinition" })
    const notKey = await s.business(s.a, P1, "generate_lead")
    expect(await s.refusal(bind({ metricDefinitionId: notKey.primaryGoal.metricDefinition.id, eventName: "generate_lead" }, notKey.businessId))).toEqual({ status: 409, reason: "KeyEventNotConfigured" })
    const key = randomUUID()
    const { binding } = await s.ok<{ binding: Ga4Binding }>(bind({ idempotencyKey: key }))
    expect(binding).toMatchObject({ property: P1, propertyTimeZone: "Asia/Makassar", metricDefinitionId: defId, metricDefinitionVersion: 1, eventName: "book_appointment", providerMetric: "keyEvents", keyEventCountingMethod: "ONCE_PER_EVENT" })
    expect(await s.ok<{ replayed: boolean }>(bind({ idempotencyKey: key }))).toMatchObject({ replayed: true })
    expect(await s.refusal(bind({ idempotencyKey: key, property: P2 }))).toMatchObject({ status: 409 })

    // Health before any sync.
    const { health } = await s.ok<{ health: Array<{ freshness: string; lastSuccessfulSyncAt: string | null; connectionStatus: string }> }>(s.call(s.a, "GET", `/api/growth/clients/${s.pa.businessId}/ga4/bindings`))
    expect(health[0]).toMatchObject({ freshness: "NEVER_SYNCED", lastSuccessfulSyncAt: null, connectionStatus: "ACTIVE" })
    // Sync requests: bounded, complete days only, one open job.
    const sync = (body: Record<string, unknown>) => s.call(s.a, "POST", `/api/growth/clients/${s.pa.businessId}/ga4/bindings/${binding.id}/sync`, { kind: "BACKFILL", idempotencyKey: randomUUID(), ...body })
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Makassar", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date())
    expect(await s.refusal(sync({ dateStart: today, dateEnd: today }))).toEqual({ status: 422, reason: "RangeNotComplete" })
    expect(await s.refusal(sync({ dateStart: "2025-01-01", dateEnd: "2026-06-01" }))).toEqual({ status: 422, reason: "SyncRangeTooLarge" })
    expect(await s.refusal(sync({ dateStart: "2026-09-05", dateEnd: "2026-09-01" }))).toEqual({ status: 422, reason: "InvalidDateRange" })
    const queued = await s.ok<{ job: { status: string; kind: string } }>(sync({ dateStart: "2026-09-01", dateEnd: "2026-09-30" }))
    expect(queued.job).toMatchObject({ status: "QUEUED", kind: "BACKFILL" })
    expect(await s.refusal(sync({ kind: "REFRESH", dateStart: "2026-09-28", dateEnd: "2026-09-30" }))).toEqual({ status: 409, reason: "SyncAlreadyOpen" })
  })

  it("keeps connections and bindings inside their account", async () => {
    const s = await setup()
    await s.authorize(s.a, s.pa.businessId)
    const [conn] = await s.connections(s.a)
    expect(await s.connections(s.b)).toEqual([])
    expect(await s.refusal(s.call(s.b, "GET", `/api/growth/ga4/connections/${conn!.id}/properties`))).toEqual({ status: 404, reason: "Ga4ConnectionNotFound" })
    expect(await s.refusal(s.call(s.b, "POST", `/api/growth/ga4/connections/${conn!.id}/disconnect`, { idempotencyKey: randomUUID() }))).toEqual({ status: 404, reason: "Ga4ConnectionNotFound" })
    // B cannot bind A's connection to B's own business.
    expect(await s.refusal(s.call(s.b, "POST", `/api/growth/clients/${s.pb.businessId}/ga4/bindings`, { connectionId: conn!.id, property: P1, metricDefinitionId: s.pb.primaryGoal.metricDefinition.id, eventName: "book_appointment", idempotencyKey: randomUUID() })))
      .toEqual({ status: 404, reason: "Ga4ConnectionNotFound" })
    const { binding } = await s.ok<{ binding: Ga4Binding }>(s.call(s.a, "POST", `/api/growth/clients/${s.pa.businessId}/ga4/bindings`, { connectionId: conn!.id, property: P1, metricDefinitionId: s.pa.primaryGoal.metricDefinition.id, eventName: "book_appointment", idempotencyKey: randomUUID() }))
    expect(await s.refusal(s.call(s.b, "GET", `/api/growth/clients/${s.pa.businessId}/ga4/bindings`))).toEqual({ status: 404, reason: "GrowthNotFound" })
    expect(await s.refusal(s.call(s.b, "GET", `/api/growth/clients/${s.pb.businessId}/ga4/bindings/${binding.id}`))).toEqual({ status: 404, reason: "Ga4BindingNotFound" })
    expect(await s.refusal(s.call(s.b, "POST", `/api/growth/clients/${s.pa.businessId}/ga4/bindings/${binding.id}/sync`, { kind: "BACKFILL", dateStart: "2026-09-01", dateEnd: "2026-09-02", idempotencyKey: randomUUID() }))).toEqual({ status: 404, reason: "GrowthNotFound" })
    // The database refuses a cross-account binding even through direct SQL.
    await expect(pool.query(`INSERT INTO growth_ga4_bindings(business_id,connection_id,property,property_display_name,property_time_zone,metric_definition_id,event_name,provider_metric,created_by_user_id,request_key,request_fingerprint)
      VALUES($1,$2,$3,'x','Asia/Makassar',$4,'book_appointment','keyEvents',$5,$6,$7)`, [s.pb.businessId, conn!.id, P1, s.pb.primaryGoal.metricDefinition.id, s.b.userId, randomUUID(), "a".repeat(64)])).rejects.toThrow(/another account/)
    // Unauthenticated requests reach nothing.
    expect((await s.call(null, "GET", "/api/growth/ga4/connections")).status).toBe(401)
  })

  it("suspends on revoked authorization, disconnects with revocation at Google, and never returns a credential", async () => {
    const s = await setup()
    await s.authorize(s.a, s.pa.businessId)
    const [conn] = await s.connections(s.a)
    // Google-side revocation: the next read cannot refresh, so the connection asks for re-authorization.
    s.g.revokeIdentity("1001")
    await pool.query("UPDATE growth_ga4_credentials SET access_expires_at=now()-interval '1 minute' WHERE connection_id=$1", [conn!.id])
    expect(await s.refusal(s.call(s.a, "GET", `/api/growth/ga4/connections/${conn!.id}/properties`))).toEqual({ status: 409, reason: "Ga4ReauthorizationRequired" })
    expect((await s.connections(s.a))[0]).toMatchObject({ status: "REAUTHORIZATION_REQUIRED", statusReason: "AUTHORIZATION_REVOKED" })
    // Re-authorize, then disconnect: Google confirms the revocation and the stored credentials are erased.
    await s.authorize(s.a, s.pa.businessId, {}, conn!.id)
    expect((await s.connections(s.a))[0]!.status).toBe("ACTIVE")
    const { connection } = await s.ok<{ connection: Ga4Connection }>(s.call(s.a, "POST", `/api/growth/ga4/connections/${conn!.id}/disconnect`, { idempotencyKey: randomUUID() }))
    expect(connection).toMatchObject({ status: "DISCONNECTED", revocationConfirmed: true })
    expect((await pool.query("SELECT refresh_ciphertext, access_ciphertext FROM growth_ga4_credentials WHERE connection_id=$1", [conn!.id])).rows[0]).toEqual({ refresh_ciphertext: null, access_ciphertext: null })
    expect(await s.refusal(s.call(s.a, "GET", `/api/growth/ga4/connections/${conn!.id}/properties`))).toEqual({ status: 409, reason: "Ga4ReauthorizationRequired" })
    // Across every response and redirect in this flow: no token, code or client secret.
    const everything = s.bodies.join("\n")
    for (const secret of [...s.g.issuedTokens, CLIENT.clientSecret]) expect(everything).not.toContain(secret)
    expect(everything).not.toMatch(/refresh_?token|access_?token|ciphertext/i)
  })

  it("answers plainly when the server has no GA4 configuration", async () => {
    const s = await setup({ configured: false })
    expect(await s.ok<{ configured: boolean; notConfiguredReason: string }>(s.call(s.a, "GET", "/api/growth/ga4/connections"))).toMatchObject({ configured: false, notConfiguredReason: "MISSING_CLIENT" })
    expect(await s.refusal(s.call(s.a, "POST", "/api/growth/ga4/connect", { businessId: s.pa.businessId }))).toEqual({ status: 503, reason: "Ga4NotConfigured" })
  })
})
