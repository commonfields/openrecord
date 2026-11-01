// SEO data from a commercial search-data provider, on the business's own,
// paid account (optional; off until the business connects it): keywords a
// domain ranks for, search volume, keyword ideas, result pages, backlink
// profiles, referring domains, competing domains, estimated traffic history
// and domain overviews. Every number except a result page is the provider's
// estimate from its own databases, labelled ESTIMATED.
//
// The provider answers with a task envelope: HTTP 200 even on failure, an
// envelope status_code, and exactly one task with its own status_code (20000
// means OK on both). A failed task is a failure, never an empty result.
import { Schema } from "effect"
import { normalizeDomain } from "../inputs.js"
import { arr, none, num, obj, ok, txt } from "./defs-public.js"
import type { AnyEndpoint, Parsed } from "./types.js"

/** Markets: ISO country to the public Google geo target id and a default language. */
export const MARKETS: Readonly<Record<string, { readonly location: number; readonly language: string }>> = {
  US: { location: 2840, language: "en" }, GB: { location: 2826, language: "en" }, CA: { location: 2124, language: "en" }, AU: { location: 2036, language: "en" },
  IN: { location: 2356, language: "en" }, SG: { location: 2702, language: "en" }, ID: { location: 2360, language: "id" }, MY: { location: 2458, language: "en" },
  DE: { location: 2276, language: "de" }, FR: { location: 2250, language: "fr" }, NL: { location: 2528, language: "nl" }, ES: { location: 2724, language: "es" },
  BR: { location: 2076, language: "pt" }, JP: { location: 2392, language: "ja" }, IT: { location: 2380, language: "it" }, MX: { location: 2484, language: "es" },
}
const Market = Schema.optional(Schema.Literal(...(Object.keys(MARKETS) as [string, ...string[]])))
const Domain = Schema.String.pipe(Schema.maxLength(253), Schema.filter(s => normalizeDomain(s) !== null, { message: () => "a public domain" }))
const Keyword = Schema.String.pipe(Schema.minLength(2), Schema.maxLength(120))
const Limit = (max: number) => Schema.optional(Schema.Int.pipe(Schema.between(1, max)))
const base = (market: string | undefined) => { const m = MARKETS[market ?? "US"] ?? MARKETS["US"]!; return { location_code: m.location, language_code: m.language } }
const BASE = "https://api.dataforseo.com/v3"
const task = (path: string, body: Record<string, unknown>) => ({ method: "POST" as const, url: `${BASE}${path}`, body: [body] })

/** The one task's first result, or why the task failed. */
export const taskResult = (json: unknown): { result: Record<string, unknown> | null; items: unknown[] } | { failed: string } => {
  const env = obj(json)
  if (typeof env["status_code"] !== "number" || !Array.isArray(env["tasks"])) return { failed: "MALFORMED" }
  if (env["status_code"] !== 20000) return { failed: env["status_code"] === 40200 || env["status_code"] === 40210 ? "BALANCE_EXHAUSTED" : env["status_code"] === 40100 || env["status_code"] === 40104 ? "AUTH" : "PROVIDER_FAILED" }
  const tasks = arr(env["tasks"])
  if (tasks.length !== 1) return { failed: "MALFORMED" }
  const t = obj(tasks[0])
  if (t["status_code"] !== 20000) return { failed: "PROVIDER_FAILED" }
  const result = arr(t["result"]).length ? obj(arr(t["result"])[0]) : null
  return { result, items: result ? arr(result["items"]) : [] }
}
const ESTIMATE = "The provider's estimate from its own keyword and link databases; not measured visits, sales or a search engine's own reports."
const env = (json: unknown, f: (r: { result: Record<string, unknown>; items: unknown[] }) => Parsed): Parsed => {
  const t = taskResult(json)
  if ("failed" in t) return t
  return t.result ? f({ result: t.result, items: t.items }) : none("The provider returned no result. Not seen is not zero.")
}

const DomainIn = Schema.Struct({ domain: Domain, market: Market, limit: Limit(100) })
const KeywordsIn = Schema.Struct({ keywords: Schema.Array(Keyword).pipe(Schema.minItems(1), Schema.maxItems(100)), market: Market })
const SeedIn = Schema.Struct({ keyword: Keyword, market: Market, limit: Limit(100) })
const History = Schema.Struct({ domain: Domain, market: Market, months: Limit(24) })
const Bulk = Schema.Struct({ domains: Schema.Array(Domain).pipe(Schema.minItems(1), Schema.maxItems(20)), market: Market })
const d = (s: string) => normalizeDomain(s)!

export const SEO_ENDPOINTS: ReadonlyArray<AnyEndpoint> = [
  { id: "seo.ranked_keywords", provider: "seo_data", platform: "search", title: "Keywords a domain ranks for", label: "ESTIMATED", input: DomainIn, docs: "https://docs.dataforseo.com/v3/dataforseo_labs/google/ranked_keywords/live/",
    description: "Google keywords a domain ranks for in one market, highest estimated volume first: keyword, position, estimated search volume, ranking page and intent, with the total count.",
    subject: (i: typeof DomainIn.Type) => d(i.domain),
    request: (i: typeof DomainIn.Type) => task("/dataforseo_labs/google/ranked_keywords/live", { target: d(i.domain), ...base(i.market), limit: i.limit ?? 30, order_by: ["keyword_data.keyword_info.search_volume,desc"] }),
    parse: j => env(j, ({ result, items }) => items.length ? ok({ label: "ESTIMATED", total: num(result["total_count"]), keywords: items.slice(0, 100).map(x => { const it = obj(x), kd = obj(it["keyword_data"]), s = obj(obj(it["ranked_serp_element"])["serp_item"])
      return { keyword: txt(kd["keyword"], 120), volume: num(obj(kd["keyword_info"])["search_volume"]), position: num(s["rank_group"]), url: txt(s["url"], 300), intent: txt(obj(kd["search_intent_info"])["main_intent"], 30) } }) }, { note: ESTIMATE }) : none("No ranked keywords in the provider's database.")) },
  { id: "seo.keyword_volume", provider: "seo_data", platform: "search", title: "Search volume of keywords", label: "ESTIMATED", input: KeywordsIn, docs: "https://docs.dataforseo.com/v3/keywords_data/google_ads/search_volume/live/",
    description: "Monthly Google search volume, competition and cost per click of up to 100 keywords in one market, with the monthly trend.", subject: (i: typeof KeywordsIn.Type) => i.keywords.slice(0, 3).join(", ").toLowerCase(),
    request: (i: typeof KeywordsIn.Type) => task("/keywords_data/google_ads/search_volume/live", { keywords: i.keywords, ...base(i.market) }),
    // This endpoint returns one row per keyword directly as the task's result.
    parse: j => { const t = taskResult(j); if ("failed" in t) return t
      const rows = arr(obj(arr(obj(j)["tasks"])[0])["result"]).map(x => { const r = obj(x); return { keyword: txt(r["keyword"], 120), volume: num(r["search_volume"]), cpc: num(r["cpc"]), competition: txt(r["competition"], 20),
        monthly: arr(r["monthly_searches"]).slice(0, 12).map(m => ({ year: num(obj(m)["year"]), month: num(obj(m)["month"]), volume: num(obj(m)["search_volume"]) })) } })
      return rows.length ? ok({ label: "ESTIMATED", keywords: rows }, { note: ESTIMATE }) : none("No volume data.") } },
  { id: "seo.keyword_ideas", provider: "seo_data", platform: "search", title: "Keyword ideas", label: "ESTIMATED", input: SeedIn, docs: "https://docs.dataforseo.com/v3/dataforseo_labs/google/keyword_ideas/live/",
    description: "Related keywords for a seed keyword in one market with estimated volume and difficulty: the searches a category's buyers make.", subject: (i: typeof SeedIn.Type) => i.keyword.toLowerCase(),
    request: (i: typeof SeedIn.Type) => task("/dataforseo_labs/google/keyword_ideas/live", { keywords: [i.keyword], ...base(i.market), limit: i.limit ?? 30 }),
    parse: j => env(j, ({ items }) => items.length ? ok({ label: "ESTIMATED", ideas: items.map(x => { const it = obj(x); return { keyword: txt(it["keyword"], 120), volume: num(obj(it["keyword_info"])["search_volume"]), difficulty: num(obj(it["keyword_properties"])["keyword_difficulty"]) } }) }, { note: ESTIMATE }) : none("No ideas.")) },
  { id: "seo.serp", provider: "seo_data", platform: "search", title: "Google results page for a keyword", label: "SEEN", input: Schema.Struct({ keyword: Keyword, market: Market }), docs: "https://docs.dataforseo.com/v3/serp/google/organic/live/regular/",
    description: "Who ranks on Google for a keyword in one market right now: organic positions, domains, titles and addresses.", subject: (i: { keyword: string }) => i.keyword.toLowerCase(),
    request: (i: { keyword: string; market?: string | undefined }) => task("/serp/google/organic/live/regular", { keyword: i.keyword, ...base(i.market), depth: 20 }),
    parse: j => env(j, ({ items }) => { const rows = items.map(obj).filter(x => x["type"] === "organic").map(x => ({ position: num(x["rank_group"]), domain: txt(x["domain"], 120), url: txt(x["url"], 300), title: txt(x["title"], 160) }))
      return rows.length ? ok({ label: "SEEN", results: rows }, { note: "One results page, fetched once, for one location and language." }) : none("No organic results.") }) },
  { id: "seo.backlinks", provider: "seo_data", platform: "search", title: "Backlink profile", label: "ESTIMATED", input: Schema.Struct({ domain: Domain }), docs: "https://docs.dataforseo.com/v3/backlinks/summary/live/",
    description: "A domain's backlinks, referring domains, broken backlinks, spam score and the provider's rank, from the provider's own web crawl.", subject: (i: { domain: string }) => d(i.domain),
    request: (i: { domain: string }) => task("/backlinks/summary/live", { target: d(i.domain), internal_list_limit: 10 }),
    parse: j => env(j, ({ result }) => ok({ label: "ESTIMATED", backlinks: num(result["backlinks"]), referringDomains: num(result["referring_domains"]), referringMainDomains: num(result["referring_main_domains"]),
      brokenBacklinks: num(result["broken_backlinks"]), providerRank: num(result["rank"]), spamScore: num(result["backlinks_spam_score"]), firstSeen: txt(result["first_seen"], 40) }, { note: "Counted from the provider's own crawl; other crawlers report different totals." })) },
  { id: "seo.referring_domains", provider: "seo_data", platform: "search", title: "Referring domains", label: "ESTIMATED", input: DomainIn, docs: "https://docs.dataforseo.com/v3/backlinks/referring_domains/live/",
    description: "The domains linking to a domain, strongest first: backlinks from each, the provider's rank and first-seen date (partners, press and directories).", subject: (i: typeof DomainIn.Type) => d(i.domain),
    request: (i: typeof DomainIn.Type) => task("/backlinks/referring_domains/live", { target: d(i.domain), limit: i.limit ?? 30, order_by: ["rank,desc"] }),
    parse: j => env(j, ({ items }) => items.length ? ok({ label: "ESTIMATED", domains: items.map(x => { const it = obj(x); return { domain: txt(it["domain"], 120), backlinks: num(it["backlinks"]), providerRank: num(it["rank"]), firstSeen: txt(it["first_seen"], 40) } }) }) : none("No referring domains in the provider's crawl.")) },
  { id: "seo.competitors", provider: "seo_data", platform: "search", title: "Competing domains in search", label: "ESTIMATED", input: DomainIn, docs: "https://docs.dataforseo.com/v3/dataforseo_labs/google/competitors_domain/live/",
    description: "Domains that rank for the same keywords as a domain in one market: shared keywords, average position and estimated organic traffic.", subject: (i: typeof DomainIn.Type) => d(i.domain),
    request: (i: typeof DomainIn.Type) => task("/dataforseo_labs/google/competitors_domain/live", { target: d(i.domain), ...base(i.market), limit: i.limit ?? 20 }),
    parse: (j, i: typeof DomainIn.Type) => env(j, ({ items }) => { const rows = items.map(x => { const it = obj(x); return { domain: txt(it["domain"], 120), sharedKeywords: num(it["intersections"]), averagePosition: num(it["avg_position"]), organicTraffic: num(obj(obj(it["full_domain_metrics"] ?? it["metrics"])["organic"])["etv"]) } }).filter(r => r.domain !== d(i.domain))
      return rows.length ? ok({ label: "ESTIMATED", domains: rows }, { note: "Search overlap in the provider's database, not proof that buyers compare them." }) : none("No competing domains.") }) },
  { id: "seo.traffic_history", provider: "seo_data", platform: "search", title: "Estimated search traffic by month", label: "ESTIMATED", input: History, docs: "https://docs.dataforseo.com/v3/dataforseo_labs/google/historical_rank_overview/live/",
    description: "A domain's estimated monthly organic and paid search traffic and ranking keyword counts for up to two years in one market.", subject: (i: typeof History.Type) => d(i.domain),
    request: (i: typeof History.Type, now: Date) => { const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (i.months ?? 12), 1))
      return task("/dataforseo_labs/google/historical_rank_overview/live", { target: d(i.domain), ...base(i.market), date_from: from.toISOString().slice(0, 10), date_to: now.toISOString().slice(0, 10) }) },
    parse: j => env(j, ({ items }) => { const months = items.map(x => { const it = obj(x), m = obj(it["metrics"]), o = obj(m["organic"]), p = obj(m["paid"]); return { year: num(it["year"]), month: num(it["month"]), organicTraffic: num(o["etv"]), organicKeywords: num(o["count"]), paidTraffic: num(p["etv"]), paidKeywords: num(p["count"]) } })
      .filter(m => m.year && m.month).sort((a, b) => (a.year! - b.year!) || (a.month! - b.month!))
      return months.length ? ok({ label: "ESTIMATED", months }, { note: `${ESTIMATE} A change between months can come from the provider refreshing its database or a search engine update as well as from the company's own work.` }) : none("No history.") }) },
  { id: "seo.domain_overview", provider: "seo_data", platform: "search", title: "Search overview of domains", label: "ESTIMATED", input: Bulk, docs: "https://docs.dataforseo.com/v3/dataforseo_labs/google/bulk_traffic_estimation/live/",
    description: "Estimated organic and paid search traffic of up to 20 domains side by side in one market, for comparing brands.", subject: (i: typeof Bulk.Type) => i.domains.map(d).join(", ").slice(0, 300),
    request: (i: typeof Bulk.Type) => task("/dataforseo_labs/google/bulk_traffic_estimation/live", { targets: i.domains.map(d), ...base(i.market) }),
    parse: j => env(j, ({ items }) => items.length ? ok({ label: "ESTIMATED", domains: items.map(x => { const it = obj(x), m = obj(it["metrics"]); return { domain: txt(it["target"], 120), organicTraffic: num(obj(m["organic"])["etv"]), paidTraffic: num(obj(m["paid"])["etv"]), organicKeywords: num(obj(m["organic"])["count"]) } }) }, { note: ESTIMATE }) : none("No estimates.")) },
]
