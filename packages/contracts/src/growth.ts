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
/** The action actually performed, recorded on the channel-neutral execution ledger. */
export const GrowthExecutionType = Schema.Literal(
  "SOURCE_UPDATED", "SOURCE_PUBLISHED", "THIRD_PARTY_CORRECTION_REQUESTED", "KNOWLEDGE_BASE_UPDATED",
  "STRUCTURED_DATA_UPDATED", "OTHER", "CAMPAIGN_SENT", "LISTING_UPDATED",
)
export type GrowthExecutionType = typeof GrowthExecutionType.Type
/** A closed compatibility table for the types whose name already fixes where
 * the work can happen. Generic source/knowledge types stay valid on every
 * channel, and `OTHER` is always the escape hatch, so the ledger remains
 * channel-neutral rather than SaaS-shaped. */
const EXECUTION_CHANNELS: { readonly [K in GrowthExecutionType]: ReadonlyArray<typeof GrowthChannel.Type> } = {
  SOURCE_UPDATED: GrowthChannel.literals, SOURCE_PUBLISHED: GrowthChannel.literals,
  THIRD_PARTY_CORRECTION_REQUESTED: ["THIRD_PARTY_PROFILE", "SOCIAL", "OTHER"],
  KNOWLEDGE_BASE_UPDATED: GrowthChannel.literals, STRUCTURED_DATA_UPDATED: GrowthChannel.literals, OTHER: GrowthChannel.literals,
  CAMPAIGN_SENT: ["EMAIL", "PAID", "SOCIAL", "OTHER"],
  // A listing can be owned (WEBSITE), hosted (THIRD_PARTY_PROFILE) or social.
  LISTING_UPDATED: ["WEBSITE", "THIRD_PARTY_PROFILE", "SOCIAL", "OTHER"],
}
export const growthChannelsForExecution = (type: GrowthExecutionType | ""): ReadonlyArray<typeof GrowthChannel.Type> =>
  type === "" ? GrowthChannel.literals : EXECUTION_CHANNELS[type]
/** Strict RFC 3339 with seconds and an explicit offset. `Date.parse` alone
 * normalises impossible dates and `24:00`, so components are checked before
 * the instant is accepted. A day-only or offset-less value would be resolved
 * silently by the database and is refused here. */
const executionTimePattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-](\d{2}):(\d{2}))$/
const isRealInstant = (value: string): boolean => {
  const match = executionTimePattern.exec(value)
  if (!match) return false
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3])
  const hour = Number(match[4]), minute = Number(match[5]), second = Number(match[6])
  const offsetHour = match[9] === undefined ? 0 : Number(match[9]), offsetMinute = match[10] === undefined ? 0 : Number(match[10])
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59) return false
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!
  return day >= 1 && day <= days && !Number.isNaN(Date.parse(value))
}
const ExecutionTime = Schema.String.pipe(Schema.filter(isRealInstant, { message: () => "RFC 3339 instant required" }))
/** A reference is free text (page, listing, campaign, profile or artifact) or
 * an absolute http(s) URL. A value that looks like a URI with another scheme is
 * refused; OpenRecord never fetches it to accept an attestation. */
const ExecutionReference = Schema.String.pipe(Schema.maxLength(500), Schema.filter(s => s.trim().length > 0), Schema.filter(s => {
  const trimmed = s.trim()
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:/.test(trimmed)) return true
  try {
    const url = new URL(trimmed)
    return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password && !/\s/.test(trimmed)
  } catch { return false }
}, { message: () => "http(s) reference required" }))
/** One operator-attested execution request: what was actually done, on which
 * channel, on what, when, and by whom. The request never carries an assurance,
 * actor or verification field — clients and agents cannot claim system
 * verification, and the repository always records a HUMAN attestation authored
 * by the session operator. `target` names what the action touched (page,
 * listing, campaign, profile or artifact reference); `description` states what
 * was actually done. */
export const GrowthExecutionRecord = Schema.Struct({
  type: GrowthExecutionType, channel: GrowthChannel, target: ExecutionReference, description: Text(2000),
  performedAt: ExecutionTime, idempotencyKey: Schema.UUID,
}).pipe(Schema.filter(record => growthChannelsForExecution(record.type).includes(record.channel), {
  message: () => "channel is not compatible with the action type",
}))
export type GrowthExecutionRecord = typeof GrowthExecutionRecord.Type
export const decodeGrowthExecutionRecord = (input: unknown): GrowthExecutionRecord | null => {
  const result = Schema.decodeUnknownEither(GrowthExecutionRecord, { onExcessProperty: "error" })(input)
  return result._tag === "Right" ? result.right : null
}
/** The claim names exactly what the adapter confirmed; a merge is not publication. */
export const GrowthExecutionAssurance = Schema.Union(
  Schema.Struct({ assurance: Schema.Literal("OPERATOR_ATTESTED"), actor: Schema.Literal("HUMAN"), actorId: Schema.UUID, verification: Schema.Null }),
  Schema.Struct({ assurance: Schema.Literal("SYSTEM_VERIFIED"), actor: Schema.Literal("SYSTEM"), actorId: Schema.Null,
    verification: Schema.Struct({ kind: Schema.Literal("GROWTH_DELIVERY"), id: Schema.UUID, claim: Schema.Literal("PR_MERGED") }) }),
)
export const GrowthProgress = Schema.Literal("NOT_STARTED", "EXECUTED")
/** One recorded execution and exactly how strongly it is proven. Attestations
 * are never labelled as verification; the claim names what was confirmed. */
export type GrowthExecution = {
  readonly id: string; readonly opportunityId: string; readonly businessId: string
  readonly type: GrowthExecutionType; readonly channel: typeof GrowthChannel.Type
  readonly target: string; readonly description: string | null
  readonly performedAt: string; readonly recordedAt: string
} & typeof GrowthExecutionAssurance.Type
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
  /** Current (non-superseded) linked executions, oldest first, each with its exact assurance. */
  readonly executions: ReadonlyArray<GrowthExecution>
  readonly evidence: ReadonlyArray<GrowthEvidence>; readonly events: ReadonlyArray<GrowthEvent>
}
