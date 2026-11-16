// Checks on the exact artifact revision a campaign page would publish, run
// when the page is prepared. They make a broken or unsupported draft visible
// before anyone approves it:
//
//   BLOCKING  approval is refused until a new revision fixes it: a link that
//             is broken or cannot work on the hosted page, a form inside the
//             page that cannot submit there, leftover placeholder text.
//   WARNING   shown on the approval card for the person to judge: claims the
//             approved facts do not back, missing headings or image text,
//             scripts that will not run.
//
// A check is evidence about one revision, never an approval. Network checks
// go through the same guarded web access the agent uses.
import { Effect } from "effect"
import { webAccess } from "./web-access.js"

export type Severity = "BLOCKING" | "WARNING"
export interface Finding { readonly code: string; readonly severity: Severity; readonly message: string }

const MAX_LINKS = 15
const MAX_CLAIMS = 8
const text = (html: string) => html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim()
const quote = (s: string) => s.length > 90 ? `${s.slice(0, 89)}…` : s

/** Placeholder text a writer leaves for later; on a live page it reads as broken. */
const PLACEHOLDER = /\[(?:company|name|customer|product|insert[^\]]*|your [^\]]*|todo|tbd|link)\]|\{\{[^}]*\}\}|lorem ipsum|\bTODO\b|\bTBD\b|XXX/i
/** A sentence that asserts a number or an absolute. */
const CLAIM = /(\d[\d,.]*\s?(%|x\b|times|ms\b|seconds?|minutes?|hours?|customers|users|teams|companies|languages|requests|reviews|stars?)|[$€£]\s?\d|\b(guarantee[sd]?|#1|number one|best|fastest|leading|only|cheapest|most accurate)\b)/i

/** Links in an HTML or Markdown artifact. */
export const linksOf = (format: "HTML" | "MARKDOWN", content: string): ReadonlyArray<string> => {
  const found = format === "HTML"
    ? [...content.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']*)["']/gi)].map(m => m[1]!.trim())
    : [...content.matchAll(/\[[^\]]*\]\(([^)\s]+)[^)]*\)/g)].map(m => m[1]!.trim())
  return [...new Set(found)]
}

/** Sentences that make a numeric or absolute claim, with whether an approved fact backs them. */
export const claimsOf = (plain: string, facts: ReadonlyArray<string>) => {
  const lowerFacts = facts.map(f => f.toLowerCase())
  const sentences = plain.split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(s => s.length > 3 && s.length < 400 && CLAIM.test(s))
  return [...new Set(sentences)].map(sentence => {
    const numbers = sentence.match(/\d[\d,.]*/g) ?? []
    // Backed when every number it states appears in an approved fact; an absolute with no number never is.
    const backed = numbers.length > 0 && numbers.every(n => lowerFacts.some(f => f.includes(n.replace(/[.,]$/, ""))))
    return { sentence, backed }
  })
}

/** Checks that need nothing but the content. `hosted` is true for an OpenRecord-hosted campaign page. */
export const staticFindings = (format: "HTML" | "MARKDOWN", content: string, facts: ReadonlyArray<string>, hosted: boolean, avoid: ReadonlyArray<string> = []): Finding[] => {
  const findings: Finding[] = []
  const plain = format === "HTML" ? text(content) : content
  const lower = plain.toLowerCase()
  for (const phrase of avoid.filter(p => p.trim() && lower.includes(p.trim().toLowerCase())).slice(0, 10))
    findings.push({ code: "AVOIDED_PHRASE", severity: "WARNING", message: `Uses "${quote(phrase.trim())}", which the approved strategy says to avoid.` })
  const placeholder = plain.match(PLACEHOLDER)
  if (placeholder) findings.push({ code: "PLACEHOLDER", severity: "BLOCKING", message: `Leftover placeholder text: "${quote(placeholder[0])}".` })
  if (format === "HTML") {
    if (!/<h1\b/i.test(content)) findings.push({ code: "NO_MAIN_HEADING", severity: "WARNING", message: "The page has no main heading (h1), so readers and search engines get no clear title." })
    const noAlt = [...content.matchAll(/<img\b(?![^>]*\balt\s*=)[^>]*>/gi)].length
    if (noAlt) findings.push({ code: "IMAGE_WITHOUT_TEXT", severity: "WARNING", message: `${noAlt === 1 ? "One image has" : `${noAlt} images have`} no description (alt text) for screen readers.` })
    if (hosted && /<form\b/i.test(content)) findings.push({ code: "FORM_CANNOT_SUBMIT", severity: "BLOCKING", message: "The page has its own form, which cannot submit on a hosted campaign page. Remove it; the inquiry form is added below the page." })
    if (hosted && /<script\b/i.test(content)) findings.push({ code: "SCRIPT_WILL_NOT_RUN", severity: "WARNING", message: "The page includes scripts, which do not run on a hosted campaign page. Anything that depends on them will not appear." })
  }
  for (const link of linksOf(format, content)) {
    if (!link) findings.push({ code: "EMPTY_LINK", severity: "BLOCKING", message: "A link has no address." })
    else if (hosted && !/^(https?:|mailto:|tel:|#)/i.test(link)) findings.push({ code: "RELATIVE_LINK", severity: "BLOCKING", message: `The link "${quote(link)}" points inside a site, so it breaks on a hosted campaign page. Use the full address.` })
  }
  const unbacked = claimsOf(plain, facts).filter(c => !c.backed)
  for (const c of unbacked.slice(0, MAX_CLAIMS)) findings.push({ code: "UNSUPPORTED_CLAIM", severity: "WARNING", message: `Not in the approved facts: "${quote(c.sentence)}". Check it before publishing.` })
  if (unbacked.length > MAX_CLAIMS) findings.push({ code: "UNSUPPORTED_CLAIM", severity: "WARNING", message: `${unbacked.length - MAX_CLAIMS} more claims are not in the approved facts.` })
  return findings
}

/** Absolute links that do not answer: each fetched once through guarded web access. */
export const brokenLinkFindings = (links: ReadonlyArray<string>) => Effect.gen(function*() {
  const web = yield* webAccess
  const absolute = links.filter(l => /^https?:\/\//i.test(l)).slice(0, MAX_LINKS)
  const results = yield* Effect.forEach(absolute, url => Effect.promise(() => web.fetch(url, "page").then(d => ({ url, status: d.status }), () => ({ url, status: null as number | null }))), { concurrency: 4 })
  return results.filter(r => r.status === null || r.status >= 400).map((r): Finding => ({
    code: "BROKEN_LINK", severity: "BLOCKING",
    message: r.status === null ? `The link ${quote(r.url)} could not be reached.` : `The link ${quote(r.url)} answers ${r.status}.`,
  }))
})

/** Every check for one revision. */
export const checkDeliverable = (format: "HTML" | "MARKDOWN", content: string, facts: ReadonlyArray<string>, hosted: boolean, avoid: ReadonlyArray<string> = []) => Effect.gen(function*() {
  const broken = yield* brokenLinkFindings(linksOf(format, content))
  return [...staticFindings(format, content, facts, hosted, avoid), ...broken]
})
export const blockingCount = (findings: ReadonlyArray<Finding>) => findings.filter(f => f.severity === "BLOCKING").length
