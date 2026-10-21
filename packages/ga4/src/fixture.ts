// A faithful in-process stand-in for the Google endpoints OpenRecord uses:
// the OAuth consent screen, token and revocation endpoints, Admin API
// account summaries / property / key events, and Data API runReport. It
// enforces what Google enforces for this flow (client credentials, exact
// redirect URI, single-use codes, PKCE S256, scopes, per-identity property
// access, token expiry and revocation) and answers in Google's JSON shapes and
// error format. Tests drive OpenRecord's real HTTP code through its `fetch`.
//
// Passing against this fixture is MOCK_ADAPTER_PASS, never a live result.
import { createHash, randomBytes } from "node:crypto"
import { createServer, type Server } from "node:http"
import { GA4_READONLY_SCOPE } from "@openrecord/contracts"
import { Layer } from "effect"
import { standInEndpoints, type FetchLike, type Ga4Endpoints } from "./http.js"
import { makeTokenCipher, parseCipherKeys } from "./cipher.js"
import { Ga4Provider, type Ga4ProviderConfig } from "./provider.js"

export interface FixtureIdentity { readonly sub: string; readonly email: string; readonly emailVerified?: boolean; properties: string[] }
export interface FixtureDay { keyEvents: number; eventCount: number }
export interface FixtureProperty {
  readonly name: string
  displayName: string
  readonly account: string
  readonly accountDisplayName: string
  timeZone: string
  keyEvents: Array<{ eventName: string; countingMethod: string }>
  /** event name → day (YYYY-MM-DD) → counts. Days not listed have no row. */
  data: Record<string, Record<string, FixtureDay>>
  flags?: { thresholded?: boolean; sampled?: boolean; dataLoss?: boolean }
}
export interface FixtureGoogleOptions {
  readonly clientId: string
  readonly clientSecret: string
  readonly redirectUri: string
  readonly identities: FixtureIdentity[]
  readonly properties: FixtureProperty[]
  readonly accessTokenTtlSeconds?: number
  /** Caps rows per runReport page to exercise pagination. */
  readonly pageSizeCap?: number
}
interface Grant { sub: string; scopes: string[]; revoked: boolean }
interface Failure { readonly path: RegExp; readonly status: number; readonly code: string; readonly retryAfter?: number; remaining: number }

const ORIGIN = "http://127.0.0.1:65535"
const token = (prefix: string) => `${prefix}${randomBytes(18).toString("base64url")}`
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } })
const apiError = (status: number, code: string, headers: Record<string, string> = {}) => json(status, { error: { code: status, message: `fixture ${code}`, status: code } }, headers)
const oauthError = (status: number, code: string) => json(status, { error: code, error_description: `fixture ${code}` })

export const fixtureGoogle = (opts: FixtureGoogleOptions) => {
  let clock = Date.now()
  const endpoints: Ga4Endpoints = standInEndpoints(ORIGIN)!
  const codes = new Map<string, { sub: string; challenge: string; redirectUri: string; scopes: string[]; used: boolean }>()
  const grants: Grant[] = []
  const access = new Map<string, { grant: Grant; expiresAt: number }>()
  const refresh = new Map<string, Grant>()
  const failures: Failure[] = []
  const calls: Array<{ method: string; path: string }> = []
  const issued: string[] = []
  const identity = (sub: string) => opts.identities.find(i => i.sub === sub)
  const property = (name: string) => opts.properties.find(p => p.name === name)

  const bearer = (req: Request): Grant | Response => {
    const header = req.headers.get("authorization") ?? ""
    const entry = access.get(header.replace(/^Bearer /, ""))
    if (!entry || entry.grant.revoked || entry.expiresAt <= clock) return apiError(401, "UNAUTHENTICATED")
    if (!entry.grant.scopes.includes(GA4_READONLY_SCOPE)) return apiError(403, "PERMISSION_DENIED")
    return entry.grant
  }
  const canRead = (grant: Grant, name: string) => identity(grant.sub)?.properties.includes(name) === true && property(name) !== undefined
  const issue = (grant: Grant, withRefresh: boolean) => {
    const accessToken = token("ya29.fixture-"), refreshToken = withRefresh ? token("1//fixture-") : null
    access.set(accessToken, { grant, expiresAt: clock + (opts.accessTokenTtlSeconds ?? 3600) * 1000 })
    if (refreshToken) refresh.set(refreshToken, grant)
    issued.push(accessToken, ...(refreshToken ? [refreshToken] : []))
    return { accessToken, refreshToken }
  }
  const idToken = (sub: string) => {
    const who = identity(sub)!
    const part = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url")
    return `${part({ alg: "RS256", kid: "fixture" })}.${part({ iss: "https://accounts.google.com", aud: opts.clientId, sub, email: who.email, email_verified: who.emailVerified ?? true, iat: Math.floor(clock / 1000), exp: Math.floor(clock / 1000) + 3600 })}.fixture-signature`
  }

  const tokenEndpoint = async (req: Request) => {
    const form = new URLSearchParams(await req.text())
    if (form.get("client_id") !== opts.clientId || form.get("client_secret") !== opts.clientSecret) return oauthError(401, "invalid_client")
    if (form.get("grant_type") === "authorization_code") {
      const entry = codes.get(form.get("code") ?? "")
      if (!entry || entry.used) return oauthError(400, "invalid_grant")
      entry.used = true
      if (form.get("redirect_uri") !== entry.redirectUri) return oauthError(400, "redirect_uri_mismatch")
      const verifier = form.get("code_verifier") ?? ""
      if (createHash("sha256").update(verifier, "ascii").digest("base64url") !== entry.challenge) return oauthError(400, "invalid_grant")
      const grant: Grant = { sub: entry.sub, scopes: entry.scopes, revoked: false }
      grants.push(grant)
      const t = issue(grant, true)
      return json(200, { access_token: t.accessToken, expires_in: opts.accessTokenTtlSeconds ?? 3600, refresh_token: t.refreshToken, scope: entry.scopes.join(" "), token_type: "Bearer", id_token: idToken(entry.sub) })
    }
    if (form.get("grant_type") === "refresh_token") {
      const grant = refresh.get(form.get("refresh_token") ?? "")
      if (!grant || grant.revoked) return oauthError(400, "invalid_grant")
      const t = issue(grant, false)
      return json(200, { access_token: t.accessToken, expires_in: opts.accessTokenTtlSeconds ?? 3600, scope: grant.scopes.join(" "), token_type: "Bearer" })
    }
    return oauthError(400, "unsupported_grant_type")
  }
  const revokeEndpoint = async (req: Request) => {
    const value = new URLSearchParams(await req.text()).get("token") ?? ""
    const grant = refresh.get(value) ?? access.get(value)?.grant
    if (!grant || grant.revoked) return oauthError(400, "invalid_token")
    grant.revoked = true
    return new Response("", { status: 200 })
  }
  const accountSummaries = (grant: Grant, url: URL) => {
    const readable = opts.properties.filter(p => canRead(grant, p.name))
    const accounts = [...new Set(readable.map(p => p.account))].sort()
    const size = Math.min(Number(url.searchParams.get("pageSize") ?? 50), opts.pageSizeCap ?? 200)
    const start = Number(url.searchParams.get("pageToken") ?? 0)
    const page = accounts.slice(start, start + size)
    return json(200, {
      accountSummaries: page.map(a => {
        const props = readable.filter(p => p.account === a)
        return { name: `accountSummaries/${a.split("/")[1]}`, account: a, displayName: props[0]!.accountDisplayName,
          propertySummaries: props.map(p => ({ property: p.name, displayName: p.displayName, propertyType: "PROPERTY_TYPE_ORDINARY", parent: a })) }
      }),
      ...(start + size < accounts.length ? { nextPageToken: String(start + size) } : {}),
    })
  }
  const runReport = async (grant: Grant, name: string, req: Request) => {
    const p = property(name)
    if (!p || !canRead(grant, name)) return apiError(403, "PERMISSION_DENIED")
    const body = await req.json() as {
      dateRanges?: Array<{ startDate: string; endDate: string }>; dimensions?: Array<{ name: string }>; metrics?: Array<{ name: string }>
      dimensionFilter?: { filter?: { fieldName?: string; stringFilter?: { matchType?: string; value?: string } } }
      keepEmptyRows?: boolean; limit?: number; offset?: number; returnPropertyQuota?: boolean
    }
    const range = body.dateRanges?.[0], dims = (body.dimensions ?? []).map(d => d.name), mets = (body.metrics ?? []).map(m => m.name)
    if (!range || body.dateRanges!.length !== 1 || dims.join(",") !== "date,eventName" || mets.some(m => !["keyEvents", "eventCount"].includes(m))) return apiError(400, "INVALID_ARGUMENT")
    const filter = body.dimensionFilter?.filter
    if (filter?.fieldName !== "eventName" || filter.stringFilter?.matchType !== "EXACT" || !filter.stringFilter.value) return apiError(400, "INVALID_ARGUMENT")
    const event = filter.stringFilter.value
    const days = Object.entries(p.data[event] ?? {}).filter(([d]) => d >= range.startDate && d <= range.endDate).sort(([a], [b]) => a.localeCompare(b))
    const all = days.filter(([, v]) => body.keepEmptyRows || v.keyEvents !== 0 || v.eventCount !== 0)
    const offset = body.offset ?? 0, limit = Math.min(body.limit ?? 10_000, opts.pageSizeCap ?? 250_000)
    const rows = all.slice(offset, offset + limit).map(([d, v]) => ({
      dimensionValues: [{ value: d.replaceAll("-", "") }, { value: event }],
      metricValues: mets.map(m => ({ value: String(m === "keyEvents" ? v.keyEvents : v.eventCount) })),
    }))
    return json(200, {
      dimensionHeaders: dims.map(n => ({ name: n })), metricHeaders: mets.map(n => ({ name: n, type: "TYPE_INTEGER" })),
      ...(rows.length ? { rows } : {}), rowCount: all.length,
      metadata: { currencyCode: "USD", timeZone: p.timeZone, ...(p.flags?.thresholded ? { subjectToThresholding: true } : {}),
        ...(p.flags?.sampled ? { samplingMetadatas: [{ samplesReadCount: "10", samplingSpaceSize: "100" }] } : {}), ...(p.flags?.dataLoss ? { dataLossFromOtherRow: true } : {}) },
      ...(body.returnPropertyQuota ? { propertyQuota: { tokensPerDay: { consumed: 1, remaining: 199_999 }, tokensPerHour: { consumed: 1, remaining: 39_999 } } } : {}),
      kind: "analyticsData#runReport",
    })
  }

  const handle = async (req: Request): Promise<Response> => {
    const url = new URL(req.url)
    calls.push({ method: req.method, path: url.pathname })
    const failure = failures.find(f => f.remaining > 0 && f.path.test(url.pathname))
    if (failure) {
      failure.remaining -= 1
      return failure.code.startsWith("invalid_") ? oauthError(failure.status, failure.code)
        : apiError(failure.status, failure.code, failure.retryAfter === undefined ? {} : { "retry-after": String(failure.retryAfter) })
    }
    if (req.method === "POST" && url.pathname === "/token") return tokenEndpoint(req)
    if (req.method === "POST" && url.pathname === "/revoke") return revokeEndpoint(req)
    const report = /^\/data\/v1beta\/(properties\/[0-9]+):runReport$/.exec(url.pathname)
    const admin = /^\/admin\/v1beta\/(.+)$/.exec(url.pathname)
    if (!report && !admin) return apiError(404, "NOT_FOUND")
    const grant = bearer(req)
    if (grant instanceof Response) return grant
    if (report && req.method === "POST") return runReport(grant, report[1]!, req)
    const path = admin![1]!
    if (req.method !== "GET") return apiError(405, "METHOD_NOT_ALLOWED")
    if (path === "accountSummaries") return accountSummaries(grant, url)
    const keyEvents = /^(properties\/[0-9]+)\/keyEvents$/.exec(path)
    const one = /^(properties\/[0-9]+)$/.exec(path)
    const name = keyEvents?.[1] ?? one?.[1]
    if (!name || !canRead(grant, name)) return apiError(403, "PERMISSION_DENIED")
    const p = property(name)!
    if (keyEvents) return json(200, { keyEvents: p.keyEvents.map((k, i) => ({ name: `${name}/keyEvents/${i + 1}`, eventName: k.eventName, countingMethod: k.countingMethod, custom: true, deletable: true })) })
    return json(200, { name, displayName: p.displayName, timeZone: p.timeZone, currencyCode: "USD", parent: p.account, propertyType: "PROPERTY_TYPE_ORDINARY" })
  }

  const fetchImpl: FetchLike = async (input, init) => {
    if (init.redirect !== "error") throw new Error("fixture: redirects must be refused")
    return handle(new Request(input, init))
  }

  return {
    endpoints,
    fetch: fetchImpl,
    handle,
    calls,
    /** Every token value issued, so tests can prove none of them leaks. */
    issuedTokens: issued,
    /** Google's consent screen: validates the authorization request and returns the callback URL Google would redirect to. */
    consent: (authorizationUrl: string, input: { readonly sub: string; readonly grantScopes?: ReadonlyArray<string>; readonly deny?: boolean }): string => {
      const url = new URL(authorizationUrl)
      if (url.origin + url.pathname !== endpoints.authorize) throw new Error("fixture: wrong authorization endpoint")
      const q = url.searchParams
      const redirectUri = q.get("redirect_uri") ?? ""
      if (q.get("client_id") !== opts.clientId || redirectUri !== opts.redirectUri) throw new Error("fixture: redirect_uri_mismatch")
      if (q.get("response_type") !== "code" || q.get("code_challenge_method") !== "S256" || !q.get("code_challenge") || !q.get("state")) throw new Error("fixture: invalid_request")
      const state = q.get("state")!
      if (input.deny) return `${redirectUri}?error=access_denied&state=${encodeURIComponent(state)}`
      const requested = (q.get("scope") ?? "").split(" ").filter(Boolean)
      const scopes = [...(input.grantScopes ?? requested)].sort()
      const code = token("4/fixture-")
      codes.set(code, { sub: input.sub, challenge: q.get("code_challenge")!, redirectUri, scopes, used: false })
      issued.push(code)
      return `${redirectUri}?state=${encodeURIComponent(state)}&code=${encodeURIComponent(code)}&scope=${encodeURIComponent(scopes.join(" "))}`
    },
    /** The user removes OpenRecord's access in their Google account. */
    revokeIdentity: (sub: string) => { for (const g of grants) if (g.sub === sub) g.revoked = true },
    /** The next `times` requests whose path matches fail with this status and Google status code. */
    failNext: (path: RegExp, status: number, code: string, times = 1, retryAfter?: number) => { failures.push({ path, status, code, remaining: times, ...(retryAfter === undefined ? {} : { retryAfter }) }) },
    advance: (seconds: number) => { clock += seconds * 1000 },
    setDay: (propertyName: string, event: string, day: string, value: FixtureDay) => {
      const p = property(propertyName)!
      p.data[event] = { ...(p.data[event] ?? {}), [day]: value }
    },
    property,
    identity,
    reportCalls: () => calls.filter(c => c.path.endsWith(":runReport")).length,
  }
}
export type FixtureGoogle = ReturnType<typeof fixtureGoogle>

/** Serves the fixture over real loopback HTTP, for built-runtime smoke tests. */
export const serveFixtureGoogle = (fixture: FixtureGoogle, port: number): Promise<Server> => new Promise(resolve => {
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const body = chunks.length ? Buffer.concat(chunks) : undefined
    const response = await fixture.handle(new Request(`${ORIGIN}${req.url}`, { method: req.method ?? "GET", headers: req.headers as Record<string, string>, ...(body && req.method !== "GET" ? { body } : {}) }))
    res.writeHead(response.status, Object.fromEntries(response.headers))
    res.end(Buffer.from(await response.arrayBuffer()))
  })
  server.listen(port, "127.0.0.1", () => resolve(server))
})

/** A configured provider whose every request goes to the fixture. */
export const fixtureGa4Config = (fixture: FixtureGoogle, opts: { readonly clientId: string; readonly clientSecret: string; readonly redirectUri: string; readonly appBaseUrl?: string; readonly keys?: string }): Ga4ProviderConfig => {
  const keys = parseCipherKeys(opts.keys ?? `fixture1:${randomBytes(32).toString("base64")}`)!
  return {
    configured: true,
    oauth: { clientId: opts.clientId, clientSecret: opts.clientSecret, redirectUri: opts.redirectUri, endpoints: fixture.endpoints, fetch: fixture.fetch },
    api: { endpoints: fixture.endpoints, fetch: fixture.fetch },
    cipher: makeTokenCipher(keys),
    appBaseUrl: opts.appBaseUrl ?? "http://localhost:3000",
  }
}
export const fixtureGa4Layer = (config: Ga4ProviderConfig) => Layer.succeed(Ga4Provider, config)
