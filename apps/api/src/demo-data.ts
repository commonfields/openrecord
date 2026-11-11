// Dev-only sample data for the live provider readers, so a demo business shows
// every Overview section and its Channels without real accounts. A business is
// a demo only when its ID is listed in OPENRECORD_DEMO_BUSINESSES, and never
// when NODE_ENV is production. The numbers are deterministic, so a chart reads
// the same on every reload, and the windows match the real readers'.
import { adTotals, adWindows, searchConsoleWindows, type AdAccountPerformance, type AdPerformanceDays, type LocalProfilePerformance, type LocalTotals, type RevenuePerformance, type RevenueTotals, type SearchPerformance, type SearchPerformanceDays, type SearchTotals } from "@openrecord/contracts"
import type { ChannelFacts } from "./channels.js"

/** Whether `businessId` is a demo business on this dev server. */
export const isDemoBusiness = (businessId: string): boolean =>
  process.env["NODE_ENV"] !== "production" &&
  (process.env["OPENRECORD_DEMO_BUSINESSES"] ?? "").split(",").map(s => s.trim()).filter(Boolean).includes(businessId)

const DOMAIN = "openrecord.example"
/** A steady rise with a weekly rhythm: `days` worth of a daily base, scaled. */
const volume = (days: number, perDay: number, growth: number) => Math.round(days * perDay * growth)
const round = (n: number, places = 2) => Math.round(n * 10 ** places) / 10 ** places

export const demoSearch = (days: SearchPerformanceDays): SearchPerformance => {
  const w = searchConsoleWindows(Date.now(), days)
  const totals = (impressions: number, clicks: number, position: number): SearchTotals => ({ clicks, impressions, ctr: round(clicks / impressions, 4), position })
  const current = totals(volume(days, 1840, 1.18), volume(days, 74, 1.24), 14.2)
  const previous = totals(volume(days, 1840, 1), volume(days, 74, 1), 16.8)
  const row = (key: string, share: number, ctr: number, position: number) => {
    const impressions = Math.round(current.impressions * share), clicks = Math.round(impressions * ctr)
    return { key, ...totals(impressions, clicks, position) }
  }
  return {
    siteUrl: `sc-domain:${DOMAIN}`, days,
    current: { ...w.current, totals: current }, previous: { ...w.previous, totals: previous },
    topQueries: [
      row("ai answer monitoring", 0.14, 0.061, 6.4), row("what does chatgpt say about my business", 0.11, 0.048, 8.1),
      row("ai search visibility tool", 0.09, 0.052, 9.3), row("openrecord", 0.06, 0.41, 1.2),
      row("track brand mentions in ai answers", 0.05, 0.037, 11.6), row("generative engine optimization software", 0.045, 0.029, 13.9),
      row("fix wrong ai answers about company", 0.03, 0.044, 10.2), row("ai citation tracking", 0.028, 0.033, 12.5),
    ],
    topPages: [
      row(`https://${DOMAIN}/`, 0.31, 0.046, 7.8), row(`https://${DOMAIN}/pricing`, 0.12, 0.071, 6.1),
      row(`https://${DOMAIN}/guides/ai-answer-accuracy`, 0.18, 0.039, 9.9), row(`https://${DOMAIN}/blog/how-assistants-pick-sources`, 0.15, 0.031, 12.4),
      row(`https://${DOMAIN}/integrations/google-analytics`, 0.06, 0.035, 10.8), row(`https://${DOMAIN}/docs/quickstart`, 0.05, 0.058, 5.6),
    ],
    collectedAt: new Date().toISOString(),
  }
}

export const demoAds = (days: AdPerformanceDays): { accounts: AdAccountPerformance[]; failures: never[] } => {
  const w = adWindows(Date.now(), days)
  const google = (k: number) => adTotals({ spend: round(days * 42 * k), impressions: volume(days, 2600, k), clicks: volume(days, 96, k), conversions: round(days * 3.1 * k, 1), conversionValue: round(days * 3.1 * k * 49) })
  const meta = (k: number) => adTotals({ spend: round(days * 18 * k), impressions: volume(days, 5200, k), clicks: volume(days, 61, k), conversions: round(days * 1.2 * k, 1), conversionValue: round(days * 1.2 * k * 49) })
  const campaign = (id: string, name: string, share: number, t: ReturnType<typeof adTotals>, status = "ENABLED") =>
    ({ id, name, status, ...adTotals({ spend: round(t.spend * share), impressions: Math.round(t.impressions * share), clicks: Math.round(t.clicks * share), conversions: round(t.conversions * share, 1), conversionValue: round(t.conversionValue * share) }) })
  const g = google(1.12), m = meta(0.94)
  return {
    accounts: [
      { provider: "google_ads", accountName: "OpenRecord Search", externalId: "4815162342", currency: "USD", days,
        current: { ...w.current, totals: g }, previous: { ...w.previous, totals: google(1) },
        topCampaigns: [campaign("1001", "AI visibility, exact", 0.46, g), campaign("1002", "Competitor comparisons", 0.31, g), campaign("1003", "Brand", 0.23, g)],
        conversionDefinition: "Google Ads conversions (trial signups)", collectedAt: new Date().toISOString() },
      { provider: "meta", accountName: "OpenRecord Social", externalId: "907112233", currency: "USD", days,
        current: { ...w.current, totals: m }, previous: { ...w.previous, totals: meta(1) },
        topCampaigns: [campaign("2001", "Founder story, retargeting", 0.58, m), campaign("2002", "Guide download", 0.42, m, "PAUSED")],
        conversionDefinition: "Meta results (lead forms)", collectedAt: new Date().toISOString() },
    ],
    failures: [],
  }
}

export const demoLocal = (days: AdPerformanceDays): { locations: LocalProfilePerformance[]; failures: never[] } => {
  const w = adWindows(Date.now(), days)
  const t = (k: number): LocalTotals => ({ calls: volume(days, 1.4, k), websiteClicks: volume(days, 9.5, k), directionRequests: volume(days, 0.6, k), bookings: volume(days, 0.4, k),
    conversations: volume(days, 0.3, k), impressions: volume(days, 210, k), searchImpressions: volume(days, 140, k), mapsImpressions: volume(days, 70, k) })
  const day = (ago: number) => new Date(Date.now() - ago * 86_400_000).toISOString()
  return {
    locations: [{
      locationName: "OpenRecord HQ", locationId: "loc-openrecord-hq", days,
      current: { ...w.current, totals: t(1.15) }, previous: { ...w.previous, totals: t(1) },
      searchTerms: { month: new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() - 1, 1)).toISOString().slice(0, 7), terms: [
        { term: "openrecord", impressions: 820, atLeast: false }, { term: "ai visibility software", impressions: 140, atLeast: false },
        { term: "marketing analytics near me", impressions: 60, atLeast: true }, { term: "ai seo agency tools", impressions: 30, atLeast: true },
      ] },
      reviews: { averageRating: 4.8, total: 36, sampled: 3, unanswered: 1, inWindow: 4, recent: [
        { rating: 5, text: "We found three wrong prices in ChatGPT answers in the first week and fixed them.", createdAt: day(3), replied: true },
        { rating: 5, text: "The weekly brief is the one report our team actually reads.", createdAt: day(9), replied: true },
        { rating: 4, text: "Setup took an afternoon. Would love more integrations.", createdAt: day(16), replied: false },
      ] },
      collectedAt: new Date().toISOString(),
    }],
    failures: [],
  }
}

export const demoRevenue = (days: AdPerformanceDays): RevenuePerformance => {
  const w = adWindows(Date.now(), days)
  const t = (k: number): RevenueTotals => {
    const orders = volume(days, 2.6, k), gross = round(orders * 61.5), refunded = round(gross * 0.03)
    return { byCurrency: [{ currency: "USD", net: round(gross - refunded), gross, refunded, orders, averageOrder: round(gross / orders) }], payingCustomers: Math.round(orders * 0.92), newCustomers: volume(days, 1.1, k), truncated: false }
  }
  return { provider: "stripe", accountName: "OpenRecord", livemode: false, days, current: { ...w.current, totals: t(1.21) }, previous: { ...w.previous, totals: t(1) }, collectedAt: new Date().toISOString() }
}

/** The Channels page as it reads once GA4, Search Console and the usual profiles are connected. */
export const demoChannelFacts = (f: ChannelFacts): ChannelFacts => ({
  ...f,
  websiteUrl: f.websiteUrl ?? `https://${DOMAIN}`,
  siteTargets: Math.max(1, f.siteTargets),
  ga4: { configured: true, connections: [{ status: "ACTIVE", statusReason: null, googleEmail: "growth@openrecord.example" }], boundToBusiness: true },
  searchConsole: { scopeGranted: true, site: `sc-domain:${DOMAIN}` },
  lastAnswerAt: f.lastAnswerAt ?? new Date(Date.now() - 2 * 3_600_000).toISOString(),
  discovery: f.discovery ?? {
    channels: [
      { kind: "LINKEDIN", url: "https://www.linkedin.com/company/openrecord" }, { kind: "X", url: "https://x.com/openrecord" },
      { kind: "GITHUB", url: "https://github.com/openrecord" }, { kind: "YOUTUBE", url: "https://www.youtube.com/@openrecord" },
      { kind: "PRODUCT_HUNT", url: "https://www.producthunt.com/products/openrecord" }, { kind: "G2", url: "https://www.g2.com/products/openrecord" },
      { kind: "EMAIL", url: "mailto:hello@openrecord.example" },
    ],
  } as unknown as ChannelFacts["discovery"],
})
