import { load } from "cheerio"
import { readablePage } from "./readable.js"
import { structuredDataProblems } from "./structured-data.js"

const cut = (text: string, max: number) => text.replace(/\s+/g, " ").trim().slice(0, max)

export interface PageAssessment {
  readonly url: string
  readonly basis: "STATIC_HTML"
  readonly title: string | null
  readonly description: string | null
  readonly content: { readonly excerpt: string; readonly truncated: boolean; readonly words: number; readonly headings: ReadonlyArray<{ readonly level: number; readonly text: string }> }
  readonly structuredData: { readonly types: ReadonlyArray<string>; readonly syntaxErrors: number; readonly review: ReturnType<typeof structuredDataProblems> }
  readonly links: { readonly internal: number; readonly external: number; readonly examples: ReadonlyArray<{ readonly label: string; readonly url: string; readonly location: "MAIN_CONTENT" | "PAGE" }> }
  readonly conversion: { readonly forms: number; readonly buttons: ReadonlyArray<string>; readonly contactLinks: number }
  readonly attribution: { readonly author: string | null; readonly published: string | null; readonly modified: string | null }
  readonly checks: ReadonlyArray<{ readonly code: string; readonly observation: string; readonly next: string }>
  readonly limitations: ReadonlyArray<string>
}

/** Deterministic observations for a specialist to interpret against the business
 * goal. No network, authority score, conversion prediction, or automatic fix. */
export const assessPage = (input: { readonly html: string; readonly url: string; readonly headers: Readonly<Record<string, string>> }): PageAssessment => {
  const page = readablePage(input.html, input.url, { maxChars: 3500 })
  const $ = load(input.html)
  const base = new URL(input.url)
  const examples: Array<{ label: string; url: string; location: "MAIN_CONTENT" | "PAGE" }> = []
  const seen = new Set<string>()
  let contactLinks = 0
  $("a[href]").each((_, element) => {
    const href = ($(element).attr("href") ?? "").trim()
    if (/^(mailto|tel):/i.test(href)) { contactLinks += 1; return }
    if (examples.length >= 100 || !href || href.startsWith("#")) return
    try {
      const url = new URL(href, base)
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.href.length > 300 || seen.has(url.href)) return
      seen.add(url.href)
      examples.push({ label: cut($(element).text() || $(element).attr("aria-label") || "", 100), url: url.href,
        location: $(element).parents("main, article, [role=main]").length ? "MAIN_CONTENT" : "PAGE" })
    } catch { /* Non-web and malformed links are not destinations to suggest. */ }
  })
  const buttons = new Set<string>()
  $("button, input[type=submit], input[type=button]").each((_, element) => {
    // Input values, form fields, destinations and hidden data are never collected.
    const label = cut($(element).text() || $(element).attr("aria-label") || "", 100)
    if (label && buttons.size < 6) buttons.add(label)
  })
  const checks: Array<{ code: string; observation: string; next: string }> = []
  const add = (code: string, observation: string, next: string) => { checks.push({ code, observation, next }) }
  if (!page.title) add("MISSING_TITLE", "No non-empty title was found in the fetched HTML.", "Draft a title that reflects this page and the approved offer.")
  if (!page.description) add("MISSING_DESCRIPTION", "No meta description was found in the fetched HTML.", "Review whether a description would clarify the page's offer; it does not guarantee the displayed search snippet.")
  if (page.h1Count === 0) add("MISSING_H1", "No h1 was found in the fetched HTML.", "Review the main heading and page purpose with the content specialist.")
  if (/\bnoindex\b/i.test(`${page.robotsMeta ?? ""} ${input.headers["x-robots-tag"] ?? ""}`)) add("NOINDEX", "The page declares noindex in a robots meta tag or response header.", "Check whether exclusion is intentional before proposing a change.")
  if (page.wordCount < 50 && /<script[\s>]/i.test(input.html)) add("RENDERING_UNVERIFIED", "Little text was found in static HTML and the page contains scripts.", "Compare with a rendered read if available; do not conclude the browser page is empty.")
  if (page.canonical) {
    try {
      const canonical = new URL(page.canonical, base)
      canonical.hash = ""
      const current = new URL(base); current.hash = ""
      if (canonical.href !== current.href) add("ALTERNATE_CANONICAL", "The canonical URL differs from the fetched page URL.", "Confirm whether this is deliberate duplication or a URL variant before changing it.")
    } catch { add("INVALID_CANONICAL", "The canonical URL could not be resolved.", "Review the canonical address and validate its intended destination.") }
  }
  const structure = structuredDataProblems(input.html)
  if (page.invalidStructuredData || structure.length) add("STRUCTURED_DATA_REVIEW", "Some JSON-LD syntax or structural checks need review.", "Validate affected markup and compare its facts with visible page content; these checks do not establish rich-result eligibility.")
  return {
    url: input.url, basis: "STATIC_HTML", title: page.title?.slice(0, 200) ?? null, description: page.description?.slice(0, 500) ?? null,
    content: { excerpt: page.text, truncated: page.truncated, words: page.wordCount, headings: page.headings.slice(0, 12).map(h => ({ ...h, text: h.text.slice(0, 140) })) },
    structuredData: { types: page.structuredDataTypes.slice(0, 10), syntaxErrors: page.invalidStructuredData, review: structure },
    links: { internal: page.internalLinks.length, external: page.externalLinkCount,
      examples: examples.sort((a, b) => Number(b.location === "MAIN_CONTENT") - Number(a.location === "MAIN_CONTENT")).slice(0, 8) },
    conversion: { forms: $("form").length, buttons: [...buttons], contactLinks },
    attribution: { author: page.author?.slice(0, 200) ?? null, published: page.published?.slice(0, 100) ?? null, modified: page.modified?.slice(0, 100) ?? null },
    checks,
    limitations: ["Static HTML only; forms and buttons were not used, links were not followed, and JavaScript was not executed.",
      "No browser performance or Core Web Vitals were measured.", "Author and dates are page declarations, not verified expertise or freshness.",
      "Conversion effectiveness, customer intent and the best next action need business context and outcome data. No minimum word count or page score determines quality."],
  }
}
