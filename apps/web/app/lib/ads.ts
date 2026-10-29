// Ad account client: which platforms this server can connect, the account's
// sign-ins, the ad accounts bound to a business, and live performance.
// Read-only: OpenRecord cannot create, change or pause an ad.
import type { AdAccountPerformance, AdBinding, AdConnection, AdPerformanceDays, AdProvider } from "@openrecord/contracts"
import { api, ApiError } from "./api"

export type AdPlatformStatus = { configured: true } | { configured: false; reason: "MISSING_REDIRECT_URI" | "MISSING_ENCRYPTION_KEY" | "MISSING_APP" | "MISSING_DEVELOPER_TOKEN" }
export type AdAccountChoice = { externalId: string; name: string; currency: string | null; active: boolean }
export type AdPerformanceResult = { accounts: AdAccountPerformance[]; failures: Array<{ provider: AdProvider; accountName: string; reason: string }> }
const client = (id: string) => `/api/ads/clients/${encodeURIComponent(id)}`

export const Ads = {
  status: (businessId: string) => api<{ providers: Record<AdProvider, AdPlatformStatus>; connections: AdConnection[]; bindings: AdBinding[] }>(client(businessId)),
  connect: (businessId: string, provider: AdProvider) => api<{ authorizationUrl: string }>("/api/ads/connect", { method: "POST", body: JSON.stringify({ provider, businessId }) }),
  accounts: (connectionId: string) => api<{ accounts: AdAccountChoice[] }>(`/api/ads/connections/${encodeURIComponent(connectionId)}/accounts`),
  bind: (businessId: string, connectionId: string, externalId: string) =>
    api<{ binding: AdBinding }>(`${client(businessId)}/bindings`, { method: "POST", body: JSON.stringify({ connectionId, externalId }) }),
  unbind: (businessId: string, bindingId: string) => api<{ ended: true }>(`${client(businessId)}/bindings/${encodeURIComponent(bindingId)}/end`, { method: "POST", body: "{}" }),
  disconnect: (connectionId: string) => api<{ disconnected: true }>(`/api/ads/connections/${encodeURIComponent(connectionId)}/disconnect`, { method: "POST", body: "{}" }),
  performance: (businessId: string, days: AdPerformanceDays) => api<AdPerformanceResult>(`${client(businessId)}/performance?days=${days}`),
}

/** Why a platform can't be connected yet, for the person running the server. */
export const SETUP_NEEDED: Record<AdProvider, Record<string, string>> = {
  meta: {
    MISSING_APP: "Needs a Meta app with Facebook Login and the ads_read permission (META_APP_ID and META_APP_SECRET).",
    MISSING_REDIRECT_URI: "Needs ADS_OAUTH_REDIRECT_URI, registered in the Meta app.",
    MISSING_ENCRYPTION_KEY: "Needs a token encryption key (ADS_TOKEN_ENCRYPTION_KEYS).",
  },
  google_ads: {
    MISSING_APP: "Needs the Google sign-in client (GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET).",
    MISSING_DEVELOPER_TOKEN: "Needs a Google Ads developer token (GOOGLE_ADS_DEVELOPER_TOKEN) from a manager account's API Center.",
    MISSING_REDIRECT_URI: "Needs ADS_OAUTH_REDIRECT_URI, added to the Google client's redirect URIs.",
    MISSING_ENCRYPTION_KEY: "Needs a token encryption key (ADS_TOKEN_ENCRYPTION_KEYS).",
  },
}

export const adsError = (err: unknown): string => {
  if (!(err instanceof ApiError)) return "The request failed. Try again."
  const reason = typeof err.body["reason"] === "string" ? err.body["reason"] : ""
  const copy: Record<string, string> = {
    AdsNotConfigured: "This ad platform isn't set up on this server yet.",
    AdsReauthorizationRequired: "The sign-in expired or was removed. Reconnect to continue.",
    AdAccountNotAccessible: "The signed-in person can't read that ad account.",
    ProviderQuota: "The platform's rate limit was reached. Try again in a few minutes.",
    ProviderUnavailable: "The ad platform didn't answer. Try again later.",
    ProviderRejected: "The ad platform refused the request.",
  }
  return copy[reason] ?? `The request was refused (${reason || err.tag}).`
}

/** The callback's status word on the Channels page. */
export const ADS_CALLBACK_COPY: Record<string, { ok: boolean; text: string }> = {
  connected: { ok: true, text: "Connected with read-only access. Choose the ad account for this business." },
  consent_denied: { ok: false, text: "Access wasn't granted, so nothing was connected." },
  scope_refused: { ok: false, text: "The platform granted more than read-only access, so OpenRecord didn't keep it. Try again and allow only the requested access." },
  token_exchange_failed: { ok: false, text: "The platform didn't complete the sign-in. Try again." },
  identity_unverified: { ok: false, text: "OpenRecord couldn't confirm who signed in. Try again." },
  state_invalid: { ok: false, text: "The sign-in link expired or was already used. Start again." },
  failed: { ok: false, text: "The connection didn't finish. Try again." },
}
