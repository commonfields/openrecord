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
import type { AnyCapability } from "./types.js"

export const CAPABILITIES: ReadonlyArray<AnyCapability> = [
  ...SITE_CAPABILITIES, ...HISTORY_CAPABILITIES, ...COMPANY_CAPABILITIES, ...SOCIAL_CAPABILITIES, ...ADS_CAPABILITIES, ...AI_CAPABILITIES, ...TRAFFIC_CAPABILITIES,
]
export const capability = (id: string) => CAPABILITIES.find(c => c.id === id) ?? null

const SYNONYMS: Readonly<Record<string, string>> = {
  seo: "keywords search phrases", rank: "search results keywords", ranking: "search results keywords", ads: "advertising ad library pixel", ad: "advertising ad library pixel",
  paid: "advertising pixel ad library", advertise: "advertising pixel ad library", advertising: "advertising pixel ad library", social: "youtube bluesky social", hiring: "jobs careers roles", jobs: "jobs careers roles", stack: "technologies", tech: "technologies",
  price: "pricing", pricing: "pricing plans", history: "archive history snapshot changes", changes: "changes snapshot archive", timeline: "history archive content",
  ai: "ai answers visibility citations", llm: "ai answers visibility", chatgpt: "ai answers visibility traffic", citation: "ai citations", citations: "ai citations",
  visibility: "ai visibility answers", crawler: "ai traffic crawler logs", bots: "ai traffic crawler", referral: "ai traffic referral affiliate", backlinks: "partners marketplace community mentions",
  partners: "partners integrations marketplace", integrations: "partners integrations", content: "content publishing blog", blog: "content publishing blog",
  plg: "growth signals signup free", growth: "growth signals loops content jobs", competitors: "ai visibility share search results", reviews: "technologies reviews marketplace",
  community: "hackernews community bluesky", mentions: "hackernews ai answers", domain: "domain registration dns", email: "dns email", facts: "ai fact check",
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
  return CAPABILITIES.filter(c => !platform || c.platform === platform).map(c => {
    const hay = { id: tokens(c.id), title: tokens(c.title), text: tokens(`${c.description} ${c.platform}`) }
    const score = q.reduce((s, { t, w }) => s + w * ((hay.id.includes(t) ? 4 : 0) + (hay.title.includes(t) ? 3 : 0) + (hay.text.includes(t) ? 1 : 0)), 0)
    return { c, score }
  }).filter(x => x.score > 0 || !q.length).sort((a, b) => b.score - a.score).slice(0, limit).map(x => x.c)
}
export const describe = (c: AnyCapability) => ({ id: c.id, platform: c.platform, title: c.title, what: c.description, source: c.source, label: c.label,
  reuse: c.cache === "day" ? "same input on the same day reuses the saved result" : "runs every time", input: JSONSchema.make(c.input) })
/** One line per capability, for the run_research declaration. */
export const INDEX = CAPABILITIES.map(c => `${c.id}: ${c.title}`).join("; ")
