import { Schema } from "effect"
import { createHash } from "node:crypto"
import { operatorView, RECORD_CANCELLED } from "./record-view.js"
import type { RecordSnapshot } from "./record.js"
import type { AgentReportSupplement } from "./agent-referrals.js"

const Text = (max: number) => Schema.String.pipe(Schema.minLength(1), Schema.maxLength(max))
export const ActionDraftInput = Schema.Struct({
  slot: Schema.Literal(1, 2, 3), proposedAction: Text(1200), assumptions: Schema.Array(Text(300)).pipe(Schema.maxItems(5)),
  uncertainty: Text(600), verificationPlan: Text(600),
})
export const ReportDraftInput = Schema.Struct({ start: Schema.String, end: Schema.String })
export const DraftPayload = Schema.Struct({
  kind: Schema.Literal("DRAFT_SOURCE_ACTION", "PREPARE_CLIENT_REPORT", "PROPOSE_QUESTION_SET", "REQUEST_ACQUISITION_BATCH"),
  generatedAt: Schema.String, businessId: Schema.UUID, evidenceJson: Text(180000), evidenceDigest: Text(64),
  measurementPlan: Schema.optional(Schema.Struct({ setId: Schema.NullOr(Schema.UUID), provider: Schema.String, requestedModel: Schema.NullOr(Schema.String), questions: Schema.Int, samples: Schema.Int,
    maxProviderCalls: Schema.Int, estimatedMaxCostUsd: Schema.NullOr(Schema.Number), costBasis: Schema.String, missingRequirements: Schema.Array(Schema.String) })),
  text: Text(60000), references: Schema.Array(Schema.Struct({ kind: Schema.String, id: Schema.UUID, text: Schema.String })).pipe(Schema.maxItems(1000)),
})
export type DraftPayload = typeof DraftPayload.Type
const sha = (text: string) => createHash("sha256").update(text).digest("hex")
export const sealDraft = (input: Omit<DraftPayload, "evidenceJson" | "evidenceDigest"> & { readonly evidence: unknown }): DraftPayload => {
  const evidenceJson = JSON.stringify(input.evidence)
  return { kind: input.kind, businessId: input.businessId, generatedAt: input.generatedAt, text: input.text,
    references: input.references, evidenceJson, evidenceDigest: sha(evidenceJson), ...(input.measurementPlan ? { measurementPlan: input.measurementPlan } : {}) }
}

export const buildActionDraft = (snapshot: RecordSnapshot, input: typeof ActionDraftInput.Type, generatedAt: string): DraftPayload | null => {
  const view = operatorView(snapshot)
  const slot = view.slots.find(s => s.slot === input.slot)
  if (!slot?.item.approval) return null
  const evidence = view.runs.flatMap(r => r.checks).filter(c => c.itemId === slot.item.id && c.observation !== null && !c.observation.synthetic)
  if (!evidence.length || evidence.length > 100) return null
  const observed = evidence.map(c => ({ observationId: c.observation!.id, digest: c.observation!.rawDigest, judgmentId: c.judgment?.id ?? null, decision: c.judgment?.decision ?? "UNREVIEWED" }))
  const references = [{ kind: "record", id: snapshot.profile.businessId, text: "Client record" },
    { kind: "fact", id: slot.item.fact.id, text: slot.item.fact.predicate },
    { kind: "question", id: slot.item.question.id, text: slot.item.question.prompt },
    ...evidence.map(c => ({ kind: "observation", id: c.observation!.id, text: `Evidence sample ${c.sample}` }))]
  const text = [`Action hypothesis for ${snapshot.profile.name}`, `Observed: ${evidence.filter(c => c.judgment?.decision === "CONTRADICTS").length} contradictions in ${evidence.filter(c => c.judgment !== null).length} reviewed real observations for this approved fact. Unreviewed and UNKNOWN answers remain unresolved.`,
    `Approved fact v${slot.item.fact.version}: ${slot.item.fact.predicate}: ${slot.item.fact.valueText}`,
    `Source evidence location: ${slot.item.sourceUrl}. This URL is not a newly fetched source snapshot.`,
    `Proposed action: ${input.proposedAction}`, `Assumptions: ${input.assumptions.join("; ") || "None stated"}`,
    `Uncertainty: ${input.uncertainty}`, "Operator required: agency operator. Approval accepts a plan; it does not record completion or publish content.",
    `Expected measurement opportunity: re-check the stored question after the human records completed work: ${slot.item.question.prompt}`,
    `Verification plan: ${input.verificationPlan}`, view.disclosure].join("\n\n")
  return sealDraft({ kind: "DRAFT_SOURCE_ACTION", generatedAt, businessId: snapshot.profile.businessId, text, references,
    evidence: { recordItemId: slot.item.id, factId: slot.item.fact.id, factVersion: slot.item.fact.version, questionId: slot.item.question.id, sourceUrl: slot.item.sourceUrl, observed, input, finding: slot.finding } })
}

export const buildClientReport = (snapshot: RecordSnapshot, input: typeof ReportDraftInput.Type, generatedAt: string, pending: ReadonlyArray<{ readonly id: string; readonly kind: string; readonly status: string }> = [], supplement?: AgentReportSupplement): DraftPayload | null => {
  const start = Date.parse(input.start), end = Date.parse(input.end)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 93 * 86400000 || end > Date.parse(generatedAt)) return null
  const view = operatorView(snapshot)
  const runs = view.runs.filter(r => Date.parse(r.createdAt) >= start && Date.parse(r.createdAt) < end)
  if (runs.length > 100) return null
  const facts = view.slots.map(s => ({ slot: s.slot, id: s.item.fact.id, version: s.item.fact.version,
    label: s.item.fact.predicate, value: s.item.approval ? s.item.fact.valueText : null, approved: s.item.approval !== null,
    sourceUrl: s.item.sourceUrl, questionId: s.item.question.id, comparison: s.comparison }))
  const batches = runs.map(r => {
    const successful = r.checks.filter(c => c.status === "SUCCEEDED" && c.observation !== null)
    const real = successful.filter(c => !c.observation!.synthetic)
    const reviewed = real.filter(c => c.judgment !== null)
    const cancelledBeforeStart = r.checks.filter(c => c.status === "FAILED" && c.failureClass === RECORD_CANCELLED).length
    const queued = r.checks.filter(c => c.status === "QUEUED").length
    return { id: r.id, kind: r.kind, createdAt: r.createdAt, status: r.status, attempted: r.checks.length - cancelledBeforeStart - queued,
      queued, cancelledBeforeStart,
      successful: successful.length, synthetic: successful.length - real.length, reviewed: reviewed.length, eligible: real.length,
      contradictions: reviewed.filter(c => c.judgment!.decision === "CONTRADICTS").length,
      matches: reviewed.filter(c => c.judgment!.decision === "MATCHES").length,
      unknown: reviewed.filter(c => c.judgment!.decision === "UNKNOWN").length,
      questions: [...new Set(r.checks.map(c => c.questionId))],
      observations: successful.map(c => ({ id: c.observation!.id, digest: c.observation!.rawDigest, provider: c.observation!.provider,
        requestedModel: c.observation!.requestedModel, observedModel: c.observation!.observedModel, collectedAt: c.observation!.collectedAt,
        synthetic: c.observation!.synthetic, judgmentId: c.judgment?.id ?? null, decision: c.judgment?.decision ?? "UNREVIEWED" })),
    }
  })
  const actions = view.actions.filter(a => Date.parse(a.performedAt) >= start && Date.parse(a.performedAt) < end)
    .map(a => ({ id: a.id, type: a.type, performedAt: a.performedAt, links: a.links, slot: a.slot }))
  const references = [{ kind: "record", id: snapshot.profile.businessId, text: "Client record" },
    ...batches.flatMap(b => b.observations.map(o => ({ kind: "observation", id: o.id, text: `Observed ${o.collectedAt}` })))]
  const text = [
    `Private client report draft: ${snapshot.profile.name}`, `Generated: ${generatedAt}\nPeriod: ${input.start} to ${input.end} (end exclusive). Coverage selects runs by creation time.`,
    "Measurement coverage", ...(batches.length ? batches.map(b => `Batch ${b.kind} (${b.createdAt}): ${b.questions.length} questions, ${b.attempted} attempted, ${b.successful} successful, ${b.synthetic} synthetic and excluded from findings. Human review: ${b.reviewed} of ${b.eligible} eligible real answers. ${b.queued} queued; ${b.cancelledBeforeStart} stopped before starting.\nSurfaces: ${[...new Set(b.observations.map(o => `${o.provider}; requested ${o.requestedModel ?? "unknown"}; observed ${o.observedModel ?? "unknown"}`))].join("; ") || "No successful observation"}.`) : ["No measurement runs in this period. This is missing evidence, not evidence of no problems."]),
    "Findings", ...batches.map(b => `${b.contradictions} reviewed contradictions, ${b.matches} reviewed matches and ${b.unknown} unknown judgments out of ${b.reviewed} reviewed real answers. These are answer-level judgments; they do not establish every supported fact's current state.`),
    supplement?.text ?? "Recommendation observations, competitor appearances and acquisition citations are not included by this report contract.",
    "Agency work", ...(actions.length ? actions.map(a => `${a.performedAt}: human-recorded ${a.type}. Source links: ${a.links.join(", ") || "None recorded"}.`) : ["No completed agency work recorded in this period. Proposals are not completed actions."]),
    ...pending.filter(p => p.status === "PROPOSED").map(p => `Awaiting approval: ${p.kind === "REQUEST_CHECK" ? "measurement re-check" : p.kind === "DRAFT_SOURCE_ACTION" ? "source action hypothesis" : "private client report"}. This is not completed agency work.`),
    "Observed changes", ...facts.map(f => `${f.label}: ${f.comparison === null ? "No before-and-after comparison" : f.comparison.state === "DERIVED" ? f.comparison.text : f.comparison.state === "AWAITING_REVIEW" ? "Awaiting human review" : "Follow-up check pending"}. Comparison reflects the stored record at generation time, including evidence outside this report period.`),
    "Recommended next steps", "Agency operator: review remaining unknown or unreviewed answers, inspect linked evidence, and review pending proposals. Publication and paid re-checks require separate explicit approval.",
    "Important unknowns", supplement ? "Unreviewed evidence is not confirmed. Source locations are not proof of their current content. Revenue and causal acquisition outcomes are not measured here." : "Referral data is unavailable in this report contract. Signups and revenue are not measured here. Unreviewed evidence is not confirmed. Source locations are not proof of their current content.",
    view.disclosure, "This private draft has not been published or delivered.",
  ].join("\n\n")
  return sealDraft({ kind: "PREPARE_CLIENT_REPORT", generatedAt, businessId: snapshot.profile.businessId, text, references: [...references, ...(supplement?.references ?? [])],
    evidence: { period: input, facts, batches, actions, pending, generatedAt, ...(supplement ? { acquisition: supplement.evidence } : {}) } })
}
