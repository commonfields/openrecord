// Google OAuth 2.0 authorization-code flow for a confidential web client:
// state (CSRF), PKCE S256, exact redirect URI, offline access for a refresh
// token, and the minimum scopes (openid email analytics.readonly). The ID
// token is read only for the authorizing identity (sub, email); it comes
// directly from Google's token endpoint over TLS, and its issuer, audience
// and expiry are still checked.
import { createHash, randomBytes } from "node:crypto"
import { GA4_OAUTH_SCOPES } from "@openrecord/contracts"
import { Ga4Error } from "./errors.js"
import { parseJson, send, unexpected, type FetchLike, type Ga4Endpoints } from "./http.js"

export interface Ga4OAuthConfig {
  readonly clientId: string
  readonly clientSecret: string
  readonly redirectUri: string
  readonly endpoints: Ga4Endpoints
  readonly fetch: FetchLike
}
export interface Ga4TokenSet {
  readonly accessToken: string
  readonly accessTokenExpiresAt: number
  readonly refreshToken: string | null
  readonly grantedScopes: ReadonlyArray<string>
  readonly idToken: string | null
}
export interface Ga4Identity { readonly subject: string; readonly email: string }

const b64url = (buffer: Buffer) => buffer.toString("base64url")
/** 32 random bytes: the state sent to Google and the verifier kept server-side. */
export const newOAuthSecret = (): string => b64url(randomBytes(32))
export const pkceChallenge = (verifier: string): string => b64url(createHash("sha256").update(verifier, "ascii").digest())
export const sha256Hex = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex")

export const authorizationUrl = (config: Pick<Ga4OAuthConfig, "clientId" | "redirectUri" | "endpoints">, input: { readonly state: string; readonly codeVerifier: string; readonly loginHint?: string | null }): string => {
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: GA4_OAUTH_SCOPES.join(" "),
    access_type: "offline",
    // Consent each time: a re-authorization must yield a fresh refresh token.
    prompt: "consent",
    state: input.state,
    code_challenge: pkceChallenge(input.codeVerifier),
    code_challenge_method: "S256",
  })
  if (input.loginHint) params.set("login_hint", input.loginHint)
  return `${config.endpoints.authorize}?${params.toString()}`
}

const tokenSet = (raw: unknown, now: number): Ga4TokenSet => {
  const body = raw as Record<string, unknown>
  const accessToken = body["access_token"], expiresIn = Number(body["expires_in"])
  if (typeof accessToken !== "string" || !accessToken || !Number.isFinite(expiresIn) || expiresIn <= 0) throw unexpected()
  const refresh = body["refresh_token"]
  const scope = typeof body["scope"] === "string" ? body["scope"] : ""
  return {
    accessToken, accessTokenExpiresAt: now + expiresIn * 1000,
    refreshToken: typeof refresh === "string" && refresh ? refresh : null,
    grantedScopes: scope.split(/\s+/).filter(Boolean).sort(),
    idToken: typeof body["id_token"] === "string" ? body["id_token"] : null,
  }
}
const form = (values: Record<string, string>) => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
  body: new URLSearchParams(values).toString(),
})

export const exchangeCode = async (config: Ga4OAuthConfig, code: string, codeVerifier: string, now = Date.now()): Promise<Ga4TokenSet> => {
  const result = await send(config.fetch, config.endpoints.token, form({
    client_id: config.clientId, client_secret: config.clientSecret, code, code_verifier: codeVerifier,
    grant_type: "authorization_code", redirect_uri: config.redirectUri,
  }))
  return tokenSet(parseJson(result.text), now)
}

/** `invalid_grant` means the refresh token was revoked or expired: the connection needs re-authorization. */
export const refreshAccessToken = async (config: Ga4OAuthConfig, refreshToken: string, now = Date.now()): Promise<Ga4TokenSet> => {
  const result = await send(config.fetch, config.endpoints.token, form({
    client_id: config.clientId, client_secret: config.clientSecret, refresh_token: refreshToken, grant_type: "refresh_token",
  }))
  return tokenSet(parseJson(result.text), now)
}

/** Revokes the grant at Google. 200 confirms; a 400 means the token was already invalid, which is also a revoked grant. */
export const revokeToken = async (config: Ga4OAuthConfig, token: string): Promise<"CONFIRMED" | "UNCONFIRMED"> => {
  try {
    await send(config.fetch, config.endpoints.revoke, form({ token }))
    return "CONFIRMED"
  } catch (e) {
    if (e instanceof Ga4Error && e.status === 400) return "CONFIRMED"
    return "UNCONFIRMED"
  }
}

const ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"])
/** The authorizing Google identity, or null when the ID token is not for this client, expired, or unverified. */
export const identityFromIdToken = (idToken: string | null, clientId: string, now = Date.now()): Ga4Identity | null => {
  if (!idToken) return null
  const parts = idToken.split(".")
  if (parts.length !== 3) return null
  let claims: Record<string, unknown>
  try { claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as Record<string, unknown> } catch { return null }
  const aud = claims["aud"], exp = Number(claims["exp"]), sub = claims["sub"], email = claims["email"]
  const audOk = aud === clientId || (Array.isArray(aud) && aud.length === 1 && aud[0] === clientId)
  if (!ISSUERS.has(String(claims["iss"])) || !audOk || !Number.isFinite(exp) || exp * 1000 <= now) return null
  if (typeof sub !== "string" || !/^[0-9A-Za-z_-]{1,255}$/.test(sub)) return null
  if (typeof email !== "string" || email.length > 320 || !email.includes("@") || claims["email_verified"] !== true) return null
  return { subject: sub, email: email.toLowerCase() }
}
