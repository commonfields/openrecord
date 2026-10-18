// AI Acquisition read model. Everything is derived from stored rows on each
// request: candidate mentions, classified citations, batch metrics, the
// referral summary and the agency report. Nothing here writes or caches.
//
// Measurement contract (every rate carries its numerator and denominator):
// - eligible sample      a SUCCEEDED check with a non-synthetic observation.
// - mention rate         confirmed MENTIONED reviews / eligible samples.
// - recommendation rate  reviewed RECOMMENDED / reviewed eligible samples.
// - owned citation rate  eligible samples citing an owned domain / eligible.
// - competitor counts    eligible samples with an exact-name detection of a
//                        named competitor (detection, not review; not share).
// - repeatability        per frozen question: "Recommended in r of n reviewed
//                        samples", never a probability.
// Unreviewed candidates never enter confirmed counts. Failed checks stay in
// the attempt counts. Samples of one question are correlated; no interval is
// computed from sample counts.
import {
  DETECTOR_VERSION, classifyCitation, detectMentions, type BrandSpec, type CandidateMention, type ClassifiedCitation,
} from "./acquisition-detect.js"
import { AI_SOURCES_VERSION, aiAssistantFor } from "./acquisition-ga4.js"
import {
  ACQ_INTENT_GROUPS, type AcqBatch, type AcqCheck, type AcqIntentGroup, type AcqJudgment, type AcqQuestionSet, type AcqReferralImport, type AcqSnapshot,
} from "./acquisition.js"

export interface Fraction { readonly n: number; readonly d: number }
const frac = (n: number, d: number): Fraction => ({ n, d })

export const ACQ_SURFACE_LABELS: Record<string, string> = { gemini: "Gemini API with Google Search grounding", mock: "Fixture provider (synthetic)" }
export const surfaceText = (provider: string, model: string | null) => `${ACQ_SURFACE_LABELS[provider] ?? provider}${model ? ` (${model})` : ""}`
export const SIGNUPS_NOT_MEASURED = "SIGNUPS_NOT_MEASURED" as const
export const ACQ_CAUSALITY_DISCLOSURE =
  "Answer samples and analytics referrals come from different sources and methods. This report does not claim that any answer produced a visit, a signup, incremental customers or revenue."

const RETRIEVAL_OBSERVED = new Set(["PROVIDER_GROUNDING", "WEB_SEARCH", "grounded"])

/** Current judgment: the head of the append-only correction chain. */
export const currentAcqJudgment = (chain: ReadonlyArray<AcqJudgment>): AcqJudgment | null => {
  const superseded = new Set(chain.flatMap(j => (j.supersedesId === null ? [] : [j.supersedesId])))
  const heads = chain.filter(j => !superseded.has(j.id))
  return heads.length === 1 ? heads[0]! : null
}

export interface DerivedObservation {
  readonly id: string
  readonly provider: string
  readonly requestedModel: string | null
  readonly observedModel: string | null
  readonly collectedAt: string
  readonly answerText: string
  readonly rawDigest: string
  readonly synthetic: boolean
  readonly retrievalMode: string
  readonly retrievalTool: string | null
  readonly retrievalRequested: boolean
  readonly retrievalObserved: boolean
  readonly searchQueries: ReadonlyArray<string>
  readonly searchSuggestionsHtml: string | null
  readonly citations: ReadonlyArray<ClassifiedCitation & { readonly attributedByProvider: boolean }>
}
export interface DerivedCheck {
  readonly id: string
  readonly batchId: string
  readonly questionId: string
  readonly questionKey: string
  readonly group: AcqIntentGroup
  readonly prompt: string
  readonly sample: number
  readonly status: AcqCheck["status"]
  readonly failureClass: string | null
  readonly failureDetailSafe: string | null
  readonly attempts: number
  readonly queuedAt: string
  readonly completedAt: string | null
  readonly observation: DerivedObservation | null
  readonly candidates: ReadonlyArray<CandidateMention>
  readonly judgment: AcqJudgment | null
  readonly judgments: ReadonlyArray<AcqJudgment>
  readonly eligible: boolean
}

const metaOf = (m: unknown): { queries: string[]; html: string | null } => {
  const o = (m ?? {}) as { webSearchQueries?: unknown; searchSuggestionsHtml?: unknown }
  return {
    queries: Array.isArray(o.webSearchQueries) ? o.webSearchQueries.filter((q): q is string => typeof q === "string") : [],
    html: typeof o.searchSuggestionsHtml === "string" ? o.searchSuggestionsHtml : null,
  }
}

export const deriveCheck = (c: AcqCheck, set: AcqQuestionSet): DerivedCheck => {
  const q = set.questions.find(x => x.id === c.questionId)!
  const o = c.observation
  let observation: DerivedObservation | null = null
  let candidates: CandidateMention[] = []
  if (o) {
    const tools = (o.requestParameters as { tools?: unknown } | null)?.tools
    const meta = metaOf(o.providerMetadata)
    observation = {
      id: o.id, provider: o.provider, requestedModel: o.requestedModel, observedModel: o.observedModel, collectedAt: o.collectedAt,
      answerText: o.answerText, rawDigest: o.rawDigest, synthetic: o.synthetic, retrievalMode: o.retrievalMode, retrievalTool: o.retrievalTool,
      retrievalRequested: Array.isArray(tools) && tools.length > 0, retrievalObserved: RETRIEVAL_OBSERVED.has(o.retrievalMode),
      searchQueries: meta.queries, searchSuggestionsHtml: meta.html,
      citations: o.citations.map(ci => ({ ...classifyCitation(ci, set.target.domains, set.competitors), attributedByProvider: ci.attributed })),
    }
    candidates = detectMentions(o.answerText, set.target, set.competitors)
  }
  return {
    id: c.id, batchId: c.batchId, questionId: c.questionId, questionKey: q.key, group: q.group, prompt: q.prompt, sample: c.sample,
    status: c.status, failureClass: c.failureClass, failureDetailSafe: c.failureDetailSafe, attempts: c.attempts, queuedAt: c.queuedAt,
    completedAt: c.completedAt, observation, candidates, judgment: currentAcqJudgment(c.judgments), judgments: c.judgments,
    eligible: c.status === "SUCCEEDED" && o !== null && !o.synthetic,
  }
}

export type BatchStatus = "QUEUED" | "RUNNING" | "SUCCEEDED" | "PARTIALLY_SUCCEEDED" | "FAILED"
export const batchStatus = (checks: ReadonlyArray<{ status: AcqCheck["status"] }>): BatchStatus => {
  if (checks.length === 0) return "FAILED"
  if (checks.some(c => c.status === "QUEUED" || c.status === "RUNNING")) return checks.every(c => c.status === "QUEUED") ? "QUEUED" : "RUNNING"
  const ok = checks.filter(c => c.status === "SUCCEEDED").length
  return ok === checks.length ? "SUCCEEDED" : ok === 0 ? "FAILED" : "PARTIALLY_SUCCEEDED"
}

export interface QuestionSummary {
  readonly key: string
  readonly group: AcqIntentGroup
  readonly prompt: string
  readonly planned: number
  readonly failed: number
  readonly eligible: number
  readonly reviewed: number
  readonly mentioned: number
  readonly recommended: number
  readonly ownedCited: number
  readonly statement: string
}
export interface BatchMetrics {
  readonly planned: number
  readonly providerAttempts: number
  readonly succeeded: number
  readonly failed: number
  readonly pending: number
  readonly failures: ReadonlyArray<{ readonly failureClass: string; readonly count: number }>
  readonly eligible: number
  readonly syntheticExcluded: number
  readonly groundingObserved: Fraction
  readonly reviewed: Fraction
  readonly candidateSamples: Fraction
  readonly mentionRate: Fraction
  readonly recommendationRate: Fraction
  readonly breakdown: { readonly recommended: number; readonly mentionedNotRecommended: number; readonly advisedAgainst: number; readonly recommendationUnclear: number
    readonly notMentioned: number; readonly mentionUnclear: number }
  readonly ownedCitationRate: Fraction
  readonly competitors: ReadonlyArray<{ readonly name: string; readonly samples: Fraction }>
  readonly questions: ReadonlyArray<QuestionSummary>
  /** Question-level: questions with >= 1 reviewed RECOMMENDED sample / questions with >= 1 reviewed sample. */
  readonly questionsRecommended: Fraction
  readonly groups: ReadonlyArray<{ readonly group: AcqIntentGroup; readonly questions: number; readonly reviewed: number; readonly recommended: number }>
}

export const repeatabilityStatement = (q: { planned: number; failed: number; eligible: number; reviewed: number; recommended: number }): string => {
  if (q.eligible === 0) return q.failed > 0 ? `No answer collected (${q.failed} of ${q.planned} failed)` : "No answer collected yet"
  if (q.reviewed === 0) return `Not reviewed (${q.eligible} of ${q.planned} answered)`
  const base = `Recommended in ${q.recommended} of ${q.reviewed} reviewed sample${q.reviewed === 1 ? "" : "s"}`
  const extra: string[] = []
  if (q.reviewed < q.eligible) extra.push(`${q.eligible - q.reviewed} unreviewed`)
  if (q.failed > 0) extra.push(`${q.failed} failed`)
  return extra.length ? `${base} (${extra.join(", ")})` : base
}

export const batchMetrics = (batch: AcqBatch, set: AcqQuestionSet, all: ReadonlyArray<DerivedCheck>): BatchMetrics => {
  const checks = all.filter(c => c.batchId === batch.id)
  const eligible = checks.filter(c => c.eligible)
  const reviewed = eligible.filter(c => c.judgment !== null)
  const is = (c: DerivedCheck, rec: string) => c.judgment?.recommendation === rec
  const failuresMap = new Map<string, number>()
  for (const c of checks.filter(x => x.status === "FAILED")) failuresMap.set(c.failureClass ?? "UNKNOWN", (failuresMap.get(c.failureClass ?? "UNKNOWN") ?? 0) + 1)
  const keys = [...new Set(checks.map(c => c.questionKey))]
  const questions = set.questions.filter(q => keys.includes(q.key)).map((q): QuestionSummary => {
    const qc = checks.filter(c => c.questionKey === q.key)
    const qe = qc.filter(c => c.eligible)
    const qr = qe.filter(c => c.judgment !== null)
    const s = { planned: qc.length, failed: qc.filter(c => c.status === "FAILED").length, eligible: qe.length, reviewed: qr.length,
      mentioned: qr.filter(c => c.judgment!.mention === "MENTIONED").length, recommended: qr.filter(c => is(c, "RECOMMENDED")).length,
      ownedCited: qe.filter(c => c.observation!.citations.some(ci => ci.owner === "OWNED")).length }
    return { key: q.key, group: q.group, prompt: q.prompt, ...s, statement: repeatabilityStatement(s) }
  })
  const reviewedQuestions = questions.filter(q => q.reviewed > 0)
  return {
    planned: checks.length,
    providerAttempts: checks.reduce((n, c) => n + c.attempts, 0),
    succeeded: checks.filter(c => c.status === "SUCCEEDED").length,
    failed: checks.filter(c => c.status === "FAILED").length,
    pending: checks.filter(c => c.status === "QUEUED" || c.status === "RUNNING").length,
    failures: [...failuresMap].map(([failureClass, count]) => ({ failureClass, count })).sort((a, b) => b.count - a.count),
    eligible: eligible.length,
    syntheticExcluded: checks.filter(c => c.status === "SUCCEEDED" && c.observation?.synthetic).length,
    groundingObserved: frac(eligible.filter(c => c.observation!.retrievalObserved).length, eligible.length),
    reviewed: frac(reviewed.length, eligible.length),
    candidateSamples: frac(eligible.filter(c => c.candidates.some(m => m.role === "TARGET")).length, eligible.length),
    mentionRate: frac(reviewed.filter(c => c.judgment!.mention === "MENTIONED").length, eligible.length),
    recommendationRate: frac(reviewed.filter(c => is(c, "RECOMMENDED")).length, reviewed.length),
    breakdown: {
      recommended: reviewed.filter(c => is(c, "RECOMMENDED")).length,
      mentionedNotRecommended: reviewed.filter(c => is(c, "MENTIONED_NOT_RECOMMENDED")).length,
      advisedAgainst: reviewed.filter(c => is(c, "ADVISED_AGAINST")).length,
      recommendationUnclear: reviewed.filter(c => is(c, "UNCLEAR")).length,
      notMentioned: reviewed.filter(c => c.judgment!.mention === "NOT_MENTIONED").length,
      mentionUnclear: reviewed.filter(c => c.judgment!.mention === "UNCLEAR").length,
    },
    ownedCitationRate: frac(eligible.filter(c => c.observation!.citations.some(ci => ci.owner === "OWNED")).length, eligible.length),
    competitors: set.competitors.map(b => ({ name: b.name,
      samples: frac(eligible.filter(c => c.candidates.some(m => m.role === "COMPETITOR" && m.brand === b.name)).length, eligible.length) })),
    questions,
    questionsRecommended: frac(reviewedQuestions.filter(q => q.recommended > 0).length, reviewedQuestions.length),
    groups: ACQ_INTENT_GROUPS.filter(g => questions.some(q => q.group === g)).map(g => {
      const qs = questions.filter(q => q.group === g)
      return { group: g, questions: qs.length, reviewed: qs.reduce((n, q) => n + q.reviewed, 0), recommended: qs.reduce((n, q) => n + q.recommended, 0) }
    }),
  }
}

/** Why two batches are not like-for-like. Empty means comparable. Periods are
 * still never subtracted: the report shows each period on its own. */
export const configurationDifferences = (a: AcqBatch, b: AcqBatch, checks: ReadonlyArray<DerivedCheck>): string[] => {
  const diffs: string[] = []
  if (a.setId !== b.setId) diffs.push("question set version")
  if (a.provider !== b.provider || a.requestedModel !== b.requestedModel) diffs.push("provider or model")
  if (a.retrievalRequested !== b.retrievalRequested) diffs.push("requested retrieval")
  if (a.sampleCount !== b.sampleCount) diffs.push("samples per question")
  const keys = (id: string) => [...new Set(checks.filter(c => c.batchId === id).map(c => c.questionKey))].sort().join(",")
  if (keys(a.id) !== keys(b.id)) diffs.push("questions asked")
  return diffs
}

// ---------------------------------------------------------------------------
// Referral evidence (manually supplied GA4 exports)
// ---------------------------------------------------------------------------

export interface ReferralSummary {
  readonly id: string
  readonly synthetic: boolean
  readonly propertyRef: string
  readonly dateStart: string
  readonly dateEnd: string
  readonly timeZone: string
  readonly attributionBasis: string
  readonly conversionEvent: string | null
  readonly rawDigest: string
  readonly importedAt: string
  readonly totalSessions: number
  readonly aiSessions: number
  readonly bySource: ReadonlyArray<{ readonly assistant: string; readonly sources: ReadonlyArray<string>; readonly sessions: number; readonly conversions: number | null }>
  readonly signups: number | typeof SIGNUPS_NOT_MEASURED
}

export const referralSummary = (i: AcqReferralImport): ReferralSummary => {
  const measured = i.conversionEvent !== null
  const groups = new Map<string, { sources: Set<string>; sessions: number; conversions: number }>()
  for (const r of i.rows) {
    const assistant = aiAssistantFor(r.sessionSource)
    if (!assistant) continue
    const g = groups.get(assistant) ?? { sources: new Set<string>(), sessions: 0, conversions: 0 }
    g.sources.add(`${r.sessionSource} / ${r.sessionMedium}`)
    g.sessions += r.sessions
    g.conversions += r.conversions ?? 0
    groups.set(assistant, g)
  }
  const bySource = [...groups].map(([assistant, g]) => ({ assistant, sources: [...g.sources].sort(), sessions: g.sessions, conversions: measured ? g.conversions : null }))
    .sort((a, b) => b.sessions - a.sessions || a.assistant.localeCompare(b.assistant))
  return {
    id: i.id, synthetic: i.dataOrigin !== "GA4_EXPORT", propertyRef: i.propertyRef, dateStart: i.dateStart, dateEnd: i.dateEnd, timeZone: i.timeZone,
    attributionBasis: i.attributionBasis, conversionEvent: i.conversionEvent, rawDigest: i.rawDigest, importedAt: i.importedAt,
    totalSessions: i.rows.reduce((n, r) => n + r.sessions, 0),
    aiSessions: bySource.reduce((n, s) => n + s.sessions, 0),
    bySource,
    signups: measured ? bySource.reduce((n, s) => n + (s.conversions ?? 0), 0) : SIGNUPS_NOT_MEASURED,
  }
}

// ---------------------------------------------------------------------------
// Operator view and agency report
// ---------------------------------------------------------------------------

export const acquisitionView = (s: AcqSnapshot) => {
  const setById = new Map(s.sets.map(x => [x.id, x]))
  const batchSet = new Map(s.batches.map(b => [b.id, setById.get(b.setId)!]))
  const checks = s.checks.map(c => deriveCheck(c, batchSet.get(c.batchId)!))
  const batches = s.batches.map(b => {
    const own = checks.filter(c => c.batchId === b.id)
    return { ...b, setVersion: batchSet.get(b.id)!.version, status: batchStatus(own), surface: surfaceText(b.provider, b.requestedModel),
      collectedFrom: minMax(own).from, collectedTo: minMax(own).to, metrics: batchMetrics(b, batchSet.get(b.id)!, checks) }
  })
  return {
    profile: s.profile,
    sets: s.sets.map(x => ({ ...x,
      // Transparency, not a gate: questions that name the target brand can lead the answer.
      questionsNamingTarget: x.questions.filter(q => detectMentions(q.prompt, x.target, []).length > 0).map(q => q.key) })),
    batches,
    checks,
    referrals: s.imports.map(referralSummary),
    activeBatch: batches.some(b => b.status === "QUEUED" || b.status === "RUNNING"),
    detectorVersion: DETECTOR_VERSION,
    aiSourcesVersion: AI_SOURCES_VERSION,
  }
}

const minMax = (checks: ReadonlyArray<DerivedCheck>) => {
  const times = checks.flatMap(c => (c.observation ? [c.observation.collectedAt] : [])).sort()
  return { from: times[0] ?? null, to: times.at(-1) ?? null }
}

export type AcquisitionView = ReturnType<typeof acquisitionView>

/** The agency report. Counts derive from reviewed observations only; it is an
 * authenticated operator document, never a public page. */
export const acquisitionReport = (s: AcqSnapshot) => {
  const view = acquisitionView(s)
  const done = view.batches.filter(b => b.status !== "QUEUED" && b.status !== "RUNNING")
  const set = s.sets.find(x => x.id === done.at(-1)?.setId) ?? s.sets.at(-1) ?? null
  const measuredSetIds = new Set(done.map(b => b.setId))
  const bases = new Set((done.length ? s.sets.filter(x => measuredSetIds.has(x.id)) : set ? [set] : []).map(x => x.basis))
  const periods = done.map(b => {
    const own = view.checks.filter(c => c.batchId === b.id && c.eligible && c.judgment !== null)
    const pick = (pred: (c: DerivedCheck) => boolean, n: number) => own.filter(pred).slice(0, n)
    const representative = [
      ...pick(c => c.judgment!.recommendation === "RECOMMENDED", 2),
      ...pick(c => c.judgment!.recommendation === "ADVISED_AGAINST" || c.judgment!.recommendation === "MENTIONED_NOT_RECOMMENDED", 1),
      ...pick(c => c.judgment!.mention === "NOT_MENTIONED", 1),
    ].map(c => ({ questionKey: c.questionKey, prompt: c.prompt, sample: c.sample, collectedAt: c.observation!.collectedAt, answerText: c.observation!.answerText,
      mention: c.judgment!.mention, recommendation: c.judgment!.recommendation, observationId: c.observation!.id, rawDigest: c.observation!.rawDigest,
      ownedCitations: c.observation!.citations.filter(ci => ci.owner === "OWNED").map(ci => ci.domain!) }))
    return { batchId: b.id, scope: b.scope, setVersion: b.setVersion, surface: b.surface, sampleCount: b.sampleCount, collectedFrom: b.collectedFrom,
      collectedTo: b.collectedTo, metrics: b.metrics, representative }
  })
  const first = view.batches[0]
  const changed = first ? [...new Set(view.batches.slice(1).flatMap(b => configurationDifferences(first, b, view.checks)))] : []
  const realReferrals = view.referrals.filter(r => !r.synthetic)
  const unreviewed = periods.reduce((n, p) => n + (p.metrics.eligible - p.metrics.reviewed.n), 0)
  const failed = periods.reduce((n, p) => n + p.metrics.failed, 0)
  const planned = periods.reduce((n, p) => n + p.metrics.planned, 0)
  const surfaces = [...new Set(periods.map(p => p.surface))]
  const limitations = [
    `Measured surface: ${surfaces.join("; ") || "none yet"}. These answers describe that surface only; they do not measure ChatGPT, Claude, Perplexity or any other assistant.`,
    "Samples of the same question are correlated. \"Recommended in r of n samples\" is a count, not the probability that a buyer receives that answer, and no confidence interval is computed from sample counts.",
    `Recommendation and mention counts include human-reviewed samples only.${unreviewed ? ` ${unreviewed} successful sample${unreviewed === 1 ? " is" : "s are"} not reviewed and not counted.` : ""}`,
    `Competitor appearances are exact-name detections (${DETECTOR_VERSION}), not human-reviewed, and are not market share.`,
    "Owned-domain citations use the source domain the provider reported for each grounding source. Redirect links were not followed, and whether a cited source supports the answer was not verified.",
    ...(failed ? [`${failed} of ${planned} planned samples failed. They remain in the attempt counts and are not retried selectively.`] : []),
    ...(bases.has("PUBLIC_RESEARCH") ? [`Public research pilot: ${s.profile.name} is not an OpenRecord customer and did not authorize or review this measurement.`] : []),
    ...(bases.has("FIXTURE") ? [bases.size === 1 ? "Fixture pilot: every figure comes from test fixtures." : "Fixture periods contain test fixtures."] : []),
    ...(changed.length ? [`The measurement configuration changed between periods (${changed.join(", ")}). Periods are shown separately and are not compared.`] : []),
    realReferrals.length
      ? "Referral totals come from a manually supplied GA4 export: a separate source and method. An AI-attributed session is not evidence that any sampled answer produced it."
      : "No GA4 export was provided, so AI referral traffic and signups are not measured.",
    ACQ_CAUSALITY_DISCLOSURE,
  ]
  return {
    question: "How often did the measured AI surface mention or recommend this business?",
    business: { name: s.profile.name, websiteUrl: s.profile.websiteUrl },
    category: set?.category ?? null,
    basis: set?.basis ?? null,
    questionSet: set ? { version: set.version, specDigest: set.specDigest, questions: set.questions.length, createdAt: set.createdAt } : null,
    ownedDomains: set?.target.domains ?? [],
    competitors: set?.competitors.map(c => c.name) ?? [],
    periods,
    configurationChanged: changed,
    referrals: { provided: realReferrals.length > 0, imports: realReferrals, syntheticExcluded: view.referrals.length - realReferrals.length },
    limitations,
    detectorVersion: DETECTOR_VERSION,
    aiSourcesVersion: AI_SOURCES_VERSION,
  }
}
export type AcquisitionReport = ReturnType<typeof acquisitionReport>
export type { BrandSpec }
