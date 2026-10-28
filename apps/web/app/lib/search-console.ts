// Search Console client: status, the sites a Google connection can read, the
// site bound to a business, and live performance. Numbers come from Google
// Search only; they say nothing about AI answers, and a change between two
// periods is not proof of what caused it.
import type { SearchConsoleBinding, SearchPerformance, SearchPerformanceDays } from "@openrecord/contracts"
import { api, ApiError } from "./api"

const base = (id: string) => `/api/growth/clients/${encodeURIComponent(id)}/search-console`
export type SearchConsoleConnection = { id: string; googleEmail: string; status: "ACTIVE" | "REAUTHORIZATION_REQUIRED"; searchConsole: boolean }
export type SearchConsoleSiteChoice = { siteUrl: string; permissionLevel: string; matchesWebsite: boolean }
export const SearchConsole = {
  status: (businessId: string) => api<{ configured: boolean; binding: SearchConsoleBinding | null; connections: SearchConsoleConnection[] }>(base(businessId)),
  sites: (businessId: string, connectionId: string) => api<{ sites: SearchConsoleSiteChoice[] }>(`${base(businessId)}/sites?connectionId=${encodeURIComponent(connectionId)}`),
  bind: (businessId: string, connectionId: string, siteUrl: string) =>
    api<{ binding: SearchConsoleBinding }>(`${base(businessId)}/binding`, { method: "POST", body: JSON.stringify({ connectionId, siteUrl }) }),
  unbind: (businessId: string) => api<{ binding: null }>(`${base(businessId)}/binding/end`, { method: "POST", body: "{}" }),
  performance: (businessId: string, days: SearchPerformanceDays) => api<{ performance: SearchPerformance }>(`${base(businessId)}/performance?days=${days}`),
  /** Starts Google consent for Analytics and Search Console together, returning to Channels. */
  connect: (businessId: string, connectionId: string | null = null) =>
    api<{ authorizationUrl: string }>("/api/growth/ga4/connect", { method: "POST", body: JSON.stringify({ businessId, connectionId, returnTo: "CHANNELS" }) }),
}

/** A Search Console property in plain words: domain properties cover every subdomain. */
export const siteLabel = (siteUrl: string) => siteUrl.startsWith("sc-domain:") ? `${siteUrl.slice("sc-domain:".length)} (whole domain)` : siteUrl

export const searchConsoleError = (err: unknown): string => {
  if (!(err instanceof ApiError)) return "The request failed. Try again."
  const reason = typeof err.body["reason"] === "string" ? err.body["reason"] : ""
  const copy: Record<string, string> = {
    Ga4NotConfigured: "Google sign-in is not configured on this server.",
    Ga4ReauthorizationRequired: "Google no longer accepts this connection. Reconnect it to continue.",
    SearchConsoleScopeMissing: "This Google connection was made without Search Console access. Reconnect and allow it.",
    SiteNotAccessible: "The connected Google account cannot read that Search Console site.",
    PropertyNotAccessible: "The connected Google account can no longer read this Search Console site.",
    SearchConsoleNotBound: "No Search Console site is chosen for this business yet.",
    ProviderQuota: "Google's quota is used up for now. Try again later.",
    ProviderUnavailable: "Google Search Console did not answer. Try again later.",
  }
  return copy[reason] ?? `The request was refused (${reason || err.tag}).`
}

/** The Google callback's status word on the Channels page. */
export const GOOGLE_CALLBACK_COPY: Record<string, { ok: boolean; text: string }> = {
  connected: { ok: true, text: "Google is connected with read-only access. Choose the Search Console site for this business." },
  reconnected: { ok: true, text: "Google is reconnected." },
  consent_denied: { ok: false, text: "Access was not granted in Google, so nothing was connected." },
  scope_refused: { ok: false, text: "Google granted different permissions than read-only access, so OpenRecord did not keep them. Try again and allow the requested access." },
  identity_mismatch: { ok: false, text: "That is a different Google account than the one this connection belongs to." },
  no_refresh_token: { ok: false, text: "Google did not issue long-lived access. Remove OpenRecord from the Google account's third-party access and connect again." },
  token_exchange_failed: { ok: false, text: "Google did not complete the connection. Try again." },
  state_expired: { ok: false, text: "The connection took longer than ten minutes. Start it again." },
}
