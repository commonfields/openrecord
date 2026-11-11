// Dev-only sample data for the live provider readers, so a demo business shows
// every Overview section and its Channels without real accounts. A business is
// a demo only when its ID is listed in OPENRECORD_DEMO_BUSINESSES, and never
// when NODE_ENV is production. The numbers are deterministic, so a chart reads
// the same on every reload, and the windows match the real readers'.
import { adTotals, adWindows, searchConsoleWindows, type AdAccountPerformance, type AdPerformanceDays, type LocalProfilePerformance, type LocalTotals, type RevenuePerformance, type RevenueTotals, type SearchPerformance, type SearchPerformanceDays, type SearchTotals } from "@openrecord/contracts"
import type { ChannelFacts } from "./channels.js"
import type { RealtimeSnapshot } from "@openrecord/contracts"

/** Whether `businessId` is a demo business on this dev server. */
export const isDemoBusiness = (businessId: string): boolean =>
  process.env["NODE_ENV"] !== "production" &&
  (process.env["OPENRECORD_DEMO_BUSINESSES"] ?? "").split(",").map(s => s.trim()).filter(Boolean).includes(businessId)

const DOMAIN = "openrecord.example"
/** A steady rise with a weekly rhythm: `days` worth of a daily base, scaled. */
const volume = (days: number, perDay: number, growth: number) => Math.round(days * perDay * growth)
const round = (n: number, places = 2) => Math.round(n * 10 ** places) / 10 ** places
const DAY_MS = 86_400_000
/** Each day of a window with a value: a weekly rhythm, a gentle climb, and a little noise. */
const series = (start: string, end: string, perDay: number, k: number, seed: number) => {
  const out: Array<{ day: string; v: number }> = []
  for (let ms = Date.parse(`${start}T00:00:00Z`), i = 0; ms <= Date.parse(`${end}T00:00:00Z`); ms += DAY_MS, i++) {
    const weekday = new Date(ms).getUTCDay(), weekend = weekday === 0 || weekday === 6
    const v = perDay * k * (1 + 0.18 * Math.sin((i + seed) / 3.1) + 0.07 * Math.sin((i * 7 + seed) / 1.7) + (weekend ? -0.32 : 0.06) + i * 0.004)
    out.push({ day: new Date(ms).toISOString().slice(0, 10), v: Math.max(0, v) })
  }
  return out
}

export const demoSearch = (days: SearchPerformanceDays): SearchPerformance => {
  const w = searchConsoleWindows(Date.now(), days)
  const totals = (impressions: number, clicks: number, position: number): SearchTotals => ({ clicks, impressions, ctr: round(clicks / impressions, 4), position })
  const current = totals(volume(days, 1840, 1.18), volume(days, 74, 1.24), 14.2)
  const previous = totals(volume(days, 1840, 1), volume(days, 74, 1), 16.8)
  const row = (key: string, share: number, ctr: number, position: number) => {
    const impressions = Math.round(current.impressions * share), clicks = Math.round(impressions * ctr)
    return { key, ...totals(impressions, clicks, position) }
  }
  const daily = (wnd: { start: string; end: string }, k: number) => {
    const imp = series(wnd.start, wnd.end, 1840, k * 1.0, 2), clk = series(wnd.start, wnd.end, 74, k * 1.05, 5)
    return imp.map((d, i) => { const impressions = Math.round(d.v), clicks = Math.round(clk[i]!.v); return { key: d.day, clicks, impressions, ctr: impressions ? round(clicks / impressions, 4) : 0, position: round(15.6 - (k - 1) * 8 + Math.sin(i / 4) * 0.8, 1) } })
  }
  const dailyNow = daily(w.current, 1.18), dailyBefore = daily(w.previous, 1)
  return {
    daily: { current: dailyNow, previous: dailyBefore },
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
  const adDays = (wnd: { start: string; end: string }, k: number, spend: number, clicks: number, impressions: number, conv: number, seed: number) => {
    const base = series(wnd.start, wnd.end, 1, k, seed)
    return base.map(d => ({ day: d.day, spend: round(spend * d.v), clicks: Math.round(clicks * d.v), impressions: Math.round(impressions * d.v), conversions: round(conv * d.v, 1) }))
  }
  return {
    accounts: [
      { provider: "google_ads", accountName: "OpenRecord Search", externalId: "4815162342", currency: "USD", days,
        current: { ...w.current, totals: g }, previous: { ...w.previous, totals: google(1) },
        topCampaigns: [campaign("1001", "AI visibility, exact", 0.46, g), campaign("1002", "Competitor comparisons", 0.31, g), campaign("1003", "Brand", 0.23, g)],
        daily: { current: adDays(w.current, 1.12, 42, 96, 2600, 3.1, 1), previous: adDays(w.previous, 1, 42, 96, 2600, 3.1, 1) },
        conversionDefinition: "Google Ads conversions (trial signups)", collectedAt: new Date().toISOString() },
      { provider: "meta", accountName: "OpenRecord Social", externalId: "907112233", currency: "USD", days,
        current: { ...w.current, totals: m }, previous: { ...w.previous, totals: meta(1) },
        topCampaigns: [campaign("2001", "Founder story, retargeting", 0.58, m), campaign("2002", "Guide download", 0.42, m, "PAUSED")],
        daily: { current: adDays(w.current, 0.94, 18, 61, 5200, 1.2, 4), previous: adDays(w.previous, 1, 18, 61, 5200, 1.2, 4) },
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
  // Each day: a weekly rhythm and a steady climb, more in the current window.
  const daily = (start: string, k: number) => Array.from({ length: days }, (_, i) => {
    const ms = Date.parse(`${start}T00:00:00Z`) + i * 86_400_000, day = new Date(ms).toISOString().slice(0, 10)
    const weekday = new Date(ms).getUTCDay(), wave = 1 + 0.25 * Math.sin(i / 2.2) + (weekday === 0 || weekday === 6 ? -0.45 : 0.1)
    const orders = Math.max(0, Math.round(2.6 * k * wave * (0.85 + i / days * 0.3)))
    return { day, currency: "USD", net: round(orders * 61.5 * 0.97), orders }
  })
  const t = (start: string, k: number): RevenueTotals => {
    const d = daily(start, k), orders = d.reduce((s, x) => s + x.orders, 0), net = round(d.reduce((s, x) => s + x.net, 0)), gross = round(net / 0.97)
    return { byCurrency: [{ currency: "USD", net, gross, refunded: round(gross - net), orders, averageOrder: orders ? round(net / orders) : null }], payingCustomers: Math.round(orders * 0.92), newCustomers: volume(days, 1.1, k), truncated: false, daily: d }
  }
  return { provider: "stripe", accountName: "OpenRecord", livemode: false, days, current: { ...w.current, totals: t(w.current.start, 1.21) }, previous: { ...w.previous, totals: t(w.previous.start, 1) }, collectedAt: new Date().toISOString() }
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

/** Who is on the demo site now: a few dozen people across the usual countries, drifting minute to minute. */
export const demoRealtime = (): RealtimeSnapshot => {
  const minute = Math.floor(Date.now() / 60_000)
  const wobble = (seed: number) => 0.8 + 0.4 * Math.abs(Math.sin(minute / 7 + seed))
  const base: Array<[string, string, number]> = [["US", "United States", 14], ["GB", "United Kingdom", 6], ["DE", "Germany", 4], ["IN", "India", 4], ["CA", "Canada", 3],
    ["ID", "Indonesia", 3], ["FR", "France", 2], ["NL", "Netherlands", 2], ["AU", "Australia", 2], ["BR", "Brazil", 2], ["SG", "Singapore", 1], ["JP", "Japan", 1], ["ES", "Spain", 1], ["SE", "Sweden", 1]]
  const countries = base.map(([code, name, n], i) => ({ code, name, users: Math.max(1, Math.round(n * wobble(i))) })).sort((a, b) => b.users - a.users)
  const activeUsers = countries.reduce((t, c) => t + c.users, 0)
  const pages = [["OpenRecord, see what AI says about you", 0.34], ["Pricing", 0.21], ["How assistants pick sources", 0.14], ["Quickstart", 0.11], ["AI answer accuracy guide", 0.09], ["Integrations", 0.06]] as const
  return {
    activeUsers,
    countries,
    pages: pages.map(([title, share]) => ({ title, users: Math.max(1, Math.round(activeUsers * share)) })),
    perMinute: Array.from({ length: 30 }, (_, i) => Math.max(0, Math.round(activeUsers / 9 * (0.75 + 0.5 * Math.abs(Math.sin((minute - 29 + i) / 3.3)))))),
    collectedAt: new Date().toISOString(),
  }
}
