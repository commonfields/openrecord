// Deployment configuration for ad platform connections, all from server
// environment. Each platform is on only when its credentials are present; a
// missing or invalid value turns that platform off rather than guessing.
//
//   ADS_OAUTH_REDIRECT_URI         https://<api>/api/ads/oauth/callback, registered with Meta and Google
//   ADS_TOKEN_ENCRYPTION_KEYS      like GA4_TOKEN_ENCRYPTION_KEYS (used when this is absent)
//   META_APP_ID, META_APP_SECRET   a Meta app with Facebook Login and the ads_read permission
//   META_GRAPH_VERSION             default v23.0
//   GOOGLE_OAUTH_CLIENT_ID/SECRET  the Google client GA4 uses
//   GOOGLE_ADS_DEVELOPER_TOKEN     from the Google Ads API Center of a manager account
//   GOOGLE_ADS_API_VERSION         default v21
//   ADS_PROVIDER_STAND_IN_URL      loopback stand-in for tests only
import { Context, Layer } from "effect"
import { AD_OAUTH_CALLBACK_PATH, type AdProvider } from "@openrecord/contracts"
import { GOOGLE_ENDPOINTS, makeTokenCipher, parseCipherKeys, standInEndpoints, type Ga4OAuthConfig, type TokenCipher } from "@openrecord/ga4"
import { GOOGLE_ADS_ENDPOINT, type GoogleAdsConfig } from "./google-ads.js"
import { META_ENDPOINTS, type MetaConfig } from "./meta.js"
import type { FetchLike } from "./http.js"

export type AdsUnavailable = "MISSING_REDIRECT_URI" | "MISSING_ENCRYPTION_KEY" | "MISSING_APP" | "MISSING_DEVELOPER_TOKEN"
export interface AdsConfig {
  readonly cipher: TokenCipher | null
  readonly appBaseUrl: string
  readonly meta: { readonly configured: true; readonly config: MetaConfig } | { readonly configured: false; readonly reason: AdsUnavailable }
  readonly googleAds: { readonly configured: true; readonly config: GoogleAdsConfig; readonly oauth: Ga4OAuthConfig } | { readonly configured: false; readonly reason: AdsUnavailable }
}
export class AdsProvider extends Context.Tag("AdsProvider")<AdsProvider, AdsConfig>() {}
export const adsConfigured = (c: AdsConfig, provider: AdProvider) => (provider === "meta" ? c.meta : c.googleAds).configured

const validRedirect = (raw: string) => {
  try {
    const u = new URL(raw)
    if (u.username || u.password || u.search || u.hash || u.pathname !== AD_OAUTH_CALLBACK_PATH) return false
    return u.protocol === "https:" || (u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname))
  } catch { return false }
}
const VERSION = /^v\d{1,3}(\.\d{1,2})?$/

export const adsConfigFromEnv = (env: Record<string, string | undefined> = process.env, fetchImpl: FetchLike = fetch): AdsConfig => {
  const v = (k: string) => env[k]?.trim() ?? ""
  const keys = parseCipherKeys(env["ADS_TOKEN_ENCRYPTION_KEYS"] || env["GA4_TOKEN_ENCRYPTION_KEYS"])
  const cipher = keys ? makeTokenCipher(keys) : null
  const redirectUri = v("ADS_OAUTH_REDIRECT_URI")
  const appBaseUrl = new URL(v("APP_BASE_URL") || "http://localhost:3000").origin
  const common: AdsUnavailable | null = !validRedirect(redirectUri) ? "MISSING_REDIRECT_URI" : !cipher ? "MISSING_ENCRYPTION_KEY" : null
  // A stand-in replaces every platform host with one loopback origin.
  const standIn = v("ADS_PROVIDER_STAND_IN_URL")
  const local = standIn ? standInEndpoints(standIn) : null
  const origin = local ? new URL(standIn).origin : null

  const metaVersion = VERSION.test(v("META_GRAPH_VERSION")) ? v("META_GRAPH_VERSION") : "v23.0"
  const meta: AdsConfig["meta"] = common ? { configured: false, reason: common }
    : !v("META_APP_ID") || !v("META_APP_SECRET") ? { configured: false, reason: "MISSING_APP" }
    : { configured: true, config: { appId: v("META_APP_ID"), appSecret: v("META_APP_SECRET"), redirectUri, version: metaVersion,
        endpoints: origin ? { dialog: `${origin}/meta`, graph: `${origin}/graph` } : META_ENDPOINTS, fetch: fetchImpl } }

  const googleVersion = VERSION.test(v("GOOGLE_ADS_API_VERSION")) ? v("GOOGLE_ADS_API_VERSION") : "v21"
  const endpoints = local ?? GOOGLE_ENDPOINTS
  const googleAds: AdsConfig["googleAds"] = common ? { configured: false, reason: common }
    : !v("GOOGLE_OAUTH_CLIENT_ID") || !v("GOOGLE_OAUTH_CLIENT_SECRET") ? { configured: false, reason: "MISSING_APP" }
    : !v("GOOGLE_ADS_DEVELOPER_TOKEN") ? { configured: false, reason: "MISSING_DEVELOPER_TOKEN" }
    : { configured: true,
        config: { developerToken: v("GOOGLE_ADS_DEVELOPER_TOKEN"), version: googleVersion, endpoint: origin ? `${origin}/googleads` : GOOGLE_ADS_ENDPOINT, authorize: endpoints.authorize, fetch: fetchImpl },
        oauth: { clientId: v("GOOGLE_OAUTH_CLIENT_ID"), clientSecret: v("GOOGLE_OAUTH_CLIENT_SECRET"), redirectUri, endpoints, fetch: fetchImpl } }
  return { cipher, appBaseUrl, meta, googleAds }
}

export const AdsProviderLive = Layer.sync(AdsProvider, () => adsConfigFromEnv())
