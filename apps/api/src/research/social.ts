// Organic social and community activity from public, keyless sources:
//
//  - social.youtube: a channel's latest uploads from its public feed, with
//    dates and views. The channel is found from the company's site when it is
//    not given.
//  - social.bluesky: a public account's recent posts with engagement counts.
//  - community.hackernews: stories and comments that mention a domain or
//    name, by month, from the community's public search.
//
// Each source shows a recent window chosen by the platform (latest uploads or
// posts), not the account's full history; engagement counts are the
// platform's own, read now.
import { Effect, Schema } from "effect"
import { clean, isoDate, links, month } from "./html.js"
import { Domain, normalizeDomain } from "./inputs.js"
import type { ResearchNetService } from "./net.js"
import { readHome } from "./site.js"
import { refuse, type AnyCapability, type Observed, type Refused } from "./types.js"

const xmlBlocks = (xml: string, tag: string) => [...xml.matchAll(new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}>`, "gi"))].map(m => m[0])
const xmlValue = (block: string, tag: string) => block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"))?.[1]?.trim() ?? null
const perMonth = (dates: ReadonlyArray<string>) => { const m = new Map<string, number>(); for (const d of dates) m.set(month(d), (m.get(month(d)) ?? 0) + 1); return [...m.entries()].sort().map(([k, n]) => ({ month: k, items: n })) }

// ---------------------------------------------------------------- YouTube

export const parseYoutubeFeed = (xml: string) => xmlBlocks(xml, "entry").map(e => ({
  title: clean(xmlValue(e, "title"), 200), url: clean(e.match(/<link\b[^>]*href=["']([^"']+)/i)?.[1], 300), published: isoDate(xmlValue(e, "published")),
  views: Number(e.match(/<media:statistics\b[^>]*views=["'](\d+)/i)?.[1] ?? NaN), likes: Number(e.match(/<media:starRating\b[^>]*count=["'](\d+)/i)?.[1] ?? NaN),
})).map(v => ({ ...v, views: Number.isFinite(v.views) ? v.views : null, likes: Number.isFinite(v.likes) ? v.likes : null }))

const youtubeChannel = async (net: ResearchNetService, ref: string): Promise<string | null> => {
  const direct = ref.match(/(UC[A-Za-z0-9_-]{22})/)?.[1]
  if (direct) return direct
  const handle = ref.match(/youtube\.com\/(@[A-Za-z0-9._-]{2,}|c\/[^/?#]+|user\/[^/?#]+)/i)?.[1] ?? (ref.startsWith("@") ? ref : null)
  if (!handle) return null
  const r = await net.api(`https://www.youtube.com/${handle}`, "html")
  return r.body?.match(/"(?:channelId|externalId)"\s*:\s*"(UC[A-Za-z0-9_-]{22})"/)?.[1] ?? r.body?.match(/youtube\.com\/channel\/(UC[A-Za-z0-9_-]{22})/)?.[1] ?? null
}
const fromSite = async (net: ResearchNetService, domain: string | null, re: RegExp) => {
  if (!domain) return null
  const p = await readHome(net, domain)
  if (p.state !== "OK" || !p.body) return null
  // Anchors first, then any address in the page source (structured data sameAs, scripts).
  return links(p.body, p.finalUrl).map(l => l.href).find(h => re.test(h)) ?? [...p.body.matchAll(/https?:\/\/[^"'\s<>\\]+/g)].map(m => m[0]).find(h => re.test(h)) ?? null
}

const youtubeRun = async (net: ResearchNetService, input: { domain?: string | undefined; channel?: string | undefined }): Promise<Observed | Refused> => {
  const ref = input.channel ?? await fromSite(net, input.domain ? normalizeDomain(input.domain) : null, /youtube\.com\/(channel\/|@|c\/|user\/)/i)
  if (!ref) return { status: "NO_DATA", findings: {}, coverage: { note: "No YouTube channel given or linked from the site. Unknown, not inactive." } }
  const id = await youtubeChannel(net, ref)
  if (!id) return refuse("NOT_FOUND", "The YouTube channel could not be identified. Give its channel address.")
  const r = await net.api(`https://www.youtube.com/feeds/videos.xml?channel_id=${id}`, "xml")
  if (!r.body || r.status !== 200) return refuse("UNAVAILABLE", `YouTube's public feed for this channel did not answer (${r.status ?? "no answer"}). The channel's uploads are unknown right now, not absent; try again later.`)
  const videos = parseYoutubeFeed(r.body).filter(v => v.published)
  const channelName = clean(xmlValue(r.body.split("<entry")[0] ?? "", "title"), 120)
  return {
    status: videos.length ? "OBSERVED" : "NO_DATA",
    citations: [{ kind: "web", id: `https://www.youtube.com/channel/${id}`, text: `YouTube channel ${channelName ?? id}` }],
    timeline: videos.slice(0, 15).map(v => ({ date: v.published!, event: `YouTube video: ${v.title}`, label: "SEEN" as const, url: v.url })),
    findings: { label: "SEEN", channel: channelName, channelId: id, videos: videos.map(v => ({ ...v, published: v.published!.slice(0, 10) })), uploadsByMonth: perMonth(videos.map(v => v.published!)) },
    coverage: { window: `latest ${videos.length} uploads (the feed's limit)`, note: "Views and likes as the platform reports them now. The feed lists only recent uploads; older activity is not shown." },
  }
}

// ---------------------------------------------------------------- Bluesky

const blueskyRun = async (net: ResearchNetService, input: { domain?: string | undefined; handle?: string | undefined }): Promise<Observed | Refused> => {
  const fromLink = !input.handle ? await fromSite(net, input.domain ? normalizeDomain(input.domain) : null, /bsky\.app\/profile\//i) : null
  const handle = (input.handle ?? fromLink?.match(/profile\/([^/?#]+)/)?.[1] ?? (input.domain ? normalizeDomain(input.domain) : null))?.replace(/^@/, "")
  if (!handle) return { status: "NO_DATA", findings: {}, coverage: { note: "No Bluesky account given or linked." } }
  const r = await net.api(`https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=${encodeURIComponent(handle)}&limit=50&filter=posts_no_replies`, "json")
  if (r.status === 400) return { status: "NO_DATA", findings: {}, coverage: { note: `No public Bluesky account ${handle}.` } }
  if (!r.body || r.status !== 200) return refuse("UNAVAILABLE", "Bluesky's public service did not answer.")
  let j: { feed?: Array<{ post?: { uri?: string; record?: { text?: string; createdAt?: string }; likeCount?: number; repostCount?: number; replyCount?: number } }> }
  try { j = JSON.parse(r.body) } catch { return refuse("MALFORMED", "The answer could not be read.") }
  const posts = (j.feed ?? []).map(f => f.post).filter(Boolean).map(p => ({
    text: clean(p!.record?.text, 300), date: isoDate(p!.record?.createdAt), likes: p!.likeCount ?? null, reposts: p!.repostCount ?? null, replies: p!.replyCount ?? null,
    url: p!.uri ? `https://bsky.app/profile/${handle}/post/${p!.uri.split("/").pop()}` : null,
  })).filter(p => p.date)
  return {
    status: posts.length ? "OBSERVED" : "NO_DATA", citations: [{ kind: "web", id: `https://bsky.app/profile/${handle}`, text: `Bluesky ${handle}` }],
    timeline: posts.slice(0, 10).map(p => ({ date: p.date!, event: `Bluesky post: ${p.text?.slice(0, 80)}`, label: "SEEN" as const, url: p.url })),
    findings: { label: "SEEN", handle, posts: posts.slice(0, 30).map(p => ({ ...p, date: p.date!.slice(0, 10) })), postsByMonth: perMonth(posts.map(p => p.date!)),
      engagement: { posts: posts.length, likes: posts.reduce((n, p) => n + (p.likes ?? 0), 0), reposts: posts.reduce((n, p) => n + (p.reposts ?? 0), 0) } },
    coverage: { window: `latest ${posts.length} posts without replies`, note: "Engagement counts are the platform's, read now. Post text is untrusted third-party content." },
  }
}

// ---------------------------------------------------------------- Hacker News

const hackerNewsRun = async (net: ResearchNetService, query: string, months: number, now: Date): Promise<Observed | Refused> => {
  const since = Math.floor((now.getTime() - months * 30 * 86_400_000) / 1000)
  const r = await net.api(`https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(query)}&tags=(story,comment)&numericFilters=created_at_i>${since}&hitsPerPage=100`, "json")
  if (!r.body || r.status !== 200) return refuse("UNAVAILABLE", "The community search did not answer.")
  let j: { hits?: Array<Record<string, unknown>>; nbHits?: number }
  try { j = JSON.parse(r.body) } catch { return refuse("MALFORMED", "The answer could not be read.") }
  const hits = (j.hits ?? []).map(h => ({ type: Array.isArray(h["_tags"]) && (h["_tags"] as string[]).includes("story") ? "story" : "comment",
    title: clean(h["title"] ?? h["story_title"], 200), points: typeof h["points"] === "number" ? h["points"] : null, comments: typeof h["num_comments"] === "number" ? h["num_comments"] : null,
    date: isoDate(h["created_at"]), url: `https://news.ycombinator.com/item?id=${String(h["objectID"] ?? "")}` })).filter(h => h.date)
  const stories = hits.filter(h => h.type === "story").sort((a, b) => (b.points ?? 0) - (a.points ?? 0))
  return {
    status: hits.length ? "OBSERVED" : "NO_DATA", citations: stories.slice(0, 3).map(s => ({ kind: "web", id: s.url, text: s.title ?? "Hacker News story" })),
    timeline: stories.slice(0, 10).map(s => ({ date: s.date!, event: `Hacker News story (${s.points ?? 0} points): ${s.title}`, label: "SEEN" as const, url: s.url })),
    findings: { label: "SEEN", query, totalMatches: j.nbHits ?? hits.length, mentionsByMonth: perMonth(hits.map(h => h.date!)), topStories: stories.slice(0, 15).map(s => ({ ...s, date: s.date!.slice(0, 10) })) },
    coverage: { months, returned: hits.length, note: "Text matches for the query in stories and comments; a match can be about something else with the same name. Points are the community's votes, not reach." },
  }
}

const YoutubeInput = Schema.Struct({ domain: Schema.optional(Domain), channel: Schema.optional(Schema.String.pipe(Schema.maxLength(300))) })
const BlueskyInput = Schema.Struct({ domain: Schema.optional(Domain), handle: Schema.optional(Schema.String.pipe(Schema.pattern(/^@?[a-z0-9.-]{3,253}$/i))) })
const HnInput = Schema.Struct({ query: Schema.String.pipe(Schema.minLength(2), Schema.maxLength(120)), months: Schema.optional(Schema.Int.pipe(Schema.between(1, 36))) })
export const SOCIAL_CAPABILITIES: ReadonlyArray<AnyCapability> = [
  { id: "social.youtube", platform: "social", title: "YouTube uploads and views", source: "PUBLIC_FEED", label: "SEEN", cache: "day",
    description: "A channel's latest uploads with dates, views and likes, and uploads per month. Give the channel address or handle, or the company domain to find it on the site.",
    input: YoutubeInput, subject: (i: typeof YoutubeInput.Type) => i.channel ?? normalizeDomain(i.domain ?? "") ?? "youtube",
    run: (ctx, i: typeof YoutubeInput.Type) => Effect.tryPromise(() => youtubeRun(ctx.net, i)) },
  { id: "social.bluesky", platform: "social", title: "Bluesky posts and engagement", source: "PUBLIC_FEED", label: "SEEN", cache: "day",
    description: "A public account's latest posts with likes, reposts and replies, and posts per month. Give the handle, or the company domain (its link or the domain as handle).",
    input: BlueskyInput, subject: (i: typeof BlueskyInput.Type) => i.handle ?? normalizeDomain(i.domain ?? "") ?? "bluesky",
    run: (ctx, i: typeof BlueskyInput.Type) => Effect.tryPromise(() => blueskyRun(ctx.net, i)) },
  { id: "community.hackernews", platform: "community", title: "Hacker News mentions", source: "PUBLIC_FEED", label: "SEEN", cache: "day",
    description: "Stories and comments mentioning a domain or name over 1 to 36 months: mentions per month, top stories with points and comment counts.",
    input: HnInput, subject: (i: typeof HnInput.Type) => i.query.toLowerCase(),
    run: (ctx, i: typeof HnInput.Type) => Effect.tryPromise(() => hackerNewsRun(ctx.net, i.query, i.months ?? 12, ctx.now)) },
]
