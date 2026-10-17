// AI Acquisition first-stage detection (pure, deterministic, auditable).
//
// It proposes CANDIDATE brand mentions and classifies cited sources. It never
// decides that a brand was recommended: a mention can be a recommendation, a
// neutral comparison, a warning, or a different entity with the same name.
// Only a human review (acq_judgments) confirms a mention or a recommendation.
//
// Rules, versioned by DETECTOR_VERSION:
// - An alias matches only between word boundaries (letters, digits and "_"
//   are word characters, Unicode-aware), case-insensitively unless the brand
//   is configured to match case.
// - Overlapping matches resolve to the longest span ("Acme Desk AI" wins over
//   "Acme Desk"); an identical span claimed by two brands is kept for both
//   and flagged as a collision.
// - Hints (negative cue, list, comparison) describe the sentence around the
//   match for the reviewer. They are never verdicts.

export const DETECTOR_VERSION = "acq-exact-alias-v1"

export interface BrandSpec {
  readonly name: string
  readonly aliases: ReadonlyArray<string>
  readonly domains: ReadonlyArray<string>
  readonly matchCase: boolean
  /** Operator-declared ambiguity, e.g. "also the name of a programming language". */
  readonly ambiguity: string | null
}
export type BrandRole = "TARGET" | "COMPETITOR"
export type MentionHint = "NEGATIVE_CUE" | "LIST" | "COMPARISON"
export interface CandidateMention {
  readonly role: BrandRole
  readonly brand: string
  readonly alias: string
  /** UTF-16 offsets into the exact answer text. */
  readonly start: number
  readonly end: number
  readonly matched: string
  readonly sentence: string
  readonly hints: ReadonlyArray<MentionHint>
  readonly ambiguity: string | null
  readonly collision: boolean
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const WORD = "[\\p{L}\\p{N}_]"

/** Every term a brand is matched by: its name and its aliases, deduplicated. */
export const brandTerms = (b: BrandSpec): string[] => {
  const seen = new Set<string>()
  const out: string[] = []
  for (const t of [b.name, ...b.aliases].map(s => s.trim()).filter(Boolean)) {
    const k = b.matchCase ? t : t.toLowerCase()
    if (!seen.has(k)) { seen.add(k); out.push(t) }
  }
  return out
}

const NEGATIVE = /\b(not|isn't|aren't|wasn't|doesn't|don't|didn't|won't|wouldn't|cannot|can't|lacks?|lacking|avoid|unsuitable|unable|never|no longer|limited|weak|poor|drawbacks?|downsides?)\b/i
const COMPARISON = /\b(vs\.?|versus|compared (to|with)|alternatives? to|instead of|rather than|than)\b/i
const LIST_ITEM = /^\s*([-*•]|\d+[.)]|#{1,6}\s)/

/** The sentence (or list line) containing [start, end), trimmed to 400 chars. */
const sentenceAround = (text: string, start: number, end: number): { sentence: string; line: string } => {
  const lineStart = text.lastIndexOf("\n", start - 1) + 1
  const nl = text.indexOf("\n", end)
  const lineEnd = nl === -1 ? text.length : nl
  const line = text.slice(lineStart, lineEnd)
  let s = start
  while (s > lineStart && !/[.!?]/.test(text[s - 1]!)) s--
  let e = end
  while (e < lineEnd && !/[.!?]/.test(text[e]!)) e++
  const sentence = text.slice(s, Math.min(lineEnd, e + 1)).trim()
  return { sentence: sentence.length > 400 ? `${sentence.slice(0, 397)}...` : sentence, line }
}

interface Raw { role: BrandRole; brand: BrandSpec; alias: string; start: number; end: number }

/** Candidate mentions of the target and competitor brands in one exact answer. */
export const detectMentions = (answer: string, target: BrandSpec, competitors: ReadonlyArray<BrandSpec>): CandidateMention[] => {
  const raws: Raw[] = []
  const brands: Array<[BrandRole, BrandSpec]> = [["TARGET", target], ...competitors.map((c): [BrandRole, BrandSpec] => ["COMPETITOR", c])]
  for (const [role, brand] of brands) {
    for (const alias of brandTerms(brand)) {
      const re = new RegExp(`(?<!${WORD})${escape(alias)}(?!${WORD})`, brand.matchCase ? "gu" : "giu")
      for (const m of answer.matchAll(re)) raws.push({ role, brand, alias, start: m.index, end: m.index + m[0].length })
    }
  }
  // Longest span wins; identical spans from different brands are collisions.
  raws.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start))
  const kept: Raw[] = []
  for (const r of raws) {
    const overlapping = kept.filter(k => r.start < k.end && k.start < r.end)
    if (overlapping.length === 0) { kept.push(r); continue }
    const sameSpan = overlapping.every(k => k.start === r.start && k.end === r.end)
    if (sameSpan && overlapping.every(k => k.brand !== r.brand)) kept.push(r)
  }
  const perSentenceBrands = new Map<string, Set<string>>()
  const located = kept.map(r => ({ r, ...sentenceAround(answer, r.start, r.end) }))
  for (const { r, sentence } of located) {
    const set = perSentenceBrands.get(sentence) ?? new Set<string>()
    set.add(r.brand.name)
    perSentenceBrands.set(sentence, set)
  }
  return located.map(({ r, sentence, line }) => {
    const hints: MentionHint[] = []
    if (NEGATIVE.test(sentence)) hints.push("NEGATIVE_CUE")
    if (LIST_ITEM.test(line) || (perSentenceBrands.get(sentence)?.size ?? 0) >= 3) hints.push("LIST")
    if (COMPARISON.test(sentence)) hints.push("COMPARISON")
    const collision = kept.some(k => k !== r && k.start === r.start && k.end === r.end)
    return { role: r.role, brand: r.brand.name, alias: r.alias, start: r.start, end: r.end, matched: answer.slice(r.start, r.end),
      sentence, hints, ambiguity: r.brand.ambiguity, collision }
  })
}

// ---------------------------------------------------------------------------
// Cited sources
// ---------------------------------------------------------------------------

/** Where a cited source's domain came from. Gemini grounding cites
 * vertexaisearch redirect URLs and reports the source domain only as the
 * chunk title; the redirect is never followed. */
export type DomainBasis = "URI_HOST" | "PROVIDER_TITLE" | "UNRESOLVED"
export type CitationOwner = "OWNED" | "COMPETITOR" | "OTHER" | "UNRESOLVED"
export interface ClassifiedCitation {
  readonly uri: string | null
  readonly title: string | null
  readonly position: number | null
  readonly domain: string | null
  readonly domainBasis: DomainBasis
  readonly owner: CitationOwner
  readonly competitor: string | null
  /** V1 never fetches cited pages, so whether a source supports a claim is unverified. */
  readonly support: "NOT_VERIFIED"
}

const GROUNDING_REDIRECT_HOSTS = new Set(["vertexaisearch.cloud.google.com"])
const HOSTNAME = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/

/** Lower-case hostname without a leading "www.", or null. */
export const normalizeDomain = (input: string): string | null => {
  const s = input.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/[/?#].*$/, "").replace(/:\d+$/, "").replace(/^www\./, "").replace(/\.$/, "")
  return HOSTNAME.test(s) ? s : null
}

export const domainMatches = (domain: string, allow: ReadonlyArray<string>): boolean =>
  allow.some(d => domain === d || domain.endsWith(`.${d}`))

export const citationDomain = (c: { uri: string | null; title: string | null }): { domain: string | null; basis: DomainBasis } => {
  let host: string | null = null
  let redirect = false
  if (c.uri) {
    try {
      const u = new URL(c.uri)
      if ((u.protocol === "https:" || u.protocol === "http:") && !u.username && !u.password) {
        host = u.hostname.toLowerCase()
        redirect = GROUNDING_REDIRECT_HOSTS.has(host)
      }
    } catch { /* unresolved */ }
  }
  if (host && !redirect) {
    const d = normalizeDomain(host)
    return d ? { domain: d, basis: "URI_HOST" } : { domain: null, basis: "UNRESOLVED" }
  }
  const fromTitle = c.title ? normalizeDomain(c.title) : null
  return fromTitle && c.title!.trim().split(/\s+/).length === 1 ? { domain: fromTitle, basis: "PROVIDER_TITLE" } : { domain: null, basis: "UNRESOLVED" }
}

export const classifyCitation = (
  c: { uri: string | null; title: string | null; position: number | null },
  owned: ReadonlyArray<string>,
  competitors: ReadonlyArray<BrandSpec>,
): ClassifiedCitation => {
  const { domain, basis } = citationDomain(c)
  if (!domain) return { ...c, domain: null, domainBasis: basis, owner: "UNRESOLVED", competitor: null, support: "NOT_VERIFIED" }
  if (domainMatches(domain, owned)) return { ...c, domain, domainBasis: basis, owner: "OWNED", competitor: null, support: "NOT_VERIFIED" }
  const comp = competitors.find(b => domainMatches(domain, b.domains))
  return { ...c, domain, domainBasis: basis, owner: comp ? "COMPETITOR" : "OTHER", competitor: comp?.name ?? null, support: "NOT_VERIFIED" }
}
