import { decodeGrowthProfileInput, type GrowthObservedRef, type GrowthProfileInput, type GrowthGoal, type GrowthOpportunity, type GrowthProfile, type GrowthProductInput, type CreateGrowthOpportunity, type GrowthDecision, type GrowthReview } from "@openrecord/contracts"
import { api, ApiError } from "./api"

export const GROWTH_STATUS_LABELS = { DISCOVERED: "Discovered", PROPOSED: "Proposed", APPROVED: "Approved", REVIEWED: "Reviewed", CANCELLED: "Cancelled" }
export const GROWTH_GOAL_LABELS = { LEAD: "Leads", SIGNUP: "Signups", PURCHASE: "Purchases", BOOKING: "Bookings" }
export const GROWTH_EVIDENCE_LABELS = { OBSERVED: "Observed", OPERATOR_HYPOTHESIS: "Hypothesis", MODEL_SUGGESTION: "Agent hypothesis" }
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
export const growthError = (e: unknown): string => {
  if (e instanceof ApiError && e.body["reason"] === "StaleDecision") return "This opportunity changed. Refresh and review its current state before deciding."
  if (e instanceof ApiError && e.body["reason"] === "IdempotencyConflict") return "This review no longer matches the saved decision. Close it and review the opportunity again."
  if (e instanceof ApiError && e.body["reason"] === "PrimaryGoalChanged") return "The primary goal changed. Refresh before proposing an opportunity."
  if (e instanceof ApiError && e.status === 404) return "This product or opportunity is unavailable."
  return e instanceof Error ? e.message : "The request failed. Try again."
}
