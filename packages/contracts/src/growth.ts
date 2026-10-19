import { Schema } from "effect"

const Text = (max: number) => Schema.String.pipe(Schema.maxLength(max), Schema.filter(s => s.trim().length > 0))
export const GrowthUrl = Schema.String.pipe(Schema.maxLength(2000), Schema.filter(s => {
  try { const u = new URL(s); return ["http:", "https:"].includes(u.protocol) && !u.username && !u.password && !/\s/.test(s) } catch { return false }
}))
export const GrowthTimeZone = Schema.String.pipe(Schema.maxLength(100), Schema.filter(s => {
  try { new Intl.DateTimeFormat("en", { timeZone: s }); return s === "UTC" || s.includes("/") } catch { return false }
}))
export const GrowthConversionKind = Schema.Literal("LEAD", "SIGNUP", "PURCHASE", "BOOKING")
const MetricFields = {
  conversionKind: GrowthConversionKind, label: Text(120), sourceIdentity: Text(200), reportingTimeZone: GrowthTimeZone,
}
const Count = { countingSemantics: Schema.Literal("EVENT_COUNT"), unit: Schema.Literal("COUNT"), currency: Schema.Null }
/** Definitions only. W0 neither imports a CSV nor authenticates its source. */
export const GrowthMetricDefinitionInput = Schema.Union(
  Schema.Struct({ ...MetricFields, sourceKind: Schema.Literal("GA4_AGGREGATE_EXPORT"),
    propertyRef: Text(200), eventName: Schema.String.pipe(Schema.pattern(/^[A-Za-z][A-Za-z0-9_]{0,39}$/)), ...Count }),
  Schema.Struct({ ...MetricFields, sourceKind: Schema.Literal("OPERATOR_AGGREGATE_EXPORT"),
    propertyRef: Schema.NullOr(Text(200)), eventName: Schema.Null, ...Count }),
  Schema.Struct({ ...MetricFields, sourceKind: Schema.Literal("OPERATOR_AGGREGATE_EXPORT"),
    propertyRef: Schema.NullOr(Text(200)), eventName: Schema.Null, countingSemantics: Schema.Literal("SUM"),
    unit: Schema.Literal("CURRENCY_MINOR"), currency: Schema.String.pipe(Schema.pattern(/^[A-Z]{3}$/)) }),
)
export type GrowthMetricDefinitionInput = typeof GrowthMetricDefinitionInput.Type
export const GrowthProfileInput = Schema.Struct({
  category: Text(300), audience: Text(1000), valueProposition: Text(2000), goalStatement: Text(1000), metric: GrowthMetricDefinitionInput,
})
export type GrowthProfileInput = typeof GrowthProfileInput.Type
/** A profile update request: exact content plus its request identity. The key
 * identifies one operation; replaying it returns the original result and a
 * different payload under the same key is refused. */
export const GrowthProfileUpdate = Schema.Struct({ ...GrowthProfileInput.fields, idempotencyKey: Schema.UUID })
export type GrowthProfileUpdate = typeof GrowthProfileUpdate.Type
export const decodeGrowthProfileInput = (input: unknown): GrowthProfileInput | null => {
  const result = Schema.decodeUnknownEither(GrowthProfileInput, { onExcessProperty: "error" })(input)
  return result._tag === "Right" ? result.right : null
}
export const GrowthProductInput = Schema.Struct({
  name: Text(200), websiteUrl: GrowthUrl, engagement: Schema.Literal("DOGFOOD", "CLIENT"),
  ...GrowthProfileInput.fields,
  idempotencyKey: Schema.UUID,
})
export const GrowthStatus = Schema.Literal("DISCOVERED", "PROPOSED", "APPROVED", "REVIEWED", "CANCELLED")
export type GrowthStatus = typeof GrowthStatus.Type
export type GrowthActor = "OPERATOR" | "ASSISTANT"
/** Human decision state only. Adapters never move an initiative. */
export const GROWTH_TRANSITIONS: ReadonlyArray<{
  from: GrowthStatus | null; to: GrowthStatus; actors: ReadonlyArray<GrowthActor>
}> = [
  { from: null, to: "DISCOVERED", actors: ["OPERATOR", "ASSISTANT"] },
  { from: null, to: "PROPOSED", actors: ["OPERATOR", "ASSISTANT"] },
  { from: "DISCOVERED", to: "PROPOSED", actors: ["OPERATOR", "ASSISTANT"] },
  { from: "PROPOSED", to: "APPROVED", actors: ["OPERATOR"] },
  { from: "APPROVED", to: "REVIEWED", actors: ["OPERATOR"] },
  ...(["DISCOVERED", "PROPOSED", "APPROVED"] satisfies GrowthStatus[]).map(from => ({ from, to: "CANCELLED" as const, actors: ["OPERATOR"] as const })),
]
export const canTransitionGrowth = (from: GrowthStatus | null, to: GrowthStatus, actor: string): boolean =>
  GROWTH_TRANSITIONS.some(t => t.from === from && t.to === to && t.actors.some(a => a === actor))

export const GrowthObservedRef = Schema.Struct({
  kind: Schema.Literal("OBSERVATION", "RECORD_CHECK", "RECORD_JUDGMENT", "ACQUISITION_BATCH", "ACQUISITION_RESULT", "REFERRAL_IMPORT", "RECORD_ACTION"),
  id: Schema.UUID,
})
export type GrowthObservedRef = typeof GrowthObservedRef.Type
export const GrowthEvidenceInput = Schema.Union(
  Schema.Struct({ type: Schema.Literal("OBSERVED"), reference: GrowthObservedRef, note: Text(1000) }),
  Schema.Struct({ type: Schema.Literal("OPERATOR_HYPOTHESIS"), note: Text(1000) }),
  Schema.Struct({ type: Schema.Literal("MODEL_SUGGESTION"), note: Text(1000) }),
)
export type GrowthEvidenceInput = typeof GrowthEvidenceInput.Type
export const GrowthOpportunityFields = Schema.Struct({
  goalId: Schema.UUID, title: Text(200), problemStatement: Text(2000), audience: Text(1000), buyerIntent: Text(1000),
  targetUrl: Schema.optionalWith(Schema.NullOr(GrowthUrl), { default: () => null }), source: Text(300), proposedChange: Text(2000), expectedMechanism: Text(2000),
  assumptions: Text(2000), uncertainty: Text(2000), baselineAvailability: Schema.Literal("UNKNOWN", "UNAVAILABLE", "AVAILABLE"),
})
export type GrowthOpportunityFields = typeof GrowthOpportunityFields.Type
export const CreateGrowthOpportunity = Schema.Struct({
  ...GrowthOpportunityFields.fields,
  ownerUserId: Schema.UUID, initialStatus: Schema.Literal("DISCOVERED", "PROPOSED"), idempotencyKey: Schema.UUID,
  evidence: Schema.Array(GrowthEvidenceInput).pipe(Schema.minItems(1), Schema.maxItems(20)),
})
export type CreateGrowthOpportunity = typeof CreateGrowthOpportunity.Type
export const GrowthDecision = Schema.Struct({
  expectedStatus: GrowthStatus, expectedRevision: Schema.Int.pipe(Schema.greaterThanOrEqualTo(1)), idempotencyKey: Schema.UUID,
  reason: Text(1000),
})
export type GrowthDecision = typeof GrowthDecision.Type
export type GrowthMetricDefinition = GrowthMetricDefinitionInput & {
  readonly id: string; readonly businessId: string; readonly version: number; readonly createdByUserId: string; readonly createdAt: string
}
export interface GrowthGoal {
  readonly id: string; readonly businessId: string; readonly version: number; readonly statement: string
  readonly metricDefinition: GrowthMetricDefinition; readonly createdByUserId: string; readonly createdAt: string
}
export const GrowthReviewConclusion = Schema.Literal("KEEP", "REVERT", "EXTEND", "INCONCLUSIVE")
export const GrowthReview = Schema.Struct({ ...GrowthDecision.fields, conclusion: GrowthReviewConclusion })
export type GrowthReview = typeof GrowthReview.Type
export const GrowthChannel = Schema.Literal("WEBSITE", "THIRD_PARTY_PROFILE", "EMAIL", "PAID", "SOCIAL", "OTHER")
/** The claim names exactly what the adapter confirmed; a merge is not publication. */
export const GrowthExecutionAssurance = Schema.Union(
  Schema.Struct({ assurance: Schema.Literal("OPERATOR_ATTESTED"), actor: Schema.Literal("HUMAN"), actorId: Schema.UUID, verification: Schema.Null }),
  Schema.Struct({ assurance: Schema.Literal("SYSTEM_VERIFIED"), actor: Schema.Literal("SYSTEM"), actorId: Schema.Null,
    verification: Schema.Struct({ kind: Schema.Literal("GROWTH_DELIVERY"), id: Schema.UUID, claim: Schema.Literal("PR_MERGED") }) }),
)
export const GrowthProgress = Schema.Literal("NOT_STARTED", "EXECUTED")
export interface GrowthProfile {
  readonly businessId: string; readonly category: string; readonly audience: string; readonly valueProposition: string
  readonly primaryGoal: GrowthGoal; readonly updatedByUserId: string; readonly updatedAt: string
}
export interface GrowthEvent {
  readonly id: string; readonly status: GrowthStatus; readonly revision: number; readonly actor: GrowthActor
  readonly userId: string; readonly reason: string; readonly conclusion: typeof GrowthReviewConclusion.Type | null; readonly createdAt: string
}
export type GrowthEvidence = GrowthEvidenceInput & { readonly id: string; readonly createdAt: string }
export interface GrowthOpportunity extends GrowthOpportunityFields {
  readonly id: string; readonly businessId: string; readonly ownerUserId: string; readonly createdByUserId: string
  readonly createdByActor: "OPERATOR" | "ASSISTANT"; readonly createdAt: string; readonly updatedAt: string
  readonly updatedByUserId: string; readonly status: GrowthStatus; readonly revision: number
  readonly progress: typeof GrowthProgress.Type; readonly executionCount: number
  readonly evidence: ReadonlyArray<GrowthEvidence>; readonly events: ReadonlyArray<GrowthEvent>
}
