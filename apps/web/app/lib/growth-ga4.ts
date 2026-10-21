// W8 GA4 measurement client: operator API calls and the plain-language words
// for connection, binding and synchronization states. A connection says who
// allowed read access; it never says the property belongs to anyone. A sync
// says what Google reported and when; it never says anything about impact.
import type { Ga4Binding, Ga4BindingHealth, Ga4Connection, Ga4ConnectionStatus, Ga4Freshness, Ga4KeyEventChoice, Ga4PropertyChoice, Ga4SyncJob } from "@openrecord/contracts"
import { api, ApiError } from "./api"

const client = (id: string) => `/api/growth/clients/${encodeURIComponent(id)}/ga4`
export const Ga4 = {
  connections: () => api<{ configured: boolean; notConfiguredReason?: string; connections: Ga4Connection[] }>("/api/growth/ga4/connections"),
  connect: (businessId: string, connectionId: string | null = null) =>
    api<{ authorizationUrl: string }>("/api/growth/ga4/connect", { method: "POST", body: JSON.stringify({ businessId, connectionId }) }),
  properties: (connectionId: string) => api<{ properties: Ga4PropertyChoice[]; truncated: boolean }>(`/api/growth/ga4/connections/${encodeURIComponent(connectionId)}/properties`),
  keyEvents: (connectionId: string, property: string) =>
    api<{ keyEvents: Ga4KeyEventChoice[] }>(`/api/growth/ga4/connections/${encodeURIComponent(connectionId)}/properties/${encodeURIComponent(property.replace(/^properties\//, ""))}/key-events`),
  disconnect: (connectionId: string) =>
    api<{ connection: Ga4Connection }>(`/api/growth/ga4/connections/${encodeURIComponent(connectionId)}/disconnect`, { method: "POST", body: JSON.stringify({ idempotencyKey: crypto.randomUUID() }) }),
  bindings: (businessId: string) => api<{ bindings: Array<Ga4Binding & { active: boolean }>; health: Ga4BindingHealth[] }>(`${client(businessId)}/bindings`),
  bind: (businessId: string, input: { connectionId: string; property: string; metricDefinitionId: string; eventName: string }, idempotencyKey: string) =>
    api<{ binding: Ga4Binding; replayed: boolean }>(`${client(businessId)}/bindings`, { method: "POST", body: JSON.stringify({ ...input, idempotencyKey }) }),
  sync: (businessId: string, bindingId: string, input: { kind: "BACKFILL" | "REFRESH"; dateStart: string; dateEnd: string }, idempotencyKey: string) =>
    api<{ job: Ga4SyncJob; replayed: boolean }>(`${client(businessId)}/bindings/${encodeURIComponent(bindingId)}/sync`, { method: "POST", body: JSON.stringify({ ...input, idempotencyKey }) }),
}

export const GA4_CONNECTION_COPY: Record<Ga4ConnectionStatus, { title: string; detail: string }> = {
  ACTIVE: { title: "Connected (read-only)", detail: "OpenRecord can read reports from the Google Analytics properties this Google account can see. It cannot change anything in Google Analytics." },
  REAUTHORIZATION_REQUIRED: { title: "Needs reconnecting", detail: "Google no longer accepts this connection, so synchronization has stopped. Figures already collected are kept. Reconnect with the same Google account to continue." },
  DISCONNECTED: { title: "Disconnected", detail: "OpenRecord's access was removed and its stored credentials were erased. Figures already collected are kept." },
}
export const GA4_FRESHNESS_COPY: Record<Ga4Freshness, string> = {
  NEVER_SYNCED: "Not synchronized yet",
  FRESH: "Up to date",
  STALE: "Out of date: the last successful synchronization is more than a day and a half old",
}
/** Why a synchronization stopped, in operator language. */
export const GA4_SYNC_ERROR_COPY: Record<string, string> = {
  AUTHORIZATION_REVOKED: "Google stopped accepting the connection. Reconnect Google Analytics; collected figures are kept.",
  CONNECTION_NOT_ACTIVE: "The connection is not active, so nothing was read.",
  BINDING_INACTIVE: "This property link was replaced, or the person who created it left the account.",
  PROPERTY_ACCESS_LOST: "The connected Google account can no longer read this property.",
  PROPERTY_TIME_ZONE_CHANGED: "The property's reporting time zone changed and no longer matches the metric definition. Days would be counted differently, so nothing was recorded.",
  KEY_EVENT_NOT_CONFIGURED: "The event is no longer marked as a key event in Google Analytics, so its key-event count would not mean the same thing.",
  QUOTA_EXHAUSTED: "Google's reporting quota for this property was used up. OpenRecord waits and tries again later.",
  PROVIDER_UNAVAILABLE: "Google Analytics did not answer. OpenRecord waits and tries again later.",
  PROVIDER_REJECTED: "Google Analytics refused the request.",
  RESPONSE_SAMPLED: "Google returned sampled (estimated) figures, which are not exact daily counts, so nothing was recorded.",
  RESPONSE_DATA_LOSS: "Google grouped some figures into an \"(other)\" row, so exact daily counts were not available.",
  RESPONSE_UNEXPECTED: "Google's answer did not match what was asked, so nothing was recorded.",
  RANGE_NOT_COMPLETE: "Only complete days (up to yesterday in the property's time zone) can be synchronized.",
  NOT_CONFIGURED: "Google Analytics access is not configured on this server.",
}
/** The status word the OAuth callback puts on the URL. */
export const GA4_CALLBACK_COPY: Record<string, { ok: boolean; text: string }> = {
  connected: { ok: true, text: "Google Analytics is connected with read-only access." },
  reconnected: { ok: true, text: "Google Analytics is reconnected. Synchronization can continue." },
  consent_denied: { ok: false, text: "Access was not granted in Google, so nothing was connected." },
  scope_refused: { ok: false, text: "Google granted different permissions than read-only Analytics access, so OpenRecord did not keep them. Try again and allow the requested read-only access." },
  identity_mismatch: { ok: false, text: "That is a different Google account than the one this connection belongs to. Connect it as a new connection instead." },
  identity_unverified: { ok: false, text: "Google did not confirm the account's identity, so nothing was connected." },
  no_refresh_token: { ok: false, text: "Google did not issue long-lived access. Remove OpenRecord from the Google account's third-party access and connect again." },
  token_exchange_failed: { ok: false, text: "Google did not complete the connection. Try again." },
  state_invalid: { ok: false, text: "That sign-in link was not started from this session, so it was ignored. Start the connection again." },
  state_expired: { ok: false, text: "The connection took longer than ten minutes. Start it again." },
  state_reused: { ok: false, text: "That sign-in link was already used. Start the connection again." },
  not_configured: { ok: false, text: "Google Analytics access is not configured on this server." },
}
export const ga4Error = (err: unknown): string => {
  if (!(err instanceof ApiError)) return "The request failed. Try again."
  const reason = typeof err.body["reason"] === "string" ? err.body["reason"] : ""
  const copy: Record<string, string> = {
    Ga4NotConfigured: "Google Analytics access is not configured on this server.",
    Ga4ReauthorizationRequired: "Google no longer accepts this connection. Reconnect it to continue.",
    Ga4ConnectionNotActive: "The connection is not active.",
    PropertyNotAccessible: "The connected Google account cannot read that property.",
    PropertyDiffersFromDefinition: "That property is not the one named in the metric definition. Bind the property the definition names.",
    KeyEventDiffersFromDefinition: "That event is not the one the metric definition counts.",
    PropertyTimeZoneDiffersFromDefinition: "The property reports in a different time zone than the metric definition, so days would not line up.",
    KeyEventNotConfigured: "That event is not marked as a key event in this Google Analytics property.",
    MetricDefinitionNotGa4: "Only Google Analytics key-event count metrics can be linked to a property.",
    SyncAlreadyOpen: "A synchronization for this property is already queued or running.",
    RangeNotComplete: "Only complete days, up to yesterday in the property's time zone, can be synchronized.",
    SyncRangeTooLarge: "One synchronization covers at most 366 days.",
    InvalidDateRange: "The start date must be on or before the end date.",
    BindingInactive: "This property link was replaced by a newer one.",
    ProviderQuota: "Google's reporting quota is used up for now. Try again later.",
    ProviderUnavailable: "Google Analytics did not answer. Try again later.",
    IdempotencyConflict: "This request no longer matches what was sent. Reload and try again.",
  }
  return copy[reason] ?? `The request was refused (${reason || err.tag}).`
}
export const ga4CoverageLine = (h: Ga4BindingHealth): string => {
  const c = h.coverage
  const parts = [`${c.reported} of ${c.days} days reported`]
  if (c.missing) parts.push(`${c.missing} missing (Google reported no figure; not counted as zero)`)
  if (c.unavailable) parts.push(`${c.unavailable} not yet synchronized`)
  if (c.conflicting) parts.push(`${c.conflicting} conflicting with an uploaded file`)
  if (c.revised) parts.push(`${c.revised} revised by Google since first collected`)
  return `${c.start} to ${c.end}: ${parts.join("; ")}.`
}
