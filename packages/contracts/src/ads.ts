// Ad platform connections: the client's own ad accounts on Meta (Facebook and
// Instagram) and Google Ads, read-only. A connection is one person's sign-in
// on one platform, owned by the OpenRecord account; a binding attaches one ad
// account to one business. Performance is reported in one shape for every
// platform, with each platform's own conversion definition named.
import { Schema } from "effect"
import { SEARCH_PERFORMANCE_DAYS, type SearchWindow } from "./search-console.js"

export const AD_PROVIDERS = ["meta", "google_ads"] as const
export const AdProvider = Schema.Literal(...AD_PROVIDERS)
export type AdProvider = typeof AdProvider.Type
/** Everything signed in through the same connection tables: the ad platforms and Google Business Profile. */
export const CHANNEL_PROVIDERS = ["meta", "google_ads", "google_business"] as const
export const ChannelProvider = Schema.Literal(...CHANNEL_PROVIDERS)
export type ChannelProvider = typeof ChannelProvider.Type
export const AD_PROVIDER_NAME: Readonly<Record<ChannelProvider, string>> = { meta: "Meta Ads", google_ads: "Google Ads", google_business: "Google Business Profile" }
export const AD_OAUTH_CALLBACK_PATH = "/api/ads/oauth/callback"
export const AD_PERFORMANCE_DAYS = SEARCH_PERFORMANCE_DAYS
export type AdPerformanceDays = typeof AD_PERFORMANCE_DAYS[number]
export const AD_TOP_CAMPAIGNS = 10

export type AdConnectionStatus = "ACTIVE" | "REAUTHORIZATION_REQUIRED" | "DISCONNECTED"
export interface AdConnection {
  readonly id: string
  readonly provider: ChannelProvider
  /** The signed-in person on the platform: a name or email, never a token. */
  readonly displayName: string
  readonly status: AdConnectionStatus
  readonly connectedAt: string
  readonly expiresAt: string | null
}
/** An ad account a connection can read. */
export interface AdAccount {
  readonly externalId: string
  readonly name: string
  readonly currency: string | null
  /** Google Ads: the manager account the access goes through, sent as login-customer-id. */
  readonly loginCustomerId: string | null
  /** Google Business Profile: the account the location belongs to. */
  readonly parentId?: string | null
  readonly active: boolean
}
export interface AdBinding {
  readonly id: string
  readonly provider: ChannelProvider
  readonly connectionId: string
  readonly externalId: string
  readonly name: string
  readonly currency: string | null
  readonly boundAt: string
}

export interface AdTotals {
  readonly spend: number
  readonly impressions: number
  readonly clicks: number
  readonly conversions: number
  readonly conversionValue: number
  /** Derived here, never taken from the platform: null when the divisor is zero. */
  readonly ctr: number | null
  readonly cpc: number | null
  readonly costPerConversion: number | null
  readonly roas: number | null
}
export interface AdCampaignRow extends AdTotals { readonly id: string; readonly name: string; readonly status: string | null }
export interface AdAccountPerformance {
  readonly provider: AdProvider
  readonly accountName: string
  readonly externalId: string
  readonly currency: string | null
  readonly days: AdPerformanceDays
  readonly current: SearchWindow & { readonly totals: AdTotals }
  readonly previous: SearchWindow & { readonly totals: AdTotals }
  readonly topCampaigns: ReadonlyArray<AdCampaignRow>
  /** What this platform counts as a conversion, so totals are never compared as if they meant the same thing. */
  readonly conversionDefinition: string
  readonly collectedAt: string
}

export const adTotals = (raw: { spend: number; impressions: number; clicks: number; conversions: number; conversionValue: number }): AdTotals => {
  const ratio = (a: number, b: number) => b > 0 ? a / b : null
  return { ...raw, ctr: ratio(raw.clicks, raw.impressions), cpc: ratio(raw.spend, raw.clicks), costPerConversion: ratio(raw.spend, raw.conversions), roas: ratio(raw.conversionValue, raw.spend) }
}

/** Ad data settles within a day or two; the window ends yesterday (UTC). */
export const adWindows = (nowMs: number, days: AdPerformanceDays): { readonly current: SearchWindow; readonly previous: SearchWindow } => {
  const DAY = 86_400_000, day = (ms: number) => new Date(ms).toISOString().slice(0, 10)
  const today = Date.UTC(new Date(nowMs).getUTCFullYear(), new Date(nowMs).getUTCMonth(), new Date(nowMs).getUTCDate())
  const end = today - DAY, start = end - (days - 1) * DAY, prevEnd = start - DAY
  return { current: { start: day(start), end: day(end) }, previous: { start: day(prevEnd - (days - 1) * DAY), end: day(prevEnd) } }
}

export const StartAdConnection = Schema.Struct({ provider: ChannelProvider, businessId: Schema.UUID })
export const BindAdAccount = Schema.Struct({
  connectionId: Schema.UUID,
  externalId: Schema.String.pipe(Schema.pattern(/^(act_)?\d{1,30}$/)),
})

/** One Google Business Profile location: what people did from the profile, how often it was shown, what they searched, and its reviews. */
export interface LocalTotals {
  readonly calls: number; readonly websiteClicks: number; readonly directionRequests: number; readonly bookings: number; readonly conversations: number
  readonly impressions: number; readonly searchImpressions: number; readonly mapsImpressions: number
}
export interface LocalProfilePerformance {
  readonly locationName: string
  readonly locationId: string
  readonly days: AdPerformanceDays
  readonly current: SearchWindow & { readonly totals: LocalTotals }
  readonly previous: SearchWindow & { readonly totals: LocalTotals }
  readonly searchTerms: { readonly month: string; readonly terms: ReadonlyArray<{ readonly term: string; readonly impressions: number; readonly atLeast: boolean }> } | null
  readonly reviews: {
    readonly averageRating: number | null; readonly total: number; readonly sampled: number; readonly unanswered: number; readonly inWindow: number
    readonly recent: ReadonlyArray<{ readonly rating: number | null; readonly text: string; readonly createdAt: string; readonly replied: boolean }>
  } | null
  readonly collectedAt: string
}

/** Revenue from the business's own payment account (Stripe), per currency, never converted or added across currencies. */
export interface CurrencyRevenue {
  readonly currency: string
  /** Paid, minus what was refunded, in major units. */
  readonly net: number
  readonly gross: number
  readonly refunded: number
  readonly orders: number
  readonly averageOrder: number | null
}
export interface RevenueTotals {
  readonly byCurrency: ReadonlyArray<CurrencyRevenue>
  /** Distinct paying customers (by customer, else by billing email). */
  readonly payingCustomers: number
  /** Customers created in the window, when the key may list customers. */
  readonly newCustomers: number | null
  /** True when there were more charges than OpenRecord reads at once (3,000). */
  readonly truncated: boolean
}

export interface RevenuePerformance {
  readonly provider: "stripe"
  readonly accountName: string
  readonly livemode: boolean
  readonly days: AdPerformanceDays
  readonly current: SearchWindow & { readonly totals: RevenueTotals }
  readonly previous: SearchWindow & { readonly totals: RevenueTotals }
  readonly collectedAt: string
}
export interface RevenueConnection { readonly id: string; readonly provider: "stripe"; readonly displayName: string; readonly livemode: boolean; readonly last4: string; readonly status: "ACTIVE" | "REVOKED"; readonly connectedAt: string }
export const ConnectStripe = Schema.Struct({ key: Schema.String.pipe(Schema.minLength(10), Schema.maxLength(300)) })
