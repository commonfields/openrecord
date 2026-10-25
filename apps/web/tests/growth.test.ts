import { describe, expect, it } from "vitest"
import { createElement } from "react"
import { matchRoutes } from "react-router"
import { renderToStaticMarkup } from "react-dom/server"
import type { GrowthExecution, GrowthGoal, GrowthOpportunity } from "@openrecord/contracts"
import { agentEvidencePath } from "../app/lib/agent-evidence"
import { executionChannelsFor, executionFromForm, growthAssuranceBadge, growthAssuranceLabel, growthExecutionActorLabel, growthPath, growthEvidencePath, localDateTimeInput, profileFromForm } from "../app/lib/growth"
import { OpportunityCard, OpportunityForm } from "../app/routes/client-growth"

describe("growth workspace form and navigation", () => {
  const id = "00000000-0000-4000-8000-000000000001"
  const userId = "00000000-0000-4000-8000-000000000001"
  const form = () => {
    const data = new FormData()
    for (const [key, value] of Object.entries({ category: "Software", audience: "Operators", valueProposition: "Clear positioning", goalStatement: "Increase trials", conversionKind: "SIGNUP", metricLabel: "Trial signups", sourceKind: "GA4_AGGREGATE_EXPORT", sourceIdentity: "TEST GA4", unit: "COUNT", eventName: "trial_signup", reportingTimeZone: "Asia/Makassar", propertyRef: "TEST property" })) data.set(key, value)
    return data
  }
  const baseOpportunity = (overrides: Partial<GrowthOpportunity>): GrowthOpportunity => ({
    id: "00000000-0000-4000-8000-000000000030", businessId: id, goalId: "00000000-0000-4000-8000-000000000010", title: "TEST opportunity",
    problemStatement: "TEST problem", audience: "TEST audience", buyerIntent: "TEST intent", targetUrl: null, source: "TEST source", proposedChange: "TEST change",
    expectedMechanism: "TEST mechanism", assumptions: "TEST assumptions", uncertainty: "TEST uncertainty", baselineAvailability: "UNKNOWN",
    ownerUserId: userId, createdByUserId: userId, createdByActor: "OPERATOR", createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z", updatedByUserId: userId, status: "PROPOSED", revision: 1, progress: "NOT_STARTED",
    executionCount: 0, executions: [], evidence: [], events: [], ...overrides,
  })
  const attested: GrowthExecution = {
    id: "00000000-0000-4000-8000-000000000040", opportunityId: "00000000-0000-4000-8000-000000000030", businessId: id,
    type: "SOURCE_PUBLISHED", channel: "WEBSITE", target: "TEST pricing page", description: "TEST published the revised pricing explainer",
    performedAt: "2026-10-19T09:30:00.000Z", recordedAt: "2026-10-19T09:35:00.000Z",
    assurance: "OPERATOR_ATTESTED", actor: "HUMAN", actorId: userId, verification: null,
  }
  const verified: GrowthExecution = {
    ...attested, id: "00000000-0000-4000-8000-000000000041", type: "SOURCE_UPDATED", description: null,
    assurance: "SYSTEM_VERIFIED", actor: "SYSTEM", actorId: null,
    verification: { kind: "GROWTH_DELIVERY", id: "00000000-0000-4000-8000-000000000042", claim: "PR_MERGED" },
  }
  it("saves an event definition with explicit count semantics and optional property", () => {
    const value = profileFromForm(form())
    expect(value.metric).toEqual({ conversionKind: "SIGNUP", label: "Trial signups", sourceKind: "GA4_AGGREGATE_EXPORT", sourceIdentity: "TEST GA4", unit: "COUNT", currency: null, eventName: "trial_signup", countingSemantics: "EVENT_COUNT", reportingTimeZone: "Asia/Makassar", propertyRef: "TEST property" })
  })
  it("rejects invalid timezone, empty audience and malformed event names before saving", () => {
    for (const [key, value] of [["reportingTimeZone", "+08:00"], ["eventName", "signup events"], ["audience", "   "]]) {
      const data = form(); data.set(key!, value!); expect(() => profileFromForm(data)).toThrow("Check the product details")
    }
  })
  it("defines operator booking counts and monetary sums without pretending GA4 is configured", () => {
    const data = form(); data.set("sourceKind", "OPERATOR_AGGREGATE_EXPORT"); data.set("conversionKind", "BOOKING"); data.set("sourceIdentity", "TEST booking system"); data.set("eventName", "ignored"); data.set("propertyRef", "")
    expect(profileFromForm(data).metric).toMatchObject({ eventName: null, propertyRef: null, conversionKind: "BOOKING", unit: "COUNT", currency: null })
    data.set("unit", "CURRENCY_MINOR"); data.set("currency", "EUR")
    expect(profileFromForm(data).metric).toMatchObject({ countingSemantics: "SUM", unit: "CURRENCY_MINOR", currency: "EUR" })
  })
  it("links every observed reference kind to its stored source workspace", () => {
    const paths = {
      OBSERVATION: `/observations/${id}`, RECORD_CHECK: `/clients/${id}`, RECORD_JUDGMENT: `/clients/${id}`, RECORD_ACTION: `/clients/${id}`,
      ACQUISITION_BATCH: `/clients/${id}/discovery?batchId=${id}`, ACQUISITION_RESULT: `/clients/${id}/discovery`, REFERRAL_IMPORT: `/clients/${id}/discovery/report`,
    }
    for (const kind of ["OBSERVATION", "RECORD_CHECK", "RECORD_JUDGMENT", "RECORD_ACTION", "ACQUISITION_BATCH", "ACQUISITION_RESULT", "REFERRAL_IMPORT"] as const) {
      expect(growthEvidencePath(id, { kind, id })).toBe(paths[kind])
    }
  })
  it("links goal and opportunity citations to the authenticated workspace", () => {
    for (const kind of ["growth_goal", "growth_opportunity"]) {
      const path = agentEvidencePath(id, { kind, id, text: "Growth evidence" })
      expect(path?.split("#")[0]).toBe(growthPath(id)); expect(matchRoutes([{ path: "/clients/:id/growth" }], path!)?.[0]?.params["id"]).toBe(id)
    }
  })
  it("labels the goal version and the metric definition version from their own fields", () => {
    const goal: GrowthGoal = {
      id: "00000000-0000-4000-8000-000000000010", businessId: id, version: 7, statement: "TEST goal",
      metricDefinition: { id: "00000000-0000-4000-8000-000000000020", businessId: id, version: 3, conversionKind: "SIGNUP", label: "Trial signups",
        sourceKind: "GA4_AGGREGATE_EXPORT", sourceIdentity: "TEST GA4", eventName: "trial_signup", countingSemantics: "EVENT_COUNT", unit: "COUNT", currency: null,
        reportingTimeZone: "UTC", propertyRef: "TEST property", createdByUserId: userId, createdAt: "2026-10-01T00:00:00.000Z" },
      createdByUserId: userId, createdAt: "2026-10-01T00:00:00.000Z",
    }
    const form = renderToStaticMarkup(createElement(OpportunityForm, { businessId: id, goal, userId, websiteUrl: "https://growth.test", done: async () => {} }))
    expect(form).toContain("metric version 3")
    expect(form).not.toContain("metric version 7")
    const card = renderToStaticMarkup(createElement(OpportunityCard, { businessId: id, opportunity: baseOpportunity({}), goal, userId, reload: async () => {} }))
    expect(card).toContain("metric version 3")
    expect(card).not.toContain("metric version 7")
  })
  it("builds one operator-attested execution request from the dialog and refuses incomplete ones", () => {
    const executionForm = (values: Record<string, string>) => {
      const data = new FormData()
      for (const [key, value] of Object.entries(values)) data.set(key, value)
      return data
    }
    const choice = { type: "SOURCE_PUBLISHED", channel: "WEBSITE" }
    const key = "00000000-0000-4000-8000-000000000050"
    const parsed = executionFromForm(executionForm({ target: " https://growth.test/pricing ", description: " Published the revised pricing explainer ", performedAt: "2026-10-19T09:30" }), key, choice)
    expect(parsed).toMatchObject({ ...choice, target: "https://growth.test/pricing", description: "Published the revised pricing explainer", idempotencyKey: key })
    expect(parsed.performedAt).toBe(new Date("2026-10-19T09:30").toISOString())
    const bad = [
      { choice: { ...choice, type: "" } }, { choice: { ...choice, channel: "GITHUB" } }, { choice: { type: "CAMPAIGN_SENT", channel: "WEBSITE" } }, { choice: { type: "LISTING_UPDATED", channel: "EMAIL" } },
      { values: { target: "   " } }, { values: { target: "javascript:alert(1)" } }, { values: { description: "" } }, { values: { performedAt: "not-a-time" } }, { values: { performedAt: "" } },
    ]
    for (const entry of bad) {
      const data = executionForm({ target: "TEST page", description: "TEST description", performedAt: "2026-10-19T09:30", ...entry.values })
      expect(() => executionFromForm(data, key, entry.choice ?? choice)).toThrow("Choose the action type and a compatible channel")
    }
    // The dialog offers only the channels the chosen action supports, so a
    // marketing operator never submits a nonsensical pair.
    expect(executionChannelsFor("CAMPAIGN_SENT")).toEqual(["EMAIL", "PAID", "SOCIAL", "OTHER"])
    expect(executionChannelsFor("LISTING_UPDATED")).toEqual(["WEBSITE", "THIRD_PARTY_PROFILE", "SOCIAL", "OTHER"])
    expect(executionChannelsFor("SOURCE_PUBLISHED")).toContain("WEBSITE")
    expect(localDateTimeInput(new Date(2026, 9, 19, 9, 5))).toBe("2026-10-19T09:05")
  })
  it("labels operator attestation and a system claim distinctly before any execution status", () => {
    expect(growthAssuranceLabel(attested)).toBe("Operator-attested; not independently verified.")
    expect(growthAssuranceLabel(verified)).toBe("System-verified by the delivery adapter: pr merged (growth delivery). A merged change is not production publication.")
    expect(growthAssuranceBadge(attested)).toBe("Operator-attested"); expect(growthAssuranceBadge(verified)).toBe("System-verified")
    expect(growthExecutionActorLabel(attested, userId)).toBe("You (account operator)")
    expect(growthExecutionActorLabel(attested, "00000000-0000-4000-8000-000000000002")).toBe("Another account operator")
    expect(growthExecutionActorLabel(verified, userId)).toBe("System adapter")
  })
  it("exposes execution history and assurance, and offers recording only on approved initiatives", () => {
    const approved = baseOpportunity({ status: "APPROVED", revision: 2, progress: "EXECUTED", executionCount: 1, executions: [attested] })
    const card = renderToStaticMarkup(createElement(OpportunityCard, { businessId: id, opportunity: approved, goal: undefined, userId, reload: async () => {} }))
    expect(card).toContain("Record execution")
    expect(card).toContain("Execution history (1)")
    expect(card).toContain("Website"); expect(card).toContain("Source published")
    expect(card).toContain("Operator-attested"); expect(card).not.toContain("System-verified")
    expect(card).toContain("Reference: "); expect(card).toContain("TEST pricing page")
    expect(card).toContain("TEST published the revised pricing explainer")
    expect(card).toContain("Asserted by You (account operator)")
    expect(card).toContain("Operator-attested; not independently verified.")
    const pending = renderToStaticMarkup(createElement(OpportunityCard, { businessId: id, opportunity: baseOpportunity({ executions: [attested] }), goal: undefined, userId, reload: async () => {} }))
    expect(pending).not.toContain("Record execution")
    expect(pending).toContain("Execution history (1)")
    const system = renderToStaticMarkup(createElement(OpportunityCard, { businessId: id, opportunity: baseOpportunity({ status: "APPROVED", revision: 2, progress: "EXECUTED", executionCount: 1, executions: [verified] }), goal: undefined, userId, reload: async () => {} }))
    expect(system).toContain("System-verified"); expect(system).toContain("Asserted by System adapter")
    expect(system).toContain("A merged change is not production publication.")
  })
})
