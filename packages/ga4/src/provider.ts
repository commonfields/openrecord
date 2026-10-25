// Deployment configuration for the GA4 connection. Everything comes from
// server environment; nothing is hardcoded and nothing reaches the browser
// except the authorization URL. A missing or invalid value disables the
// feature (routes answer Ga4NotConfigured) rather than guessing.
import { Context, Layer } from "effect"
import { GA4_OAUTH_CALLBACK_PATH } from "@openrecord/contracts"
import { makeTokenCipher, parseCipherKeys, type TokenCipher } from "./cipher.js"
import { GOOGLE_ENDPOINTS, standInEndpoints, type FetchLike, type Ga4Endpoints } from "./http.js"
import type { Ga4OAuthConfig } from "./oauth.js"
import type { Ga4ApiConfig } from "./api.js"

export type Ga4NotConfiguredReason = "MISSING_CLIENT" | "INVALID_REDIRECT_URI" | "MISSING_ENCRYPTION_KEY" | "INVALID_STAND_IN"
export type Ga4ProviderConfig =
  | { readonly configured: false; readonly reason: Ga4NotConfiguredReason }
  | {
    readonly configured: true
    readonly oauth: Ga4OAuthConfig
    readonly api: Ga4ApiConfig
    readonly cipher: TokenCipher
    /** Where the operator lands after the callback, e.g. https://app.example. */
    readonly appBaseUrl: string
  }
export class Ga4Provider extends Context.Tag("Ga4Provider")<Ga4Provider, Ga4ProviderConfig>() {}

/** The redirect URI must be exactly OpenRecord's callback on https (or loopback http for local development). */
export const validRedirectUri = (raw: string): boolean => {
  let url: URL
  try { url = new URL(raw) } catch { return false }
  if (url.username || url.password || url.search || url.hash || url.pathname !== GA4_OAUTH_CALLBACK_PATH) return false
  if (url.protocol === "https:") return true
  return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
}

export const ga4ConfigFromEnv = (env: Record<string, string | undefined> = process.env, fetchImpl: FetchLike = fetch): Ga4ProviderConfig => {
  const clientId = env["GOOGLE_OAUTH_CLIENT_ID"]?.trim() ?? "", clientSecret = env["GOOGLE_OAUTH_CLIENT_SECRET"]?.trim() ?? ""
  const redirectUri = env["GA4_OAUTH_REDIRECT_URI"]?.trim() ?? ""
  if (!clientId || !clientSecret) return { configured: false, reason: "MISSING_CLIENT" }
  if (!validRedirectUri(redirectUri)) return { configured: false, reason: "INVALID_REDIRECT_URI" }
  const keys = parseCipherKeys(env["GA4_TOKEN_ENCRYPTION_KEYS"])
  if (!keys) return { configured: false, reason: "MISSING_ENCRYPTION_KEY" }
  let endpoints: Ga4Endpoints = GOOGLE_ENDPOINTS
  const standIn = env["GA4_PROVIDER_STAND_IN_URL"]?.trim()
  if (standIn) {
    const local = standInEndpoints(standIn)
    if (!local) return { configured: false, reason: "INVALID_STAND_IN" }
    endpoints = local
  }
  const appBaseUrl = new URL(env["APP_BASE_URL"]?.trim() || "http://localhost:3000").origin
  return {
    configured: true,
    oauth: { clientId, clientSecret, redirectUri, endpoints, fetch: fetchImpl },
    api: { endpoints, fetch: fetchImpl },
    cipher: makeTokenCipher(keys),
    appBaseUrl,
  }
}

export const Ga4ProviderLive = Layer.sync(Ga4Provider, () => ga4ConfigFromEnv())
