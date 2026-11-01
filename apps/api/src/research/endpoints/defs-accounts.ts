// Endpoints on the business's own accounts: YouTube Data and Chrome real-user
// metrics (its Google Cloud key), PageSpeed Insights, Reddit (its app),
// Product Hunt (its token) and Bing Webmaster (its own site).
import { Schema } from "effect"
import { isoDate } from "../html.js"
import { normalizeDomain, normalizeUrl } from "../inputs.js"
import { arr, none, num, obj, ok, txt } from "./defs-public.js"
import type { AnyEndpoint } from "./types.js"

const Str = (max: number, pattern?: RegExp) => pattern ? Schema.String.pipe(Schema.minLength(1), Schema.maxLength(max), Schema.pattern(pattern)) : Schema.String.pipe(Schema.minLength(1), Schema.maxLength(max))
const Url = Schema.String.pipe(Schema.maxLength(2000), Schema.filter(s => normalizeUrl(s) !== null, { message: () => "a public page address" }))
const Channel = Schema.Struct({ handle: Schema.optional(Str(100, /^@?[A-Za-z0-9._-]{2,100}$/)), channelId: Schema.optional(Str(30, /^UC[A-Za-z0-9_-]{22}$/)) })
const Uploads = Schema.Struct({ channelId: Str(30, /^UC[A-Za-z0-9_-]{22}$/), limit: Schema.optional(Schema.Int.pipe(Schema.between(1, 50))) })
const Videos = Schema.Struct({ ids: Schema.Array(Str(15, /^[A-Za-z0-9_-]{11}$/)).pipe(Schema.minItems(1), Schema.maxItems(50)) })
const YtSearch = Schema.Struct({ query: Str(150), region: Schema.optional(Str(2, /^[A-Z]{2}$/)), limit: Schema.optional(Schema.Int.pipe(Schema.between(1, 25))) })
const Origin = Schema.Struct({ origin: Url, formFactor: Schema.optional(Schema.Literal("PHONE", "DESKTOP")) })
const Psi = Schema.Struct({ url: Url, strategy: Schema.optional(Schema.Literal("mobile", "desktop")) })
const RedditSearch = Schema.Struct({ query: Str(150), period: Schema.optional(Schema.Literal("week", "month", "year", "all")), limit: Schema.optional(Schema.Int.pipe(Schema.between(1, 100))) })
const Subreddit = Schema.Struct({ name: Str(21, /^[A-Za-z0-9_]{2,21}$/) })
const PhPost = Schema.Struct({ slug: Str(120, /^[a-z0-9-]+$/) })
const Site = Schema.Struct({ siteUrl: Url })
const msDate = (v: unknown) => { const m = String(v ?? "").match(/\/Date\((\d+)/); return m ? new Date(Number(m[1])).toISOString().slice(0, 10) : null }
const metric = (m: unknown) => { const p = obj(obj(m)["percentiles"]); return num(p["p75"]) }

export const ACCOUNT_ENDPOINTS: ReadonlyArray<AnyEndpoint> = [
  { id: "social.youtube.channel", provider: "google_api", platform: "social", title: "YouTube channel statistics", label: "SEEN", input: Channel, docs: "https://developers.google.com/youtube/v3/docs/channels/list",
    description: "A YouTube channel's subscribers, total views, video count, creation date and uploads playlist, by handle or channel id (official YouTube Data API on the business's own key).",
    subject: (i: typeof Channel.Type) => i.channelId ?? i.handle ?? "channel",
    request: (i: typeof Channel.Type) => ({ method: "GET", url: "https://www.googleapis.com/youtube/v3/channels", query: { part: "snippet,statistics,contentDetails", ...(i.channelId ? { id: i.channelId } : { forHandle: i.handle?.startsWith("@") ? i.handle : `@${i.handle}` }) } }),
    parse: j => { const c = obj(arr(obj(j)["items"])[0]); if (!c["id"]) return none("No such channel."); const s = obj(c["statistics"]), sn = obj(c["snippet"])
      return ok({ label: "SEEN", channelId: txt(c["id"], 30), title: txt(sn["title"]), created: isoDate(sn["publishedAt"])?.slice(0, 10) ?? null, subscribers: s["hiddenSubscriberCount"] ? null : num(s["subscriberCount"]),
        views: num(s["viewCount"]), videos: num(s["videoCount"]), uploadsPlaylist: txt(obj(obj(c["contentDetails"])["relatedPlaylists"])["uploads"], 40) }, { note: "Counts as YouTube reports them now (subscriber counts are rounded)." }) } },
  { id: "social.youtube.uploads", provider: "google_api", platform: "social", title: "YouTube uploads with dates", label: "SEEN", input: Uploads, docs: "https://developers.google.com/youtube/v3/docs/playlistItems/list",
    description: "A channel's latest uploads (up to 50) with publish dates and titles: video publishing cadence. Combine with social.youtube.videos for views.", subject: (i: typeof Uploads.Type) => i.channelId,
    request: (i: typeof Uploads.Type) => ({ method: "GET", url: "https://www.googleapis.com/youtube/v3/playlistItems", query: { part: "snippet,contentDetails", playlistId: `UU${i.channelId.slice(2)}`, maxResults: i.limit ?? 25 } }),
    parse: j => { const rows = arr(obj(j)["items"]).map(x => { const it = obj(x), sn = obj(it["snippet"]), cd = obj(it["contentDetails"]); return { videoId: txt(cd["videoId"], 15), title: txt(sn["title"]), published: isoDate(cd["videoPublishedAt"] ?? sn["publishedAt"])?.slice(0, 10) ?? null } }).filter(v => v.published)
      return rows.length ? ok({ label: "SEEN", videos: rows, timeline: rows.slice(0, 15).map(v => ({ date: `${v.published}T00:00:00.000Z`, event: `YouTube upload: ${v.title}`, label: "SEEN" })) }) : none("No uploads.") } },
  { id: "social.youtube.videos", provider: "google_api", platform: "social", title: "YouTube video statistics", label: "SEEN", input: Videos, docs: "https://developers.google.com/youtube/v3/docs/videos/list",
    description: "Views, likes and comments of up to 50 YouTube videos, with titles and publish dates.", subject: (i: typeof Videos.Type) => i.ids.slice(0, 3).join(","),
    request: (i: typeof Videos.Type) => ({ method: "GET", url: "https://www.googleapis.com/youtube/v3/videos", query: { part: "snippet,statistics", id: i.ids.join(",") } }),
    parse: j => { const rows = arr(obj(j)["items"]).map(x => { const v = obj(x), s = obj(v["statistics"]), sn = obj(v["snippet"]); return { videoId: txt(v["id"], 15), title: txt(sn["title"]), channel: txt(sn["channelTitle"]), published: isoDate(sn["publishedAt"])?.slice(0, 10) ?? null, views: num(s["viewCount"]), likes: num(s["likeCount"]), comments: num(s["commentCount"]) } })
      return rows.length ? ok({ label: "SEEN", videos: rows }) : none("No such videos.") } },
  { id: "social.youtube.search", provider: "google_api", platform: "social", title: "YouTube search", label: "SEEN", input: YtSearch, docs: "https://developers.google.com/youtube/v3/docs/search/list",
    description: "Videos YouTube returns for a search (who shows up for a topic on YouTube), with channels and dates. Costs 100 quota units of the business's key per call.", subject: (i: typeof YtSearch.Type) => i.query.toLowerCase(),
    request: (i: typeof YtSearch.Type) => ({ method: "GET", url: "https://www.googleapis.com/youtube/v3/search", query: { part: "snippet", q: i.query, type: "video", maxResults: i.limit ?? 10, regionCode: i.region } }),
    parse: j => { const rows = arr(obj(j)["items"]).map((x, k) => { const it = obj(x), sn = obj(it["snippet"]); return { position: k + 1, videoId: txt(obj(it["id"])["videoId"], 15), title: txt(sn["title"]), channel: txt(sn["channelTitle"]), published: isoDate(sn["publishedAt"])?.slice(0, 10) ?? null } })
      return rows.length ? ok({ label: "SEEN", results: rows }, { note: "One search, now, as the API returns it; personalized results on youtube.com differ." }) : none("No results.") } },
  { id: "web.chrome.real_users", provider: "google_api", platform: "website", title: "Real-user speed of any website (Chrome)", label: "SEEN", input: Origin, docs: "https://developer.chrome.com/docs/crux/api",
    description: "How fast a site is for its real Chrome visitors over the last 28 days (largest contentful paint, interaction to next paint, layout shift, 75th percentile). No data means the site has too little Chrome traffic to report.",
    subject: (i: typeof Origin.Type) => normalizeDomain(i.origin) ?? i.origin,
    request: (i: typeof Origin.Type) => ({ method: "POST", url: "https://chromeuxreport.googleapis.com/v1/records:queryRecord", body: { origin: new URL(normalizeUrl(i.origin)!).origin, ...(i.formFactor ? { formFactor: i.formFactor } : {}) } }),
    parse: j => { const r = obj(obj(j)["record"]), m = obj(r["metrics"]), p = obj(r["collectionPeriod"])
      if (!Object.keys(m).length) return none("Not enough real Chrome traffic for Google to report this site.")
      const d = (x: unknown) => { const o = obj(x); return `${num(o["year"])}-${String(num(o["month"])).padStart(2, "0")}-${String(num(o["day"])).padStart(2, "0")}` }
      return ok({ label: "SEEN", largestContentfulPaintMs: metric(m["largest_contentful_paint"]), interactionToNextPaintMs: metric(m["interaction_to_next_paint"]), cumulativeLayoutShift: metric(m["cumulative_layout_shift"]),
        firstContentfulPaintMs: metric(m["first_contentful_paint"]), timeToFirstByteMs: metric(m["experimental_time_to_first_byte"]), period: { from: d(p["firstDate"]), to: d(p["lastDate"]) } },
        { note: "Measured from real Chrome users who opted in, 75th percentile. Having data at all means the site has meaningful Chrome traffic; it does not say how much." }) } },
  { id: "web.pagespeed", provider: "pagespeed", platform: "website", title: "PageSpeed test of a page", label: "SEEN", input: Psi, docs: "https://developers.google.com/speed/docs/insights/v5/reference/pagespeedapi/runpagespeed",
    description: "Google's lab performance test of one page (score and key timings), plus real-user field data when available. Takes up to 30 seconds.", subject: (i: typeof Psi.Type) => normalizeUrl(i.url) ?? i.url,
    request: (i: typeof Psi.Type) => ({ method: "GET", url: "https://www.googleapis.com/pagespeedonline/v5/runPagespeed", query: { url: normalizeUrl(i.url)!, strategy: i.strategy ?? "mobile", category: "performance" } }),
    parse: j => { const l = obj(obj(j)["lighthouseResult"]), a = obj(l["audits"]); if (!Object.keys(l).length) return none("The page could not be tested.")
      const v = (k: string) => num(obj(a[k])["numericValue"])
      return ok({ label: "SEEN", performanceScore: (num(obj(obj(l["categories"])["performance"])["score"]) ?? 0) * 100, largestContentfulPaintMs: v("largest-contentful-paint"), totalBlockingTimeMs: v("total-blocking-time"),
        cumulativeLayoutShift: v("cumulative-layout-shift"), speedIndexMs: v("speed-index"), fieldData: txt(obj(obj(j)["loadingExperience"])["overall_category"], 20) }, { note: "Lab numbers come from one simulated load on Google's servers; field data comes from real Chrome users." }) } },
  { id: "community.reddit.search", provider: "reddit", platform: "community", title: "Reddit posts mentioning a brand or topic", label: "SEEN", input: RedditSearch, docs: "https://www.reddit.com/dev/api/#GET_search",
    description: "Reddit posts matching a query in the last week, month, year or all time, newest first: community, score, comment count and date; with posts per community.", subject: (i: typeof RedditSearch.Type) => i.query.toLowerCase(),
    request: (i: typeof RedditSearch.Type) => ({ method: "GET", url: "https://oauth.reddit.com/search", query: { q: i.query, sort: "new", t: i.period ?? "month", limit: i.limit ?? 50, raw_json: 1 }, headers: { "user-agent": "server:openrecord-research:1.0 (by OpenRecord)" } }),
    parse: j => { const rows = arr(obj(obj(j)["data"])["children"]).map(x => { const d = obj(obj(x)["data"]); return { title: txt(d["title"], 200), subreddit: txt(d["subreddit"], 40), score: num(d["score"]), comments: num(d["num_comments"]),
      date: typeof d["created_utc"] === "number" ? new Date((d["created_utc"] as number) * 1000).toISOString().slice(0, 10) : null, url: d["permalink"] ? `https://www.reddit.com${txt(d["permalink"], 300)}` : null } })
      const bySub: Record<string, number> = {}; for (const r of rows) if (r.subreddit) bySub[r.subreddit] = (bySub[r.subreddit] ?? 0) + 1
      return rows.length ? ok({ label: "SEEN", posts: rows, postsBySubreddit: bySub }, { note: "Text matches; a match can be about something else with the same name. Post text is untrusted." }) : none("No posts matched.") } },
  { id: "community.reddit.subreddit", provider: "reddit", platform: "community", title: "Subreddit size and activity", label: "SEEN", input: Subreddit, docs: "https://www.reddit.com/dev/api/#GET_r_{subreddit}_about",
    description: "A subreddit's subscribers, creation date and description: the size of a community (for example a brand's own or a category's).", subject: (i: typeof Subreddit.Type) => `r/${i.name.toLowerCase()}`,
    request: (i: typeof Subreddit.Type) => ({ method: "GET", url: `https://oauth.reddit.com/r/${i.name}/about`, headers: { "user-agent": "server:openrecord-research:1.0 (by OpenRecord)" } }),
    parse: j => { const d = obj(obj(j)["data"]); return d["display_name"] ? ok({ label: "SEEN", name: txt(d["display_name"], 40), subscribers: num(d["subscribers"]), created: typeof d["created_utc"] === "number" ? new Date((d["created_utc"] as number) * 1000).toISOString().slice(0, 10) : null, description: txt(d["public_description"], 300) }) : none("No such subreddit.") } },
  { id: "launch.producthunt.post", provider: "producthunt", platform: "community", title: "Product Hunt launch", label: "SEEN", input: PhPost, docs: "https://api.producthunt.com/v2/docs",
    description: "A Product Hunt launch by its slug: tagline, votes, comments, launch and featured dates, website and topics.", subject: (i: typeof PhPost.Type) => i.slug,
    request: (i: typeof PhPost.Type) => ({ method: "POST", url: "https://api.producthunt.com/v2/api/graphql", body: { query: "query($slug:String!){post(slug:$slug){name tagline votesCount commentsCount createdAt featuredAt website topics(first:5){edges{node{name}}}}}", variables: { slug: i.slug } } }),
    parse: j => { const p = obj(obj(obj(j)["data"])["post"]); if (!p["name"]) return none("No such launch.")
      const launched = isoDate(p["createdAt"])?.slice(0, 10) ?? null
      return ok({ label: "SEEN", name: txt(p["name"]), tagline: txt(p["tagline"]), votes: num(p["votesCount"]), comments: num(p["commentsCount"]), launched, featured: isoDate(p["featuredAt"])?.slice(0, 10) ?? null, website: txt(p["website"], 300),
        topics: arr(obj(p["topics"])["edges"]).map(e => txt(obj(obj(e)["node"])["name"], 60)), ...(launched ? { timeline: [{ date: `${launched}T00:00:00.000Z`, event: `Launched on Product Hunt: ${txt(p["tagline"], 100)}`, label: "SEEN" }] } : {}) }) } },
  { id: "search.bing.queries", provider: "bing_webmaster", platform: "search", title: "Bing search queries for the business's site", label: "SEEN", input: Site, docs: "https://learn.microsoft.com/dotnet/api/microsoft.bing.webmaster.api.interfaces.iwebmasterapi.getquerystats",
    description: "Bing search queries that showed the business's own site: impressions, clicks and average position by query (from its Bing Webmaster account).", subject: (i: typeof Site.Type) => normalizeDomain(i.siteUrl) ?? i.siteUrl,
    request: (i: typeof Site.Type) => ({ method: "GET", url: "https://ssl.bing.com/webmaster/api.svc/json/GetQueryStats", query: { siteUrl: normalizeUrl(i.siteUrl)! } }),
    parse: j => { const rows = arr(obj(j)["d"]).map(x => { const r = obj(x); return { query: txt(r["Query"], 160), impressions: num(r["Impressions"]), clicks: num(r["Clicks"]), averagePosition: num(r["AvgImpressionPosition"]), date: msDate(r["Date"]) } })
      return rows.length ? ok({ label: "SEEN", queries: rows.sort((a, b) => (b.impressions ?? 0) - (a.impressions ?? 0)).slice(0, 50) }, { note: "Bing search only, as Bing measures it for the verified site." }) : none("No Bing query data for this site.") } },
  { id: "search.bing.traffic", provider: "bing_webmaster", platform: "search", title: "Bing clicks and impressions over time", label: "SEEN", input: Site, docs: "https://learn.microsoft.com/dotnet/api/microsoft.bing.webmaster.api.interfaces.iwebmasterapi.getrankandtrafficstats",
    description: "Daily Bing search clicks and impressions for the business's own site.", subject: (i: typeof Site.Type) => normalizeDomain(i.siteUrl) ?? i.siteUrl,
    request: (i: typeof Site.Type) => ({ method: "GET", url: "https://ssl.bing.com/webmaster/api.svc/json/GetRankAndTrafficStats", query: { siteUrl: normalizeUrl(i.siteUrl)! } }),
    parse: j => { const rows = arr(obj(j)["d"]).map(x => { const r = obj(x); return { date: msDate(r["Date"]), clicks: num(r["Clicks"]), impressions: num(r["Impressions"]) } }).filter(r => r.date).sort((a, b) => a.date!.localeCompare(b.date!))
      return rows.length ? ok({ label: "SEEN", days: rows.slice(-120) }) : none("No Bing traffic data for this site.") } },
]

const Days = Schema.optional(Schema.Literal(7, 28, 90, 365))
const window = (days: number, now: Date, lagDays = 0) => { const end = new Date(now.getTime() - lagDays * 86_400_000), start = new Date(end.getTime() - (days - 1) * 86_400_000); return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) } }
const Ga4Report = Schema.Struct({ property: Str(20, /^\d{4,20}$/), dimensions: Schema.optional(Schema.Array(Str(60, /^[A-Za-z0-9_:]+$/)).pipe(Schema.maxItems(4))),
  metrics: Schema.Array(Str(60, /^[A-Za-z0-9_:]+$/)).pipe(Schema.minItems(1), Schema.maxItems(8)), days: Days, limit: Schema.optional(Schema.Int.pipe(Schema.between(1, 250))) })
const ScQuery = Schema.Struct({ siteUrl: Str(300, /^(https?:\/\/\S+|sc-domain:[a-z0-9.-]+)$/), dimensions: Schema.optional(Schema.Array(Schema.Literal("query", "page", "country", "device", "date", "searchAppearance")).pipe(Schema.maxItems(3))),
  days: Days, limit: Schema.optional(Schema.Int.pipe(Schema.between(1, 1000))) })
const GbpReviews = Schema.Struct({ account: Str(30, /^\d{3,30}$/), location: Str(30, /^\d{3,30}$/) })
const STARS: Readonly<Record<string, number>> = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 }

export const CONNECTED_GOOGLE_ENDPOINTS: ReadonlyArray<AnyEndpoint> = [
  { id: "analytics.report", provider: "google_analytics", platform: "analytics", title: "Google Analytics report (any dimensions and metrics)", label: "SEEN", input: Ga4Report, docs: "https://developers.google.com/analytics/devguides/reporting/data/v1/rest/v1beta/properties/runReport",
    description: "A report from the business's own Google Analytics property for the last 7, 28, 90 or 365 days: any of GA4's dimensions (for example sessionSource, landingPage, country) and metrics (sessions, totalUsers, conversions, keyEvents, totalRevenue). Read-only.",
    subject: (i: typeof Ga4Report.Type) => `property ${i.property}`,
    request: (i: typeof Ga4Report.Type, now: Date) => { const w = window(i.days ?? 28, now, 1)
      return { method: "POST", url: `https://analyticsdata.googleapis.com/v1beta/properties/${i.property}:runReport`, body: { dateRanges: [{ startDate: w.start, endDate: w.end }],
        dimensions: (i.dimensions ?? []).map(name => ({ name })), metrics: i.metrics.map(name => ({ name })), limit: i.limit ?? 50, metricAggregations: ["TOTAL"] } } },
    parse: j => { const o = obj(j), dh = arr(o["dimensionHeaders"]).map(h => txt(obj(h)["name"], 60) ?? ""), mh = arr(o["metricHeaders"]).map(h => txt(obj(h)["name"], 60) ?? "")
      const row = (r: unknown) => Object.fromEntries([...arr(obj(r)["dimensionValues"]).map((v, k) => [dh[k], txt(obj(v)["value"], 200)]), ...arr(obj(r)["metricValues"]).map((v, k) => [mh[k], num(obj(v)["value"])])])
      const rows = arr(o["rows"]).map(row)
      return rows.length || arr(o["totals"]).length ? ok({ label: "SEEN", rows, totals: arr(o["totals"]).map(row)[0] ?? null, rowCount: num(o["rowCount"]) }, { note: "As Google Analytics measured it for the property; definitions follow the property's settings." }) : none("No data for this report.") } },
  { id: "search.console.query", provider: "google_search_console", platform: "search", title: "Search Console query (any dimensions)", label: "SEEN", input: ScQuery, docs: "https://developers.google.com/webmaster-tools/v1/searchanalytics/query",
    description: "Google Search clicks, impressions, click-through rate and average position for the business's own site, by query, page, country, device, date or search appearance, for the last 7, 28, 90 or 365 days.",
    subject: (i: typeof ScQuery.Type) => i.siteUrl,
    request: (i: typeof ScQuery.Type, now: Date) => { const w = window(i.days ?? 28, now, 3)
      return { method: "POST", url: `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(i.siteUrl)}/searchAnalytics/query`, body: { startDate: w.start, endDate: w.end, dimensions: i.dimensions ?? ["query"], rowLimit: i.limit ?? 100 } } },
    parse: (j, i: typeof ScQuery.Type) => { const dims = i.dimensions ?? ["query"]
      const rows = arr(obj(j)["rows"]).map(x => { const r = obj(x); return { ...Object.fromEntries(arr(r["keys"]).map((k, n) => [dims[n] ?? `key${n}`, txt(k, 300)])), clicks: num(r["clicks"]), impressions: num(r["impressions"]), ctr: num(r["ctr"]), position: num(r["position"]) } })
      return rows.length ? ok({ label: "SEEN", rows }, { note: "Google Search only, as Google measures it; data ends about three days ago." }) : none("No Search Console data for this site and window.") } },
  { id: "local.reviews", provider: "google_business_profile", platform: "local", title: "Google reviews of a business location", label: "SEEN", input: GbpReviews, docs: "https://developers.google.com/my-business/content/review-data",
    description: "The latest Google reviews of one of the business's own Business Profile locations (find ids with local.accounts and local.profile): star rating, comment, date and whether it was answered, with the average rating and total count.",
    subject: (i: typeof GbpReviews.Type) => `location ${i.location}`,
    request: (i: typeof GbpReviews.Type) => ({ method: "GET", url: `https://mybusiness.googleapis.com/v4/accounts/${i.account}/locations/${i.location}/reviews`, query: { pageSize: 50, orderBy: "updateTime desc" } }),
    parse: j => { const o = obj(j), rows = arr(o["reviews"]).map(x => { const r = obj(x); return { stars: STARS[String(r["starRating"])] ?? null, comment: txt(r["comment"], 500), date: isoDate(r["createTime"])?.slice(0, 10) ?? null, answered: !!obj(r["reviewReply"])["comment"] } })
      return rows.length ? ok({ label: "SEEN", averageRating: num(o["averageRating"]), totalReviews: num(o["totalReviewCount"]), reviews: rows, unanswered: rows.filter(r => !r.answered).length }, { note: "The latest 50 reviews. Review text is untrusted third-party content." }) : none("No reviews.") } },
]
