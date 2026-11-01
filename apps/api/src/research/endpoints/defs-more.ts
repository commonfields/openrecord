// More official endpoints: the business's own Meta ad accounts (its existing
// Meta connection, read-only ads scope), Bluesky's public API, and Wikimedia
// search, edit activity and top articles.
import { Schema } from "effect"
import { compactJson } from "./generated.js"
import { arr, none, num, obj, ok, txt } from "./defs-public.js"
import type { AnyEndpoint, Parsed } from "./types.js"

const Str = (max: number, pattern?: RegExp) => pattern ? Schema.String.pipe(Schema.minLength(1), Schema.maxLength(max), Schema.pattern(pattern)) : Schema.String.pipe(Schema.minLength(1), Schema.maxLength(max))
const graph = () => `https://graph.facebook.com/${/^v\d+\.\d+$/.test(process.env["META_GRAPH_VERSION"] ?? "") ? process.env["META_GRAPH_VERSION"] : "v23.0"}`
const generic = (json: unknown): Parsed => {
  const o = obj(json), list = Array.isArray(json) ? json : arr(o["data"]).length || Array.isArray(o["data"]) ? arr(o["data"]) : null
  if (list && !list.length) return none("Nothing returned. Not listed is not zero.")
  return ok({ label: "SEEN", ...(list ? { items: compactJson(list), count: list.length } : { result: compactJson(json) }) })
}

// ---------------------------------------------------------------- Meta ads (own accounts)

const Account = Schema.Struct({ account: Str(30, /^(act_)?\d{3,30}$/), limit: Schema.optional(Schema.Int.pipe(Schema.between(1, 100))) })
const Insights = Schema.Struct({
  account: Str(30, /^(act_)?\d{3,30}$/), level: Schema.optional(Schema.Literal("account", "campaign", "adset", "ad")),
  period: Schema.optional(Schema.Literal("last_7d", "last_28d", "last_90d", "this_month", "last_month", "this_year")),
  breakdown: Schema.optional(Schema.Literal("age", "gender", "country", "region", "publisher_platform", "platform_position", "device_platform", "impression_device")),
  daily: Schema.optional(Schema.Boolean), limit: Schema.optional(Schema.Int.pipe(Schema.between(1, 200))),
})
const act = (a: string) => a.startsWith("act_") ? a : `act_${a}`
const metaEndpoint = (id: string, title: string, description: string, path: (i: typeof Account.Type) => string, fields: string): AnyEndpoint => ({
  id, provider: "meta_ads", platform: "advertising", title, label: "SEEN", input: Account, docs: "https://developers.facebook.com/docs/marketing-api", description,
  subject: (i: typeof Account.Type) => act(i.account), request: (i: typeof Account.Type) => ({ method: "GET", url: `${graph()}/${path(i)}`, query: { fields, limit: i.limit ?? 50 } }), parse: generic,
})
export const META_ENDPOINTS: ReadonlyArray<AnyEndpoint> = [
  { id: "ads.meta.accounts", provider: "meta_ads", platform: "advertising", title: "Meta ad accounts", label: "SEEN", input: Schema.Struct({}), docs: "https://developers.facebook.com/docs/marketing-api/reference/user/adaccounts",
    description: "The Meta ad accounts the business's connected Meta login can read: id, name, currency, status and lifetime spend.", subject: () => "meta ad accounts",
    request: () => ({ method: "GET", url: `${graph()}/me/adaccounts`, query: { fields: "id,name,currency,account_status,amount_spent,timezone_name", limit: 50 } }), parse: generic },
  metaEndpoint("ads.meta.campaigns", "Meta campaigns of an ad account", "Campaigns of one of the business's own Meta ad accounts: objective, status, budgets, start and stop dates.", i => `${act(i.account)}/campaigns`, "id,name,objective,status,effective_status,daily_budget,lifetime_budget,start_time,stop_time,created_time"),
  metaEndpoint("ads.meta.adsets", "Meta ad sets of an ad account", "Ad sets of one of the business's own Meta ad accounts: optimization goal, billing, budget, schedule and targeting summary.", i => `${act(i.account)}/adsets`, "id,name,campaign_id,status,optimization_goal,billing_event,daily_budget,lifetime_budget,start_time,end_time,targeting"),
  metaEndpoint("ads.meta.ads", "Meta ads with their creative", "Ads of one of the business's own Meta ad accounts with the creative's title, text, link and call to action.", i => `${act(i.account)}/ads`, "id,name,status,effective_status,adset_id,created_time,creative{id,title,body,object_url,call_to_action_type,thumbnail_url}"),
  { id: "ads.meta.insights", provider: "meta_ads", platform: "advertising", title: "Meta ads results with breakdowns", label: "SEEN", input: Insights, docs: "https://developers.facebook.com/docs/marketing-api/insights",
    description: "Results of one of the business's own Meta ad accounts at account, campaign, ad set or ad level for a period: spend, impressions, reach, frequency, clicks, CTR, CPC, CPM and actions, optionally by age, gender, country, region, platform, placement or device, or by day. Meta's own attribution.",
    subject: (i: typeof Insights.Type) => act(i.account),
    request: (i: typeof Insights.Type) => ({ method: "GET", url: `${graph()}/${act(i.account)}/insights`, query: { level: i.level ?? "campaign", date_preset: i.period ?? "last_28d", breakdowns: i.breakdown, time_increment: i.daily ? 1 : undefined, limit: i.limit ?? 100,
      fields: "account_name,campaign_name,adset_name,ad_name,spend,impressions,reach,frequency,clicks,ctr,cpc,cpm,actions,date_start,date_stop" } }),
    parse: j => { const rows = arr(obj(j)["data"]).map(x => { const r = obj(x); return { ...Object.fromEntries(Object.entries(r).filter(([k]) => !["actions"].includes(k)).map(([k, v]) => [k, typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : txt(v, 160)])),
      actions: Object.fromEntries(arr(r["actions"]).map(a => [txt(obj(a)["action_type"], 60) ?? "", num(obj(a)["value"])])) } })
      return rows.length ? ok({ label: "SEEN", rows }, { note: "Meta's own measurement and attribution; its conversions overlap with other platforms' and must not be added to them." }) : none("No delivery in this period.") } },
]

// ---------------------------------------------------------------- Bluesky (public)

const BSKY = "https://public.api.bsky.app/xrpc"
const LIST_KEYS = new Set(["followers", "follows", "feeds", "lists", "starterPacks", "actors", "posts", "likes", "repostedBy"])
const Actor = Schema.Struct({ actor: Str(253, /^@?[A-Za-z0-9.:-]{3,253}$/), limit: Schema.optional(Schema.Int.pipe(Schema.between(1, 100))) })
const Query = Schema.Struct({ q: Str(200), limit: Schema.optional(Schema.Int.pipe(Schema.between(1, 100))) })
const Uri = Schema.Struct({ uri: Str(300, /^at:\/\/[A-Za-z0-9.:/_-]+$/), limit: Schema.optional(Schema.Int.pipe(Schema.between(1, 100))) })
const bsky = (id: string, method: string, title: string, description: string, input: typeof Actor | typeof Query | typeof Uri, key: "actor" | "q" | "uri"): AnyEndpoint => ({
  id, provider: "bluesky", platform: "social", title, label: "SEEN", input, docs: `https://docs.bsky.app/docs/api/${method.replace(/\./g, "-").replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase()}`, description: `${description} Public Bluesky API.`,
  subject: (i: Record<string, unknown>) => String(i[key]).replace(/^@/, "").toLowerCase(),
  request: (i: Record<string, unknown>) => ({ method: "GET", url: `${BSKY}/${method}`, query: { [key]: String(i[key]).replace(/^@/, ""), ...(method.includes("getProfile") ? {} : { limit: (i["limit"] as number | undefined) ?? 50 }) } }),
  // Only the method's own list (followers, feeds, posts...) counts as the result list; a profile's empty labels are not.
  parse: j => { const o = obj(j), key = Object.keys(o).find(k => LIST_KEYS.has(k)), list = key ? arr(o[key]) : null
    if (list && !list.length) return none("Nothing returned."); return ok({ label: "SEEN", ...(list ? { items: compactJson(list), count: list.length } : { result: compactJson(o) }) }) },
})
export const BLUESKY_ENDPOINTS: ReadonlyArray<AnyEndpoint> = [
  bsky("social.bluesky.profile", "app.bsky.actor.getProfile", "Bluesky profile", "A Bluesky account's display name, description, followers, follows and post counts.", Actor, "actor"),
  bsky("social.bluesky.search_accounts", "app.bsky.actor.searchActors", "Find Bluesky accounts", "Bluesky accounts matching a name or term.", Query, "q"),
  bsky("social.bluesky.followers", "app.bsky.graph.getFollowers", "Bluesky followers", "The latest followers of a Bluesky account.", Actor, "actor"),
  bsky("social.bluesky.follows", "app.bsky.graph.getFollows", "Bluesky follows", "The accounts a Bluesky account follows.", Actor, "actor"),
  bsky("social.bluesky.thread", "app.bsky.feed.getPostThread", "Bluesky post thread", "A Bluesky post with its replies and engagement.", Uri, "uri"),
  bsky("social.bluesky.likes", "app.bsky.feed.getLikes", "Who liked a Bluesky post", "The accounts that liked a Bluesky post.", Uri, "uri"),
  bsky("social.bluesky.reposts", "app.bsky.feed.getRepostedBy", "Who reposted a Bluesky post", "The accounts that reposted a Bluesky post.", Uri, "uri"),
  bsky("social.bluesky.feeds", "app.bsky.feed.getActorFeeds", "Bluesky custom feeds of an account", "Custom feeds an account publishes.", Actor, "actor"),
  bsky("social.bluesky.lists", "app.bsky.graph.getLists", "Bluesky lists of an account", "Lists an account maintains.", Actor, "actor"),
  bsky("social.bluesky.starter_packs", "app.bsky.graph.getActorStarterPacks", "Bluesky starter packs of an account", "Starter packs an account created (a community-growth tool).", Actor, "actor"),
  bsky("social.bluesky.search_posts", "app.bsky.feed.searchPosts", "Search Bluesky posts", "Bluesky posts matching a term, newest first (the public service may require sign-in for search; then it says so).", Query, "q"),
]

// ---------------------------------------------------------------- Wikimedia extras

const WikiSearch = Schema.Struct({ query: Str(200), lang: Schema.optional(Schema.String.pipe(Schema.pattern(/^[a-z]{2,3}$/))) })
const WikiEdits = Schema.Struct({ title: Str(200), lang: Schema.optional(Schema.String.pipe(Schema.pattern(/^[a-z]{2,3}$/))), months: Schema.optional(Schema.Int.pipe(Schema.between(1, 36))) })
const WikiTop = Schema.Struct({ year: Schema.Int.pipe(Schema.between(2016, 2100)), month: Schema.Int.pipe(Schema.between(1, 12)), lang: Schema.optional(Schema.String.pipe(Schema.pattern(/^[a-z]{2,3}$/))) })
const ym = (d: Date) => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}01`
export const WIKI_MORE: ReadonlyArray<AnyEndpoint> = [
  { id: "wiki.search", provider: "wikimedia", platform: "reference", title: "Wikipedia search", label: "SEEN", input: WikiSearch, docs: "https://www.mediawiki.org/wiki/API:Search",
    description: "Wikipedia articles matching a term with snippets and sizes: whether a company, product or category has articles and which.", subject: (i: typeof WikiSearch.Type) => i.query.toLowerCase(),
    request: (i: typeof WikiSearch.Type) => ({ method: "GET", url: `https://${i.lang ?? "en"}.wikipedia.org/w/api.php`, query: { action: "query", list: "search", srsearch: i.query, format: "json", srlimit: 15 } }),
    parse: j => { const rows = arr(obj(obj(j)["query"])["search"]).map(x => { const r = obj(x); return { title: txt(r["title"]), words: num(r["wordcount"]), snippet: txt(String(r["snippet"] ?? "").replace(/<[^>]+>/g, ""), 200), edited: txt(r["timestamp"], 30) } })
      return rows.length ? ok({ label: "SEEN", articles: rows }) : none("No articles matched.") } },
  { id: "wiki.edits", provider: "wikimedia", platform: "reference", title: "Wikipedia edits by month", label: "SEEN", input: WikiEdits, docs: "https://doc.wikimedia.org/generated-data-platform/aqs/analytics-api/reference/edits.html",
    description: "Monthly edits to a Wikipedia article: how actively its page (often a company's or product's) is being written about.", subject: (i: typeof WikiEdits.Type) => i.title.toLowerCase(),
    request: (i: typeof WikiEdits.Type, now: Date) => ({ method: "GET", url: `https://wikimedia.org/api/rest_v1/metrics/edits/per-page/${i.lang ?? "en"}.wikipedia/${encodeURIComponent(i.title.replace(/ /g, "_"))}/all-editor-types/monthly/${ym(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (i.months ?? 24), 1)))}/${ym(now)}` }),
    parse: j => { const rows = arr(obj(arr(obj(j)["items"])[0])["results"]).map(x => ({ month: txt(obj(x)["timestamp"], 7), edits: num(obj(x)["edits"]) })); return rows.length ? ok({ label: "SEEN", months: rows }) : none("No edit data.") } },
  { id: "wiki.top", provider: "wikimedia", platform: "reference", title: "Most-read Wikipedia articles in a month", label: "SEEN", input: WikiTop, docs: "https://doc.wikimedia.org/generated-data-platform/aqs/analytics-api/reference/page-views.html",
    description: "The most-read Wikipedia articles of a month: what the public was paying attention to.", subject: (i: typeof WikiTop.Type) => `${i.year}-${i.month}`,
    request: (i: typeof WikiTop.Type) => ({ method: "GET", url: `https://wikimedia.org/api/rest_v1/metrics/pageviews/top/${i.lang ?? "en"}.wikipedia/all-access/${i.year}/${String(i.month).padStart(2, "0")}/all-days` }),
    parse: j => { const rows = arr(obj(arr(obj(j)["items"])[0])["articles"]).slice(0, 50).map(x => ({ article: txt(obj(x)["article"]), views: num(obj(x)["views"]), rank: num(obj(x)["rank"]) })); return rows.length ? ok({ label: "SEEN", articles: rows }) : none("No data for that month.") } },
]
