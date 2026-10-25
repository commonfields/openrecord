import { describe, expect, it } from "vitest"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import type { GrowthEvaluationWindow, GrowthOpportunity, GrowthOutcomeEvaluation } from "@openrecord/contracts"
import { EvaluationView } from "../app/components/growth-evaluation"
import { OpportunityCard } from "../app/routes/client-growth"

const id = "00000000-0000-4000-8000-000000000001"
const userId = "00000000-0000-4000-8000-000000000002"
const window = (role: GrowthEvaluationWindow["role"], start: string, end: string, perDay: number, overrides: Partial<GrowthEvaluationWindow> = {}): GrowthEvaluationWindow => ({
  role, start, end, days: 7, validDays: 7, coverage: 1, missingDays: [], unavailableDays: [], conflictingDays: [], syntheticDays: [],
  validTotal: perDay * 7, dailyMean: { total: perDay * 7, days: 7, value: perDay }, series: [], conflicts: [], ...overrides,
})
const comparable: GrowthOutcomeEvaluation = {
  businessId: id, opportunityId: "00000000-0000-4000-8000-000000000030", evaluatedAt: "2026-10-01T00:00:00.000Z", interpretation: "DESCRIPTIVE_ONLY", status: "COMPARABLE",
  reasons: [], caveats: [{ code: "OPERATOR_ATTESTED_ONLY", detail: "1 of 1 of this initiative's actions are operator-attested and not independently verified.", refs: [] }],
  initiative: { id: "00000000-0000-4000-8000-000000000030", title: "TEST initiative", status: "APPROVED", revision: 2, approvedAt: "2026-08-21T00:00:00.000Z", decisions: [] },
  goal: { id: "00000000-0000-4000-8000-000000000010", version: 1, statement: "Increase bookings" },
  metric: { id: "00000000-0000-4000-8000-000000000020", version: 1, label: "Bookings", conversionKind: "BOOKING", sourceKind: "OPERATOR_AGGREGATE_EXPORT", sourceIdentity: "TEST booking system",
    eventName: null, propertyRef: null, countingSemantics: "EVENT_COUNT", unit: "COUNT", currency: null, timeZone: "Asia/Makassar" },
  plan: { id: "00000000-0000-4000-8000-000000000050", metricDefinitionId: "00000000-0000-4000-8000-000000000020", metricDefinitionVersion: 1, baselineStart: "2026-09-01", baselineEnd: "2026-09-07",
    observationStart: "2026-09-09", observationEnd: "2026-09-15", declaredAt: "2026-08-25T00:00:00.000Z", declaredByUserId: userId, timing: "PRE_DECLARED", firstLinkedExecutionAt: "2026-09-07T20:00:00.000Z", declarations: 1 },
  baseline: window("BASELINE", "2026-09-01", "2026-09-07", 4), observation: window("OBSERVATION", "2026-09-09", "2026-09-15", 6),
  comparison: { basis: "TOTAL_AND_DAILY_MEAN", totalDifference: 14, dailyMeanDifference: 2, dailyMeanPercentChange: 50 },
  actions: [{ id: "00000000-0000-4000-8000-000000000060", type: "LISTING_UPDATED", channel: "THIRD_PARTY_PROFILE", performedAt: "2026-09-07T20:00:00.000Z", recordedAt: "2026-09-20T01:00:00.000Z",
    performedDay: "2026-09-08", phase: "BETWEEN_WINDOWS", assurance: "OPERATOR_ATTESTED", actor: "HUMAN", reference: "TEST booking listing", description: null, verification: null,
    association: "THIS_INITIATIVE", initiative: { id: "00000000-0000-4000-8000-000000000030", title: "TEST initiative" } }],
  assumptions: ["TEST assumption"], limitations: ["TEST limitation"],
}

describe("growth outcome evaluation view", () => {
  it("shows the comparable reading as a description with both times, assurance and no causal credit", () => {
    const html = renderToStaticMarkup(createElement(EvaluationView, { evaluation: comparable }))
    expect(html).toContain("Measurements comparable")
    expect(html).toContain("It does not show what caused any change.")
    expect(html).toContain("not growth caused by this initiative")
    expect(html).toContain("Bookings, version 1, EVENT_COUNT/COUNT")
    expect(html).toContain("Asia/Makassar")
    expect(html).toContain("before any linked action")
    expect(html).toContain("Operator-attested")
    expect(html).toContain("Third-party profile")
    expect(html).toContain("2026-09-08, between the windows")
    expect(html).toContain("recorded ")
    expect(html).toContain("Totals differ by +14")
    for (const persuasive of ["Success", "Effective", "ROI", "Attributed", "Lift", "Generated"]) expect(html).not.toContain(persuasive)
  })

  it("explains indeterminate readings with blocking reasons and never shows a difference", () => {
    const html = renderToStaticMarkup(createElement(EvaluationView, { evaluation: {
      ...comparable, status: "INDETERMINATE", comparison: null,
      reasons: [{ code: "MISSING_DAYS", detail: "observation: 1 day(s) were covered by an import that reported no value; missing is not zero.", refs: ["2026-09-11"] }],
      observation: window("OBSERVATION", "2026-09-09", "2026-09-15", 6, { validDays: 6, coverage: 0.8571, validTotal: 36, missingDays: ["2026-09-11"], dailyMean: { total: 36, days: 6, value: 6 } }),
    } }))
    expect(html).toContain("Indeterminate")
    expect(html).toContain("Why no comparison is shown")
    expect(html).toContain("Missing days")
    expect(html).toContain("1 missing: 2026-09-11")
    expect(html).toContain("6 of 7 days carry a valid recorded value")
    expect(html).not.toContain("difference")
  })

  it("offers the evaluation only on initiatives a human approved", () => {
    const base = { id: "00000000-0000-4000-8000-000000000030", businessId: id, goalId: "00000000-0000-4000-8000-000000000010", title: "TEST", problemStatement: "TEST", audience: "TEST",
      buyerIntent: "TEST", targetUrl: null, source: "TEST", proposedChange: "TEST", expectedMechanism: "TEST", assumptions: "TEST", uncertainty: "TEST", baselineAvailability: "UNKNOWN",
      ownerUserId: userId, createdByUserId: userId, createdByActor: "OPERATOR", createdAt: "2026-08-20T00:00:00.000Z", updatedAt: "2026-08-21T00:00:00.000Z", updatedByUserId: userId,
      status: "PROPOSED", revision: 1, progress: "NOT_STARTED", executionCount: 0, executions: [], evidence: [], events: [] } satisfies GrowthOpportunity
    const event = (status: "PROPOSED" | "APPROVED", revision: number) => ({ id: `00000000-0000-4000-8000-00000000004${revision}`, status, revision, actor: "OPERATOR" as const, userId, reason: "TEST", conclusion: null, createdAt: "2026-08-21T00:00:00.000Z" })
    const proposed = renderToStaticMarkup(createElement(OpportunityCard, { businessId: id, opportunity: { ...base, events: [event("PROPOSED", 1)] }, goal: undefined, userId, reload: async () => {} }))
    expect(proposed).not.toContain("Outcome evaluation")
    const approved = renderToStaticMarkup(createElement(OpportunityCard, { businessId: id, opportunity: { ...base, status: "APPROVED", revision: 2, events: [event("PROPOSED", 1), event("APPROVED", 2)] }, goal: undefined, userId, reload: async () => {} }))
    expect(approved).toContain("Outcome evaluation")
  })
})
