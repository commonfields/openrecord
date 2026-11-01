// Advertising and search visibility of another company:
//
//  - ads.meta_library: the company's ads in Meta's public ad library, read
//    with the business's own connected Meta account (Channels page). Start
//    and stop dates, platforms, creative text and how long each ad has run.
//    Meta's library API covers ads delivered in the EU and ads about social
//    issues, elections or politics; outside that it can return nothing even
//    when the company advertises. It never shows spend or results.
//  - search.results: who shows up for a search, through the web search this
//    server already has configured. A snapshot, not a ranking report.
//
// Paid channels are also visible from advertising pixels (site.technologies).
import { Effect, Schema } from "effect"
import { metaLibraryAccess } from "../ads.js"
import { clean, hostOf, isoDate } from "./html.js"
import { Domain, normalizeDomain } from "./inputs.js"
import { webAccess } from "../web-access.js"
import { refuse, type AnyCapability, type Observed, type Refused, type RunContext } from "./types.js"

const COUNTRIES = ["US", "GB", "CA", "AU", "IN", "SG", "ID", "MY", "DE", "FR", "NL", "ES", "IT", "IE", "BR", "MX", "JP", "SE", "PL", "BE", "AT", "DK", "FI", "NO", "PT"] as const
const LibraryInput = Schema.Struct({
  query: Schema.String.pipe(Schema.minLength(2), Schema.maxLength(100)),
  country: Schema.optional(Schema.Literal(...COUNTRIES)),
  activeOnly: Schema.optional(Schema.Boolean),
})
/** The snapshot link Meta returns carries the reader's token; it never leaves the server. */
export const withoutToken = (url: unknown) => {
  const s = clean(url, 600)
  if (!s) return null
  try { const u = new URL(s); u.searchParams.delete("access_token"); return u.href } catch { return null }
}
const days = (from: string | null, to: string | null, now: Date) => from ? Math.max(0, Math.round(((to ? Date.parse(to) : now.getTime()) - Date.parse(from)) / 86_400_000)) : null

export const parseLibrary = (body: unknown, now: Date) => {
  const data = Array.isArray((body as { data?: unknown })?.data) ? (body as { data: Array<Record<string, unknown>> }).data : []
  return data.map(a => {
    const start = isoDate(a["ad_delivery_start_time"]), stop = isoDate(a["ad_delivery_stop_time"])
    return { id: clean(a["id"], 40), page: clean(a["page_name"], 120), started: start?.slice(0, 10) ?? null, stopped: stop?.slice(0, 10) ?? null, active: !stop,
      runningDays: days(start, stop, now), platforms: Array.isArray(a["publisher_platforms"]) ? (a["publisher_platforms"] as unknown[]).map(p => clean(p, 30)).filter(Boolean) : [],
      body: clean(Array.isArray(a["ad_creative_bodies"]) ? (a["ad_creative_bodies"] as unknown[])[0] : null, 400),
      headline: clean(Array.isArray(a["ad_creative_link_titles"]) ? (a["ad_creative_link_titles"] as unknown[])[0] : null, 160),
      landing: clean(Array.isArray(a["ad_creative_link_captions"]) ? (a["ad_creative_link_captions"] as unknown[])[0] : null, 160),
      snapshot: withoutToken(a["ad_snapshot_url"]) }
  })
}

const libraryRun = (ctx: RunContext, input: typeof LibraryInput.Type) => Effect.gen(function*() {
  const access = yield* metaLibraryAccess(ctx.accountId)
  if (!access) return refuse("NOT_CONNECTED", "Connect the business's Meta account on the Channels page to read Meta's ad library. Until then the company's Meta ads are unknown; site.technologies still shows whether it has the Meta pixel.")
  const country = input.country ?? "US"
  const q = new URLSearchParams({ search_terms: input.query, ad_reached_countries: JSON.stringify([country]), ad_active_status: input.activeOnly ? "ACTIVE" : "ALL", ad_type: "ALL", limit: "50",
    fields: "id,page_name,ad_delivery_start_time,ad_delivery_stop_time,ad_creative_bodies,ad_creative_link_titles,ad_creative_link_captions,publisher_platforms,ad_snapshot_url", access_token: access.token })
  const r = yield* Effect.tryPromise(() => ctx.net.api(`${access.graph}/ads_archive?${q}`, "json"))
  let body: unknown = null
  try { body = JSON.parse(r.body ?? "null") } catch { body = null }
  const err = (body as { error?: { code?: number } } | null)?.error
  if (err || r.status !== 200) {
    if (err?.code === 10 || err?.code === 200 || err?.code === 2332002 || r.status === 403) return refuse("AD_LIBRARY_ACCESS_REQUIRED", "Meta refused ad library access for the connected account. It needs ad library API access (identity confirmation in Meta). Say the company's Meta ads are unknown.")
    if (err?.code === 4 || err?.code === 17 || err?.code === 613 || r.status === 429) return refuse("RATE_LIMITED", "Meta's rate limit for the library was reached. Try again later.")
    if (err?.code === 190) return refuse("RECONNECT_REQUIRED", "The Meta connection needs to be reconnected on the Channels page.")
    return refuse("UNAVAILABLE", "Meta's ad library did not answer.")
  }
  const ads = parseLibrary(body, ctx.now)
  const active = ads.filter(a => a.active)
  const longest = [...ads].sort((a, b) => (b.runningDays ?? 0) - (a.runningDays ?? 0)).slice(0, 5)
  return {
    status: ads.length ? "OBSERVED" : "NO_DATA",
    citations: [{ kind: "web", id: `https://www.facebook.com/ads/library/?q=${encodeURIComponent(input.query)}&country=${country}`, text: `Meta ad library: ${input.query} (${country})` }],
    timeline: ads.filter(a => a.started).slice(0, 20).map(a => ({ date: `${a.started}T00:00:00.000Z`, event: `Meta ad started (${a.page}): ${a.headline ?? a.body?.slice(0, 80) ?? "ad"}`, label: "SEEN" as const })),
    findings: { label: "SEEN", ads, active: active.length, pages: [...new Set(ads.map(a => a.page).filter(Boolean))],
      longestRunning: { label: "INFERRED", ads: longest.map(a => ({ headline: a.headline, body: a.body?.slice(0, 120), runningDays: a.runningDays, active: a.active })),
        note: "Advertisers usually keep ads that work, so long-running ads are a hint of what performs; the library shows no spend, reach or results to confirm it." } },
    coverage: { country, returned: ads.length, note: "Search-term matches in Meta's ad library for one country. Outside the EU the library API mainly covers ads about social issues, elections or politics, so no ads here is not proof the company does not advertise." },
  } satisfies Observed
})

const SearchInput = Schema.Struct({ query: Schema.String.pipe(Schema.minLength(2), Schema.maxLength(200)), domain: Schema.optional(Domain), limit: Schema.optional(Schema.Int.pipe(Schema.between(3, 10))) })
const searchRun = (ctx: RunContext, input: typeof SearchInput.Type) => Effect.gen(function*() {
  const web = yield* webAccess
  if (!web.search) return refuse("NOT_CONFIGURED", "Web search is not configured on this server, so who ranks for a search is unknown here.")
  const search = web.search
  const results = yield* Effect.tryPromise(() => search(input.query, input.limit ?? 10)).pipe(Effect.orElseSucceed(() => null))
  if (!results) return refuse("UNAVAILABLE", "Web search did not answer.")
  const domain = input.domain ? normalizeDomain(input.domain) : null
  const rows = results.map((r, i) => ({ position: i + 1, domain: hostOf(r.url), url: r.url, title: clean(r.title, 160) }))
  const own = domain ? rows.filter(r => r.domain === domain || r.domain?.endsWith(`.${domain}`)) : []
  return {
    status: rows.length ? "OBSERVED" : "NO_DATA", citations: rows.slice(0, 5).map(r => ({ kind: "web", id: r.url, text: r.title ?? r.url })),
    findings: { label: "SEEN", query: input.query, results: rows, ...(domain ? { domain, positions: own.map(r => r.position) } : {}) },
    coverage: { provider: web.provider, note: "One search through this server's search provider, now. Positions differ by person, place, device and time and are not a search engine's ranking report." },
  } satisfies Observed | Refused
})

export const ADS_CAPABILITIES: ReadonlyArray<AnyCapability> = [
  { id: "ads.meta_library", platform: "advertising", title: "Meta ad library: a company's ads", source: "CONNECTED_ACCOUNT", label: "SEEN", cache: "day",
    description: "The company's ads in Meta's ad library for one country (search by brand or page name): start and stop dates, active or not, how long each has run, platforms, headline, text and landing caption. Needs the business's Meta account connected. No spend or results.",
    input: LibraryInput, subject: (i: typeof LibraryInput.Type) => i.query.toLowerCase(), run: (ctx, i: typeof LibraryInput.Type) => libraryRun(ctx, i),
    availability: ctx => Effect.map(metaLibraryAccess(ctx.accountId).pipe(Effect.orElseSucceed(() => null)), a => a ? null : "Needs the business's Meta account connected on the Channels page") },
  { id: "search.results", platform: "search", title: "Who shows up for a search", source: "PUBLIC_WEB", label: "SEEN", cache: "day",
    description: "Result positions, domains and titles for one search through this server's web search, and where a given domain appears. A snapshot, not a ranking report.",
    input: SearchInput, subject: (i: typeof SearchInput.Type) => i.query.toLowerCase(), run: (ctx, i: typeof SearchInput.Type) => searchRun(ctx, i),
    availability: () => Effect.map(webAccess, w => w.search ? null : "No web search provider is configured on this server") },
]
