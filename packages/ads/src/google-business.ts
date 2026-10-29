// Google Business Profile, read-only: the locations a sign-in manages, their
// daily performance (calls, website clicks, direction requests, bookings,
// messages and how often the profile was shown in Search and Maps), the
// search terms people used to find them, and their reviews. Google offers one
// scope for Business Profile (business.manage), which could edit a profile or
// reply to reviews; this module only issues GET requests.
import { pkceChallenge } from "@openrecord/ga4"
import type { SearchWindow } from "@openrecord/contracts"
import { unexpected } from "./errors.js"
import { amount, send, text, type FetchLike } from "./http.js"

export const GOOGLE_BUSINESS_SCOPE = "https://www.googleapis.com/auth/business.manage"
export const GOOGLE_BUSINESS_SCOPES = ["openid", "email", GOOGLE_BUSINESS_SCOPE] as const
export const GOOGLE_BUSINESS_ACCEPTED_SCOPES: ReadonlyArray<string> = [...GOOGLE_BUSINESS_SCOPES, "https://www.googleapis.com/auth/userinfo.email"]
export interface GoogleBusinessConfig {
  readonly authorize: string
  readonly endpoints: { readonly accounts: string; readonly information: string; readonly performance: string; readonly reviews: string }
  readonly fetch: FetchLike
}
export const GOOGLE_BUSINESS_ENDPOINTS = {
  accounts: "https://mybusinessaccountmanagement.googleapis.com/v1",
  information: "https://mybusinessbusinessinformation.googleapis.com/v1",
  performance: "https://businessprofileperformance.googleapis.com/v1",
  reviews: "https://mybusiness.googleapis.com/v4",
}

export const googleBusinessAuthorizationUrl = (c: Pick<GoogleBusinessConfig, "authorize">, client: { clientId: string; redirectUri: string }, state: string, verifier: string) =>
  `${c.authorize}?${new URLSearchParams({
    client_id: client.clientId, redirect_uri: client.redirectUri, response_type: "code", scope: GOOGLE_BUSINESS_SCOPES.join(" "),
    access_type: "offline", prompt: "consent", state, code_challenge: pkceChallenge(verifier), code_challenge_method: "S256",
  })}`

const get = (c: GoogleBusinessConfig, token: string, url: string) => send(c.fetch, url, { method: "GET", headers: { authorization: `Bearer ${token}`, accept: "application/json" } })
const idOf = (name: unknown, prefix: string) => { const s = text(name, 80); return s.startsWith(prefix) && /^\d{1,30}$/.test(s.slice(prefix.length)) ? s.slice(prefix.length) : null }

/** A location this sign-in can read, with the account it belongs to. */
export interface BusinessLocation { readonly locationId: string; readonly accountId: string; readonly name: string; readonly address: string | null; readonly website: string | null }

export const googleBusinessLocations = async (c: GoogleBusinessConfig, token: string): Promise<ReadonlyArray<BusinessLocation>> => {
  const accounts = await get(c, token, `${c.endpoints.accounts}/accounts?pageSize=20`) as { accounts?: Array<Record<string, unknown>> }
  const out: BusinessLocation[] = []
  for (const a of (accounts.accounts ?? []).slice(0, 20)) {
    const accountId = idOf(a["name"], "accounts/")
    if (!accountId) continue
    let pageToken = ""
    for (let page = 0; page < 5; page++) {
      const body = await get(c, token, `${c.endpoints.information}/accounts/${accountId}/locations?${new URLSearchParams({
        readMask: "name,title,storefrontAddress,websiteUri", pageSize: "100", ...(pageToken ? { pageToken } : {}) })}`) as { locations?: Array<Record<string, unknown>>; nextPageToken?: unknown }
      for (const l of body.locations ?? []) {
        const locationId = idOf(l["name"], "locations/")
        if (!locationId) continue
        const addr = (l["storefrontAddress"] ?? {}) as Record<string, unknown>
        const address = [...(Array.isArray(addr["addressLines"]) ? addr["addressLines"].slice(0, 1) : []), addr["locality"]].map(v => text(v, 100)).filter(Boolean).join(", ") || null
        out.push({ locationId, accountId, name: text(l["title"], 200) || `Location ${locationId}`, address, website: text(l["websiteUri"], 300) || null })
      }
      if (typeof body.nextPageToken !== "string" || !body.nextPageToken) break
      pageToken = body.nextPageToken
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

export interface LocalTotals {
  readonly calls: number
  readonly websiteClicks: number
  readonly directionRequests: number
  readonly bookings: number
  readonly conversations: number
  /** Times the profile was shown on Google Search and Maps, desktop and mobile. */
  readonly impressions: number
  readonly searchImpressions: number
  readonly mapsImpressions: number
}
const DAILY = ["CALL_CLICKS", "WEBSITE_CLICKS", "BUSINESS_DIRECTION_REQUESTS", "BUSINESS_BOOKINGS", "BUSINESS_CONVERSATIONS",
  "BUSINESS_IMPRESSIONS_DESKTOP_SEARCH", "BUSINESS_IMPRESSIONS_MOBILE_SEARCH", "BUSINESS_IMPRESSIONS_DESKTOP_MAPS", "BUSINESS_IMPRESSIONS_MOBILE_MAPS"] as const
const ymd = (iso: string, key: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!m) throw unexpected()
  return { [`dailyRange.${key}.year`]: String(Number(m[1])), [`dailyRange.${key}.month`]: String(Number(m[2])), [`dailyRange.${key}.day`]: String(Number(m[3])) }
}

/** Totals over a window. Google omits a day's value when it is zero. */
export const googleBusinessTotals = async (c: GoogleBusinessConfig, token: string, locationId: string, window: SearchWindow): Promise<LocalTotals> => {
  const params = new URLSearchParams({ ...ymd(window.start, "start_date"), ...ymd(window.end, "end_date") })
  for (const m of DAILY) params.append("dailyMetrics", m)
  const body = await get(c, token, `${c.endpoints.performance}/locations/${locationId}:fetchMultiDailyMetricsTimeSeries?${params}`) as { multiDailyMetricTimeSeries?: Array<{ dailyMetricTimeSeries?: Array<Record<string, unknown>> }> }
  const sum: Record<string, number> = {}
  for (const group of body.multiDailyMetricTimeSeries ?? []) for (const series of group.dailyMetricTimeSeries ?? []) {
    const metric = text(series["dailyMetric"], 60)
    const values = ((series["timeSeries"] ?? {}) as { datedValues?: Array<{ value?: unknown }> }).datedValues ?? []
    sum[metric] = (sum[metric] ?? 0) + values.reduce((n, v) => n + amount(v.value), 0)
  }
  const n = (k: string) => sum[k] ?? 0
  const searchImpressions = n("BUSINESS_IMPRESSIONS_DESKTOP_SEARCH") + n("BUSINESS_IMPRESSIONS_MOBILE_SEARCH")
  const mapsImpressions = n("BUSINESS_IMPRESSIONS_DESKTOP_MAPS") + n("BUSINESS_IMPRESSIONS_MOBILE_MAPS")
  return { calls: n("CALL_CLICKS"), websiteClicks: n("WEBSITE_CLICKS"), directionRequests: n("BUSINESS_DIRECTION_REQUESTS"), bookings: n("BUSINESS_BOOKINGS"),
    conversations: n("BUSINESS_CONVERSATIONS"), impressions: searchImpressions + mapsImpressions, searchImpressions, mapsImpressions }
}

/** The search terms people used before the profile was shown, for one month, most first. Small counts arrive only as a threshold. */
export const googleBusinessSearchTerms = async (c: GoogleBusinessConfig, token: string, locationId: string, month: { year: number; month: number }, limit = 10) => {
  const body = await get(c, token, `${c.endpoints.performance}/locations/${locationId}/searchkeywords/impressions/monthly?${new URLSearchParams({
    "monthlyRange.start_month.year": String(month.year), "monthlyRange.start_month.month": String(month.month),
    "monthlyRange.end_month.year": String(month.year), "monthlyRange.end_month.month": String(month.month), pageSize: "50" })}`) as { searchKeywordsCounts?: Array<Record<string, unknown>> }
  return (body.searchKeywordsCounts ?? []).flatMap(k => {
    const term = text(k["searchKeyword"], 120), v = (k["insightsValue"] ?? {}) as { value?: unknown; threshold?: unknown }
    if (!term) return []
    return [v.value !== undefined ? { term, impressions: amount(v.value), atLeast: false } : { term, impressions: amount(v.threshold), atLeast: true }]
  }).sort((a, b) => b.impressions - a.impressions).slice(0, limit)
}

const STARS: Readonly<Record<string, number>> = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 }
export interface LocalReviews {
  readonly averageRating: number | null
  readonly total: number
  /** Among the newest reviews read (up to 50). */
  readonly sampled: number
  readonly unanswered: number
  readonly inWindow: number
  readonly recent: ReadonlyArray<{ readonly rating: number | null; readonly text: string; readonly createdAt: string; readonly replied: boolean }>
}
/** The rating, review count and newest reviews. Review text is the customers' own words: untrusted. */
export const googleBusinessReviews = async (c: GoogleBusinessConfig, token: string, accountId: string, locationId: string, window: SearchWindow): Promise<LocalReviews> => {
  const body = await get(c, token, `${c.endpoints.reviews}/accounts/${accountId}/locations/${locationId}/reviews?pageSize=50&orderBy=updateTime%20desc`) as {
    reviews?: Array<Record<string, unknown>>; averageRating?: unknown; totalReviewCount?: unknown }
  const reviews = (body.reviews ?? []).map(r => ({
    rating: STARS[text(r["starRating"], 10)] ?? null, text: text(r["comment"], 500), createdAt: text(r["createTime"], 40), replied: r["reviewReply"] !== undefined && r["reviewReply"] !== null,
  }))
  const from = Date.parse(`${window.start}T00:00:00Z`), to = Date.parse(`${window.end}T23:59:59Z`)
  return {
    averageRating: body.averageRating === undefined ? null : Math.round(amount(body.averageRating) * 10) / 10,
    total: amount(body.totalReviewCount), sampled: reviews.length, unanswered: reviews.filter(r => !r.replied).length,
    inWindow: reviews.filter(r => { const t = Date.parse(r.createdAt); return t >= from && t <= to }).length,
    recent: reviews.slice(0, 5),
  }
}
