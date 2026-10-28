// W8 authenticated measurement contracts: one read-only Google Analytics 4
// connection per authorized Google identity and account, an explicit binding of
// one GA4 property and one key event to one immutable W0 metric definition,
// and durable synchronization jobs that record daily key-event counts as W3
// imports with their own provenance (AUTHENTICATED_PROVIDER_API).
//
// Three things stay apart:
//   the connection   who authorized read access (a Google identity), not who owns a property
//   the binding      which property and key event measure which business metric
//   the observation  what the provider reported for which days, when, with which digest
// No token, client secret or authorization code ever appears in these shapes.
import { Schema } from "effect"
import { GrowthIsoDay } from "./growth-measurement.js"

/** The only Analytics scope OpenRecord requests. `openid email` identify the authorizing Google account. */
export const GA4_READONLY_SCOPE = "https://www.googleapis.com/auth/analytics.readonly"
/** Read-only Search Console access (search performance). Requested with Analytics in one Google connection. */
export const SEARCH_CONSOLE_READONLY_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly"
export const GA4_OAUTH_SCOPES: ReadonlyArray<string> = ["openid", "email", GA4_READONLY_SCOPE, SEARCH_CONSOLE_READONLY_SCOPE]
/** Any granted scope outside this set (for example `analytics.edit`) is refused: OpenRecord never holds write access to analytics configuration. */
export const GA4_ACCEPTED_SCOPES: ReadonlyArray<string> = [
  "openid", "email", GA4_READONLY_SCOPE, SEARCH_CONSOLE_READONLY_SCOPE,
  "https://www.googleapis.com/auth/userinfo.email",
]
/** Exact callback path. The configured redirect URI must end with it. */
export const GA4_OAUTH_CALLBACK_PATH = "/api/growth/ga4/oauth/callback"
/** One sync request reads at most this many days (W3 imports are bounded to 366 days). */
export const GA4_SYNC_MAX_DAYS = 366
/** Days a scheduled sync re-reads, ending yesterday in the property time zone, so recent revisions are captured. */
export const GA4_REFRESH_DAYS = 3
/** A binding whose last successful sync is older than this is stale. */
export const GA4_STALE_AFTER_HOURS = 36
/** The provider metric a binding reads. Key events, not raw event counts: W3 GA4 definitions measure key events. */
export const GA4_PROVIDER_METRIC = "keyEvents"

export const Ga4ConnectionStatus = Schema.Literal("ACTIVE", "REAUTHORIZATION_REQUIRED", "DISCONNECTED")
export type Ga4ConnectionStatus = typeof Ga4ConnectionStatus.Type
export const Ga4SyncKind = Schema.Literal("BACKFILL", "REFRESH", "SCHEDULED")
export type Ga4SyncKind = typeof Ga4SyncKind.Type
export const Ga4JobStatus = Schema.Literal("QUEUED", "CLAIMED", "SUCCEEDED", "FAILED", "CANCELLED")
export type Ga4JobStatus = typeof Ga4JobStatus.Type
/** One attempt's outcome. `RECORDED` stored a new observation; `UNCHANGED` confirmed the latest one. */
export const Ga4RunOutcome = Schema.Literal("RECORDED", "UNCHANGED", "RETRYING", "FAILED")
export type Ga4RunOutcome = typeof Ga4RunOutcome.Type
export const Ga4Freshness = Schema.Literal("NEVER_SYNCED", "FRESH", "STALE")
export type Ga4Freshness = typeof Ga4Freshness.Type

/** Stable failure codes. Plain-language copy lives in the web client. */
export const GA4_SYNC_ERROR_CODES = [
  "AUTHORIZATION_REVOKED", "CONNECTION_NOT_ACTIVE", "BINDING_INACTIVE", "PROPERTY_ACCESS_LOST", "PROPERTY_TIME_ZONE_CHANGED",
  "KEY_EVENT_NOT_CONFIGURED", "QUOTA_EXHAUSTED", "PROVIDER_UNAVAILABLE", "PROVIDER_REJECTED", "RESPONSE_SAMPLED",
  "RESPONSE_DATA_LOSS", "RESPONSE_UNEXPECTED", "NOT_CONFIGURED", "RANGE_NOT_COMPLETE",
] as const
export type Ga4SyncErrorCode = typeof GA4_SYNC_ERROR_CODES[number]

/** GA4 resource names. A property is always `properties/<digits>`. */
export const Ga4PropertyName = Schema.String.pipe(Schema.pattern(/^properties\/[0-9]{1,20}$/))
export const Ga4EventName = Schema.String.pipe(Schema.pattern(/^[A-Za-z][A-Za-z0-9_]{0,39}$/))

export const StartGa4Connection = Schema.Struct({
  /** Where the operator returns after Google: a business the session can reach. */
  businessId: Schema.UUID,
  /** Re-authorize an existing connection (must belong to the account and the same Google identity). */
  connectionId: Schema.optional(Schema.NullOr(Schema.UUID)),
  /** Which page the operator returns to after Google. Defaults to measurement. */
  returnTo: Schema.optional(Schema.Literal("MEASUREMENT", "CHANNELS")),
})
export type StartGa4Connection = typeof StartGa4Connection.Type
export const BindGa4Property = Schema.Struct({
  connectionId: Schema.UUID,
  property: Ga4PropertyName,
  metricDefinitionId: Schema.UUID,
  eventName: Ga4EventName,
  idempotencyKey: Schema.UUID,
})
export type BindGa4Property = typeof BindGa4Property.Type
export const RequestGa4Sync = Schema.Struct({
  kind: Schema.Literal("BACKFILL", "REFRESH"),
  dateStart: GrowthIsoDay,
  dateEnd: GrowthIsoDay,
  idempotencyKey: Schema.UUID,
})
export type RequestGa4Sync = typeof RequestGa4Sync.Type
export const DisconnectGa4 = Schema.Struct({ idempotencyKey: Schema.UUID })

export interface Ga4Connection {
  readonly id: string
  readonly accountId: string
  /** The Google account that authorized read access. It is not proof of property ownership. */
  readonly googleEmail: string
  readonly grantedScopes: ReadonlyArray<string>
  readonly status: Ga4ConnectionStatus
  readonly statusReason: string | null
  readonly connectedByUserId: string
  readonly createdAt: string
  readonly lastAuthorizedAt: string
  readonly disconnectedAt: string | null
  /** True when Google confirmed revocation at disconnect; false when it could not be confirmed (credentials are erased either way). */
  readonly revocationConfirmed: boolean | null
}
export interface Ga4PropertyChoice {
  readonly property: string
  readonly displayName: string
  readonly account: string
  readonly accountDisplayName: string
  readonly propertyType: string
}
export interface Ga4KeyEventChoice {
  readonly eventName: string
  readonly countingMethod: string | null
}
export interface Ga4Binding {
  readonly id: string
  readonly businessId: string
  readonly connectionId: string
  readonly property: string
  readonly propertyDisplayName: string
  readonly propertyTimeZone: string
  readonly metricDefinitionId: string
  readonly metricDefinitionVersion: number
  readonly eventName: string
  readonly providerMetric: typeof GA4_PROVIDER_METRIC
  readonly keyEventCountingMethod: string | null
  readonly createdByUserId: string
  readonly createdAt: string
}
export interface Ga4SyncJob {
  readonly id: string
  readonly bindingId: string
  readonly kind: Ga4SyncKind
  readonly dateStart: string
  readonly dateEnd: string
  readonly status: Ga4JobStatus
  readonly attemptCount: number
  readonly lastError: string | null
  readonly notBefore: string
  readonly createdAt: string
  readonly updatedAt: string
}
export interface Ga4SyncRun {
  readonly id: string
  readonly jobId: string
  readonly attempt: number
  readonly outcome: Ga4RunOutcome
  readonly errorCode: string | null
  readonly importId: string | null
  readonly responseDigest: string | null
  readonly daysReported: number | null
  readonly finishedAt: string
}
export interface Ga4BindingHealth {
  readonly binding: Ga4Binding
  readonly connectionStatus: Ga4ConnectionStatus
  readonly connectionEmail: string
  readonly freshness: Ga4Freshness
  readonly lastSuccessfulSyncAt: string | null
  readonly lastAttemptAt: string | null
  readonly lastErrorCode: string | null
  readonly openJob: Ga4SyncJob | null
  /** Newest complete day the property time zone allows a sync to read. */
  readonly latestCompleteDay: string
  /** Over the last 28 complete days: what the resolved W3 series shows. */
  readonly coverage: {
    readonly start: string; readonly end: string; readonly days: number
    readonly reported: number; readonly missing: number; readonly unavailable: number; readonly conflicting: number; readonly revised: number
  }
  readonly recentJobs: ReadonlyArray<Ga4SyncJob>
  readonly recentRuns: ReadonlyArray<Ga4SyncRun>
}
/** Provider identity attached to a W5 report source. No Google identity or token is included: reports can be shared. */
export interface Ga4ObservationRef {
  readonly provider: "GA4_DATA_API"
  readonly connectionId: string
  readonly bindingId: string
  readonly property: string
  readonly eventName: string
  readonly providerMetric: typeof GA4_PROVIDER_METRIC
  readonly timeZone: string
  readonly requestedStart: string
  readonly requestedEnd: string
  readonly observedStart: string | null
  readonly observedEnd: string | null
  readonly collectedAt: string
  readonly responseDigest: string
  readonly supersedesImportId: string | null
  readonly subjectToThresholding: boolean
}

/** Calendar day an instant falls on in an IANA time zone. */
export const ga4LocalDay = (instantMs: number, timeZone: string): string => {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(instantMs))
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? ""
  return `${get("year")}-${get("month")}-${get("day")}`
}
export const ga4ShiftDay = (day: string, days: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)
/** The newest day whose data is complete: yesterday in the property's own time zone. Today is never synchronized. */
export const ga4LatestCompleteDay = (nowMs: number, timeZone: string): string => ga4ShiftDay(ga4LocalDay(nowMs, timeZone), -1)
export const ga4DaySpan = (start: string, end: string): number => Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000) + 1
const realDay = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(Date.parse(`${d}T00:00:00Z`)).toISOString().slice(0, 10) === d
/** Why a requested range cannot be synchronized, or null when it can. */
export const ga4RangeRefusal = (start: string, end: string, latestComplete: string): "InvalidDateRange" | "SyncRangeTooLarge" | "RangeNotComplete" | null => {
  if (!realDay(start) || !realDay(end) || start > end) return "InvalidDateRange"
  if (ga4DaySpan(start, end) > GA4_SYNC_MAX_DAYS) return "SyncRangeTooLarge"
  if (end > latestComplete) return "RangeNotComplete"
  return null
}
/** GA4 property ids may be written `properties/123` or `123` in a W0 definition; both name the same property. */
export const ga4PropertyMatchesRef = (property: string, propertyRef: string | null): boolean => {
  if (propertyRef === null) return false
  const ref = propertyRef.trim()
  return ref === property || `properties/${ref}` === property
}
/** True when the granted scopes include read-only Analytics and nothing broader. */
/** Google lets a person grant only some requested scopes: either read scope is enough, and nothing broader is accepted. */
export const ga4ScopesAcceptable = (granted: ReadonlyArray<string>): boolean =>
  (granted.includes(GA4_READONLY_SCOPE) || granted.includes(SEARCH_CONSOLE_READONLY_SCOPE)) && granted.every(s => GA4_ACCEPTED_SCOPES.includes(s))
export const hasSearchConsoleScope = (granted: ReadonlyArray<string>): boolean => granted.includes(SEARCH_CONSOLE_READONLY_SCOPE)
