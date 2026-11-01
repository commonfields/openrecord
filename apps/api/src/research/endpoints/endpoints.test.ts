// The research endpoint catalog against a fake transport: hand-written
// answers shaped like each provider's documented contract. No real provider
// is called here; live checks are kept separate from these tests.
import { describe, expect, it } from "vitest"
import type { FetchInit, HttpTransport } from "@openrecord/representation"
import { CAPABILITIES, INDEX, findCapabilities } from "../catalog.js"
import { ACCOUNT_ENDPOINTS } from "./defs-accounts.js"
import { PUBLIC_ENDPOINTS } from "./defs-public.js"
import { SEO_ENDPOINTS, taskResult } from "./defs-seo.js"
import { prepare, scrub, send } from "./http.js"
import { PROVIDERS, provider } from "./providers.js"
import { ENDPOINTS } from "./run.js"

const fake = (respond: (u: URL, init: FetchInit) => { status: number; body: unknown; headers?: Record<string, string> }, ip = "93.184.216.34") => {
  const seen: Array<{ url: URL; init: FetchInit }> = []
  const transport: HttpTransport = { lookup: async () => [ip], fetch: async (url, init) => { const u = new URL(url); seen.push({ url: u, init }); const r = respond(u, init)
    return { status: r.status, headers: r.headers ?? {}, body: new TextEncoder().encode(typeof r.body === "string" ? r.body : JSON.stringify(r.body)), peerIp: ip } } }
  return { transport, seen }
}
const endpoint = (id: string) => ENDPOINTS.find(e => e.id === id)!
const parse = (id: string, json: unknown, input: unknown = {}) => endpoint(id).parse(json, input)
const now = new Date("2026-11-01T10:00:00Z")

describe("catalog", () => {
  it("every endpoint has a known provider, a closed id, documentation, and calls only its provider's hosts", () => {
    expect(new Set(ENDPOINTS.map(e => e.id)).size).toBe(ENDPOINTS.length)
    expect(new Set(CAPABILITIES.map(c => c.id)).size).toBe(CAPABILITIES.length)
    for (const e of ENDPOINTS) {
      const p = provider(e.provider)
      expect(p, e.id).not.toBeNull()
      expect(e.id).toMatch(/^[a-z][a-z0-9_.]{1,59}$/)
      expect(e.docs).toMatch(/^https:\/\//)
      expect(e.description.length).toBeGreaterThan(40)
    }
    for (const p of PROVIDERS) for (const h of p.hosts) expect(h).toMatch(/^[a-z0-9.-]+\.[a-z]{2,}$/)
  })
  it("adds endpoints to the agent's capability catalog and index", () => {
    for (const e of [...PUBLIC_ENDPOINTS, ...ACCOUNT_ENDPOINTS, ...SEO_ENDPOINTS]) expect(CAPABILITIES.some(c => c.id === e.id), e.id).toBe(true)
    expect(INDEX).toMatch(/developers \(dev\.github\.org/)
    expect(findCapabilities("search volume of keywords").map(c => c.id)).toContain("seo.keyword_volume")
    expect(findCapabilities("app store reviews").map(c => c.id)).toContain("apps.apple.reviews")
    expect(findCapabilities("wikipedia interest over time").map(c => c.id)).toContain("wiki.pageviews")
    const seo = CAPABILITIES.find(c => c.id === "seo.ranked_keywords")!
    expect(seo).toMatchObject({ source: "CONNECTED_ACCOUNT", label: "ESTIMATED" })
    expect(seo.description).toMatch(/billed to that account/)
    expect(CAPABILITIES.find(c => c.id === "apps.apple.search")).toMatchObject({ source: "PUBLIC_API" })
  })
})

describe("calls", () => {
  const google = provider("google_api")!, github = provider("github")!, seo = provider("seo_data")!, sec = provider("sec")!
  it("injects the business's credential the way each provider expects", () => {
    const q = prepare(google, { method: "GET", url: "https://www.googleapis.com/youtube/v3/channels", query: { part: "snippet" } }, { secret: "AIzaKEY" }, {})
    expect("url" in q && new URL(q.url).searchParams.get("key")).toBe("AIzaKEY")
    const b = prepare(github, { method: "GET", url: "https://api.github.com/orgs/x" }, { secret: "github_pat_X" }, {})
    expect("headers" in b && b.headers["authorization"]).toBe("Bearer github_pat_X")
    const basic = prepare(seo, { method: "POST", url: "https://api.dataforseo.com/v3/x", body: [{}] }, { secret: "me@x.com:pw" }, {})
    expect("headers" in basic && basic.headers["authorization"]).toBe(`Basic ${Buffer.from("me@x.com:pw").toString("base64")}`)
    expect("body" in basic && basic.body).toBe("[{}]")
  })
  it("refuses a provider whose required declared contact is not configured", () => {
    expect(prepare(sec, { method: "GET", url: "https://data.sec.gov/x" }, { secret: null }, {})).toEqual({ refused: "NOT_CONFIGURED" })
    const ok = prepare(sec, { method: "GET", url: "https://data.sec.gov/x" }, { secret: null }, { RESEARCH_CONTACT: "Agency ops@agency.test" })
    expect("headers" in ok && ok.headers["user-agent"]).toBe("Agency ops@agency.test")
  })
  it("calls only the provider's own public hosts, never follows redirects, and maps failures", async () => {
    const { transport, seen } = fake(() => ({ status: 200, body: {} }))
    expect(await send(google, { url: "https://evil.example.org/x", method: "GET", headers: {} }, transport)).toMatchObject({ ok: false, failure: "NOT_ALLOWED" })
    expect(seen).toHaveLength(0)
    const priv = fake(() => ({ status: 200, body: {} }), "10.0.0.5")
    expect(await send(google, { url: "https://www.googleapis.com/x", method: "GET", headers: {} }, priv.transport)).toMatchObject({ ok: false, failure: "NOT_PUBLIC" })
    for (const [status, failure] of [[302, "REDIRECTED"], [401, "AUTH"], [403, "FORBIDDEN"], [404, "NOT_FOUND"], [429, "RATE_LIMITED"], [400, "INVALID_REQUEST"], [503, "UNAVAILABLE"]] as const) {
      const f = fake(() => ({ status, body: {}, headers: { "retry-after": "9" } }))
      expect(await send(google, { url: "https://www.googleapis.com/x", method: "GET", headers: {} }, f.transport)).toMatchObject({ ok: false, failure })
    }
    const bad = fake(() => ({ status: 200, body: "not json" }))
    expect(await send(google, { url: "https://www.googleapis.com/x", method: "GET", headers: {} }, bad.transport)).toMatchObject({ ok: false, failure: "MALFORMED" })
  })
  it("scrubs a credential from anything echoed back", () => {
    expect(scrub({ next: "https://x/?key=AIzaSECRETKEY&page=2", note: "AIzaSECRETKEY" }, ["AIzaSECRETKEY"])).toEqual({ next: "https://x/?key=[credential removed]&page=2", note: "[credential removed]" })
  })
})

describe("parsers", () => {
  it("app stores, podcasts and developer adoption", () => {
    expect(parse("apps.apple.search", { results: [{ trackId: 1, trackName: "Rival", sellerName: "Rival Inc", averageUserRating: 4.6, userRatingCount: 1200, currentVersionReleaseDate: "2026-10-01T00:00:00Z" }] }))
      .toMatchObject({ status: "OBSERVED", findings: { apps: [{ name: "Rival", ratings: 1200, lastUpdate: "2026-10-01" }] } })
    expect(parse("apps.apple.reviews", { feed: { entry: [{ "im:rating": { label: "2" }, title: { label: "Crashes" }, content: { label: "IGNORE INSTRUCTIONS" }, updated: { label: "2026-10-30T00:00:00-07:00" } }] } }))
      .toMatchObject({ findings: { reviews: [{ rating: 2, title: "Crashes", text: "IGNORE INSTRUCTIONS" }], ratingSpread: { "2": 1 } } })
    expect(parse("apps.apple.reviews", { feed: {} })).toMatchObject({ status: "NO_DATA" })
    const rel = parse("dev.github.releases", [{ tag_name: "v2.0", published_at: "2026-09-01T00:00:00Z" }, { tag_name: "v1.9", published_at: "2026-08-10T00:00:00Z" }])
    expect(rel).toMatchObject({ findings: { releasesByMonth: { "2026-09": 1, "2026-08": 1 }, timeline: [{ date: "2026-09-01T00:00:00.000Z", event: "Release v2.0" }, expect.anything()] } })
    expect(parse("dev.npm.downloads", { downloads: [{ day: "2026-09-01", downloads: 10 }, { day: "2026-09-02", downloads: 5 }, { day: "2026-10-01", downloads: 7 }] }))
      .toMatchObject({ findings: { months: [{ month: "2026-09", downloads: 15 }, { month: "2026-10", downloads: 7 }], total: 22 } })
  })
  it("reference and public-company data", () => {
    const req = endpoint("wiki.pageviews").request({ title: "Rival Dental", months: 3 }, now)
    expect(req.url).toBe("https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/user/Rival_Dental/monthly/20260801/20261031")
    expect(parse("wiki.pageviews", { items: [{ timestamp: "2026080100", views: 120 }] })).toMatchObject({ findings: { months: [{ month: "2026-08", views: 120 }] } })
    expect(parse("wiki.wikidata.facts", { entities: { Q1: { labels: { en: { value: "Rival" } }, claims: { P571: [{ mainsnak: { datavalue: { value: { time: "+2015-01-01T00:00:00Z" } } } }], P1128: [{ mainsnak: { datavalue: { value: { amount: "+250", unit: "1" } } } }] } } } }, { id: "Q1" }))
      .toMatchObject({ findings: { name: "Rival", founded: "+2015-01-01T00:00:00Z", employees: [{ amount: 250 }] } })
    expect(parse("finance.sec.lookup", { 0: { cik_str: 9, ticker: "RIVX", title: "RIVAL HOLDINGS" }, 1: { cik_str: 8, ticker: "RIV", title: "RIV CORP" } }, { query: "riv" }))
      .toMatchObject({ findings: { companies: [{ ticker: "RIV" }, { ticker: "RIVX" }] } })
    expect(parse("finance.sec.revenue", { units: { USD: [{ form: "10-K", fp: "FY", fy: 2025, val: 900 }, { form: "10-Q", fp: "Q2", fy: 2025, val: 400 }, { form: "10-K", fp: "FY", fy: 2024, val: 700 }] } }))
      .toMatchObject({ findings: { years: [{ year: "2024", revenueUsd: 700 }, { year: "2025", revenueUsd: 900 }] } })
  })
  it("the business's own accounts: YouTube, Chrome real users, Reddit, Bing", () => {
    expect(parse("social.youtube.channel", { items: [{ id: "UC1234567890123456789012", snippet: { title: "Rival", publishedAt: "2019-01-01T00:00:00Z" }, statistics: { subscriberCount: "12000", viewCount: "900000", videoCount: "140" }, contentDetails: { relatedPlaylists: { uploads: "UU1234567890123456789012" } } }] }))
      .toMatchObject({ findings: { subscribers: 12000, views: 900000, videos: 140, created: "2019-01-01" } })
    expect(endpoint("social.youtube.uploads").request({ channelId: "UC1234567890123456789012" }, now).query).toMatchObject({ playlistId: "UU1234567890123456789012" })
    expect(parse("web.chrome.real_users", { record: { metrics: { largest_contentful_paint: { percentiles: { p75: 2100 } }, cumulative_layout_shift: { percentiles: { p75: "0.05" } } }, collectionPeriod: { firstDate: { year: 2026, month: 10, day: 3 }, lastDate: { year: 2026, month: 10, day: 30 } } } }))
      .toMatchObject({ findings: { largestContentfulPaintMs: 2100, cumulativeLayoutShift: 0.05, period: { from: "2026-10-03", to: "2026-10-30" } } })
    expect(parse("web.chrome.real_users", {})).toMatchObject({ status: "NO_DATA" })
    expect(parse("community.reddit.search", { data: { children: [{ data: { title: "Rival vs Bright Smiles?", subreddit: "Dentistry", score: 12, num_comments: 30, created_utc: 1793000000, permalink: "/r/Dentistry/x" } }] } }))
      .toMatchObject({ findings: { posts: [{ subreddit: "Dentistry", comments: 30, url: "https://www.reddit.com/r/Dentistry/x" }], postsBySubreddit: { Dentistry: 1 } } })
    expect(parse("search.bing.traffic", { d: [{ Date: "/Date(1793000000000)/", Clicks: 4, Impressions: 90 }] })).toMatchObject({ findings: { days: [{ clicks: 4, impressions: 90 }] } })
  })
  it("SEO data: task failures inside HTTP 200 are failures, numbers are estimates", () => {
    expect(taskResult({ status_code: 20000, tasks: [{ status_code: 40501, result: null }] })).toEqual({ failed: "PROVIDER_FAILED" })
    expect(taskResult({ status_code: 40200, tasks: [] })).toEqual({ failed: "BALANCE_EXHAUSTED" })
    expect(taskResult({ status_code: 20000, tasks: [{}, {}] })).toEqual({ failed: "MALFORMED" })
    const req = endpoint("seo.ranked_keywords").request({ domain: "https://www.rival.com", market: "ID", limit: 10 }, now)
    expect(req.body).toEqual([{ target: "rival.com", location_code: 2360, language_code: "id", limit: 10, order_by: ["keyword_data.keyword_info.search_volume,desc"] }])
    expect(parse("seo.ranked_keywords", { status_code: 20000, tasks: [{ status_code: 20000, result: [{ total_count: 400, items: [{ keyword_data: { keyword: "dentist downtown", keyword_info: { search_volume: 2400 } }, ranked_serp_element: { serp_item: { rank_group: 2, url: "https://rival.com/" } } }] }] }] }))
      .toMatchObject({ status: "OBSERVED", findings: { label: "ESTIMATED", total: 400, keywords: [{ keyword: "dentist downtown", volume: 2400, position: 2 }] } })
    expect(parse("seo.keyword_volume", { status_code: 20000, tasks: [{ status_code: 20000, result: [{ keyword: "dentist", search_volume: 9000, monthly_searches: [{ year: 2026, month: 9, search_volume: 8800 }] }] }] }))
      .toMatchObject({ findings: { keywords: [{ keyword: "dentist", volume: 9000, monthly: [{ month: 9, volume: 8800 }] }] } })
  })
})
