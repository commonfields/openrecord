import type { DiscoverySignals, SetupBrief } from "@openrecord/contracts"
import type { SpecialistId } from "./agent-skills.js"
import { WEBSITE_RULES, type WebsiteCheckKey } from "./setup-plan.js"

// Deterministic diagnosis for the first-improvement workflow. Candidates come
// only from recorded evidence: OpenRecord's own homepage read (fetched by the
// worker through its SSRF-guarded fetch) and AI answers a person reviewed as
// contradicting approved facts. Page text never selects or ranks a candidate.

export type DiagnosisEvidence =
  | { readonly kind: "WEBSITE_READ"; readonly url: string; readonly fetchedAt: string; readonly bodyDigest: string | null; readonly check: WebsiteCheckKey }
  | { readonly kind: "REVIEWED_AI_ANSWER"; readonly observationId: string; readonly claimId: string; readonly judgmentId: string; readonly provider: string; readonly collectedAt: string }

export interface ProblemCandidate {
  readonly key: string
  readonly specialist: SpecialistId
  readonly severity: "critical" | "high"
  readonly observed: string
  readonly whyItMatters: string
  readonly targetUrl: string | null
  readonly evidence: ReadonlyArray<DiagnosisEvidence>
  readonly uncertainty: string
  /** An open opportunity already proposing this change, e.g. from /setup. */
  readonly existingOpportunityId: string | null
}

export interface ContradictedAnswer {
  readonly claimId: string; readonly claimText: string; readonly observationId: string; readonly judgmentId: string
  readonly provider: string; readonly collectedAt: string; readonly questionPrompt: string | null
}

export interface DiagnosisInput {
  readonly businessName: string
  readonly website:
    | { readonly state: "NOT_STARTED" }
    | { readonly state: "PENDING"; readonly url: string }
    | { readonly state: "FAILED"; readonly url: string; readonly failure: string }
    | { readonly state: "READ"; readonly url: string; readonly signals: DiscoverySignals }
  readonly brief: SetupBrief | null
  readonly goalStatement: string | null
  readonly facts: ReadonlyArray<{ readonly id: string; readonly predicate: string; readonly valueText: string }>
  readonly contradictedAnswers: ReadonlyArray<ContradictedAnswer>
  readonly unreviewedClaims: number
  readonly openOpportunities: ReadonlyArray<{ readonly id: string; readonly title: string }>
}

export interface Diagnosis {
  readonly status: "PROBLEM_SELECTED" | "INSUFFICIENT_EVIDENCE" | "NO_SUPPORTED_PROBLEM"
  readonly selected: ProblemCandidate | null
  readonly selectionReason: string | null
  readonly candidates: ReadonlyArray<ProblemCandidate>
  readonly gaps: ReadonlyArray<string>
  readonly conflicts: ReadonlyArray<string>
  readonly checked: ReadonlyArray<string>
}

const WHY: Record<WebsiteCheckKey, { severity: ProblemCandidate["severity"]; observed: string; why: string; uncertainty: string }> = {
  "homepage.noindex": { severity: "critical", observed: "The homepage carries a noindex robots instruction.",
    why: "Search engines are told to leave the homepage out of results, which blocks every other search improvement.",
    uncertainty: "The instruction may be intentional, for example on a staging site. Any effect on search or AI answers is unmeasured." },
  "homepage.organization-data": { severity: "high", observed: "No schema.org Organization data identifies the business on the homepage.",
    why: "Search engines and AI assistants infer the business name, offer and contact details from page text instead.",
    uncertainty: "Search engines and AI assistants decide independently whether to use structured data. Any effect is unmeasured." },
  "homepage.snippet": { severity: "high", observed: "The homepage is missing a title or a meta description.",
    why: "Search results show whatever text the search engine picks instead of a clear statement of the offer.",
    uncertainty: "Search engines may rewrite snippets. Any effect on clicks is unmeasured." },
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()

export const diagnoseMarketing = (input: DiagnosisInput): Diagnosis => {
  const gaps: string[] = [], conflicts: string[] = [], checked: string[] = []
  const candidates: ProblemCandidate[] = []
  const w = input.website
  if (w.state === "NOT_STARTED") gaps.push("No homepage read is recorded. Run /setup with the business website so OpenRecord can read it.")
  if (w.state === "PENDING") gaps.push("The homepage read is still in progress.")
  if (w.state === "FAILED") gaps.push(`The homepage could not be read (${w.failure.toLowerCase().replace(/_/g, " ")}). Nothing about the site is assumed.`)
  if (!input.brief) gaps.push("The business brief is not confirmed, so the offer and audience are unconfirmed.")
  if (!input.goalStatement) gaps.push("No growth goal is set. A proposal needs a confirmed goal.")
  if (input.facts.length === 0) gaps.push("No approved facts are recorded.")
  if (input.unreviewedClaims > 0) gaps.push(`${input.unreviewedClaims} AI-answer claims await human review and are not treated as problems.`)

  const existing = (title: string) => input.openOpportunities.find(o => o.title === title)?.id ?? null
  const website = (key: WebsiteCheckKey): ProblemCandidate | null => {
    if (w.state !== "READ") return null
    const rule = WEBSITE_RULES.find(r => r.key === key)
    if (!rule?.when(w.signals)) return null
    const ctx = { brief: input.brief ?? placeholderBrief(input.businessName), site: new URL(w.url).hostname.replace(/^www\./, "") }
    return { key, specialist: "seo-assessment", severity: WHY[key].severity, observed: WHY[key].observed, whyItMatters: WHY[key].why,
      targetUrl: w.signals.finalUrl, uncertainty: WHY[key].uncertainty, existingOpportunityId: existing(rule.build(ctx).title),
      evidence: [{ kind: "WEBSITE_READ", url: w.signals.finalUrl, fetchedAt: w.signals.fetchedAt, bodyDigest: w.signals.bodyDigest, check: key }] }
  }
  if (w.state === "READ") {
    checked.push("Homepage indexability, title, description and structured data")
    const org = w.signals.organization?.name
    if (org && input.brief && !norm(org).includes(norm(input.brief.businessName)) && !norm(input.brief.businessName).includes(norm(org)))
      conflicts.push("The homepage's structured data names the business differently from the confirmed brief. The brief is used; confirm which name is correct.")
  }
  checked.push("AI answers reviewed by a person as contradicting approved facts")

  const noindex = website("homepage.noindex")
  if (noindex) candidates.push(noindex)
  for (const a of input.contradictedAnswers.slice(0, 3)) candidates.push({
    key: `answer.contradicted:${a.claimId}`, specialist: "answer-accuracy", severity: "high",
    observed: `A ${a.provider} answer${a.questionPrompt ? ` to "${a.questionPrompt.slice(0, 160)}"` : ""} was reviewed by a person as contradicting approved facts.`,
    whyItMatters: "Buyers asking AI assistants may receive wrong information about the business.",
    targetUrl: w.state === "NOT_STARTED" ? null : w.url,
    uncertainty: "One reviewed answer does not show how often assistants repeat it, and publishing the fact does not guarantee a different answer.",
    existingOpportunityId: null,
    evidence: [{ kind: "REVIEWED_AI_ANSWER", observationId: a.observationId, claimId: a.claimId, judgmentId: a.judgmentId, provider: a.provider, collectedAt: a.collectedAt }],
  })
  for (const key of ["homepage.organization-data", "homepage.snippet"] as const) {
    const c = website(key)
    if (c) candidates.push(c)
  }

  const selected = candidates[0] ?? null
  if (!selected) return { status: w.state === "READ" ? "NO_SUPPORTED_PROBLEM" : "INSUFFICIENT_EVIDENCE",
    selected: null, selectionReason: null, candidates, gaps, conflicts, checked }
  const selectionReason = selected.severity === "critical"
    ? "It blocks the homepage from search results, so it comes before any other improvement."
    : selected.specialist === "answer-accuracy"
      ? "A person already confirmed this answer is wrong, which is the most specific and verifiable evidence available."
      : candidates.length > 1 ? "It is the highest-priority supported finding from the homepage read." : "It is the only supported finding from the recorded evidence."
  return { status: "PROBLEM_SELECTED", selected, selectionReason, candidates, gaps, conflicts, checked }
}

/** Only used to name an existing /setup initiative; never stored. */
const placeholderBrief = (businessName: string): SetupBrief => ({ businessName, category: "business", audience: "", valueProposition: "",
  goalStatement: "", conversionKind: "LEAD", metricLabel: "results", reportingTimeZone: "UTC", factIds: [] })
