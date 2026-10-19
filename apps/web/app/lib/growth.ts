import { decodeGrowthExecutionRecord, decodeGrowthProfileInput, growthChannelsForExecution, type GrowthObservedRef, type GrowthProfileInput, type GrowthGoal, type GrowthOpportunity, type GrowthProfile, type GrowthProductInput, type CreateGrowthOpportunity, type GrowthDecision, type GrowthExecution, type GrowthExecutionRecord, type GrowthExecutionType, type GrowthReview } from "@openrecord/contracts"
import { api, ApiError } from "./api"

export const GROWTH_STATUS_LABELS = { DISCOVERED: "Discovered", PROPOSED: "Proposed", APPROVED: "Approved", REVIEWED: "Reviewed", CANCELLED: "Cancelled" }
export const GROWTH_GOAL_LABELS = { LEAD: "Leads", SIGNUP: "Signups", PURCHASE: "Purchases", BOOKING: "Bookings" }
export const GROWTH_EVIDENCE_LABELS = { OBSERVED: "Observed", OPERATOR_HYPOTHESIS: "Hypothesis", MODEL_SUGGESTION: "Agent hypothesis" }
export const GROWTH_CHANNEL_LABELS = { WEBSITE: "Website", THIRD_PARTY_PROFILE: "Third-party profile", EMAIL: "Email", PAID: "Paid", SOCIAL: "Social", OTHER: "Other" }
export const GROWTH_EXECUTION_LABELS = {
  SOURCE_UPDATED: "Source updated", SOURCE_PUBLISHED: "Source published", THIRD_PARTY_CORRECTION_REQUESTED: "Third-party correction requested",
  KNOWLEDGE_BASE_UPDATED: "Knowledge base updated", STRUCTURED_DATA_UPDATED: "Structured data updated", OTHER: "Other",
  CAMPAIGN_SENT: "Campaign sent", LISTING_UPDATED: "Listing updated",
}
/** The proof level is stated before any progress claim: an operator attestation
 * is never presented as verification, and a merge is never presented as
 * publication. */
export const growthAssuranceLabel = (execution: GrowthExecution): string => execution.assurance === "OPERATOR_ATTESTED"
  ? "Operator-attested; not independently verified."
  : `System-verified by the delivery adapter: ${execution.verification.claim.toLowerCase().replaceAll("_", " ")} (${execution.verification.kind.toLowerCase().replaceAll("_", " ")}). A merged change is not production publication.`
export const growthAssuranceBadge = (execution: GrowthExecution): "Operator-attested" | "System-verified" =>
  execution.assurance === "OPERATOR_ATTESTED" ? "Operator-attested" : "System-verified"
/** Who asserted it, from the reading operator's point of view. A system claim
 * belongs to an adapter, never to a person. */
export const growthExecutionActorLabel = (execution: GrowthExecution, userId: string): string =>
  execution.actor === "SYSTEM" ? "System adapter" : execution.actorId === userId ? "You (account operator)" : "Another account operator"
export const executionChannelsFor = (type: GrowthExecutionType | "") => growthChannelsForExecution(type)
export const localDateTimeInput = (date: Date): string => {
  const pad = (value: number) => String(value).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}
export const growthEvidencePath = (businessId: string, reference: GrowthObservedRef): string => {
  const id = encodeURIComponent(businessId)
  switch (reference.kind) {
    case "OBSERVATION": return `/observations/${encodeURIComponent(reference.id)}`
    case "ACQUISITION_BATCH": return `/clients/${id}/discovery?batchId=${encodeURIComponent(reference.id)}`
    case "ACQUISITION_RESULT": return `/clients/${id}/discovery`
    case "REFERRAL_IMPORT": return `/clients/${id}/discovery/report`
    case "RECORD_CHECK": case "RECORD_JUDGMENT": case "RECORD_ACTION": return `/clients/${id}`
  }
}
export const growthPath = (id: string) => `/clients/${encodeURIComponent(id)}/growth`
const base = (id: string) => `/api/growth/clients/${encodeURIComponent(id)}`
export const Growth = {
  register: (input: typeof GrowthProductInput.Type) => api<{ profile: GrowthProfile }>("/api/growth/products", { method: "POST", body: JSON.stringify(input) }),
  profile: (id: string) => api<{ profile: GrowthProfile | null; goals: GrowthGoal[] }>(base(id)),
  save: (id: string, input: GrowthProfileInput, requestKey: string) => api<{ profile: GrowthProfile }>(base(id), { method: "PUT", body: JSON.stringify({ ...input, idempotencyKey: requestKey }) }),
  list: (id: string) => api<{ opportunities: GrowthOpportunity[] }>(`${base(id)}/opportunities`),
  create: (id: string, input: CreateGrowthOpportunity) => api<{ opportunity: GrowthOpportunity }>(`${base(id)}/opportunities`, { method: "POST", body: JSON.stringify(input) }),
  review: (id: string, opportunityId: string, input: GrowthReview) => api<{ opportunity: GrowthOpportunity }>(`${base(id)}/opportunities/${encodeURIComponent(opportunityId)}/review`, { method: "POST", body: JSON.stringify(input) }),
  decide: (id: string, opportunityId: string, decision: "propose" | "approve" | "cancel", input: GrowthDecision) => api<{ opportunity: GrowthOpportunity }>(`${base(id)}/opportunities/${encodeURIComponent(opportunityId)}/${decision}`, { method: "POST", body: JSON.stringify(input) }),
  recordExecution: (id: string, opportunityId: string, input: GrowthExecutionRecord) => api<{ opportunity: GrowthOpportunity }>(`${base(id)}/opportunities/${encodeURIComponent(opportunityId)}/executions`, { method: "POST", body: JSON.stringify(input) }),
}
export const profileFromForm = (form: FormData): GrowthProfileInput => {
  const sourceKind = form.get("sourceKind")
  const monetary = sourceKind === "OPERATOR_AGGREGATE_EXPORT" && form.get("unit") === "CURRENCY_MINOR"
  const parsed = decodeGrowthProfileInput({
    category: form.get("category"), audience: form.get("audience"), valueProposition: form.get("valueProposition"), goalStatement: form.get("goalStatement"),
    metric: { conversionKind: form.get("conversionKind"), label: form.get("metricLabel"), sourceKind, sourceIdentity: form.get("sourceIdentity"),
      eventName: sourceKind === "GA4_AGGREGATE_EXPORT" ? form.get("eventName") : null,
      countingSemantics: monetary ? "SUM" : "EVENT_COUNT", unit: monetary ? "CURRENCY_MINOR" : "COUNT", currency: monetary ? form.get("currency") : null,
      reportingTimeZone: form.get("reportingTimeZone"), propertyRef: String(form.get("propertyRef") ?? "").trim() || null },
  })
  if (parsed === null) throw new Error("Check the product details, goal, metric source, units and IANA reporting timezone.")
  return parsed
}
export const executionFromForm = (form: FormData, requestKey: string, choice: { readonly type: string; readonly channel: string }): GrowthExecutionRecord => {
  const performed = String(form.get("performedAt") ?? "")
  const date = performed ? new Date(performed) : null
  const parsed = decodeGrowthExecutionRecord({
    type: choice.type, channel: choice.channel, target: String(form.get("target") ?? "").trim(),
    description: String(form.get("description") ?? "").trim(),
    performedAt: date && !Number.isNaN(date.getTime()) ? date.toISOString() : performed,
    idempotencyKey: requestKey,
  })
  if (parsed === null) throw new Error("Choose the action type and a compatible channel, describe what was done, and give the reference and a real performed time.")
  return parsed
}
export const growthError = (e: unknown): string => {
  if (e instanceof ApiError && e.body["reason"] === "StaleDecision") return "This opportunity changed. Refresh and review its current state before deciding."
  if (e instanceof ApiError && e.body["reason"] === "IdempotencyConflict") return "This request no longer matches what was saved. Close and reopen it before submitting different content."
  if (e instanceof ApiError && e.body["reason"] === "PrimaryGoalChanged") return "The primary goal changed. Refresh before proposing an opportunity."
  if (e instanceof ApiError && e.body["reason"] === "InitiativeNotApproved") return "This opportunity is no longer approved. Refresh before recording an execution."
  if (e instanceof ApiError && e.body["reason"] === "ExecutionTimeRefused") return "The performed time is in the future. Record what already happened."
  if (e instanceof ApiError && e.status === 404) return "This product or opportunity is unavailable."
  return e instanceof Error ? e.message : "The request failed. Try again."
}
