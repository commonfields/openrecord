// Ad platform connections, server side: sign-in (OAuth), encrypted tokens,
// which ad account belongs to which business, and live performance reads.
// Operator-only and account-scoped like the GA4 routes: another account's
// connection, binding or business is "not found". Tokens, codes and app
// secrets never appear in a response, a log line or a redirect; the callback
// sends the operator back with a short status word. Every platform call reads;
// nothing here can create, change or pause an ad.
import { createHash } from "node:crypto"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "@effect/platform"
import { SqlClient } from "@effect/sql"
import { Data, Effect, Option } from "effect"
import { BusinessRepository, type Session } from "@openrecord/db"
import {
  AD_PERFORMANCE_DAYS, AD_TOP_CAMPAIGNS, BindAdAccount, StartAdConnection, adWindows, decodeRouteId,
  type AdAccount, type AdAccountPerformance, type AdBinding, type AdConnection, type AdPerformanceDays, type AdProvider, type ChannelProvider, type LocalProfilePerformance,
} from "@openrecord/contracts"
import {
  AdsError, AdsProvider, GOOGLE_ADS_ACCEPTED_SCOPES, GOOGLE_ADS_CONVERSIONS, GOOGLE_ADS_SCOPE, GOOGLE_BUSINESS_ACCEPTED_SCOPES, GOOGLE_BUSINESS_SCOPE, META_CONVERSIONS,
  googleAdsAccounts, googleAdsAuthorizationUrl, googleBusinessAuthorizationUrl, googleBusinessLocations, googleBusinessReviews, googleBusinessSearchTerms, googleBusinessTotals,
  googleAdsCampaigns, googleAdsTotals, metaAdAccounts, metaAuthorizationUrl, metaCampaigns, metaExchangeCode, metaIdentity, metaRevoke, metaTotals, type AdsConfig,
} from "@openrecord/ads"
import { Ga4Error, exchangeCode, identityFromIdToken, newOAuthSecret, refreshAccessToken, revokeToken } from "@openrecord/ga4"
import { decode, json, operatorSessionFor, readJson, type WithSession } from "./record-routes.js"

export class AdsRefused extends Data.TaggedError("AdsRefused")<{ readonly reason: string }> {}
const refuse = (reason: string) => Effect.fail(new AdsRefused({ reason }))
const PRIVATE = { "cache-control": "no-store" }
const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex")
const STATE_TTL_SECONDS = 600
const META_PERMISSIONS = new Set(["ads_read", "public_profile", "email"])

const NOT_CONFIGURED: AdsConfig = { cipher: null, appBaseUrl: "http://localhost:3000", meta: { configured: false, reason: "MISSING_APP" }, googleAds: { configured: false, reason: "MISSING_APP" }, googleBusiness: { configured: false, reason: "MISSING_APP" } }
const adsConfig = Effect.map(Effect.serviceOption(AdsProvider), o => Option.getOrElse(o, () => NOT_CONFIGURED))
const cipherOf = (c: AdsConfig) => c.cipher ? Effect.succeed(c.cipher) : refuse("AdsNotConfigured")
const metaOf = (c: AdsConfig) => c.meta.configured ? Effect.succeed(c.meta.config) : refuse("AdsNotConfigured")
const googleOf = (c: AdsConfig) => c.googleAds.configured ? Effect.succeed(c.googleAds) : refuse("AdsNotConfigured")
const businessOf = (c: AdsConfig) => c.googleBusiness.configured ? Effect.succeed(c.googleBusiness) : refuse("AdsNotConfigured")
/** The Google sign-in (client and endpoints) a Google provider uses. */
const googleClientOf = (c: AdsConfig, provider: ChannelProvider) => provider === "google_business" ? Effect.map(businessOf(c), b => b.oauth) : Effect.map(googleOf(c), g => g.oauth)

/** A platform call; failures become stable reasons, never platform text. */
const call = <A>(f: () => Promise<A>) => Effect.tryPromise({
  try: f,
  catch: e => e instanceof AdsError ? e : e instanceof Ga4Error ? new AdsError({ kind: e.kind, status: e.status, providerCode: e.providerCode }) : new AdsError({ kind: "UNAVAILABLE", status: null, providerCode: null }),
})
const reasonOf = (e: AdsError) => e.kind === "QUOTA" ? "ProviderQuota" : e.kind === "FORBIDDEN" || e.kind === "NOT_FOUND" ? "AdAccountNotAccessible" : e.kind === "INVALID" ? "ProviderRejected" : "ProviderUnavailable"

// ---- storage ---------------------------------------------------------------

type ConnectionRow = AdConnection & { readonly subject: string; readonly access: string | null; readonly accessExpiresAt: number | null; readonly refresh: string | null }
const toConnection = (r: Record<string, unknown>): ConnectionRow => ({
  id: String(r["id"]), provider: r["provider"] as ChannelProvider, displayName: String(r["display_name"]), status: r["status"] as AdConnection["status"],
  connectedAt: new Date(r["connected_at"] as string).toISOString(), expiresAt: r["access_expires_at"] ? new Date(r["access_expires_at"] as string).toISOString() : null,
  subject: String(r["subject"]), access: (r["access_ciphertext"] as string | null) ?? null, refresh: (r["refresh_ciphertext"] as string | null) ?? null,
  accessExpiresAt: r["access_expires_at"] ? new Date(r["access_expires_at"] as string).getTime() : null,
})
const publicConnection = ({ subject: _s, access: _a, refresh: _r, accessExpiresAt: _e, ...c }: ConnectionRow): AdConnection =>
  c.provider === "meta" ? c : { ...c, expiresAt: null }
const toBinding = (r: Record<string, unknown>): AdBinding & { readonly loginCustomerId: string | null; readonly parentId: string | null } => ({
  id: String(r["id"]), provider: r["provider"] as ChannelProvider, connectionId: String(r["connection_id"]), externalId: String(r["external_id"]),
  name: String(r["name"]), currency: (r["currency"] as string | null) ?? null, boundAt: new Date(r["bound_at"] as string).toISOString(),
  loginCustomerId: (r["login_customer_id"] as string | null) ?? null, parentId: (r["parent_id"] as string | null) ?? null,
})

const connections = (accountId: string) => Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  return (yield* sql`SELECT * FROM ad_connections WHERE account_id = ${accountId} AND status <> 'DISCONNECTED' ORDER BY connected_at`).map(toConnection)
})
const connection = (accountId: string, id: string) => Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const row = (yield* sql`SELECT * FROM ad_connections WHERE id = ${id} AND account_id = ${accountId} AND status <> 'DISCONNECTED'`)[0]
  return row ? toConnection(row) : yield* refuse("AdConnectionNotFound")
})
export const adBindings = (accountId: string, businessId: string) => Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  return (yield* sql`SELECT b.* FROM ad_account_bindings b JOIN ad_connections c ON c.id = b.connection_id
    WHERE b.account_id = ${accountId} AND b.business_id = ${businessId} AND b.ended_at IS NULL AND c.status <> 'DISCONNECTED' ORDER BY b.provider, b.name`).map(toBinding)
})
const suspend = (id: string) => Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql`UPDATE ad_connections SET status = 'REAUTHORIZATION_REQUIRED', access_ciphertext = NULL, updated_at = now() WHERE id = ${id} AND status = 'ACTIVE'`
})
const scopedBusiness = (session: Session, businessId: string) => Effect.gen(function*() {
  if (decodeRouteId(businessId)._tag === "Left") return yield* refuse("InvalidRequest")
  if (!(yield* (yield* BusinessRepository).getScoped(session.accountId, businessId))) return yield* refuse("BusinessNotFound")
})

// ---- tokens ----------------------------------------------------------------

/** A usable access token: Meta's long-lived token until it expires, Google's refreshed when stale. */
const accessToken = (config: AdsConfig, c: ConnectionRow) => Effect.gen(function*() {
  if (c.status !== "ACTIVE") return yield* refuse("AdsReauthorizationRequired")
  const cipher = yield* cipherOf(config)
  const cached = c.access && (c.accessExpiresAt === null || c.accessExpiresAt - 60_000 > Date.now()) ? cipher.decrypt(c.access, `ads:${c.id}:access`) : null
  if (cached) return cached
  if (c.provider === "meta" || !c.refresh) { yield* suspend(c.id); return yield* refuse("AdsReauthorizationRequired") }
  const oauth = yield* googleClientOf(config, c.provider)
  const refreshToken = cipher.decrypt(c.refresh, `ads:${c.id}:refresh`)
  if (!refreshToken) { yield* suspend(c.id); return yield* refuse("AdsReauthorizationRequired") }
  const fresh = yield* call(() => refreshAccessToken(oauth, refreshToken)).pipe(Effect.either)
  if (fresh._tag === "Left") {
    if (fresh.left.kind === "AUTH" || fresh.left.kind === "INVALID") { yield* suspend(c.id); return yield* refuse("AdsReauthorizationRequired") }
    return yield* refuse(reasonOf(fresh.left))
  }
  const sql = yield* SqlClient.SqlClient
  yield* sql`UPDATE ad_connections SET access_ciphertext = ${cipher.encrypt(fresh.right.accessToken, `ads:${c.id}:access`)},
    access_expires_at = ${new Date(fresh.right.accessTokenExpiresAt)}, updated_at = now() WHERE id = ${c.id} AND status = 'ACTIVE'`
  return fresh.right.accessToken
})
/** Runs a read with the connection's token; a refused token marks the connection for a new sign-in. */
const withToken = <A>(config: AdsConfig, c: ConnectionRow, f: (token: string) => Promise<A>) => Effect.gen(function*() {
  const token = yield* accessToken(config, c)
  const result = yield* call(() => f(token)).pipe(Effect.either)
  if (result._tag === "Right") return result.right
  if (result.left.kind === "AUTH") { yield* suspend(c.id); return yield* refuse("AdsReauthorizationRequired") }
  return yield* refuse(reasonOf(result.left))
})

const listAccounts = (config: AdsConfig, c: ConnectionRow): Effect.Effect<ReadonlyArray<AdAccount>, AdsRefused | import("@effect/sql/SqlError").SqlError, SqlClient.SqlClient> => c.provider === "meta"
  ? Effect.flatMap(metaOf(config), m => withToken(config, c, t => metaAdAccounts(m, t)))
  : c.provider === "google_ads" ? Effect.flatMap(googleOf(config), g => withToken(config, c, t => googleAdsAccounts(g.config, t)))
  : Effect.flatMap(businessOf(config), b => withToken(config, c, async t => (await googleBusinessLocations(b.config, t)).map((l): AdAccount => ({
      externalId: l.locationId, name: l.address ? `${l.name} · ${l.address}` : l.name, currency: null, loginCustomerId: null, parentId: l.accountId, active: true }))))

// ---- performance -----------------------------------------------------------

/** Live performance of every ad account bound to a business. One account failing never hides the others. */
export const adPerformance = (accountId: string, businessId: string, days: AdPerformanceDays, provider?: AdProvider) => Effect.gen(function*() {
  const config = yield* adsConfig
  const bindings = (yield* adBindings(accountId, businessId)).filter(b => b.provider !== "google_business" && (!provider || b.provider === provider))
  const windows = adWindows(Date.now(), days)
  const results = yield* Effect.forEach(bindings, b => Effect.gen(function*() {
    const c = yield* connection(accountId, b.connectionId)
    const [current, previous, topCampaigns] = b.provider === "meta"
      ? yield* Effect.flatMap(metaOf(config), m => withToken(config, c, t => Promise.all([
          metaTotals(m, t, b.externalId, windows.current), metaTotals(m, t, b.externalId, windows.previous), metaCampaigns(m, t, b.externalId, windows.current, AD_TOP_CAMPAIGNS)])))
      : yield* Effect.flatMap(googleOf(config), g => withToken(config, c, t => Promise.all([
          googleAdsTotals(g.config, t, b.externalId, b.loginCustomerId, windows.current), googleAdsTotals(g.config, t, b.externalId, b.loginCustomerId, windows.previous),
          googleAdsCampaigns(g.config, t, b.externalId, b.loginCustomerId, windows.current, AD_TOP_CAMPAIGNS)])))
    return { provider: b.provider as AdProvider, accountName: b.name, externalId: b.externalId, currency: b.currency, days,
      current: { ...windows.current, totals: current }, previous: { ...windows.previous, totals: previous }, topCampaigns,
      conversionDefinition: b.provider === "meta" ? META_CONVERSIONS : GOOGLE_ADS_CONVERSIONS, collectedAt: new Date().toISOString() } satisfies AdAccountPerformance
  }).pipe(Effect.either), { concurrency: 3 })
  return {
    accounts: results.flatMap(r => r._tag === "Right" ? [r.right] : []),
    failures: results.flatMap((r, i) => r._tag === "Left" ? [{ provider: bindings[i]!.provider, accountName: bindings[i]!.name,
      reason: r.left instanceof AdsRefused ? r.left.reason : "ProviderUnavailable" }] : []),
  }
})

/** Live Google Business Profile performance for each location bound to a business. Search terms and reviews are read separately, so one failing never hides the rest. */
export const localPerformance = (accountId: string, businessId: string, days: AdPerformanceDays) => Effect.gen(function*() {
  const config = yield* adsConfig
  const bindings = (yield* adBindings(accountId, businessId)).filter(b => b.provider === "google_business")
  const windows = adWindows(Date.now(), days)
  // Search terms come by month: the last complete one.
  const now = new Date(), last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1))
  const month = { year: last.getUTCFullYear(), month: last.getUTCMonth() + 1 }
  const results = yield* Effect.forEach(bindings, b => Effect.gen(function*() {
    const c = yield* connection(accountId, b.connectionId)
    const gbp = (yield* businessOf(config)).config
    const [current, previous] = yield* withToken(config, c, t => Promise.all([googleBusinessTotals(gbp, t, b.externalId, windows.current), googleBusinessTotals(gbp, t, b.externalId, windows.previous)]))
    const terms = yield* withToken(config, c, t => googleBusinessSearchTerms(gbp, t, b.externalId, month)).pipe(Effect.orElseSucceed(() => null))
    const reviews = b.parentId ? yield* withToken(config, c, t => googleBusinessReviews(gbp, t, b.parentId!, b.externalId, windows.current)).pipe(Effect.orElseSucceed(() => null)) : null
    return { locationName: b.name, locationId: b.externalId, days, current: { ...windows.current, totals: current }, previous: { ...windows.previous, totals: previous },
      searchTerms: terms ? { month: `${month.year}-${String(month.month).padStart(2, "0")}`, terms } : null, reviews, collectedAt: new Date().toISOString() } satisfies LocalProfilePerformance
  }).pipe(Effect.either), { concurrency: 3 })
  return {
    locations: results.flatMap(r => r._tag === "Right" ? [r.right] : []),
    failures: results.flatMap((r, i) => r._tag === "Left" ? [{ locationName: bindings[i]!.name, reason: r.left instanceof AdsRefused ? r.left.reason : "ProviderUnavailable" }] : []),
  }
})

// ---- routes ----------------------------------------------------------------

const STATUS: Readonly<Record<string, number>> = { InvalidRequest: 422, AdsNotConfigured: 503, ProviderUnavailable: 503, ProviderQuota: 503, AdsReauthorizationRequired: 409, AdAccountNotAccessible: 409, ProviderRejected: 409 }
const failure = (e: unknown) => {
  if (e instanceof AdsRefused) return json(STATUS[e.reason] ?? (e.reason.endsWith("NotFound") ? 404 : 409), { _tag: "AdsRefused", reason: e.reason }, PRIVATE)
  if (typeof e === "object" && e !== null && "_tag" in e && e._tag === "NotAuthenticated") return json(401, { _tag: "NotAuthenticated" }, PRIVATE)
  return json(500, { _tag: "AdsRequestFailed" }, PRIVATE)
}

export const adsApi = (withSession: WithSession) => {
  const operator = operatorSessionFor(withSession)
  const route = <E, R>(run: (session: Session, params: Readonly<Record<string, string | undefined>>) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
    operator(session => Effect.gen(function*() {
      const { params } = yield* HttpRouter.RouteContext
      for (const k of ["id", "connectionId", "bindingId"]) if (params[k] !== undefined && decodeRouteId(params[k]!)._tag === "Left") return yield* refuse("InvalidRequest")
      return yield* run(session, params)
    })).pipe(Effect.catchAll(failure))

  /** Both platforms send the person back here; it records the sign-in and returns them to the business's Channels page. */
  const callback = Effect.gen(function*() {
    const config = yield* adsConfig
    const request = yield* HttpServerRequest.HttpServerRequest
    const query = new URL(request.url, "http://localhost").searchParams
    const back = (status: string, businessId: string | null) => HttpServerResponse.empty({ status: 303, headers: {
      location: businessId ? `${config.appBaseUrl}/businesses/${businessId}/channels?ads=${status}#ads` : `${config.appBaseUrl}/clients?ads=${status}`,
      "cache-control": "no-store", "referrer-policy": "no-referrer" } })
    const state = query.get("state") ?? ""
    if (!config.cipher || !/^[A-Za-z0-9_-]{43}$/.test(state)) return yield* back("state_invalid", null)
    const cipher = config.cipher
    return yield* withSession(session => Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const rows = yield* sql`UPDATE ad_oauth_states SET consumed_at = now() WHERE state_sha256 = ${sha256(state)} AND account_id = ${session.accountId}
        AND user_id = ${session.userId} AND consumed_at IS NULL AND expires_at > now() RETURNING business_id, provider, verifier_ciphertext`
      const pending = rows[0]
      if (!pending) return yield* back("state_invalid", null)
      const businessId = String(pending["business_id"]), provider = pending["provider"] as ChannelProvider
      if (query.get("error")) return yield* back("consent_denied", businessId)
      const code = query.get("code") ?? ""
      const verifier = cipher.decrypt(String(pending["verifier_ciphertext"]), `ads-state:${sha256(state)}`)
      if (!code || code.length > 2048 || !verifier) return yield* back("state_invalid", businessId)

      let identity: { subject: string; name: string; scopes: ReadonlyArray<string>; access: string; accessExpiresAt: number | null; refresh: string | null }
      if (provider === "meta") {
        const meta = yield* metaOf(config)
        const tokens = yield* call(() => metaExchangeCode(meta, code)).pipe(Effect.either)
        if (tokens._tag === "Left") return yield* back("token_exchange_failed", businessId)
        const who = yield* call(() => metaIdentity(meta, tokens.right.accessToken)).pipe(Effect.either)
        if (who._tag === "Left") return yield* back("identity_unverified", businessId)
        const scopes = who.right.granted.filter(p => META_PERMISSIONS.has(p))
        if (!scopes.includes("ads_read") || who.right.granted.some(p => !META_PERMISSIONS.has(p))) {
          yield* call(() => metaRevoke(meta, tokens.right.accessToken, who.right.subject)).pipe(Effect.ignore)
          return yield* back("scope_refused", businessId)
        }
        identity = { subject: who.right.subject, name: who.right.name, scopes, access: tokens.right.accessToken, accessExpiresAt: tokens.right.expiresAt, refresh: null }
      } else {
        const oauth = yield* googleClientOf(config, provider)
        const tokens = yield* call(() => exchangeCode(oauth, code, verifier)).pipe(Effect.either)
        if (tokens._tag === "Left") return yield* back("token_exchange_failed", businessId)
        const t = tokens.right
        const discard = (status: string) => call(() => revokeToken(oauth, t.refreshToken ?? t.accessToken)).pipe(Effect.ignore, Effect.zipRight(back(status, businessId)))
        const who = identityFromIdToken(t.idToken, oauth.clientId)
        if (!who || !/^\d{1,30}$/.test(who.subject)) return yield* discard("identity_unverified")
        const [required, accepted] = provider === "google_business" ? [GOOGLE_BUSINESS_SCOPE, GOOGLE_BUSINESS_ACCEPTED_SCOPES] : [GOOGLE_ADS_SCOPE, GOOGLE_ADS_ACCEPTED_SCOPES]
        if (!t.grantedScopes.includes(required) || t.grantedScopes.some(s => !accepted.includes(s))) return yield* discard("scope_refused")
        identity = { subject: who.subject, name: who.email, scopes: t.grantedScopes, access: t.accessToken, accessExpiresAt: t.accessTokenExpiresAt, refresh: t.refreshToken }
      }
      // A second sign-in by the same person replaces the tokens of their existing connection.
      yield* sql.withTransaction(Effect.gen(function*() {
        const existing = yield* sql`SELECT id, refresh_ciphertext FROM ad_connections WHERE account_id = ${session.accountId} AND provider = ${provider}
          AND subject = ${identity.subject} AND status <> 'DISCONNECTED' FOR UPDATE`
        const id = existing[0] ? String(existing[0]["id"]) : String((yield* sql`INSERT INTO ad_connections(account_id, provider, subject, display_name, granted_scopes, connected_by_user_id)
          VALUES (${session.accountId}, ${provider}, ${identity.subject}, ${identity.name.slice(0, 200) || "Ad account owner"}, ${identity.scopes as string[]}, ${session.userId}) RETURNING id`)[0]!["id"])
        const refresh = identity.refresh ? cipher.encrypt(identity.refresh, `ads:${id}:refresh`) : (existing[0]?.["refresh_ciphertext"] as string | null) ?? null
        yield* sql`UPDATE ad_connections SET status = 'ACTIVE', display_name = ${identity.name.slice(0, 200) || "Ad account owner"}, granted_scopes = ${identity.scopes as string[]},
          access_ciphertext = ${cipher.encrypt(identity.access, `ads:${id}:access`)}, access_expires_at = ${identity.accessExpiresAt ? new Date(identity.accessExpiresAt) : null},
          refresh_ciphertext = ${refresh}, updated_at = now() WHERE id = ${id}`
      }))
      return yield* back("connected", businessId)
    })).pipe(Effect.catchAll(() => back("failed", null)))
  })

  return HttpRouter.empty.pipe(
    HttpRouter.get("/api/ads/oauth/callback", callback),
    // What the Channels page shows: which platforms are on, the account's sign-ins and this business's ad accounts.
    HttpRouter.get("/api/ads/clients/:id", route((session, p) => Effect.gen(function*() {
      yield* scopedBusiness(session, p["id"]!)
      const config = yield* adsConfig
      const status = (s: { readonly configured: true } | { readonly configured: false; readonly reason: string }) => s.configured ? { configured: true } : { configured: false, reason: s.reason }
      return yield* json(200, {
        providers: { meta: status(config.meta), google_ads: status(config.googleAds), google_business: status(config.googleBusiness) },
        connections: (yield* connections(session.accountId)).map(publicConnection),
        bindings: (yield* adBindings(session.accountId, p["id"]!)).map(({ loginCustomerId: _l, parentId: _p, ...b }) => b),
      }, PRIVATE)
    }))),
    HttpRouter.post("/api/ads/connect", route(session => Effect.gen(function*() {
      const input = decode(StartAdConnection, yield* readJson)
      if (!input) return yield* refuse("InvalidRequest")
      yield* scopedBusiness(session, input.businessId)
      const config = yield* adsConfig
      const cipher = yield* cipherOf(config)
      const state = newOAuthSecret(), verifier = newOAuthSecret()
      const url = input.provider === "meta" ? metaAuthorizationUrl(yield* metaOf(config), state)
        : input.provider === "google_ads" ? yield* Effect.map(googleOf(config), g => googleAdsAuthorizationUrl(g.config, g.oauth, state, verifier))
        : yield* Effect.map(businessOf(config), b => googleBusinessAuthorizationUrl(b.config, b.oauth, state, verifier))
      const sql = yield* SqlClient.SqlClient
      yield* sql`DELETE FROM ad_oauth_states WHERE expires_at < now() - interval '1 day'`
      yield* sql`INSERT INTO ad_oauth_states(state_sha256, account_id, user_id, business_id, provider, verifier_ciphertext, expires_at)
        VALUES (${sha256(state)}, ${session.accountId}, ${session.userId}, ${input.businessId}, ${input.provider}, ${cipher.encrypt(verifier, `ads-state:${sha256(state)}`)},
          now() + make_interval(secs => ${STATE_TTL_SECONDS}))`
      return yield* json(200, { authorizationUrl: url }, PRIVATE)
    }))),
    HttpRouter.get("/api/ads/connections/:connectionId/accounts", route((session, p) => Effect.gen(function*() {
      const config = yield* adsConfig
      const accounts: ReadonlyArray<AdAccount> = yield* listAccounts(config, yield* connection(session.accountId, p["connectionId"]!))
      return yield* json(200, { accounts: accounts.map(({ loginCustomerId: _l, parentId: _p, ...a }) => a) }, PRIVATE)
    }))),
    HttpRouter.post("/api/ads/connections/:connectionId/disconnect", route((session, p) => Effect.gen(function*() {
      const config = yield* adsConfig
      const c = yield* connection(session.accountId, p["connectionId"]!)
      // Revoke at the platform when possible; the stored tokens are removed either way.
      const token = c.access && config.cipher ? config.cipher.decrypt(c.access, `ads:${c.id}:access`) : null
      const refresh = c.refresh && config.cipher ? config.cipher.decrypt(c.refresh, `ads:${c.id}:refresh`) : null
      const meta = config.meta.configured ? config.meta.config : null
      const google = c.provider === "google_business" ? (config.googleBusiness.configured ? config.googleBusiness.oauth : null) : config.googleAds.configured ? config.googleAds.oauth : null
      if (c.provider === "meta" && token && meta) yield* call(() => metaRevoke(meta, token, c.subject)).pipe(Effect.ignore)
      const googleToken = refresh ?? token
      if (c.provider !== "meta" && googleToken && google) yield* call(() => revokeToken(google, googleToken)).pipe(Effect.ignore)
      const sql = yield* SqlClient.SqlClient
      yield* sql.withTransaction(Effect.gen(function*() {
        yield* sql`UPDATE ad_account_bindings SET ended_at = now(), ended_by_user_id = ${session.userId} WHERE connection_id = ${c.id} AND ended_at IS NULL`
        yield* sql`UPDATE ad_connections SET status = 'DISCONNECTED', access_ciphertext = NULL, refresh_ciphertext = NULL, disconnected_at = now(), updated_at = now() WHERE id = ${c.id}`
      }))
      return yield* json(200, { disconnected: true }, PRIVATE)
    }))),
    HttpRouter.post("/api/ads/clients/:id/bindings", route((session, p) => Effect.gen(function*() {
      const businessId = p["id"]!
      yield* scopedBusiness(session, businessId)
      const input = decode(BindAdAccount, yield* readJson)
      if (!input) return yield* refuse("InvalidRequest")
      const config = yield* adsConfig
      const c = yield* connection(session.accountId, input.connectionId)
      // Only an account this sign-in can read today may be bound; a connection is not proof of access to another.
      const externalId = input.externalId.replace(/^act_/, "")
      if (c.provider !== "meta" && input.externalId.startsWith("act_")) return yield* refuse("InvalidRequest")
      const account = (yield* listAccounts(config, c)).find(a => a.externalId === externalId)
      if (!account) return yield* refuse("AdAccountNotAccessible")
      const sql = yield* SqlClient.SqlClient
      const row = (yield* sql`INSERT INTO ad_account_bindings(account_id, business_id, connection_id, provider, external_id, login_customer_id, parent_id, name, currency, bound_by_user_id)
        VALUES (${session.accountId}, ${businessId}, ${c.id}, ${c.provider}, ${account.externalId}, ${account.loginCustomerId}, ${account.parentId ?? null}, ${account.name.slice(0, 200)}, ${account.currency && /^[A-Z]{3}$/.test(account.currency) ? account.currency : null}, ${session.userId})
        ON CONFLICT (business_id, provider, external_id) WHERE ended_at IS NULL DO UPDATE SET connection_id = EXCLUDED.connection_id, login_customer_id = EXCLUDED.login_customer_id, parent_id = EXCLUDED.parent_id, name = EXCLUDED.name
        RETURNING *`)[0]!
      const { loginCustomerId: _l, parentId: _p, ...binding } = toBinding(row)
      return yield* json(200, { binding }, PRIVATE)
    }))),
    HttpRouter.post("/api/ads/clients/:id/bindings/:bindingId/end", route((session, p) => Effect.gen(function*() {
      yield* scopedBusiness(session, p["id"]!)
      const sql = yield* SqlClient.SqlClient
      const ended = yield* sql`UPDATE ad_account_bindings SET ended_at = now(), ended_by_user_id = ${session.userId}
        WHERE id = ${p["bindingId"]!} AND account_id = ${session.accountId} AND business_id = ${p["id"]!} AND ended_at IS NULL RETURNING id`
      if (!ended.length) return yield* refuse("AdBindingNotFound")
      return yield* json(200, { ended: true }, PRIVATE)
    }))),
    HttpRouter.get("/api/ads/clients/:id/performance", route((session, p) => Effect.gen(function*() {
      yield* scopedBusiness(session, p["id"]!)
      const request = yield* HttpServerRequest.HttpServerRequest
      const raw = Number(new URL(request.url, "http://localhost").searchParams.get("days") ?? 28)
      const days = AD_PERFORMANCE_DAYS.find(d => d === raw)
      if (!days) return yield* refuse("InvalidRequest")
      return yield* json(200, yield* adPerformance(session.accountId, p["id"]!, days), PRIVATE)
    }))),
    HttpRouter.get("/api/ads/clients/:id/local", route((session, p) => Effect.gen(function*() {
      yield* scopedBusiness(session, p["id"]!)
      const request = yield* HttpServerRequest.HttpServerRequest
      const raw = Number(new URL(request.url, "http://localhost").searchParams.get("days") ?? 28)
      const days = AD_PERFORMANCE_DAYS.find(d => d === raw)
      if (!days) return yield* refuse("InvalidRequest")
      return yield* json(200, yield* localPerformance(session.accountId, p["id"]!, days), PRIVATE)
    }))),
  )
}
