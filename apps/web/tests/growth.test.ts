import { describe, expect, it } from "vitest"
import { createElement } from "react"
import { matchRoutes } from "react-router"
import { renderToStaticMarkup } from "react-dom/server"
import type { GrowthGoal, GrowthOpportunity } from "@openrecord/contracts"
import { agentEvidencePath } from "../app/lib/agent-evidence"
import { growthPath, growthEvidencePath, profileFromForm } from "../app/lib/growth"
import { OpportunityCard, OpportunityForm } from "../app/routes/client-growth"

describe("growth workspace form and navigation", () => {
  const id = "00000000-0000-4000-8000-000000000001"
  const form = () => {
    const data = new FormData()
    for (const [key, value] of Object.entries({ category: "Software", audience: "Operators", valueProposition: "Clear positioning", goalStatement: "Increase trials", conversionKind: "SIGNUP", metricLabel: "Trial signups", sourceKind: "GA4_AGGREGATE_EXPORT", sourceIdentity: "TEST GA4", unit: "COUNT", eventName: "trial_signup", reportingTimeZone: "Asia/Makassar", propertyRef: "TEST property" })) data.set(key, value)
    return data
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
    const userId = "00000000-0000-4000-8000-000000000001"
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
    const opportunity: GrowthOpportunity = {
      id: "00000000-0000-4000-8000-000000000030", businessId: id, goalId: goal.id, title: "TEST opportunity", problemStatement: "TEST problem",
      audience: "TEST audience", buyerIntent: "TEST intent", targetUrl: null, source: "TEST source", proposedChange: "TEST change",
      expectedMechanism: "TEST mechanism", assumptions: "TEST assumptions", uncertainty: "TEST uncertainty", baselineAvailability: "UNKNOWN",
      ownerUserId: userId, createdByUserId: userId, createdByActor: "OPERATOR", createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z", updatedByUserId: userId, status: "PROPOSED", revision: 1, progress: "NOT_STARTED",
      executionCount: 0, evidence: [], events: [],
    }
    const card = renderToStaticMarkup(createElement(OpportunityCard, { businessId: id, opportunity, goal, userId, reload: async () => {} }))
    expect(card).toContain("metric version 3")
    expect(card).not.toContain("metric version 7")
  })
})
