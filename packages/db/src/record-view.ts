// Client record read model. Everything is derived from the stored evidence
// on each request: run status, the before/after comparison per fact, the
// integrity finding per fact, and what the public page may show. Nothing here
// writes or caches a verdict.
//
// Wording rule: statements are never stronger than the evidence. The record
// reports what was observed before and after; it never says an action
// caused an answer (CAUSALITY_DISCLOSURE is shown with every comparison).
import { Schema } from "effect"
import { compareMeasurements, measurementSignature, MeasurementContextV1 } from "@openrecord/protocol"
import type { RecordAction, RecordCheck, RecordDecision, RecordItem, RecordJudgment, RecordObservation, RecordRun, RecordSnapshot } from "./record.js"

export const CAUSALITY_DISCLOSURE =
  "This shows what OpenRecord observed before and after the change. It does not prove that the edit caused the model's new answer."

export type RecordRunStatus = "QUEUED" | "RUNNING" | "SUCCEEDED" | "PARTIALLY_SUCCEEDED" | "FAILED"
export type RecordOutcome = "OBSERVED_CORRECTED" | "NO_OBSERVED_CHANGE" | "INDETERMINATE" | "RESOLVED_EXTERNALLY"
export type IndeterminateReason =
  | "NO_BASELINE" | "BEFORE_CHECK_FAILED" | "AFTER_CHECK_FAILED" | "FACT_CHANGED" | "QUESTION_CHANGED" | "SYNTHETIC_EVIDENCE"
  | "BEFORE_NO_RETRIEVAL" | "AFTER_NO_RETRIEVAL" | "SURFACE_CHANGED" | "SURFACE_UNKNOWN" | "OUT_OF_ORDER"
  | "BEFORE_UNKNOWN" | "AFTER_UNKNOWN" | "ANSWER_NO_LONGER_MATCHES" | "BASELINE_MATCHED" | "PARTIAL_RUN"

/** Retrieval modes that mean the provider reported actually using live web results. */
const RETRIEVAL_OBSERVED = new Set(["PROVIDER_GROUNDING", "WEB_SEARCH", "grounded"])
export const retrievalObserved = (o: RecordObservation): boolean => RETRIEVAL_OBSERVED.has(o.retrievalMode)
export const retrievalRequested = (o: RecordObservation): boolean => {
  const tools = (o.requestParameters as { tools?: unknown } | null)?.tools
  return Array.isArray(tools) && tools.length > 0
}

export const runStatus = (checks: ReadonlyArray<RecordCheck>): RecordRunStatus => {
  if (checks.length === 0) return "FAILED"
  if (checks.some(c => c.status === "QUEUED" || c.status === "RUNNING")) return checks.every(c => c.status === "QUEUED") ? "QUEUED" : "RUNNING"
  const ok = checks.filter(c => c.status === "SUCCEEDED").length
  return ok === checks.length ? "SUCCEEDED" : ok === 0 ? "FAILED" : "PARTIALLY_SUCCEEDED"
}

/** Current judgment: the head of the append-only correction chain. */
export const currentJudgment = (chain: ReadonlyArray<RecordJudgment>): RecordJudgment | null => {
  const superseded = new Set(chain.flatMap(j => (j.supersedesId === null ? [] : [j.supersedesId])))
  const heads = chain.filter(j => !superseded.has(j.id))
  return heads.length === 1 ? heads[0]! : null
}

export interface SlotEvidence { readonly check: RecordCheck; readonly item: RecordItem; readonly judgment: RecordJudgment | null; readonly runComplete: boolean }
export type SlotComparison =
  | { readonly state: "PENDING_CHECK" }
  | { readonly state: "AWAITING_REVIEW" }
  | { readonly state: "DERIVED"; readonly outcome: RecordOutcome; readonly reason: IndeterminateReason | null }

const decodeContext = Schema.decodeUnknownEither(MeasurementContextV1)
const indeterminate = (reason: IndeterminateReason): SlotComparison => ({ state: "DERIVED", outcome: "INDETERMINATE", reason })

// ---------------------------------------------------------------------------
// Sample counts: every client-facing count is derived from stored observations
// plus their reviewed judgments, never from transient state.
// ---------------------------------------------------------------------------

export interface SampleCounts {
  readonly total: number
  readonly reviewed: number
  readonly contradict: number
  readonly matches: number
  readonly unknown: number
}

export const EMPTY_COUNTS: SampleCounts = { total: 0, reviewed: 0, contradict: 0, matches: 0, unknown: 0 }

/** Counts over samples that produced an observation. Failed checks are not samples. */
export const countSamples = (evidence: ReadonlyArray<SlotEvidence>): SampleCounts => {
  const counts = { ...EMPTY_COUNTS }
  for (const e of evidence) {
    if (e.check.status !== "SUCCEEDED" || e.check.observation === null) continue
    counts.total += 1
    if (e.judgment === null) continue
    counts.reviewed += 1
    if (e.judgment.decision === "CONTRADICTS") counts.contradict += 1
    else if (e.judgment.decision === "MATCHES") counts.matches += 1
    else counts.unknown += 1
  }
  return counts
}

/** "4 of 5 reviewed observations contradicted this fact" — always backed by counts. */
export const sampleStatement = (counts: SampleCounts): string => {
  if (counts.reviewed === 0) return "No reviewed observations."
  const noun = counts.reviewed === 1 ? "observation" : "observations"
  const clauses: string[] = []
  if (counts.contradict > 0) clauses.push(`${counts.contradict} of ${counts.reviewed} reviewed ${noun} contradicted this fact`)
  if (counts.matches > 0) clauses.push(`${counts.matches} matched`)
  if (counts.unknown > 0) clauses.push(`${counts.unknown} could not be determined`)
  return `${clauses.join("; ")}.`
}

// ---------------------------------------------------------------------------
// Comparison: one fact, earlier samples, later samples. OBSERVED_CORRECTED
// needs reviewed contradiction before, unanimously reviewed MATCHES after,
// both retrieval-backed, from a comparable surface for the same fact and
// question, with a recorded action between them. A correction with no
// recorded action is RESOLVED_EXTERNALLY: the product takes no credit.
// Anything weaker is INDETERMINATE with its reason; never hidden.
// ---------------------------------------------------------------------------

type Verdict = "CONTRADICTS" | "MATCHES" | "UNKNOWN"

/** A reviewed contradiction anywhere in the set dominates: one honest
 * CONTRADICTS means the contradiction is present. Unanimous MATCHES means
 * agreement. Anything else is UNKNOWN — never optimistically resolved. */
const aggregateVerdict = (judgments: ReadonlyArray<RecordJudgment>): Verdict => {
  if (judgments.some(j => j.decision === "CONTRADICTS")) return "CONTRADICTS"
  if (judgments.some(j => j.decision === "UNKNOWN")) return "UNKNOWN"
  return "MATCHES"
}

export const compareSlot = (
  before: ReadonlyArray<SlotEvidence> | null,
  after: ReadonlyArray<SlotEvidence>,
  actionRecorded: boolean,
): SlotComparison => {
  if (after.length === 0 || after.some(e => e.check.status === "QUEUED" || e.check.status === "RUNNING")) return { state: "PENDING_CHECK" }
  if (before === null || before.length === 0) return indeterminate("NO_BASELINE")
  const beforeOk = before.filter(e => e.check.status === "SUCCEEDED" && e.check.observation !== null)
  const afterOk = after.filter(e => e.check.status === "SUCCEEDED" && e.check.observation !== null)
  if (beforeOk.length === 0) return indeterminate("BEFORE_CHECK_FAILED")
  if (afterOk.length === 0) return indeterminate("AFTER_CHECK_FAILED")
  if (beforeOk.some(e => e.judgment === null) || afterOk.some(e => e.judgment === null)) return { state: "AWAITING_REVIEW" }
  const factIds = new Set([...beforeOk, ...afterOk].map(e => e.item.fact.id))
  if (factIds.size > 1) return indeterminate("FACT_CHANGED")
  const questionIds = new Set([...beforeOk, ...afterOk].map(e => e.check.questionId))
  if (questionIds.size > 1) return indeterminate("QUESTION_CHANGED")
  if ([...beforeOk, ...afterOk].some(e => e.check.observation!.synthetic)) return indeterminate("SYNTHETIC_EVIDENCE")
  if (beforeOk.some(e => !retrievalObserved(e.check.observation!))) return indeterminate("BEFORE_NO_RETRIEVAL")
  if (afterOk.some(e => !retrievalObserved(e.check.observation!))) return indeterminate("AFTER_NO_RETRIEVAL")
  const contexts = [...beforeOk, ...afterOk].map(e => decodeContext(e.check.observation!.measurementContext))
  if (contexts.some(c => c._tag === "Left")) return indeterminate("SURFACE_UNKNOWN")
  const signatures = contexts.flatMap(c => (c._tag === "Right" ? [measurementSignature(c.right)] : []))
  let comparability: "COMPARABLE" | "SURFACE_CHANGED" | "SURFACE_UNKNOWN" = "COMPARABLE"
  for (let i = 0; i < signatures.length; i++) {
    for (let j = i + 1; j < signatures.length; j++) {
      const match = compareMeasurements(signatures[i]!, signatures[j]!)
      if (match === "NOT_COMPARABLE") comparability = "SURFACE_CHANGED"
      else if (match === "INDETERMINATE" && comparability === "COMPARABLE") comparability = "SURFACE_UNKNOWN"
    }
  }
  if (comparability !== "COMPARABLE") return indeterminate(comparability)
  const latestBefore = Math.max(...beforeOk.map(e => Date.parse(e.check.observation!.collectedAt)))
  const earliestAfter = Math.min(...afterOk.map(e => Date.parse(e.check.observation!.collectedAt)))
  if (!(earliestAfter > latestBefore)) return indeterminate("OUT_OF_ORDER")
  const was: Verdict = aggregateVerdict(beforeOk.map(e => e.judgment!))
  const now: Verdict = aggregateVerdict(afterOk.map(e => e.judgment!))
  if (was === "UNKNOWN") return indeterminate("BEFORE_UNKNOWN")
  if (now === "UNKNOWN") return indeterminate("AFTER_UNKNOWN")
  // A failure elsewhere in the run never overrides the verdict on this
  // slot's own complete evidence — but a partial run still cannot establish
  // a before/after outcome for this slot.
  if ([...beforeOk, ...afterOk].some(e => !e.runComplete)) return indeterminate("PARTIAL_RUN")
  if (was === "CONTRADICTS" && now === "MATCHES") {
    return actionRecorded
      ? { state: "DERIVED", outcome: "OBSERVED_CORRECTED", reason: null }
      : { state: "DERIVED", outcome: "RESOLVED_EXTERNALLY", reason: null }
  }
  if (was === "CONTRADICTS" && now === "CONTRADICTS") return { state: "DERIVED", outcome: "NO_OBSERVED_CHANGE", reason: null }
  if (was === "MATCHES" && now === "MATCHES") return indeterminate("BASELINE_MATCHED")
  return indeterminate("ANSWER_NO_LONGER_MATCHES")
}

// ---------------------------------------------------------------------------
// Integrity finding: the durable per-fact state of the record loop. Derived
// from stored judgments, actions and outcomes — never stored, never stronger
// than the evidence. Identity is the business slot (fact predicate), not the
// exact evidence wording: new observations attach to the existing finding.
// ---------------------------------------------------------------------------

export type FindingKind = "CONTRADICTION" | "AGREEMENT" | "UNDETERMINED" | "UNREVIEWED"
export type FindingState =
  | "NEEDS_REVIEW" | "OPEN" | "ACTION_RECORDED" | "FOLLOW_UP_PENDING" | "AGREEMENT"
  | "OBSERVED_CORRECTED" | "NO_OBSERVED_CHANGE" | "INDETERMINATE" | "RESOLVED_EXTERNALLY"
export interface SlotFinding {
  readonly kind: FindingKind
  readonly state: FindingState
  readonly samples: SampleCounts & { readonly statement: string }
}

export const findingFor = (args: {
  /** Latest published evidence for the slot (follow-up when published, else baseline). */
  readonly current: ReadonlyArray<SlotEvidence>
  /** Derived comparison when a published follow-up exists, else null. */
  readonly comparison: SlotComparison | null
  /** A follow-up run exists but is not fully published yet. */
  readonly followUpPending: boolean
  /** An action was recorded for this slot since the current evidence. */
  readonly actionRecorded: boolean
}): SlotFinding => {
  const samples = countSamples(args.current)
  const counted = { ...samples, statement: sampleStatement(samples) }
  if (samples.reviewed === 0) {
    return { kind: "UNREVIEWED", state: args.followUpPending ? "FOLLOW_UP_PENDING" : "NEEDS_REVIEW", samples: counted }
  }
  const kind: FindingKind =
    samples.contradict > 0 ? "CONTRADICTION" : samples.unknown > 0 ? "UNDETERMINED" : "AGREEMENT"
  if (args.comparison !== null && args.comparison.state === "DERIVED") {
    return { kind, state: args.comparison.outcome, samples: counted }
  }
  if (args.comparison !== null && args.comparison.state === "AWAITING_REVIEW") {
    return { kind, state: "NEEDS_REVIEW", samples: counted }
  }
  if (args.followUpPending) return { kind, state: "FOLLOW_UP_PENDING", samples: counted }
  if (kind === "CONTRADICTION") return { kind, state: args.actionRecorded ? "ACTION_RECORDED" : "OPEN", samples: counted }
  if (kind === "AGREEMENT") return { kind, state: "AGREEMENT", samples: counted }
  return { kind, state: "NEEDS_REVIEW", samples: counted }
}

const failureWords = (failureClass: string | null): string => {
  switch (failureClass) {
    case "PROVIDER_TIMEOUT": return "the AI provider timed out"
    case "PROVIDER_RATE_LIMITED": return "the AI provider was rate limited"
    case "PROVIDER_AUTH": return "the AI provider rejected OpenRecord's credentials"
    case "PROVIDER_UNAVAILABLE": return "the AI provider was unavailable"
    case "WORKER_LOST": return "the check was interrupted"
    default: return "the AI provider returned an error"
  }
}

export const reasonText = (reason: IndeterminateReason, after: ReadonlyArray<SlotEvidence> | SlotEvidence | null = null): string => {
  switch (reason) {
    case "NO_BASELINE": return "There is no earlier answer for this fact to compare against."
    case "BEFORE_CHECK_FAILED": return "The first check for this fact could not be completed, so there is no earlier answer to compare against."
    case "AFTER_CHECK_FAILED": {
      const list: ReadonlyArray<SlotEvidence> = after === null ? [] : Array.isArray(after) ? after : [after]
      const failed = list.map(e => e.check).find(c => c.status === "FAILED")
      return `The later check could not be completed (${failureWords(failed?.failureClass ?? null)}), so there is no later answer to compare.`
    }
    case "FACT_CHANGED": return "The approved fact changed between the two checks, so the answers are not compared."
    case "QUESTION_CHANGED": return "The question changed between the two checks, so the answers are not compared."
    case "SYNTHETIC_EVIDENCE": return "One of these answers is test data, not a live AI answer."
    case "BEFORE_NO_RETRIEVAL": return "Indeterminate — the earlier answer did not use live web retrieval."
    case "AFTER_NO_RETRIEVAL": return "Indeterminate — this answer did not use live web retrieval."
    case "SURFACE_CHANGED": return "The AI model or its settings changed between checks, so the answers are not directly comparable."
    case "SURFACE_UNKNOWN": return "OpenRecord could not confirm that both answers came from the same AI model and settings."
    case "OUT_OF_ORDER": return "The two answers were not recorded in order, so they are not compared."
    case "BEFORE_UNKNOWN": return "The earlier answer could not be judged against the approved fact."
    case "AFTER_UNKNOWN": return "The later answer could not be judged against the approved fact."
    case "ANSWER_NO_LONGER_MATCHES": return "The earlier answer matched the approved fact; the later answer contradicts it."
    case "BASELINE_MATCHED": return "The earlier answer already matched the approved fact, so there was no contradiction to verify a correction against. Both answers match."
    case "PARTIAL_RUN": return "One of the checks was only partially completed, so this record cannot establish a weekly outcome."
  }
}

export const outcomeText = (comparison: Extract<SlotComparison, { state: "DERIVED" }>, after: ReadonlyArray<SlotEvidence>): string => {
  if (comparison.outcome === "OBSERVED_CORRECTED") return "Observed corrected. The earlier answers contradicted the approved fact; the later answers match it."
  if (comparison.outcome === "NO_OBSERVED_CHANGE") {
    return "No observed change. The later answers still contradict the approved fact."
  }
  if (comparison.outcome === "RESOLVED_EXTERNALLY") {
    return "Resolved externally. The later answers match the approved fact, but no action was recorded in OpenRecord, so OpenRecord takes no credit for the change."
  }
  return reasonText(comparison.reason!, after)
}

// ---------------------------------------------------------------------------
// Slot assembly shared by the operator view and the public projection
// ---------------------------------------------------------------------------

const PROVIDER_LABELS: Record<string, string> = {
  gemini: "Gemini API",
  mock: "OpenRecord test fixture (not a live AI)",
  "9router": "9Router gateway",
}
export const surfaceLabel = (o: RecordObservation): string => PROVIDER_LABELS[o.provider] ?? o.provider
const RETRIEVAL_TOOL_LABELS: Record<string, string> = { google_search: "Google Search grounding" }

/** A check is visible to the client once it is final: failed, or reviewed. */
export const checkPublished = (check: RecordCheck): boolean =>
  check.status === "FAILED" || (check.status === "SUCCEEDED" && check.observation !== null && currentJudgment(check.judgments) !== null)

/** A run's samples are published once every check is final. */
const runPublished = (checks: ReadonlyArray<RecordCheck>): boolean =>
  checks.length > 0 && checks.every(checkPublished)

interface SlotTimeline {
  readonly slot: number
  readonly head: RecordItem
  readonly baseline: SlotEvidence[]
  /** Samples of the latest follow-up run, or null when there is no follow-up. */
  readonly latestFollowUp: SlotEvidence[] | null
  /** Samples of the latest fully published follow-up run. */
  readonly publishedFollowUp: SlotEvidence[] | null
  /** A follow-up run exists but is not fully published yet. */
  readonly followUpPending: boolean
}

const timelines = (s: RecordSnapshot): SlotTimeline[] => {
  const itemById = new Map(s.items.map(i => [i.id, i]))
  const baselineRun = [...s.runs].reverse().find(r => r.kind === "INITIAL") ?? null
  const followUps = baselineRun === null ? [] : s.runs.filter(r => r.kind === "FOLLOW_UP" && r.baselineRunId === baselineRun.id)
  const evidence = (check: RecordCheck): SlotEvidence => ({ check, item: itemById.get(check.itemId)!, judgment: currentJudgment(check.judgments),
    runComplete: runStatus(s.checks.filter(c => c.runId === check.runId)) === "SUCCEEDED" })
  const checksFor = (run: RecordRun, slot: number) =>
    s.checks.filter(c => c.runId === run.id && itemById.get(c.itemId)?.slot === slot).sort((a, b) => a.sample - b.sample)
  const heads = s.items.filter(i => !i.superseded).sort((a, b) => a.slot - b.slot)
  return heads.map(head => {
    const base = baselineRun === null ? [] : checksFor(baselineRun, head.slot).map(evidence)
    const ups = followUps.map(r => checksFor(r, head.slot).map(evidence)).filter(group => group.length > 0)
    const latest = ups.at(-1) ?? null
    const published = [...ups].reverse().find(group => runPublished(group.map(e => e.check))) ?? null
    return { slot: head.slot, head, baseline: base,
      latestFollowUp: latest, publishedFollowUp: published,
      followUpPending: latest !== null && published !== latest }
  })
}

const actionsBetween = (actions: ReadonlyArray<RecordAction>, slot: number, from: string | null, until: string | null) =>
  actions.filter(a => (a.slot === null || a.slot === slot)
    && (from === null || Date.parse(a.performedAt) >= Date.parse(from))
    && (until === null || Date.parse(a.performedAt) <= Date.parse(until)))

/**
 * V1 attribution rule: only a slot-targeted action qualifies its fact for
 * OBSERVED_CORRECTED. A record-level action (slot null) stays visible in the
 * overall history but never attributes an individual fact's correction — a
 * pricing-page edit must not take credit for independently corrected hours.
 */
const targetedActionsBetween = (actions: ReadonlyArray<RecordAction>, slot: number, from: string | null, until: string | null) =>
  actions.filter(a => a.slot === slot
    && (from === null || Date.parse(a.performedAt) >= Date.parse(from))
    && (until === null || Date.parse(a.performedAt) <= Date.parse(until)))

const checkedAt = (e: SlotEvidence | null): string | null => e?.check.observation?.collectedAt ?? e?.check.completedAt ?? null
const rangeOf = (evidence: ReadonlyArray<SlotEvidence>): { from: string | null; until: string | null } => {
  const times = evidence.flatMap(e => (e.check.observation ? [e.check.observation.collectedAt] : []))
  if (times.length === 0) return { from: null, until: null }
  return { from: times.reduce((a, b) => (a < b ? a : b)), until: times.reduce((a, b) => (a > b ? a : b)) }
}

// ---------------------------------------------------------------------------
// Operator view (session-scoped; full evidence, internal notes included)
// ---------------------------------------------------------------------------

export const operatorView = (s: RecordSnapshot) => {
  const runs = s.runs.map(run => {
    const checks = s.checks.filter(c => c.runId === run.id)
    return { ...run, status: runStatus(checks), checks: checks.map(c => ({ ...c, judgment: currentJudgment(c.judgments),
      retrievalRequested: c.observation ? retrievalRequested(c.observation) : null, retrievalObserved: c.observation ? retrievalObserved(c.observation) : null,
      surface: c.observation ? surfaceLabel(c.observation) : null })) }
  })
  const slots = timelines(s).map(t => {
    const after = t.latestFollowUp
    const range = after === null || after.length === 0 ? null : { from: rangeOf(t.baseline).until, until: rangeOf(after).from }
    const actionRecorded = range !== null && targetedActionsBetween(s.actions, t.slot, range.from, range.until).length > 0
    const comparison = after === null || after.length === 0 ? null : compareSlot(t.baseline.length > 0 ? t.baseline : null, after, actionRecorded)
    const current = t.publishedFollowUp ?? (t.baseline.length > 0 ? t.baseline : [])
    const currentRange = rangeOf(current)
    const finding = findingFor({
      current,
      comparison: t.publishedFollowUp === null ? null : comparison,
      followUpPending: t.followUpPending,
      actionRecorded: targetedActionsBetween(s.actions, t.slot, currentRange.from, null).length > 0,
    })
    return {
      slot: t.slot, item: t.head, history: s.items.filter(i => i.slot === t.slot),
      baselineCheckIds: t.baseline.map(e => e.check.id), latestFollowUpCheckIds: (t.latestFollowUp ?? []).map(e => e.check.id),
      finding,
      comparison: comparison === null ? null : comparison.state === "DERIVED"
        ? { ...comparison, text: outcomeText(comparison, after!) } : comparison,
      actions: actionsBetween(s.actions, t.slot, null, null),
    }
  })
  return { profile: s.profile, slots, runs, actions: s.actions, share: s.share, disclosure: CAUSALITY_DISCLOSURE,
    activeRun: runs.some(r => r.status === "QUEUED" || r.status === "RUNNING") }
}

// ---------------------------------------------------------------------------
// Public projection: an explicit allowlist. No database ids, account or user
// identities, internal review notes, raw provider payloads, or error detail.
// Unreviewed answers are drafts and stay private.
// ---------------------------------------------------------------------------

const httpUrl = (value: string | null): string | null => {
  if (value === null) return null
  try {
    const u = new URL(value)
    return (u.protocol === "https:" || u.protocol === "http:") && !u.username && !u.password ? u.toString() : null
  } catch { return null }
}

const DECISION_COPY: Record<RecordDecision, string> = {
  MATCHES: "Matches the approved fact",
  CONTRADICTS: "Contradicts the approved fact",
  UNKNOWN: "Unknown — the answer could not be judged against the approved fact",
}

const publicAnswer = (e: SlotEvidence) => {
  const o = e.check.observation
  const context = { question: e.item.question.prompt, fact: { label: e.item.fact.predicate, value: e.item.fact.valueText } }
  if (e.check.status !== "SUCCEEDED" || o === null) {
    return { ...context, status: "CHECK_FAILED" as const, checkedAt: checkedAt(e), explanation: `This check could not be completed: ${failureWords(e.check.failureClass)}.` }
  }
  const judgment = e.judgment!
  const suggestions = o.provider === "gemini" && o.providerMetadata !== null && typeof o.providerMetadata === "object"
    ? (o.providerMetadata as { searchSuggestionsHtml?: unknown }).searchSuggestionsHtml : null
  return {
    ...context,
    status: "ANSWERED" as const,
    checkedAt: o.collectedAt,
    surface: surfaceLabel(o),
    model: o.modelVersion ?? o.observedModel ?? o.requestedModel,
    retrieval: {
      requested: retrievalRequested(o),
      observed: retrievalObserved(o),
      tool: o.retrievalTool === null ? null : RETRIEVAL_TOOL_LABELS[o.retrievalTool] ?? o.retrievalTool,
    },
    syntheticFixture: o.synthetic,
    answer: o.answerText,
    searchSuggestionsHtml: typeof suggestions === "string" ? suggestions : null,
    citations: o.citations.flatMap(c => { const url = httpUrl(c.uri); return url === null && c.title === null ? [] : [{ url, title: c.title }] }),
    evidenceDigest: o.rawDigest,
    judgment: { decision: judgment.decision, label: DECISION_COPY[judgment.decision], reviewedAt: judgment.reviewedAt, reviewedBy: "Reviewed by the agency" },
  }
}

const publicAction = (a: RecordAction) => ({
  performedAt: a.performedAt,
  note: a.note,
  links: a.links.flatMap(l => { const url = httpUrl(l); return url === null ? [] : [url] }),
})

const summarize = (evidence: ReadonlyArray<SlotEvidence>) => {
  // Published samples: reviewed answers plus failed checks (shown honestly as
  // "could not be completed"). Unreviewed answers are drafts, never shown.
  const samples = evidence.flatMap(e => {
    if (e.check.status === "FAILED") return [publicAnswer(e)]
    if (e.check.status === "SUCCEEDED" && e.check.observation !== null && e.judgment !== null) return [publicAnswer(e)]
    return []
  })
  const counts = countSamples(evidence)
  return { samples, summary: { ...counts, statement: sampleStatement(counts) } }
}

export const publicRecord = (s: RecordSnapshot) => {
  const facts = timelines(s).filter(t => t.head.approval !== null && t.head.fact.status === "ACTIVE").map(t => {
    // Samples belong to the approved version that was actually checked.
    // Never display an old verdict as the verdict for newly approved wording.
    const onHead = (group: SlotEvidence[] | null) =>
      group !== null && group.length > 0 && group.every(e => e.item.id === t.head.id) ? group : null
    const after = onHead(t.publishedFollowUp)
    // An unreviewed baseline keeps the comparison private (AWAITING_REVIEW)
    // rather than reading as "no earlier answer".
    const baseline = t.baseline.length > 0 ? t.baseline : null
    const range = after === null ? null : { from: rangeOf(baseline ?? []).until, until: rangeOf(after).from }
    const actionRecorded = range !== null && targetedActionsBetween(s.actions, t.slot, range.from, range.until).length > 0
    const comparison = after === null ? null : compareSlot(baseline, after, actionRecorded)
    const publishedBaseline = baseline !== null && runPublished(baseline.map(e => e.check)) ? baseline : []
    const candidate = after !== null && comparison?.state === "DERIVED" ? after : publishedBaseline
    const latest = onHead(candidate.length > 0 ? candidate : null) ?? []
    const current = summarize(latest)
    return {
      position: t.slot,
      fact: { label: t.head.fact.predicate, subject: t.head.fact.subject, value: t.head.fact.valueText,
        source: httpUrl(t.head.sourceUrl), approvedAt: t.head.approval!.approvedAt },
      question: t.head.question.prompt,
      samples: current.samples,
      summary: current.summary,
      comparison: after === null || comparison === null || comparison.state !== "DERIVED" ? null : {
        before: summarize(baseline ?? []),
        actions: actionsBetween(s.actions, t.slot, range!.from, range!.until).map(publicAction),
        after: summarize(after),
        outcome: comparison.outcome,
        explanation: outcomeText(comparison, after),
      },
      // Actions recorded since the last published check, awaiting a re-check.
      pendingActions: latest.length === 0 ? [] : actionsBetween(s.actions, t.slot, rangeOf(latest).until, null).map(publicAction),
    }
  })
  const answered = facts.flatMap(f => f.samples.filter(a => a.status === "ANSWERED"))
  const latestSurface = [...answered].sort((a, b) => (a.status === "ANSWERED" && b.status === "ANSWERED" ? a.checkedAt.localeCompare(b.checkedAt) : 0)).at(-1)
  const lastCheckedAt = facts.flatMap(f => f.samples.flatMap(a => (a.checkedAt ? [a.checkedAt] : []))).sort().at(-1) ?? null
  return {
    client: { name: s.profile.name, website: httpUrl(s.profile.websiteUrl) },
    checkedBy: "OpenRecord",
    fixture: s.profile.engagement === "FIXTURE",
    lastCheckedAt,
    surface: latestSurface === undefined || latestSurface.status !== "ANSWERED" ? null : { name: latestSurface.surface, model: latestSurface.model, retrievalTool: latestSurface.retrieval.tool },
    facts,
    disclosure: CAUSALITY_DISCLOSURE,
  }
}
export type PublicRecord = ReturnType<typeof publicRecord>
