// W8 GA4 adapter: OAuth request shape, PKCE, identity and scope checks,
// credential encryption, the one report and its strict reading, and provider
// errors without secrets. All against the local fixture: MOCK_ADAPTER_PASS.
import { createHash, randomBytes } from "node:crypto"
import { describe, expect, it } from "vitest"
import { GA4_OAUTH_CALLBACK_PATH, GA4_READONLY_SCOPE, ga4LatestCompleteDay, ga4PropertyMatchesRef, ga4RangeRefusal, ga4ScopesAcceptable } from "@openrecord/contracts"
import {
  Ga4Error, authorizationUrl, exchangeCode, fixtureGoogle, ga4ConfigFromEnv, getProperty, identityFromIdToken, keyEventReportBody, listAccessibleProperties,
  listKeyEvents, makeTokenCipher, observationDigest, observationEvidence, parseActivityReport, parseCipherKeys, parseKeyEventReport, pkceChallenge,
  propertyActivityReportBody, refreshAccessToken,
  revokeToken, runReport, standInEndpoints, validRedirectUri,
} from "../src/index.js"

const CLIENT = { clientId: "fixture-client.apps.googleusercontent.com", clientSecret: "fixture-secret-DO-NOT-LEAK", redirectUri: `https://app.example.test${GA4_OAUTH_CALLBACK_PATH}` }
const P1 = "properties/111111", P2 = "properties/222222", P3 = "properties/333333"
const google = () => fixtureGoogle({
  ...CLIENT,
  identities: [{ sub: "1001", email: "Agency@Example.test", properties: [P1, P2] }, { sub: "2002", email: "other@example.test", properties: [P3] }],
  properties: [
    { name: P1, displayName: "Salon site", account: "accounts/10", accountDisplayName: "Salon", timeZone: "Asia/Makassar", keyEvents: [{ eventName: "book_appointment", countingMethod: "ONCE_PER_EVENT" }],
      data: { book_appointment: { "2026-09-01": { keyEvents: 3, eventCount: 5 }, "2026-09-02": { keyEvents: 0, eventCount: 2 }, "2026-09-04": { keyEvents: 7, eventCount: 7 } },
        page_view: { "2026-09-03": { keyEvents: 0, eventCount: 12 } } } },
    { name: P2, displayName: "Clinic", account: "accounts/20", accountDisplayName: "Clinic", timeZone: "UTC", keyEvents: [], data: {} },
    { name: P3, displayName: "Someone else", account: "accounts/30", accountDisplayName: "Other", timeZone: "UTC", keyEvents: [], data: {} },
  ],
})
const oauth = (g: ReturnType<typeof google>) => ({ ...CLIENT, endpoints: g.endpoints, fetch: g.fetch })
const connect = async (g: ReturnType<typeof google>, sub = "1001", grantScopes?: ReadonlyArray<string>) => {
  const state = "s".repeat(43), verifier = randomBytes(32).toString("base64url")
  const callback = new URL(g.consent(authorizationUrl(oauth(g), { state, codeVerifier: verifier }), { sub, ...(grantScopes ? { grantScopes } : {}) }))
  return { tokens: await exchangeCode(oauth(g), callback.searchParams.get("code")!, verifier), callback, verifier }
}

describe("OAuth authorization request", () => {
  it("asks for the minimum read-only scopes with state, PKCE S256, offline access and the exact redirect URI", () => {
    const g = google()
    const url = new URL(authorizationUrl(oauth(g), { state: "abc", codeVerifier: "v".repeat(43) }))
    const q = url.searchParams
    expect(q.get("scope")).toBe(`openid email ${GA4_READONLY_SCOPE}`)
    expect(q.get("scope")).not.toMatch(/analytics\.edit|analytics\.manage|auth\/analytics( |$)/)
    expect(q.get("code_challenge_method")).toBe("S256")
    expect(q.get("code_challenge")).toBe(createHash("sha256").update("v".repeat(43)).digest("base64url"))
    expect(q.get("state")).toBe("abc")
    expect(q.get("access_type")).toBe("offline")
    expect(q.get("redirect_uri")).toBe(CLIENT.redirectUri)
    expect(q.get("include_granted_scopes")).toBeNull()
    expect(url.toString()).not.toContain(CLIENT.clientSecret)
  })
  it("accepts only OpenRecord's exact callback on https or loopback http", () => {
    expect(validRedirectUri(CLIENT.redirectUri)).toBe(true)
    expect(validRedirectUri(`http://localhost:3000${GA4_OAUTH_CALLBACK_PATH}`)).toBe(true)
    for (const bad of [`http://app.example.test${GA4_OAUTH_CALLBACK_PATH}`, `https://app.example.test${GA4_OAUTH_CALLBACK_PATH}/`, `https://app.example.test${GA4_OAUTH_CALLBACK_PATH}?x=1`,
      `https://user:pw@app.example.test${GA4_OAUTH_CALLBACK_PATH}`, "https://app.example.test/elsewhere", "not a url"]) expect(validRedirectUri(bad), bad).toBe(false)
  })
  it("is disabled, not guessed, when configuration is missing or invalid", () => {
    const key = randomBytes(32).toString("base64")
    const base = { GOOGLE_OAUTH_CLIENT_ID: "id", GOOGLE_OAUTH_CLIENT_SECRET: "secret", GA4_OAUTH_REDIRECT_URI: CLIENT.redirectUri, GA4_TOKEN_ENCRYPTION_KEYS: `k1:${key}` }
    expect(ga4ConfigFromEnv(base).configured).toBe(true)
    expect(ga4ConfigFromEnv({ ...base, GOOGLE_OAUTH_CLIENT_SECRET: "" })).toEqual({ configured: false, reason: "MISSING_CLIENT" })
    expect(ga4ConfigFromEnv({ ...base, GA4_OAUTH_REDIRECT_URI: "https://evil.test/cb" })).toEqual({ configured: false, reason: "INVALID_REDIRECT_URI" })
    expect(ga4ConfigFromEnv({ ...base, GA4_TOKEN_ENCRYPTION_KEYS: "k1:short" })).toEqual({ configured: false, reason: "MISSING_ENCRYPTION_KEY" })
    expect(ga4ConfigFromEnv({ ...base, GA4_PROVIDER_STAND_IN_URL: "https://googleapis.evil.test" })).toEqual({ configured: false, reason: "INVALID_STAND_IN" })
    expect(standInEndpoints("http://127.0.0.1:4555")?.token).toBe("http://127.0.0.1:4555/token")
  })
})

describe("token exchange, identity and scopes", () => {
  it("exchanges a code only with the matching PKCE verifier and redirect URI, once", async () => {
    const g = google()
    const { tokens, callback } = await connect(g)
    expect(tokens.refreshToken).toMatch(/^1\/\/fixture-/)
    expect(tokens.grantedScopes).toEqual(["email", GA4_READONLY_SCOPE, "openid"].sort())
    // Single use.
    await expect(exchangeCode(oauth(g), callback.searchParams.get("code")!, "x".repeat(43))).rejects.toMatchObject({ kind: "AUTH", providerCode: "invalid_grant" })
    // Wrong verifier.
    const state = "t".repeat(43), verifier = "a".repeat(43)
    const second = new URL(g.consent(authorizationUrl(oauth(g), { state, codeVerifier: verifier }), { sub: "1001" }))
    await expect(exchangeCode(oauth(g), second.searchParams.get("code")!, "b".repeat(43))).rejects.toMatchObject({ kind: "AUTH" })
    // Different redirect URI at exchange.
    const third = new URL(g.consent(authorizationUrl(oauth(g), { state, codeVerifier: verifier }), { sub: "1001" }))
    await expect(exchangeCode({ ...oauth(g), redirectUri: "https://app.example.test/other" }, third.searchParams.get("code")!, verifier)).rejects.toBeInstanceOf(Ga4Error)
  })
  it("reads the authorizing identity only from an ID token for this client that has not expired", async () => {
    const g = google()
    const { tokens } = await connect(g)
    expect(identityFromIdToken(tokens.idToken, CLIENT.clientId)).toEqual({ subject: "1001", email: "agency@example.test" })
    expect(identityFromIdToken(tokens.idToken, "another-client")).toBeNull()
    expect(identityFromIdToken(tokens.idToken, CLIENT.clientId, Date.now() + 2 * 3_600_000)).toBeNull()
    expect(identityFromIdToken(null, CLIENT.clientId)).toBeNull()
    const forged = (claims: Record<string, unknown>) => `x.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.y`
    expect(identityFromIdToken(forged({ iss: "https://evil.test", aud: CLIENT.clientId, sub: "1", email: "a@b.c", email_verified: true, exp: 9e9 }), CLIENT.clientId)).toBeNull()
    expect(identityFromIdToken(forged({ iss: "accounts.google.com", aud: CLIENT.clientId, sub: "1", email: "a@b.c", email_verified: false, exp: 9e9 }), CLIENT.clientId)).toBeNull()
  })
  it("accepts read-only Analytics and refuses broader or missing Analytics scopes", () => {
    expect(ga4ScopesAcceptable(["openid", "email", GA4_READONLY_SCOPE])).toBe(true)
    expect(ga4ScopesAcceptable(["openid", "email"])).toBe(false)
    expect(ga4ScopesAcceptable(["openid", "email", GA4_READONLY_SCOPE, "https://www.googleapis.com/auth/analytics.edit"])).toBe(false)
    expect(ga4ScopesAcceptable([GA4_READONLY_SCOPE, "https://www.googleapis.com/auth/analytics"])).toBe(false)
  })
  it("refreshes, and reports a revoked grant as an authorization failure", async () => {
    const g = google()
    const { tokens } = await connect(g)
    const refreshed = await refreshAccessToken(oauth(g), tokens.refreshToken!)
    expect(refreshed.accessToken).not.toBe(tokens.accessToken)
    expect(await revokeToken(oauth(g), tokens.refreshToken!)).toBe("CONFIRMED")
    await expect(refreshAccessToken(oauth(g), tokens.refreshToken!)).rejects.toMatchObject({ kind: "AUTH", providerCode: "invalid_grant" })
    await expect(listAccessibleProperties({ endpoints: g.endpoints, fetch: g.fetch }, refreshed.accessToken)).rejects.toMatchObject({ kind: "AUTH", status: 401 })
    // Revoking an already revoked token is still a revoked grant.
    expect(await revokeToken(oauth(g), tokens.refreshToken!)).toBe("CONFIRMED")
  })
})

describe("Admin API reads", () => {
  it("lists only the properties the authorized identity can read, and their key events", async () => {
    const g = google()
    const api = { endpoints: g.endpoints, fetch: g.fetch }
    const { tokens } = await connect(g)
    const listed = await listAccessibleProperties(api, tokens.accessToken)
    expect(listed.properties.map(p => p.property).sort()).toEqual([P1, P2])
    expect(listed.truncated).toBe(false)
    expect(await getProperty(api, tokens.accessToken, P1)).toMatchObject({ timeZone: "Asia/Makassar", displayName: "Salon site", account: "accounts/10" })
    expect(await listKeyEvents(api, tokens.accessToken, P1)).toEqual([{ eventName: "book_appointment", countingMethod: "ONCE_PER_EVENT" }])
    await expect(getProperty(api, tokens.accessToken, P3)).rejects.toMatchObject({ kind: "FORBIDDEN", providerCode: "PERMISSION_DENIED" })
  })
  it("never follows a redirect and maps quota, outage and rejection without provider text", async () => {
    const g = google()
    const api = { endpoints: g.endpoints, fetch: g.fetch }
    const { tokens } = await connect(g)
    g.failNext(/runReport/, 429, "RESOURCE_EXHAUSTED", 1, 120)
    const req = { property: P1, eventName: "book_appointment", dateStart: "2026-09-01", dateEnd: "2026-09-05" }
    await expect(runReport(api, tokens.accessToken, P1, keyEventReportBody(req))).rejects.toMatchObject({ kind: "QUOTA", retryAfterSeconds: 120 })
    g.failNext(/runReport/, 503, "UNAVAILABLE")
    await expect(runReport(api, tokens.accessToken, P1, keyEventReportBody(req))).rejects.toMatchObject({ kind: "UNAVAILABLE" })
    g.failNext(/runReport/, 400, "INVALID_ARGUMENT")
    const error = await runReport(api, tokens.accessToken, P1, keyEventReportBody(req)).catch(e => e as Ga4Error)
    expect(error).toMatchObject({ kind: "INVALID", providerCode: "INVALID_ARGUMENT" })
    expect(`${(error as Ga4Error).message} ${JSON.stringify(error)}`).not.toContain("fixture INVALID_ARGUMENT")
    expect(JSON.stringify(error)).not.toContain(tokens.accessToken)
  })
})

describe("the key-event report", () => {
  const req = { property: P1, eventName: "book_appointment", dateStart: "2026-09-01", dateEnd: "2026-09-05" }
  it("asks for keyEvents and eventCount by date for exactly the selected event, keeping empty rows", () => {
    const body = keyEventReportBody(req)
    expect(body.metrics.map(m => m.name)).toEqual(["keyEvents", "eventCount"])
    expect(body.dimensions.map(d => d.name)).toEqual(["date", "eventName"])
    expect(body.dimensionFilter.filter).toEqual({ fieldName: "eventName", stringFilter: { matchType: "EXACT", value: "book_appointment", caseSensitive: true } })
    expect(body.keepEmptyRows).toBe(true)
  })
  it("reads key events (not event counts) per day, keeps explicit zeros and never fabricates absent days", async () => {
    const g = google()
    const { tokens } = await connect(g)
    const { json } = await runReport({ endpoints: g.endpoints, fetch: g.fetch }, tokens.accessToken, P1, keyEventReportBody(req))
    const parsed = parseKeyEventReport(json, req, "Asia/Makassar")
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.page.rows).toEqual([
      { day: "2026-09-01", keyEvents: 3, eventCount: 5 }, { day: "2026-09-02", keyEvents: 0, eventCount: 2 }, { day: "2026-09-04", keyEvents: 7, eventCount: 7 },
    ])
    // 2026-09-03 and 2026-09-05: no row, so no value. Never zero.
    expect(parsed.page.rows.map(r => r.day)).not.toContain("2026-09-03")
    expect(parsed.page.quota).not.toBeNull()
    // The metric is found by header name, not column position.
    const swapped = JSON.parse(JSON.stringify(json)) as { metricHeaders: Array<{ name: string }>; rows: Array<{ metricValues: Array<{ value: string }> }> }
    swapped.metricHeaders.reverse(); for (const r of swapped.rows) r.metricValues.reverse()
    expect((parseKeyEventReport(swapped, req, "Asia/Makassar") as { page: { rows: unknown } }).page.rows).toEqual(parsed.page.rows)
  })
  it("refuses a different time zone, sampled data, '(other)' data loss, foreign events, out-of-range or duplicate days and non-integers", () => {
    const ok = { dimensionHeaders: [{ name: "date" }, { name: "eventName" }], metricHeaders: [{ name: "keyEvents" }, { name: "eventCount" }], rowCount: 1,
      rows: [{ dimensionValues: [{ value: "20260901" }, { value: "book_appointment" }], metricValues: [{ value: "3" }, { value: "4" }] }], metadata: { timeZone: "UTC" } }
    expect(parseKeyEventReport(ok, req, "UTC").ok).toBe(true)
    expect(parseKeyEventReport(ok, req, "Asia/Makassar")).toEqual({ ok: false, reason: "PROPERTY_TIME_ZONE_CHANGED" })
    expect(parseKeyEventReport({ ...ok, metadata: { timeZone: "UTC", samplingMetadatas: [{}] } }, req, "UTC")).toEqual({ ok: false, reason: "RESPONSE_SAMPLED" })
    expect(parseKeyEventReport({ ...ok, metadata: { timeZone: "UTC", dataLossFromOtherRow: true } }, req, "UTC")).toEqual({ ok: false, reason: "RESPONSE_DATA_LOSS" })
    const row = (date: string, event: string, key: string) => ({ ...ok, rows: [{ dimensionValues: [{ value: date }, { value: event }], metricValues: [{ value: key }, { value: "1" }] }] })
    expect(parseKeyEventReport(row("20260901", "purchase", "1"), req, "UTC").ok).toBe(false)
    expect(parseKeyEventReport(row("20260830", "book_appointment", "1"), req, "UTC").ok).toBe(false)
    expect(parseKeyEventReport(row("20260901", "book_appointment", "1.5"), req, "UTC").ok).toBe(false)
    expect(parseKeyEventReport(row("20260901", "book_appointment", "-1"), req, "UTC").ok).toBe(false)
    expect(parseKeyEventReport(row("20260931", "book_appointment", "1"), req, "UTC").ok).toBe(false)
    expect(parseKeyEventReport({ ...ok, rows: [...ok.rows, ...ok.rows] }, req, "UTC").ok).toBe(false)
  })
  it("gives identical answers to the identical question the same digest, and a revision a different one", () => {
    const page = (n: number) => ({ rows: [{ day: "2026-09-01", keyEvents: n, eventCount: n }], rowCount: 1, timeZone: "UTC", currencyCode: "USD", subjectToThresholding: false, emptyReason: null, quota: { tokensPerDay: { consumed: n } } })
    expect(observationDigest(observationEvidence(req, [page(3)]))).toBe(observationDigest(observationEvidence(req, [{ ...page(3), quota: null }])))
    expect(observationDigest(observationEvidence(req, [page(3)]))).not.toBe(observationDigest(observationEvidence(req, [page(4)])))
  })
})

describe("the property-activity report and derived zeros", () => {
  const req = { property: P1, eventName: "book_appointment", dateStart: "2026-09-01", dateEnd: "2026-09-05" }
  it("asks for eventCount by date with no filter, keeping empty rows", () => {
    const body = propertyActivityReportBody(req)
    expect(body.dimensions.map(d => d.name)).toEqual(["date"])
    expect(body.metrics.map(m => m.name)).toEqual(["eventCount"])
    expect("dimensionFilter" in body).toBe(false)
    expect(body.keepEmptyRows).toBe(true)
  })
  it("reads property-wide activity only for days Google recorded data, and never guesses the rest", async () => {
    const g = google()
    const { tokens } = await connect(g)
    const { json } = await runReport({ endpoints: g.endpoints, fetch: g.fetch }, tokens.accessToken, P1, propertyActivityReportBody(req))
    const parsed = parseActivityReport(json, req, "Asia/Makassar")
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    // Recorded activity: 09-01/02/04 from the key event, 09-03 from page_view; 09-05 has no data at all.
    expect(parsed.page.rows).toEqual([
      { day: "2026-09-01", eventCount: 5 }, { day: "2026-09-02", eventCount: 2 },
      { day: "2026-09-03", eventCount: 12 }, { day: "2026-09-04", eventCount: 7 },
    ])
    expect(parsed.page.subjectToThresholding).toBe(false)
  })
  it("refuses a different time zone, sampled data, '(other)' data loss, out-of-range or duplicate days and non-integers", () => {
    const ok = { dimensionHeaders: [{ name: "date" }], metricHeaders: [{ name: "eventCount" }], rowCount: 1,
      rows: [{ dimensionValues: [{ value: "20260901" }], metricValues: [{ value: "12" }] }], metadata: { timeZone: "UTC" } }
    expect(parseActivityReport(ok, req, "UTC").ok).toBe(true)
    expect(parseActivityReport(ok, req, "Asia/Makassar")).toEqual({ ok: false, reason: "PROPERTY_TIME_ZONE_CHANGED" })
    expect(parseActivityReport({ ...ok, metadata: { timeZone: "UTC", samplingMetadatas: [{}] } }, req, "UTC")).toEqual({ ok: false, reason: "RESPONSE_SAMPLED" })
    expect(parseActivityReport({ ...ok, metadata: { timeZone: "UTC", dataLossFromOtherRow: true } }, req, "UTC")).toEqual({ ok: false, reason: "RESPONSE_DATA_LOSS" })
    expect(parseActivityReport({ ...ok, rows: [{ dimensionValues: [{ value: "20260906" }], metricValues: [{ value: "1" }] }] }, req, "UTC").ok).toBe(false)
    expect(parseActivityReport({ ...ok, rows: [{ dimensionValues: [{ value: "20260901" }], metricValues: [{ value: "-1" }] }] }, req, "UTC").ok).toBe(false)
    expect(parseActivityReport({ ...ok, rows: [{ dimensionValues: [{ value: "20260901" }], metricValues: [{ value: "1.5" }] }] }, req, "UTC").ok).toBe(false)
    expect(parseActivityReport({ ...ok, rows: [...ok.rows, ...ok.rows] }, req, "UTC").ok).toBe(false)
  })
  it("derives a zero only for an absent day with proven recorded activity, and keeps a silent day absent", () => {
    const filtered = [{ rows: [{ day: "2026-09-01", keyEvents: 3, eventCount: 5 }, { day: "2026-09-02", keyEvents: 0, eventCount: 2 }], rowCount: 2, timeZone: "Asia/Makassar", currencyCode: "USD", subjectToThresholding: false, emptyReason: null, quota: null }]
    const activity = { rows: [{ day: "2026-09-01", eventCount: 5 }, { day: "2026-09-02", eventCount: 2 }, { day: "2026-09-03", eventCount: 12 }], skipped: null }
    const evidence = observationEvidence(req, filtered, activity)
    expect(evidence.response.derivedZeroDays).toEqual(["2026-09-03"])
    expect(evidence.response.activity?.rows.map(r => r.day)).toEqual(["2026-09-01", "2026-09-02", "2026-09-03"])
    // No probe, or a skipped one, never derives: the days stay absent.
    expect(observationEvidence(req, filtered).response.derivedZeroDays).toBeUndefined()
    const skipped = observationEvidence(req, filtered, { rows: [], skipped: "SAMPLED" })
    expect(skipped.response.derivedZeroDays).toBeUndefined()
    expect(skipped.response.activitySkipped).toBe("SAMPLED")
    // A thresholded filtered report can hide rows: its absences are not evidence of anything.
    const thresholded = filtered.map(p => ({ ...p, subjectToThresholding: true }))
    const fromThresholded = observationEvidence(req, thresholded, activity)
    expect(fromThresholded.response.derivedZeroDays).toBeUndefined()
    expect(fromThresholded.response.activity?.rows.length).toBe(3)
    // A day the property recorded nothing about stays absent even with a clean probe.
    const quiet = observationEvidence(req, filtered, { rows: [{ day: "2026-09-01", eventCount: 5 }], skipped: null })
    expect(quiet.response.derivedZeroDays).toBeUndefined()
  })
})

describe("credential encryption at rest", () => {
  const cipher = makeTokenCipher(parseCipherKeys(`k2:${randomBytes(32).toString("base64")}`)!)
  it("round-trips, never contains the plaintext, and is bound to its connection and purpose", () => {
    const secret = "1//refresh-token-value"
    const sealed = cipher.encrypt(secret, "conn-1:refresh")
    expect(sealed.startsWith("v1.k2.")).toBe(true)
    expect(sealed).not.toContain(secret)
    expect(cipher.decrypt(sealed, "conn-1:refresh")).toBe(secret)
    expect(cipher.decrypt(sealed, "conn-2:refresh")).toBeNull()
    expect(cipher.decrypt(sealed, "conn-1:access")).toBeNull()
    const tampered = sealed.slice(0, -3) + (sealed.endsWith("AAA") ? "BBB" : "AAA")
    expect(cipher.decrypt(tampered, "conn-1:refresh")).toBeNull()
    expect(cipher.encrypt(secret, "conn-1:refresh")).not.toBe(sealed)
  })
  it("decrypts with a previous key after rotation and refuses unknown keys", () => {
    const oldKey = randomBytes(32).toString("base64"), newKey = randomBytes(32).toString("base64")
    const before = makeTokenCipher(parseCipherKeys(`old:${oldKey}`)!)
    const sealed = before.encrypt("token", "c:refresh")
    const rotated = makeTokenCipher(parseCipherKeys(`new:${newKey},old:${oldKey}`)!)
    expect(rotated.decrypt(sealed, "c:refresh")).toBe("token")
    expect(rotated.encrypt("token", "c:refresh").startsWith("v1.new.")).toBe(true)
    expect(makeTokenCipher(parseCipherKeys(`new:${newKey}`)!).decrypt(sealed, "c:refresh")).toBeNull()
    expect(parseCipherKeys("a:x,a:y")).toBeNull()
  })
})

describe("contract helpers", () => {
  it("only synchronizes complete days in the property's own time zone, at most 366 per request", () => {
    // 2026-10-21T20:00Z is already 2026-10-22 in Makassar (UTC+8).
    const at = Date.parse("2026-10-21T20:00:00Z")
    expect(ga4LatestCompleteDay(at, "Asia/Makassar")).toBe("2026-10-21")
    expect(ga4LatestCompleteDay(at, "America/Los_Angeles")).toBe("2026-10-20")
    expect(ga4RangeRefusal("2026-10-01", "2026-10-21", "2026-10-21")).toBeNull()
    expect(ga4RangeRefusal("2026-10-01", "2026-10-22", "2026-10-21")).toBe("RangeNotComplete")
    expect(ga4RangeRefusal("2025-01-01", "2026-10-01", "2026-10-21")).toBe("SyncRangeTooLarge")
    expect(ga4RangeRefusal("2026-10-05", "2026-10-01", "2026-10-21")).toBe("InvalidDateRange")
    expect(ga4RangeRefusal("2026-02-30", "2026-03-01", "2026-10-21")).toBe("InvalidDateRange")
  })
  it("matches a property written as a resource name or a bare id", () => {
    expect(ga4PropertyMatchesRef("properties/123", "properties/123")).toBe(true)
    expect(ga4PropertyMatchesRef("properties/123", "123")).toBe(true)
    expect(ga4PropertyMatchesRef("properties/123", "1234")).toBe(false)
    expect(ga4PropertyMatchesRef("properties/123", "TEST property")).toBe(false)
    expect(ga4PropertyMatchesRef("properties/123", null)).toBe(false)
  })
  it("PKCE challenge is the base64url SHA-256 of the verifier", () => {
    expect(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
  })
})
