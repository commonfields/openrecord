// Agency Operator referral interpretation (P3), pure and deterministic.
//
// Consumes the acquisition-owned read model only: referralSummary() and
// acquisitionView() over AcquisitionRepository.snapshot(). It adds no GA4
// parsing, no attribution rules and no persistence. Every number below is
// copied from those helpers; nothing is estimated, extrapolated or summed
// across exports. The conversation model receives these values as untrusted
// evidence and must quote them rather than compute its own totals.
//
// Surfaces stay separate:
// - Measured AI recommendations come from acquisition batches against the
//   measured provider surface (for example Gemini with Google Search
//   grounding) and are human-reviewed answer judgments.
// - Website referral sessions come from an operator-supplied GA4 export,
//   attributed by session source (chatgpt.com, claude.ai, gemini.google.com).
//   A GA4 "Gemini" session is not a measured Gemini recommendation.
// - Conversions are the configured key event of that export. Only a signup
//   event yields a signup count; no configured event means SIGNUPS_NOT_MEASURED,
//   never zero.
import { AI_SOURCES_VERSION, AI_SOURCE_RULES } from "./acquisition-ga4.js"
import { ACQ_CAUSALITY_DISCLOSURE, SIGNUPS_NOT_MEASURED, acquisitionView, referralSummary, surfaceText, type ReferralSummary } from "./acquisition-view.js"
import type { AcqSnapshot } from "./acquisition.js"

export const REFERRAL_DATA_UNAVAILABLE = "REFERRAL_DATA_UNAVAILABLE" as const

export const REFERRAL_LIMITATIONS = [
  "Validated operator-supplied GA4 export: the file passed schema validation; OpenRecord has not independently authenticated the analytics account.",
  "Report date selection uses UTC calendar-day overlap; each export retains its original time zone and full period. This is not exact temporal alignment with recommendation measurements.",
  "Session source attribution can miss AI discovery that arrives as direct, search or untagged traffic. Sessions are not unique people.",
  "Configured conversion counts are key events as GA4 reported them. They are not necessarily people, customers, signups or revenue.",
  "Website referral sessions and measured AI recommendations are separate sources and methods. GA4 assistant labels identify referral sources, not measured answers.",
  ACQ_CAUSALITY_DISCLOSURE,
] as const

export const REFERRAL_SURFACE_NOTE =
  "Recommendation counts exist only for the measured surfaces listed here (read them with read_acquisition_overview). GA4 referral sessions attributed to ChatGPT, Claude, Gemini or any other assistant are website traffic, not measured recommendations, and do not measure what those assistants answer."

const SIGNUP_EVENTS = new Set(["sign_up", "signup"])
/** GA4's recommended signup event (sign_up) and its common spellings. Any other
 * configured key event (purchase, generate_lead, ...) is a conversion, not a signup. */
export const isSignupEvent = (event: string | null): boolean =>
  event !== null && SIGNUP_EVENTS.has(event.trim().toLowerCase().replace(/[\s-]+/g, "_"))

const MAX_SOURCE_MEDIUMS = 10
const MAX_INDEX = 20
const MAX_SURFACES = 20
const days = (start: string, end: string) => Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400000) + 1
const leaders = <T extends { readonly assistant: string }>(rows: ReadonlyArray<T>, value: (row: T) => number | null) => {
  const max = Math.max(0, ...rows.map(r => value(r) ?? 0))
  return max === 0 ? [] : rows.filter(r => value(r) === max).map(r => ({ assistant: r.assistant, count: max }))
}

/** Real (non-synthetic) imports through the acquisition read model, oldest first. */
export const realReferralSummaries = (snapshot: AcqSnapshot | null): ReadonlyArray<ReferralSummary> =>
  (snapshot?.imports ?? []).map(referralSummary).filter(r => !r.synthetic)

/** Bounded, structured evidence for one validated real export. */
export const agentReferralEvidence = (summary: ReferralSummary) => {
  const signup = isSignupEvent(summary.conversionEvent)
  const measured = summary.conversionEvent !== null
  return {
    importId: summary.id,
    dataOrigin: "GA4_EXPORT" as const,
    validationState: "VALIDATED_IMPORT_SCHEMA" as const,
    propertyRef: summary.propertyRef,
    period: { start: summary.dateStart, end: summary.dateEnd, timeZone: summary.timeZone, days: days(summary.dateStart, summary.dateEnd) },
    attributionBasis: summary.attributionBasis,
    aiSourcesVersion: AI_SOURCES_VERSION,
    importDigest: summary.rawDigest,
    importedAt: summary.importedAt,
    sessions: { aiAttributed: summary.aiSessions, totalReported: summary.totalSessions },
    aiReferralSources: summary.bySource.map(s => ({
      assistant: s.assistant, sessions: s.sessions,
      sourceMediums: s.sources.slice(0, MAX_SOURCE_MEDIUMS), sourceMediumsTotal: s.sources.length,
      configuredConversions: s.conversions,
      signups: signup ? s.conversions : SIGNUPS_NOT_MEASURED,
    })),
    sessionLeaders: leaders(summary.bySource, s => s.sessions),
    assistantsWithoutAttributedRows: AI_SOURCE_RULES.map(r => r.assistant).filter(a => !summary.bySource.some(s => s.assistant === a)),
    configuredConversions: measured
      ? { availability: "CONFIGURED_EVENT" as const, event: summary.conversionEvent, total: summary.signups as number, leaders: leaders(summary.bySource, s => s.conversions) }
      : { availability: "NOT_CONFIGURED" as const, event: null, total: null, leaders: [] },
    signups: signup ? (summary.signups as number) : SIGNUPS_NOT_MEASURED,
    signupsBasis: signup
      ? `Configured signup event "${summary.conversionEvent}". Event counts are not necessarily unique people.`
      : measured
        ? `The configured event "${summary.conversionEvent}" is not a signup event; signups are not measured.`
        : "No conversion event was configured for this export; signups are not measured (unknown, not zero).",
    limitations: REFERRAL_LIMITATIONS,
  }
}
export type AgentReferralEvidence = ReturnType<typeof agentReferralEvidence>

/** Descriptive comparison of two full export periods. Never sums or clips periods. */
export const compareReferralEvidence = (before: AgentReferralEvidence, after: AgentReferralEvidence) => {
  const reasons = [
    ...(before.importId === after.importId ? ["same export"] : []),
    ...(before.propertyRef !== after.propertyRef ? ["analytics property changed"] : []),
    ...(before.period.timeZone !== after.period.timeZone ? ["time zone changed"] : []),
    ...(before.attributionBasis !== after.attributionBasis ? ["attribution basis changed"] : []),
    ...(before.configuredConversions.event !== after.configuredConversions.event ? ["conversion event changed"] : []),
    ...(before.period.end >= after.period.start ? ["periods overlap or are out of order"] : []),
  ]
  const comparable = reasons.length === 0
  const assistants = [...new Set([...before.aiReferralSources, ...after.aiReferralSources].map(s => s.assistant))].sort()
  const sessionsOf = (e: AgentReferralEvidence, a: string) => e.aiReferralSources.find(s => s.assistant === a)?.sessions ?? 0
  return {
    state: comparable ? "DESCRIPTIVE_PERIODS" as const : "NOT_COMPARABLE" as const,
    reasons,
    before: { importId: before.importId, period: before.period, aiAttributedSessions: before.sessions.aiAttributed, configuredConversions: before.configuredConversions.total },
    after: { importId: after.importId, period: after.period, aiAttributedSessions: after.sessions.aiAttributed, configuredConversions: after.configuredConversions.total },
    aiAttributedSessionDelta: comparable ? after.sessions.aiAttributed - before.sessions.aiAttributed : null,
    sessionDeltaByAssistant: comparable ? assistants.map(a => ({ assistant: a, before: sessionsOf(before, a), after: sessionsOf(after, a), delta: sessionsOf(after, a) - sessionsOf(before, a) })) : [],
    configuredConversionDelta: comparable && before.configuredConversions.total !== null && after.configuredConversions.total !== null
      ? after.configuredConversions.total - before.configuredConversions.total : null,
    limitation: "Each full export period is shown separately and period lengths may differ. A difference in counts does not establish incremental visits, conversions or any causal effect, including of AI recommendations or agency work.",
  }
}

export type ReferralReadInput = { readonly importId?: string | undefined; readonly beforeImportId?: string | undefined }
/** The read_ai_referral_evidence contract. "NOT_FOUND" when a requested export
 * is not a real export of this business (foreign, synthetic or unknown). */
export const agentReferralRead = (snapshot: AcqSnapshot | null, input: ReferralReadInput) => {
  const all = snapshot?.imports ?? []
  const real = realReferralSummaries(snapshot)
  const measuredSurfaces = [...new Set((snapshot?.batches ?? []).map(b => surfaceText(b.provider, b.requestedModel)))]
  const surfaces = {
    measuredRecommendationSurfaces: measuredSurfaces.slice(-MAX_SURFACES),
    measuredRecommendationSurfacesTotal: measuredSurfaces.length,
    websiteReferralSource: "Operator-supplied GA4 export, session source attribution",
    note: REFERRAL_SURFACE_NOTE,
  }
  const index = real.slice(-MAX_INDEX).reverse().map(r => ({ importId: r.id, propertyRef: r.propertyRef, period: { start: r.dateStart, end: r.dateEnd, timeZone: r.timeZone }, conversionEvent: r.conversionEvent, importedAt: r.importedAt }))
  const counts = { realImports: real.length, syntheticImportsExcluded: all.length - real.length }
  const current = input.importId ? real.find(r => r.id === input.importId) : real.at(-1)
  const previous = input.beforeImportId ? real.find(r => r.id === input.beforeImportId) : undefined
  if ((input.importId && !current) || (input.beforeImportId && !previous)) return "NOT_FOUND" as const
  if (!current) {
    return { state: REFERRAL_DATA_UNAVAILABLE, signups: SIGNUPS_NOT_MEASURED, configuredConversions: { availability: "UNKNOWN" as const, total: null },
      ...counts, imports: index, surfaces, limitations: REFERRAL_LIMITATIONS }
  }
  const evidence = agentReferralEvidence(current)
  return { state: "AVAILABLE" as const, ...counts, imports: index, evidence,
    comparison: previous ? compareReferralEvidence(agentReferralEvidence(previous), evidence) : null, surfaces }
}

// ---------------------------------------------------------------------------
// Private client report sections. Four distinct sections, deterministic text,
// no composite score. Returns null when the selection is too large to report
// faithfully (the caller refuses rather than silently dropping evidence).
// ---------------------------------------------------------------------------

export const REFERRAL_REPORT_SECTIONS = ["AI recommendation evidence", "Website referral evidence", "Conversion evidence", "Limitations"] as const

export const buildAgentReportSupplement = (snapshot: AcqSnapshot | null, start: string, end: string) => {
  const startMs = Date.parse(start), endMs = Date.parse(end)
  const view = snapshot ? acquisitionView(snapshot) : null
  const batches = (view?.batches ?? []).filter(b => Date.parse(b.createdAt) >= startMs && Date.parse(b.createdAt) < endMs)
    .map(b => ({ id: b.id, createdAt: b.createdAt, basis: view!.sets.find(s => s.id === b.setId)?.basis ?? "UNKNOWN", surface: b.surface, provider: b.provider, requestedModel: b.requestedModel,
      observedModels: [...new Set(view!.checks.filter(c => c.batchId === b.id && c.eligible).map(c => c.observation!.observedModel ?? "unknown"))],
      setVersion: b.setVersion, status: b.status, metrics: { planned: b.metrics.planned, pending: b.metrics.pending, providerAttempts: b.metrics.providerAttempts, failed: b.metrics.failed, eligible: b.metrics.eligible, syntheticExcluded: b.metrics.syntheticExcluded,
        reviewed: b.metrics.reviewed, mentionRate: b.metrics.mentionRate, recommendationRate: b.metrics.recommendationRate, ownedCitationRate: b.metrics.ownedCitationRate, competitors: b.metrics.competitors },
      observations: view!.checks.filter(c => c.batchId === b.id && c.eligible).map(c => ({ id: c.observation!.id, rawDigest: c.observation!.rawDigest, judgmentId: c.judgment?.id ?? null, citations: c.observation!.citations })) }))
  // Full export periods that overlap [start, end); dates compared as calendar days.
  const all = snapshot?.imports ?? []
  const real = realReferralSummaries(snapshot).filter(r => Date.parse(`${r.dateStart}T00:00:00Z`) < endMs && Date.parse(`${r.dateEnd}T00:00:00Z`) + 86400000 > startMs)
  const syntheticExcluded = all.filter(i => i.dataOrigin !== "GA4_EXPORT").length
  if (batches.length > 100 || real.length > 10) return null
  const referrals = real.map(agentReferralEvidence)
  const recommendation = batches.length
    ? batches.map(b => `${b.createdAt}: ${b.surface}; observed ${b.observedModels.join(", ") || "unknown"}; question set v${b.setVersion}; measurement basis ${b.basis.toLowerCase().replaceAll("_", " ")}. ${b.metrics.planned} planned samples, ${b.metrics.pending} pending, ${b.metrics.providerAttempts} provider attempts, ${b.metrics.failed} failed, ${b.metrics.syntheticExcluded} synthetic excluded. Reviewed ${b.metrics.reviewed.n} of ${b.metrics.reviewed.d} eligible real answers. Recommended in ${b.metrics.recommendationRate.n} of ${b.metrics.recommendationRate.d} reviewed answers; confirmed mention in ${b.metrics.mentionRate.n} of ${b.metrics.mentionRate.d} eligible answers. Competitor exact-name detections: ${b.metrics.competitors.map(c => `${c.name}: ${c.samples.n} of ${c.samples.d}`).join("; ") || "none configured"} (not reviewed recommendations, not market share). Owned citations: ${b.metrics.ownedCitationRate.n} of ${b.metrics.ownedCitationRate.d} eligible answers. Citation evidence: ${b.observations.flatMap(o => o.citations.map(ci => `${ci.uri ?? "URL unavailable"} (${ci.owner.toLowerCase()}, support ${ci.support.toLowerCase()})`)).join("; ") || "none observed"}. Citation presence is not proof that a citation supports the answer. These counts describe this measured surface only.`)
    : ["No AI recommendation measurement was created in this report period. Recommendation frequency is not measured for this period."]
  const website = referrals.length
    ? referrals.map(r => `${r.propertyRef}; ${r.period.start} to ${r.period.end} (${r.period.days} days, ${r.period.timeZone}); attribution ${r.attributionBasis.toLowerCase().replaceAll("_", " ")}; import digest ${r.importDigest}. ${r.sessions.aiAttributed} AI-attributed sessions out of ${r.sessions.totalReported} reported sessions. ${r.aiReferralSources.map(s => `${s.assistant}: ${s.sessions} sessions`).join("; ") || "No AI-attributed rows"}. Full export period; not clipped to this report window and not added to other exports.`)
    : ["Referral data unavailable: no validated non-synthetic GA4 export overlaps this report period. AI referral sessions are not measured."]
  const conversion = referrals.length
    ? referrals.map(r => `${r.period.start} to ${r.period.end}: ${r.configuredConversions.availability === "CONFIGURED_EVENT"
      ? `configured event "${r.configuredConversions.event}", ${r.configuredConversions.total} events from AI-attributed sessions (${r.aiReferralSources.map(s => `${s.assistant}: ${s.configuredConversions}`).join("; ") || "none"}).`
      : "no conversion event configured; conversions are not measured."} Signups: ${r.signups === SIGNUPS_NOT_MEASURED ? "not measured" : r.signups}. ${r.signupsBasis}`)
    : ["Conversions and signups are not measured: no validated GA4 export with a configured event covers this period."]
  const text = [
    REFERRAL_REPORT_SECTIONS[0], ...recommendation,
    REFERRAL_REPORT_SECTIONS[1], ...website, ...(syntheticExcluded ? [`${syntheticExcluded} synthetic referral import${syntheticExcluded === 1 ? " is" : "s are"} excluded from every figure.`] : []),
    REFERRAL_REPORT_SECTIONS[2], ...conversion,
    REFERRAL_REPORT_SECTIONS[3], ...REFERRAL_LIMITATIONS,
  ].join("\n\n")
  const references = [...batches.map(b => ({ kind: "acquisition_batch", id: b.id, text: `Acquisition measurement ${b.createdAt}` })),
    ...batches.flatMap(b => b.observations.map(o => ({ kind: "observation", id: o.id, text: "Acquisition answer evidence" }))),
    ...referrals.map(r => ({ kind: "referral_import", id: r.importId, text: `GA4 export ${r.period.start} to ${r.period.end}` }))]
  if (references.length > 800) return null
  return { text, references, evidence: { sections: REFERRAL_REPORT_SECTIONS, batches, referrals, syntheticReferralImportsExcluded: syntheticExcluded } }
}
export type AgentReportSupplement = NonNullable<ReturnType<typeof buildAgentReportSupplement>>
