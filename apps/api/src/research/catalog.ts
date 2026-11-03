// The research catalog: every research capability OpenRecord implements, in
// one closed list. The agent finds capabilities by what it needs
// (find_research_capabilities) and runs one by id (run_research); nothing
// outside this list can be run, and each capability validates its own input.
import { JSONSchema } from "effect"
import { ADS_CAPABILITIES } from "./ads.js"
import { AI_CAPABILITIES } from "./answers.js"
import { COMPANY_CAPABILITIES } from "./company.js"
import { HISTORY_CAPABILITIES } from "./history.js"
import { SITE_CAPABILITIES } from "./site.js"
import { SOCIAL_CAPABILITIES } from "./social.js"
import { TRAFFIC_CAPABILITIES } from "./traffic.js"
import { LIVE_TRAFFIC_CAPABILITIES } from "./traffic-feed.js"
import { VISIBILITY_ENGINE_CAPABILITIES } from "./visibility-engine.js"
import { CRAWLER_ACCESS_CAPABILITIES } from "./crawler-access.js"
import { ENDPOINT_CAPABILITIES } from "./endpoints/run.js"
import { GENERATED_ENDPOINTS } from "./endpoints/generated.js"

const GENERATED_IDS = new Set(GENERATED_ENDPOINTS.map(e => e.id))
import type { AnyCapability } from "./types.js"

export const CAPABILITIES: ReadonlyArray<AnyCapability> = [
  ...SITE_CAPABILITIES, ...HISTORY_CAPABILITIES, ...COMPANY_CAPABILITIES, ...SOCIAL_CAPABILITIES, ...ADS_CAPABILITIES, ...AI_CAPABILITIES, ...TRAFFIC_CAPABILITIES, ...LIVE_TRAFFIC_CAPABILITIES, ...VISIBILITY_ENGINE_CAPABILITIES, ...CRAWLER_ACCESS_CAPABILITIES,
  ...ENDPOINT_CAPABILITIES,
]
export const capability = (id: string) => CAPABILITIES.find(c => c.id === id) ?? null

const SYNONYMS: Readonly<Record<string, string>> = {
  seo: "keywords search phrases", rank: "search results keywords", ranking: "search results keywords", ads: "advertising ad library pixel", ad: "advertising ad library pixel",
  paid: "advertising pixel ad library", advertise: "advertising pixel ad library", advertising: "advertising pixel ad library", social: "youtube bluesky social", hiring: "jobs careers roles", jobs: "jobs careers roles", stack: "technologies", tech: "technologies",
  price: "pricing", pricing: "pricing plans", history: "archive history snapshot changes", changes: "changes snapshot archive", timeline: "history archive content",
  ai: "ai answers visibility citations", llm: "ai answers visibility", chatgpt: "ai answers visibility traffic", citation: "ai citations", citations: "ai citations",
  visibility: "ai visibility answers", crawler: "ai traffic crawler logs", bots: "ai traffic crawler", referral: "ai traffic referral affiliate", backlinks: "partners marketplace community mentions",
  partners: "partners integrations marketplace", integrations: "partners integrations", content: "content publishing blog", blog: "content publishing blog",
  stripe: "revenue stripe charges customers subscriptions", subscriptions: "stripe subscriptions", customers: "stripe customers", invoices: "stripe invoices", repository: "github repos", contributors: "github contributors", stars: "github stargazers", issues: "github issues",
  plg: "growth signals signup free", growth: "growth signals loops content jobs", competitors: "ai visibility share search results", reviews: "reviews apps technologies marketplace",
  community: "hackernews community bluesky reddit", app: "apps store reviews", apps: "apps store reviews", podcast: "podcasts", github: "github developers", developers: "github npm pypi docker developers",
  downloads: "npm pypi downloads", wikipedia: "wiki pageviews", interest: "wiki pageviews", revenue: "sec revenue filings", filings: "sec filings", public: "sec filings", speed: "chrome pagespeed real users",
  volume: "keyword volume seo", keywords: "keywords ranked seo ideas", backlink: "backlinks referring domains", traffic: "traffic history seo ai", bing: "bing", youtube: "youtube channel uploads videos", launch: "producthunt launch", mentions: "hackernews ai answers", domain: "domain registration dns", email: "dns email", facts: "ai fact check",
}
const STOP = new Set("a an and are as at be by can do does for from get has have how i in is it its me my of on or our say says see show that the their them they this to us was we what when where which who why will with you your about into than then there these those".split(" "))
/** Lowercase words without filler, reduced to a rough stem so "advertise", "advertising" and "ads" meet. */
const stem = (w: string) => w.length > 4 ? w.replace(/(ings?|ers?|ed|es|s|e)$/, "") : w
const tokens = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 1 && !STOP.has(t)).map(stem)

/** Capabilities ranked for a need, best first. */
export const findCapabilities = (query: string, platform?: string, limit = 8) => {
  // The asker's own words count twice as much as the synonyms they expand to.
  const words = query.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 1 && !STOP.has(t))
  const q = words.flatMap(t => [{ t: stem(t), w: 2 }, ...tokens(SYNONYMS[t] ?? "").map(x => ({ t: x, w: 1 }))])
  const ranked = CAPABILITIES.filter(c => !platform || c.platform === platform).map(c => {
    const hay = { id: tokens(c.id), title: tokens(c.title), text: tokens(`${c.description} ${c.platform}`) }
    const score = q.reduce((s, { t, w }) => s + w * ((hay.id.includes(t) ? 4 : 0) + (hay.title.includes(t) ? 3 : 0) + (hay.text.includes(t) ? 1 : 0)), 0)
    // Spec-generated operations name their parameters in their ids, so they match words easily; purpose-built capabilities come first on a tie.
    return { c, score: GENERATED_IDS.has(c.id) ? score * 0.6 : score }
  }).filter(x => x.score > 0 || !q.length).sort((a, b) => b.score - a.score)
  // At most three operations from one generated API family, so one large API cannot fill the list.
  const perFamily = new Map<string, number>()
  return ranked.filter(({ c }) => {
    if (!GENERATED_IDS.has(c.id)) return true
    const family = c.id.split(".").slice(0, 2).join(".")
    const n = (perFamily.get(family) ?? 0) + 1
    perFamily.set(family, n)
    return n <= 3
  }).slice(0, limit).map(x => x.c)
}
export const describe = (c: AnyCapability) => ({ id: c.id, platform: c.platform, title: c.title, what: c.description, source: c.source, label: c.label,
  reuse: c.cache === "day" ? "same input on the same day reuses the saved result" : "runs every time", input: JSONSchema.make(c.input) })
/** One line per capability, for the run_research declaration. */
export const INDEX = (() => {
  const native = CAPABILITIES.filter(c => !ENDPOINT_CAPABILITIES.includes(c)).map(c => `${c.id}: ${c.title}`).join("; ")
  const byPlatform = new Map<string, string[]>()
  // Hand-written endpoints are listed by id; spec-generated ones only by count (find them with find_research_capabilities).
  for (const c of ENDPOINT_CAPABILITIES) if (!GENERATED_IDS.has(c.id)) byPlatform.set(c.platform, [...(byPlatform.get(c.platform) ?? []), c.id])
  const generated = new Map<string, number>()
  for (const id of GENERATED_IDS) { const p = id.split(".").slice(0, 2).join("."); generated.set(p, (generated.get(p) ?? 0) + 1) }
  return `${native}. Official and public APIs: ${[...byPlatform.entries()].map(([p, ids]) => `${p} (${ids.join(", ")})`).join("; ")}. Generated from official API specifications: ${[...generated.entries()].map(([p, n]) => `${p}.* (${n})`).join(", ")}`
})()
