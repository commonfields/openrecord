// Site audit: technical search, AI-answer readiness and on-page checks for up
// to 25 public pages, through WebAccess (SSRF-safe, robots honoured). Every
// issue names the pages it was seen on, what to change and how to confirm the
// change worked. Deterministic: no LLM, no scores, nothing invented.
//
// The checks and their priorities are adapted from claude-seo
// (https://github.com/AgriciDaniel/claude-seo, MIT, CLAUDE_SEO_PIN in
// agent-skills.ts): seo-technical, seo-geo, seo-schema and seo-audit. The text
// is rewritten for OpenRecord; no claude-seo script or runtime is used.
import { isAllowed, parseRobots } from "@openrecord/discovery"
import { inspectPage, parseSitemapXml, readablePage, type DerivedFinding, type FindingKind, type ReadablePage } from "@openrecord/site-operator"
import { readRobots, type RobotsState, type WebAccessService, type WebDocument } from "./web-access.js"

export type AuditPriority = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW"
export type AuditArea = "Crawling and indexing" | "Search appearance" | "AI answers" | "Content" | "Accessibility" | "Speed"
export interface AuditIssue {
  readonly check: string
  readonly priority: AuditPriority
  readonly area: AuditArea
  readonly title: string
  readonly detail: string
  readonly pages: number
  readonly examples: ReadonlyArray<string>
  readonly fix: string
  readonly verify: string
}
export interface AiCrawler { readonly agent: string; readonly owner: string; readonly use: "search" | "training"; readonly purpose: string }
export interface SiteAudit {
  readonly site: string
  readonly robots: RobotsState
  readonly sitemap: { readonly found: boolean; readonly urls: number; readonly invalid: boolean }
  readonly llmsTxt: boolean
  readonly aiCrawlers: ReadonlyArray<AiCrawler & { readonly allowed: boolean }>
  readonly pagesRead: number
  readonly pagesFailed: number
  readonly issues: ReadonlyArray<AuditIssue>
  readonly pages: ReadonlyArray<{ readonly url: string; readonly status: number | null; readonly title: string | null; readonly words: number; readonly ms: number; readonly structuredData: ReadonlyArray<string> }>
  readonly gaps: ReadonlyArray<string>
}

/** Crawlers that decide whether a site can appear in an assistant's answers or
 * search results, and crawlers that only collect training data. Blocking a
 * training crawler is the business's choice and never reported as a problem. */
export const AI_CRAWLERS: ReadonlyArray<AiCrawler> = [
  { agent: "Googlebot", owner: "Google", use: "search", purpose: "Google Search, AI Overviews and AI Mode" },
  { agent: "Bingbot", owner: "Microsoft", use: "search", purpose: "Bing and Copilot answers" },
  { agent: "OAI-SearchBot", owner: "OpenAI", use: "search", purpose: "ChatGPT search results" },
  { agent: "Claude-SearchBot", owner: "Anthropic", use: "search", purpose: "Claude search results" },
  { agent: "PerplexityBot", owner: "Perplexity", use: "search", purpose: "Perplexity answers" },
  { agent: "GPTBot", owner: "OpenAI", use: "training", purpose: "OpenAI model training (not ChatGPT search)" },
  { agent: "ClaudeBot", owner: "Anthropic", use: "training", purpose: "Anthropic model training (not Claude search)" },
  { agent: "Google-Extended", owner: "Google", use: "training", purpose: "Gemini training and grounding (not Google Search)" },
  { agent: "Applebot-Extended", owner: "Apple", use: "training", purpose: "Apple Intelligence training" },
  { agent: "CCBot", owner: "Common Crawl", use: "training", purpose: "Open training dataset" },
]

const ORG_TYPE = /^(Organization|Corporation|LocalBusiness|OnlineStore|OnlineBusiness|ProfessionalService|NGO|EducationalOrganization|MedicalOrganization)$|(Business|Store|Organization)$/
const MAX_PAGES = 25
const CONCURRENCY = 4
const DEFAULT_DEADLINE_MS = 45_000

const FROM_INSPECTOR: Partial<Record<FindingKind, { area: AuditArea; title: string; verify: string }>> = {
  BLOCKED_BY_META: { area: "Crawling and indexing", title: "Pages tell search engines not to index them", verify: "View the page source and confirm no robots meta tag contains noindex." },
  BLOCKED_BY_HEADER: { area: "Crawling and indexing", title: "Pages send a noindex header", verify: "Check the response headers (for example with curl -I) and confirm X-Robots-Tag has no noindex." },
  NOT_FOUND: { area: "Crawling and indexing", title: "Linked or listed pages return 404", verify: "Open each URL and confirm it loads, or that links and the sitemap no longer point to it." },
  SERVER_ERROR: { area: "Crawling and indexing", title: "Pages return a server error", verify: "Open each URL and confirm it answers 200." },
  REDIRECT_LOOP: { area: "Crawling and indexing", title: "Redirect loops", verify: "Open the URL and confirm it lands on one final page." },
  REDIRECT_CHAIN_LONG: { area: "Crawling and indexing", title: "Long redirect chains", verify: "Request the URL and confirm it redirects at most once." },
  BROKEN_CANONICAL: { area: "Crawling and indexing", title: "Canonical tags point to a broken address", verify: "Open the canonical URL in the page source and confirm it loads with status 200." },
  CANONICALIZED_ELSEWHERE: { area: "Crawling and indexing", title: "Pages name a different page as canonical", verify: "Confirm the canonical tag names the page itself unless it is a deliberate duplicate." },
  MISSING_TITLE: { area: "Search appearance", title: "Pages without a title", verify: "View the page source and confirm a non-empty <title>." },
  MISSING_DESCRIPTION: { area: "Search appearance", title: "Pages without a meta description", verify: "View the page source and confirm a meta description of about 70 to 160 characters." },
  MISSING_H1: { area: "Content", title: "Pages without a main heading (h1)", verify: "Confirm each page has exactly one h1 that names its topic." },
  INVALID_STRUCTURED_DATA: { area: "Search appearance", title: "Structured data that does not parse", verify: "Paste the page into Google's Rich Results Test and confirm it reports no parsing errors." },
  MISSING_ALT: { area: "Accessibility", title: "Images without alt text", verify: "Confirm every meaningful image has alt text that describes it." },
}

interface Page { readonly url: string; readonly doc: WebDocument; readonly read: ReadablePage | null; readonly findings: ReadonlyArray<DerivedFinding> }
type Hit = { readonly url: string }

const normal = (raw: string): string | null => {
  try { const u = new URL(raw); if (u.protocol !== "http:" && u.protocol !== "https:") return null; u.hash = ""; return u.toString() } catch { return null }
}
const cut = (s: string, n: number) => s.length > n ? `${s.slice(0, n - 1)}…` : s

/** Runs `work` over `items` with at most `limit` in flight, stopping new work at the deadline. */
const pool = async <T, R>(items: ReadonlyArray<T>, limit: number, deadline: number, work: (t: T) => Promise<R>): Promise<R[]> => {
  const out: R[] = []
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length && Date.now() < deadline) out.push(await work(items[next++]!))
  }))
  return out
}

/** Sitemaps: robots.txt entries on this origin, else /sitemap.xml; one level of index. */
const readSitemaps = async (web: WebAccessService, origin: string, declared: ReadonlyArray<string>, deadline: number, max = 500) => {
  const sitemapUrls = [...new Set([...declared.filter(s => normal(s)?.startsWith(origin)), `${origin}/sitemap.xml`])].slice(0, 3)
  const listed = new Set<string>()
  let found = false, invalid = false
  const read = async (url: string, depth: number): Promise<void> => {
    if (depth > 1 || listed.size >= max || Date.now() > deadline) return
    const doc = await web.fetch(url, "xml")
    if (doc.body === null) return
    try {
      const parsed = parseSitemapXml(doc.body, { origin, maxEntries: max })
      found = true
      for (const u of parsed.urls) { const n = normal(u); if (n?.startsWith(origin) && listed.size < max) listed.add(n) }
      for (const nested of parsed.nested.slice(0, 3)) await read(nested, depth + 1)
    } catch { invalid = true }
  }
  for (const s of sitemapUrls) { if (found) break; await read(s, 0) }
  return { listed, found, invalid }
}

export interface SiteMap {
  readonly site: string
  readonly sitemap: { readonly found: boolean; readonly invalid: boolean }
  readonly pages: number
  /** Pages grouped by their first path segment ("/blog", "/pricing"), largest first. */
  readonly sections: ReadonlyArray<{ readonly path: string; readonly pages: number; readonly examples: ReadonlyArray<string> }>
  readonly urls: ReadonlyArray<string>
  readonly disallowed: number
}

/** The pages a site lists in its sitemaps and links from its home page, without reading them. */
export const mapSite = async (web: WebAccessService, input: { readonly url: string; readonly limit?: number }): Promise<SiteMap | { readonly refused: "NOT_PUBLIC" | "INVALID_URL" | "ROBOTS_UNAVAILABLE" }> => {
  const start = normal(input.url)
  if (!start) return { refused: "INVALID_URL" }
  const deadline = Date.now() + 30_000
  let robots = await readRobots(web, new URL(start).origin)
  if (robots.state === "NOT_PUBLIC") return { refused: "NOT_PUBLIC" }
  if (robots.state === "DENIED" || robots.state === "UNAVAILABLE") return { refused: "ROBOTS_UNAVAILABLE" }
  const home = robots.allows(start) ? await web.fetch(start, "page") : null
  if (home?.failure === "SECURITY_REJECTED") return { refused: "NOT_PUBLIC" }
  const origin = new URL(home?.finalUrl || start).origin
  if (origin !== new URL(start).origin) {
    robots = await readRobots(web, origin)
    if (robots.state === "NOT_PUBLIC") return { refused: "NOT_PUBLIC" }
  }
  const { listed, found, invalid } = await readSitemaps(web, origin, robots.sitemaps, deadline, 2000)
  const homeRead = home?.body && home.contentType !== "text/plain" ? readablePage(home.body, home.finalUrl) : null
  const all = [...new Set([...(home ? [normal(home.finalUrl) ?? start] : []), ...listed, ...(homeRead?.internalLinks ?? []).flatMap(u => normal(u) ?? [])])].filter(u => u.startsWith(origin))
  const allowed = robots.state === "PRESENT" ? all.filter(u => robots.allows(u)) : all
  const sections = new Map<string, string[]>()
  for (const u of allowed) { const seg = new URL(u).pathname.split("/").filter(Boolean)[0]; const key = seg ? `/${seg}` : "/"; sections.set(key, [...(sections.get(key) ?? []), u]) }
  return {
    site: origin, sitemap: { found, invalid }, pages: allowed.length, disallowed: all.length - allowed.length,
    sections: [...sections].sort((a, b) => b[1].length - a[1].length).slice(0, 25).map(([path, urls]) => ({ path, pages: urls.length, examples: urls.slice(0, 3) })),
    urls: allowed.slice(0, Math.min(Math.max(input.limit ?? 100, 1), 300)),
  }
}

export const auditSite = async (web: WebAccessService, input: { readonly url: string; readonly maxPages?: number; readonly deadlineMs?: number }): Promise<SiteAudit | { readonly refused: "NOT_PUBLIC" | "INVALID_URL" }> => {
  const start = normal(input.url)
  if (!start) return { refused: "INVALID_URL" }
  const deadline = Date.now() + (input.deadlineMs ?? DEFAULT_DEADLINE_MS)
  const maxPages = Math.min(Math.max(input.maxPages ?? 12, 1), MAX_PAGES)
  const gaps: string[] = []

  // robots.txt is read before any page. The home page then decides the origin:
  // a redirect to www or https switches to that origin's robots.txt.
  const startOrigin = new URL(start).origin
  let robots = await readRobots(web, startOrigin)
  if (robots.state === "NOT_PUBLIC") return { refused: "NOT_PUBLIC" }
  const nothing = (gap: string): SiteAudit => ({ site: startOrigin, robots: robots.state, sitemap: { found: false, urls: 0, invalid: false }, llmsTxt: false,
    aiCrawlers: [], pagesRead: 0, pagesFailed: 0, issues: [], pages: [], gaps: [gap] })
  if (robots.state === "DENIED" || robots.state === "UNAVAILABLE") return nothing(`robots.txt could not be read (${robots.state === "DENIED" ? "access denied" : "no answer"}), so no pages were audited`)
  if (!robots.allows(start)) return nothing("robots.txt disallows OpenRecord's agent from this page, so it was not audited")
  const home = await web.fetch(start, "page")
  if (home.failure === "SECURITY_REJECTED") return { refused: "NOT_PUBLIC" }
  const origin = new URL(home.finalUrl || start).origin
  if (origin !== startOrigin) {
    robots = await readRobots(web, origin)
    if (robots.state === "NOT_PUBLIC") return { refused: "NOT_PUBLIC" }
  }

  const crawlers = AI_CRAWLERS.map(c => {
    if (robots.state !== "PRESENT") return { ...c, allowed: robots.state === "ABSENT" }
    return { ...c, allowed: isAllowed("/", parseRobots(robots.text, [c.agent, "*"])) }
  })
  const llms = await web.fetch(`${origin}/llms.txt`, "text")
  const llmsTxt = llms.body !== null && llms.body.trim().length > 0 && !/^\s*</.test(llms.body)

  const { listed, found: sitemapFound, invalid: sitemapInvalid } = await readSitemaps(web, origin, robots.sitemaps, deadline)

  const homeRead = home.body !== null && home.contentType !== "text/plain" ? readablePage(home.body, home.finalUrl) : null
  const candidates = [...new Set([normal(home.finalUrl) ?? start, ...listed, ...(homeRead?.internalLinks ?? [])])]
  const allowed = robots.state === "DENIED" || robots.state === "UNAVAILABLE" ? candidates.slice(0, 1) : candidates.filter(u => robots.allows(u))
  if (robots.state === "DENIED" || robots.state === "UNAVAILABLE") gaps.push(`robots.txt for ${origin} could not be read, so only the home page was audited`)
  else if (allowed.length < candidates.length) gaps.push(`${candidates.length - allowed.length} pages skipped because robots.txt disallows OpenRecord's agent`)
  const queue = allowed.slice(0, maxPages)

  const known = new Set(queue)
  const pages = await pool(queue, CONCURRENCY, deadline, async (url): Promise<Page> => {
    const doc = url === normal(home.finalUrl) ? home : await web.fetch(url, "page")
    const html = doc.body !== null && doc.contentType !== "text/plain" ? doc.body : null
    const classified = inspectPage({ url, finalUrl: doc.finalUrl, status: doc.status, contentType: doc.contentType, redirectChain: doc.redirectChain,
      headers: { ...doc.headers }, html, failure: doc.failure, robotsDisallowed: false }, { knownUrls: known })
    return { url, doc, read: html ? readablePage(html, doc.finalUrl, { maxChars: 2000 }) : null, findings: classified.findings }
  })
  if (pages.length < queue.length) gaps.push(`${queue.length - pages.length} pages not reached within the time limit`)

  const issues: AuditIssue[] = []
  const add = (check: string, priority: AuditPriority, area: AuditArea, title: string, hits: ReadonlyArray<Hit>, detail: string, fix: string, verify: string) => {
    if (hits.length) issues.push({ check, priority, area, title, detail: cut(detail, 260), pages: hits.length, examples: hits.slice(0, 3).map(h => h.url), fix: cut(fix, 260), verify: cut(verify, 220) })
  }

  // Per-page findings from the site inspector, grouped by kind.
  const byKind = new Map<FindingKind, DerivedFinding[]>()
  for (const p of pages) for (const f of p.findings) byKind.set(f.findingKind, [...(byKind.get(f.findingKind) ?? []), f])
  for (const [kind, list] of byKind) {
    const meta = FROM_INSPECTOR[kind]
    if (meta) add(kind, list[0]!.severity, meta.area, meta.title, list, list[0]!.diagnosis, list[0]!.recommendedAction, meta.verify)
  }

  const ok = pages.filter((p): p is Page & { read: ReadablePage } => p.read !== null && p.doc.status !== null && p.doc.status >= 200 && p.doc.status < 300)
  const indexable = ok.filter(p => !/noindex/i.test(p.read.robotsMeta ?? ""))

  if (origin.startsWith("http:")) add("NOT_HTTPS", "HIGH", "Crawling and indexing", "The site is served without HTTPS", [{ url: origin }],
    "The home page answers over plain HTTP. Browsers mark it not secure and search engines prefer the HTTPS version.",
    "Serve every page over HTTPS and redirect HTTP to it with a single 301.", "Open the http:// address and confirm it redirects once to https://.")

  const blocked = crawlers.filter(c => c.use === "search" && !c.allowed && robots.state === "PRESENT")
  if (blocked.length) add("AI_SEARCH_CRAWLER_BLOCKED", blocked.some(c => c.agent === "Googlebot" || c.agent === "Bingbot") ? "CRITICAL" : "HIGH", "AI answers",
    `robots.txt blocks ${blocked.map(c => c.agent).join(", ")}`, [{ url: `${origin}/robots.txt` }],
    `These crawlers decide whether the site can appear in ${blocked.map(c => c.purpose).join("; ")}. While blocked, those answers cannot cite or link the site.`,
    `Remove the Disallow: / rule for ${blocked.map(c => c.agent).join(", ")} in robots.txt, unless keeping the site out of those answers is deliberate.`,
    "Open /robots.txt and confirm no group for these user agents disallows /.")

  const jsOnly = ok.filter(p => p.read.wordCount < 50 && /<script[\s>]/i.test(p.doc.body ?? ""))
  add("CONTENT_NEEDS_JAVASCRIPT", "HIGH", "AI answers", "Pages show almost no text without JavaScript", jsOnly,
    "The HTML these pages send has fewer than 50 words; the text is built in the browser. Many AI crawlers read the raw HTML without running JavaScript, so they see an almost empty page.",
    "Render the main text on the server (server-side rendering or prerendering) so it is in the HTML response.",
    "Run curl on the page (or view source, not the inspector) and confirm the main text is in the HTML.")

  const homeOk = ok.find(p => p.url === normal(home.finalUrl))
  if (homeOk && !homeOk.read.structuredDataTypes.some(t => ORG_TYPE.test(t))) add("NO_ORGANIZATION_DATA", "MEDIUM", "AI answers", "The home page has no Organization structured data", [{ url: homeOk.url }],
    "Search engines and assistants use Organization or LocalBusiness data to connect the site to the business's name, logo, contact details and profiles.",
    "Add JSON-LD for Organization (or LocalBusiness with address and opening hours) with name, url, logo and sameAs links to official profiles, matching what the page shows.",
    "Paste the home page into Google's Rich Results Test or validator.schema.org and confirm an Organization or LocalBusiness item is detected.")

  add("TITLE_LENGTH", "LOW", "Search appearance", "Titles that are too short or too long", indexable.filter(p => p.read.title !== null && (p.read.title.length < 30 || p.read.title.length > 60)),
    "Titles under 30 characters waste the space search results give them; over 60 they are usually cut off.",
    "Rewrite each title to about 30 to 60 characters: the page's topic first, then the brand.", "View source and count the <title> characters, or re-run the audit.")
  add("DESCRIPTION_LENGTH", "LOW", "Search appearance", "Meta descriptions that are too short or too long", indexable.filter(p => p.read.description !== null && (p.read.description.length < 70 || p.read.description.length > 160)),
    "Search engines often replace descriptions outside about 70 to 160 characters with text of their own choosing.",
    "Write a 70 to 160 character description per page that states what the page offers, using approved wording.", "View source and count the meta description characters, or re-run the audit.")

  const dupes = (pick: (r: ReadablePage) => string | null) => {
    const seen = new Map<string, Page[]>()
    for (const p of indexable) { const v = pick(p.read)?.toLowerCase(); if (v) seen.set(v, [...(seen.get(v) ?? []), p]) }
    return [...seen.values()].filter(g => g.length > 1).flat()
  }
  add("DUPLICATE_TITLE", "MEDIUM", "Search appearance", "Several pages share the same title", dupes(r => r.title),
    "When pages share a title, search engines struggle to tell them apart and may show the wrong one.", "Give each page a title that names its own topic.", "Re-run the audit and confirm no two pages share a title.")
  add("DUPLICATE_DESCRIPTION", "LOW", "Search appearance", "Several pages share the same meta description", dupes(r => r.description),
    "A shared description says nothing about what makes each page different.", "Write a description per page.", "Re-run the audit and confirm descriptions are unique.")
  add("MULTIPLE_H1", "LOW", "Content", "Pages with more than one h1", indexable.filter(p => p.read.h1Count > 1),
    "Several top-level headings make the page's main topic less clear to readers, search engines and assistants.", "Keep one h1 for the page's topic and turn the others into h2.", "View source and confirm one <h1>.")
  add("MISSING_CANONICAL", "LOW", "Crawling and indexing", "Pages without a canonical tag", indexable.filter(p => p.read.canonical === null),
    "Without a canonical tag, address variants (tracking parameters, trailing slashes, http and https) can be indexed as separate pages.",
    "Add <link rel=\"canonical\"> naming each page's preferred address.", "View source and confirm a canonical link with the page's own address.")
  add("MISSING_LANG", "LOW", "Accessibility", "Pages without a declared language", ok.filter(p => p.read.lang === null),
    "Screen readers and search engines use the html lang attribute to read and match the page's language.", "Add lang (for example lang=\"en\") to the <html> tag.", "View source and confirm <html lang=…>.")
  add("NO_SOCIAL_PREVIEW", "LOW", "Search appearance", "Pages without Open Graph tags", indexable.filter(p => !p.read.openGraph),
    "Without Open Graph tags, links shared in chat apps and social networks show no title, description or image.",
    "Add og:title, og:description, og:image and og:url to each page.", "Paste the URL into a link preview tool (for example LinkedIn Post Inspector) and confirm the preview.")
  add("THIN_CONTENT", "MEDIUM", "Content", "Pages with little text", indexable.filter(p => p.read.wordCount >= 50 && p.read.wordCount < 250 && p.url !== normal(home.finalUrl)),
    "Pages under about 250 words rarely answer a question fully, so search engines and assistants have little to quote or rank.",
    "Expand the page with the specific facts buyers ask about (who it is for, what it costs, how it works), or merge it into a fuller page.", "Re-run the audit and confirm the page has the added content.")
  add("SLOW_RESPONSE", "MEDIUM", "Speed", "Pages that took over 2 seconds to download", ok.filter(p => p.doc.elapsedMs > 2000),
    "Measured from OpenRecord's server as the full HTML download time, not a browser's Core Web Vitals. Slow HTML delays everything else on the page.",
    "Check server response time and caching for these pages (a CDN, page caching, slow database calls).", "Run PageSpeed Insights on the page and check server response time and LCP.")
  add("HEAVY_HTML", "LOW", "Speed", "HTML over 500 KB", ok.filter(p => p.doc.bytes > 500_000),
    "Very large HTML (often inlined data or scripts) is slow to download and parse, and some crawlers stop reading partway.", "Move inlined data and scripts out of the HTML.", "Re-run the audit and confirm the HTML size dropped.")

  if (!sitemapFound) add(sitemapInvalid ? "SITEMAP_INVALID" : "SITEMAP_MISSING", sitemapInvalid ? "HIGH" : "LOW", "Crawling and indexing",
    sitemapInvalid ? "The sitemap could not be read" : "No sitemap found", [{ url: `${origin}/sitemap.xml` }],
    sitemapInvalid ? "The sitemap exists but is not valid XML, so search engines cannot use it." : "Neither robots.txt nor /sitemap.xml lists the site's pages; search engines find them only through links.",
    sitemapInvalid ? "Regenerate the sitemap as a valid XML urlset." : "Publish /sitemap.xml with every indexable page and add a Sitemap: line to robots.txt.",
    "Open the sitemap URL and submit it in Google Search Console; confirm it reports success.")

  const rank: Record<AuditPriority, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 }
  issues.sort((a, b) => rank[a.priority] - rank[b.priority] || b.pages - a.pages)
  if (homeRead === null && home.failure) gaps.push(`the home page could not be read (${home.failure})`)

  return {
    site: origin, robots: robots.state,
    sitemap: { found: sitemapFound, urls: listed.size, invalid: sitemapInvalid },
    llmsTxt, aiCrawlers: crawlers,
    pagesRead: ok.length, pagesFailed: pages.length - ok.length,
    issues: issues.slice(0, 20),
    pages: pages.map(p => ({ url: p.url, status: p.doc.status, title: p.read?.title ? cut(p.read.title, 90) : null, words: p.read?.wordCount ?? 0, ms: p.doc.elapsedMs, structuredData: (p.read?.structuredDataTypes ?? []).slice(0, 6) })),
    gaps,
  }
}
