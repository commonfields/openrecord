// W8 GA4 measurement routes. Operator-only and session-scoped like every growth
// route; every response is no-store. Connections belong to the account; a
// binding belongs to one business; another account's connection, binding or
// business is "not found". OAuth uses a single-use, server-side state bound to
// the signed-in user, PKCE S256 and the exact configured redirect URI. Tokens,
// authorization codes and the client secret never appear in a response, a log
// line or a redirect: the callback redirects to the app with a short status word.
import { createHash } from "node:crypto"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "@effect/platform"
import { Effect, Option } from "effect"
import { GrowthGa4Refused, GrowthGa4Repository, type Session } from "@openrecord/db"
import {
  BindGa4Property, DisconnectGa4, RequestGa4Sync, StartGa4Connection, decodeRouteId, ga4LatestCompleteDay, ga4RangeRefusal, ga4ScopesAcceptable,
} from "@openrecord/contracts"
import {
  Ga4Error, Ga4Provider, authorizationUrl, exchangeCode, getProperty, identityFromIdToken, listAccessibleProperties, listKeyEvents, newOAuthSecret,
  refreshAccessToken, revokeToken, type Ga4ProviderConfig,
} from "@openrecord/ga4"
import { decode, json, operatorSessionFor, readJson, type WithSession } from "./record-routes.js"

const PRIVATE_HEADERS = { "cache-control": "no-store" }
const OAUTH_STATE_TTL_SECONDS = 600
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex")
const BAD_REQUEST = new Set(["InvalidRequest", "InvalidDateRange", "SyncRangeTooLarge", "RangeNotComplete"])
const UNAVAILABLE = new Set(["Ga4NotConfigured", "ProviderUnavailable", "ProviderQuota"])
const failure = (e: unknown) => {
  if (e instanceof GrowthGa4Refused) {
    const r = e.reason
    const status = BAD_REQUEST.has(r) ? 422 : r.endsWith("NotFound") ? 404 : UNAVAILABLE.has(r) ? 503 : 409
    return json(status, { _tag: "GrowthGa4Refused", reason: r }, PRIVATE_HEADERS)
  }
  if (typeof e === "object" && e !== null && "_tag" in e && e._tag === "NotAuthenticated") return json(401, { _tag: "NotAuthenticated" }, PRIVATE_HEADERS)
  const detail = process.env["NODE_ENV"] === "test" && e instanceof Error ? String((e as unknown as { cause?: { message?: string } }).cause?.message ?? e.message) : undefined
  return json(500, { _tag: "GrowthRequestFailed", ...(detail ? { detail } : {}) }, PRIVATE_HEADERS)
}
const refuse = (reason: string) => Effect.fail(new GrowthGa4Refused({ reason }))
const providerConfig = Effect.map(Effect.serviceOption(Ga4Provider), o => Option.getOrElse(o, (): Ga4ProviderConfig => ({ configured: false, reason: "MISSING_CLIENT" })))
const configured = Effect.flatMap(providerConfig, c => c.configured ? Effect.succeed(c) : refuse("Ga4NotConfigured"))
type Configured = Extract<Ga4ProviderConfig, { configured: true }>

/** A provider call; failures become stable reasons, never provider text. */
const provider = <A>(f: () => Promise<A>) => Effect.tryPromise({
  try: f,
  catch: e => e instanceof Ga4Error ? e : new Ga4Error({ kind: "UNAVAILABLE", status: null, providerCode: null, retryAfterSeconds: null }),
})
const providerReason = (e: Ga4Error): string =>
  e.kind === "QUOTA" ? "ProviderQuota" : e.kind === "FORBIDDEN" || e.kind === "NOT_FOUND" ? "PropertyNotAccessible" : e.kind === "INVALID" ? "ProviderRejected" : "ProviderUnavailable"

/** A usable access token for an ACTIVE connection: cached while valid, else refreshed. A refused refresh suspends the connection. */
const accessTokenFor = (config: Configured, accountId: string, connectionId: string) => Effect.gen(function*() {
  const repo = yield* GrowthGa4Repository
  const connection = yield* repo.connection(accountId, connectionId)
  if (connection.status !== "ACTIVE") return yield* refuse("Ga4ReauthorizationRequired")
  const creds = yield* repo.credentials(connectionId)
  if (creds.accessCiphertext && creds.accessExpiresAt !== null && creds.accessExpiresAt - 60_000 > Date.now()) {
    const cached = config.cipher.decrypt(creds.accessCiphertext, `${connectionId}:access`)
    if (cached) return cached
  }
  const refreshToken = creds.refreshCiphertext ? config.cipher.decrypt(creds.refreshCiphertext, `${connectionId}:refresh`) : null
  if (!refreshToken) { yield* repo.suspend(connectionId, "AUTHORIZATION_REVOKED"); return yield* refuse("Ga4ReauthorizationRequired") }
  const refreshed = yield* provider(() => refreshAccessToken(config.oauth, refreshToken)).pipe(Effect.either)
  if (refreshed._tag === "Left") {
    if (refreshed.left.kind === "AUTH" || refreshed.left.kind === "INVALID") { yield* repo.suspend(connectionId, "AUTHORIZATION_REVOKED"); return yield* refuse("Ga4ReauthorizationRequired") }
    return yield* refuse(providerReason(refreshed.left))
  }
  yield* repo.storeAccessToken(connectionId, config.cipher.encrypt(refreshed.right.accessToken, `${connectionId}:access`), refreshed.right.accessTokenExpiresAt)
  return refreshed.right.accessToken
})
/** Runs a read with the connection's token; a 401 suspends the connection. */
const read = <A>(config: Configured, accountId: string, connectionId: string, f: (token: string) => Promise<A>) => Effect.gen(function*() {
  const token = yield* accessTokenFor(config, accountId, connectionId)
  const result = yield* provider(() => f(token)).pipe(Effect.either)
  if (result._tag === "Right") return result.right
  if (result.left.kind === "AUTH") {
    yield* (yield* GrowthGa4Repository).suspend(connectionId, "AUTHORIZATION_REVOKED")
    return yield* refuse("Ga4ReauthorizationRequired")
  }
  return yield* refuse(providerReason(result.left))
})

export const growthGa4Api = (withSession: WithSession) => {
  const operator = operatorSessionFor(withSession)
  const scoped = <E, R>(params: ReadonlyArray<string>, run: (session: Session, p: Record<string, string>) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
    operator(session => Effect.gen(function*() {
      const route = yield* HttpRouter.RouteContext
      const values: Record<string, string> = {}
      for (const name of params) {
        const v = route.params[name] ?? ""
        if (decodeRouteId(v)._tag === "Left") return yield* json(422, { _tag: "InvalidRequest" }, PRIVATE_HEADERS)
        values[name] = v
      }
      return yield* run(session, values)
    })).pipe(Effect.catchAll(failure))
  const client = "/api/growth/clients/:id/ga4"

  /** The OAuth callback lands here from Google (top-level GET), then sends the operator back to the measurement page with a status word. */
  const callback = Effect.gen(function*() {
    const config = yield* providerConfig
    const request = yield* HttpServerRequest.HttpServerRequest
    const query = new URL(request.url, "http://localhost").searchParams
    const appBase = config.configured ? config.appBaseUrl : new URL(process.env["APP_BASE_URL"] || "http://localhost:3000").origin
    const back = (status: string, businessId: string | null) => HttpServerResponse.empty({
      status: 303,
      headers: { location: businessId ? `${appBase}/clients/${businessId}/growth-measurement?ga4=${status}` : `${appBase}/clients?ga4=${status}`, "cache-control": "no-store", "referrer-policy": "no-referrer" },
    })
    if (!config.configured) return yield* back("not_configured", null)
    const state = query.get("state") ?? ""
    if (!/^[A-Za-z0-9_-]{43}$/.test(state)) return yield* back("state_invalid", null)
    return yield* withSession(session => Effect.gen(function*() {
      const repo = yield* GrowthGa4Repository
      const pending = yield* repo.consumeAuthorization(session, sha256(state)).pipe(Effect.either)
      if (pending._tag === "Left") {
        const reason = pending.left instanceof GrowthGa4Refused ? pending.left.reason : "OAuthStateInvalid"
        return yield* back(reason === "OAuthStateExpired" ? "state_expired" : reason === "OAuthStateReused" ? "state_reused" : "state_invalid", null)
      }
      const { businessId, connectionId } = pending.right
      if (query.get("error")) return yield* back("consent_denied", businessId)
      const code = query.get("code") ?? ""
      const verifier = config.cipher.decrypt(pending.right.verifierCiphertext, `oauth-state:${sha256(state)}`)
      if (!code || code.length > 2048 || !verifier) return yield* back("state_invalid", businessId)
      const tokens = yield* provider(() => exchangeCode(config.oauth, code, verifier)).pipe(Effect.either)
      if (tokens._tag === "Left") return yield* back("token_exchange_failed", businessId)
      const t = tokens.right
      // Tokens OpenRecord will not keep are revoked at once.
      const discard = (status: string) => provider(() => revokeToken(config.oauth, t.refreshToken ?? t.accessToken)).pipe(Effect.ignore, Effect.zipRight(back(status, businessId)))
      const identity = identityFromIdToken(t.idToken, config.oauth.clientId)
      if (!identity) return yield* discard("identity_unverified")
      if (!ga4ScopesAcceptable(t.grantedScopes)) return yield* discard("scope_refused")
      const saved = yield* repo.saveAuthorization(session, connectionId, {
        googleSubject: identity.subject, googleEmail: identity.email, grantedScopes: t.grantedScopes,
        seal: id => ({
          refreshCiphertext: t.refreshToken ? config.cipher.encrypt(t.refreshToken, `${id}:refresh`) : null,
          accessCiphertext: config.cipher.encrypt(t.accessToken, `${id}:access`), accessExpiresAt: t.accessTokenExpiresAt,
        }),
      }).pipe(Effect.either)
      if (saved._tag === "Left") {
        const reason = saved.left instanceof GrowthGa4Refused ? saved.left.reason : ""
        if (reason === "Ga4IdentityMismatch") return yield* discard("identity_mismatch")
        if (reason === "NoRefreshToken") return yield* back("no_refresh_token", businessId)
        return yield* Effect.fail(saved.left)
      }
      return yield* back(connectionId ? "reconnected" : "connected", businessId)
    }))
  }).pipe(Effect.catchAll(e => typeof e === "object" && e !== null && "_tag" in e && e._tag === "NotAuthenticated"
    ? Effect.map(providerConfig, c => c.configured ? c.appBaseUrl : "http://localhost:3000").pipe(Effect.flatMap(base => HttpServerResponse.empty({ status: 303, headers: { location: `${base}/?ga4=signin_required`, "cache-control": "no-store", "referrer-policy": "no-referrer" } })))
    : failure(e)))

  return HttpRouter.empty.pipe(
    HttpRouter.get("/api/growth/ga4/oauth/callback", callback),
    HttpRouter.get("/api/growth/ga4/connections", scoped([], session => Effect.gen(function*() {
      const config = yield* providerConfig
      const connections = yield* (yield* GrowthGa4Repository).connections(session.accountId)
      return yield* json(200, { configured: config.configured, ...(config.configured ? {} : { notConfiguredReason: config.reason }), connections }, PRIVATE_HEADERS)
    }))),
    HttpRouter.post("/api/growth/ga4/connect", scoped([], session => Effect.gen(function*() {
      const input = decode(StartGa4Connection, yield* readJson)
      if (!input) return yield* json(422, { _tag: "InvalidRequest" }, PRIVATE_HEADERS)
      const config = yield* configured
      const state = newOAuthSecret(), verifier = newOAuthSecret()
      yield* (yield* GrowthGa4Repository).startAuthorization(session, {
        businessId: input.businessId, connectionId: input.connectionId ?? null, stateSha256: sha256(state),
        verifierCiphertext: config.cipher.encrypt(verifier, `oauth-state:${sha256(state)}`), ttlSeconds: OAUTH_STATE_TTL_SECONDS,
      })
      return yield* json(200, { authorizationUrl: authorizationUrl(config.oauth, { state, codeVerifier: verifier }) }, PRIVATE_HEADERS)
    }))),
    HttpRouter.get("/api/growth/ga4/connections/:connectionId/properties", scoped(["connectionId"], (session, p) => Effect.gen(function*() {
      const config = yield* configured
      const result = yield* read(config, session.accountId, p["connectionId"]!, token => listAccessibleProperties(config.api, token))
      return yield* json(200, result, PRIVATE_HEADERS)
    }))),
    HttpRouter.get("/api/growth/ga4/connections/:connectionId/properties/:propertyId/key-events", scoped(["connectionId"], (session, p) => Effect.gen(function*() {
      const { params } = yield* HttpRouter.RouteContext
      const propertyId = params["propertyId"] ?? ""
      if (!/^[0-9]{1,20}$/.test(propertyId)) return yield* json(422, { _tag: "InvalidRequest" }, PRIVATE_HEADERS)
      const config = yield* configured
      const keyEvents = yield* read(config, session.accountId, p["connectionId"]!, token => listKeyEvents(config.api, token, `properties/${propertyId}`))
      return yield* json(200, { keyEvents }, PRIVATE_HEADERS)
    }))),
    HttpRouter.post("/api/growth/ga4/connections/:connectionId/disconnect", scoped(["connectionId"], (session, p) => Effect.gen(function*() {
      if (!decode(DisconnectGa4, yield* readJson)) return yield* json(422, { _tag: "InvalidRequest" }, PRIVATE_HEADERS)
      const repo = yield* GrowthGa4Repository
      const connectionId = p["connectionId"]!
      const current = yield* repo.connection(session.accountId, connectionId)
      if (current.status === "DISCONNECTED") return yield* json(200, { connection: current }, PRIVATE_HEADERS)
      // Revoke at Google first (best effort); the stored credentials are erased either way.
      const config = yield* providerConfig
      let confirmed = false
      if (config.configured) {
        const creds = yield* repo.credentials(connectionId)
        const token = (creds.refreshCiphertext && config.cipher.decrypt(creds.refreshCiphertext, `${connectionId}:refresh`))
          || (creds.accessCiphertext && config.cipher.decrypt(creds.accessCiphertext, `${connectionId}:access`)) || null
        if (token) confirmed = (yield* provider(() => revokeToken(config.oauth, token)).pipe(Effect.orElseSucceed(() => "UNCONFIRMED" as const))) === "CONFIRMED"
      }
      return yield* json(200, { connection: yield* repo.disconnect(session, connectionId, confirmed) }, PRIVATE_HEADERS)
    }))),

    HttpRouter.get(`${client}/bindings`, scoped(["id"], (session, p) => Effect.gen(function*() {
      const repo = yield* GrowthGa4Repository
      const bindings = yield* repo.bindings(session.accountId, p["id"]!)
      const health = yield* Effect.forEach(bindings.filter(b => b.active), b => repo.health(session.accountId, p["id"]!, b.id, Date.now()))
      return yield* json(200, { bindings, health }, PRIVATE_HEADERS)
    }))),
    HttpRouter.post(`${client}/bindings`, scoped(["id"], (session, p) => Effect.gen(function*() {
      const input = decode(BindGa4Property, yield* readJson)
      if (!input) return yield* json(422, { _tag: "InvalidRequest" }, PRIVATE_HEADERS)
      const repo = yield* GrowthGa4Repository
      const businessId = p["id"]!
      const config = yield* configured
      const { timeZone } = yield* repo.checkBindable(session.accountId, businessId, input)
      // Only a property the authorized identity can read may be bound. A connection is not proof of ownership.
      const listed = yield* read(config, session.accountId, input.connectionId, token => listAccessibleProperties(config.api, token))
      const choice = listed.properties.find(x => x.property === input.property)
      if (!choice) return yield* refuse("PropertyNotAccessible")
      const property = yield* read(config, session.accountId, input.connectionId, token => getProperty(config.api, token, input.property))
      if (property.timeZone !== timeZone) return yield* refuse("PropertyTimeZoneDiffersFromDefinition")
      const keyEvents = yield* read(config, session.accountId, input.connectionId, token => listKeyEvents(config.api, token, input.property))
      const keyEvent = keyEvents.find(k => k.eventName === input.eventName)
      if (!keyEvent) return yield* refuse("KeyEventNotConfigured")
      const result = yield* repo.bind(session, businessId, input, {
        propertyDisplayName: property.displayName, propertyAccount: property.account && /^accounts\/[0-9]{1,20}$/.test(property.account) ? property.account : null,
        propertyTimeZone: property.timeZone, keyEventCountingMethod: keyEvent.countingMethod && /^[A-Z_]{1,64}$/.test(keyEvent.countingMethod) ? keyEvent.countingMethod : null,
      })
      return yield* json(200, result, PRIVATE_HEADERS)
    }))),
    HttpRouter.get(`${client}/bindings/:bindingId`, scoped(["id", "bindingId"], (session, p) => Effect.gen(function*() {
      return yield* json(200, { health: yield* (yield* GrowthGa4Repository).health(session.accountId, p["id"]!, p["bindingId"]!, Date.now()) }, PRIVATE_HEADERS)
    }))),
    HttpRouter.post(`${client}/bindings/:bindingId/sync`, scoped(["id", "bindingId"], (session, p) => Effect.gen(function*() {
      const input = decode(RequestGa4Sync, yield* readJson)
      if (!input) return yield* json(422, { _tag: "InvalidRequest" }, PRIVATE_HEADERS)
      const repo = yield* GrowthGa4Repository
      const health = yield* repo.health(session.accountId, p["id"]!, p["bindingId"]!, Date.now())
      const refusal = ga4RangeRefusal(input.dateStart, input.dateEnd, ga4LatestCompleteDay(Date.now(), health.binding.propertyTimeZone))
      if (refusal) return yield* refuse(refusal)
      return yield* json(200, yield* repo.requestSync(session, p["id"]!, p["bindingId"]!, input), PRIVATE_HEADERS)
    }))),
  )
}
