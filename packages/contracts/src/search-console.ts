// Read-only Google Search Console. One site (a Search Console property) is
// bound to one business, through a Google connection that granted the
// webmasters.readonly scope. Performance is read live from Search Console for
// a requested window; OpenRecord stores the binding, not the numbers.
//
// What Search Console reports is Google's own measurement of Google Search:
// clicks, impressions, click-through rate and average position. It says nothing
// about AI answers or other search engines, and a change in it is not proof
// that any one piece of work caused it.
import { Schema } from "effect"

/** `sc-domain:example.com` (domain property) or a URL-prefix property, which Search Console always ends with `/`. */
export const SearchConsoleSiteUrl = Schema.String.pipe(
  Schema.maxLength(2048),
  Schema.pattern(/^(sc-domain:[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?|https?:\/\/[^\s/?#]+(?:\/[^\s?#]*)?\/)$/),
)
export const BindSearchConsoleSite = Schema.Struct({ connectionId: Schema.UUID, siteUrl: SearchConsoleSiteUrl })
export type BindSearchConsoleSite = typeof BindSearchConsoleSite.Type

export interface SearchConsoleSite {
  readonly siteUrl: string
  /** siteOwner, siteFullUser or siteRestrictedUser. Unverified sites are never listed. */
  readonly permissionLevel: string
}
export interface SearchConsoleBinding {
  readonly id: string
  readonly businessId: string
  readonly connectionId: string
  readonly siteUrl: string
  readonly permissionLevel: string
  readonly createdByUserId: string
  readonly createdAt: string
}

export const SEARCH_PERFORMANCE_DAYS = [7, 28, 90] as const
export type SearchPerformanceDays = typeof SEARCH_PERFORMANCE_DAYS[number]
/** Search Console data lags; the window ends this many days before today (UTC) so it is complete. */
export const SEARCH_CONSOLE_LAG_DAYS = 3
export const SEARCH_PERFORMANCE_ROWS = 10

export interface SearchTotals { readonly clicks: number; readonly impressions: number; readonly ctr: number; readonly position: number | null }
export interface SearchPerformanceRow extends SearchTotals { readonly key: string }
export interface SearchWindow { readonly start: string; readonly end: string }
export interface SearchPerformance {
  readonly siteUrl: string
  readonly days: SearchPerformanceDays
  readonly current: SearchWindow & { readonly totals: SearchTotals }
  readonly previous: SearchWindow & { readonly totals: SearchTotals }
  readonly topQueries: ReadonlyArray<SearchPerformanceRow>
  readonly topPages: ReadonlyArray<SearchPerformanceRow>
  readonly collectedAt: string
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10)
const DAY_MS = 86_400_000
/** The requested window and the one before it, both complete and of equal length. */
export const searchConsoleWindows = (nowMs: number, days: SearchPerformanceDays): { readonly current: SearchWindow; readonly previous: SearchWindow } => {
  const today = Date.UTC(new Date(nowMs).getUTCFullYear(), new Date(nowMs).getUTCMonth(), new Date(nowMs).getUTCDate())
  const end = today - SEARCH_CONSOLE_LAG_DAYS * DAY_MS
  const start = end - (days - 1) * DAY_MS
  const prevEnd = start - DAY_MS
  return { current: { start: day(start), end: day(end) }, previous: { start: day(prevEnd - (days - 1) * DAY_MS), end: day(prevEnd) } }
}
/** Whether a site belongs to a website host: a domain property covers subdomains, a URL prefix must match the host. */
export const searchConsoleSiteMatchesHost = (siteUrl: string, host: string): boolean => {
  const h = host.toLowerCase().replace(/^www\./, "")
  if (siteUrl.startsWith("sc-domain:")) {
    const domain = siteUrl.slice("sc-domain:".length)
    return h === domain || h.endsWith(`.${domain}`)
  }
  try { return new URL(siteUrl).hostname.toLowerCase().replace(/^www\./, "") === h } catch { return false }
}
