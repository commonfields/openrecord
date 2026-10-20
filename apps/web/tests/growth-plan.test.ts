// W6 regression: an operator must be able to declare the measurement plan in
// the product (it was API-only), and the workspace must link to the page that
// imports daily figures. TEST fixtures only.
import { describe, expect, it } from "vitest"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import type { GrowthOpportunity, GrowthPlanRead } from "@openrecord/contracts"
import { PlanSummary } from "../app/components/growth-plan"
import { planFromForm } from "../app/lib/growth"
import { OpportunityCard } from "../app/routes/client-growth"

const form = (fields: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(fields)) f.set(k, v); return f }
const days = { baselineStart: "2026-09-01", baselineEnd: "2026-09-07", observationStart: "2026-09-09", observationEnd: "2026-09-15" }
const key = "00000000-0000-4000-8000-0000000000aa"

describe("measurement plan in the operator workspace", () => {
  it("turns the four dates into the API input and refuses bad periods before sending", () => {
    expect(planFromForm(form(days), key)).toEqual({ ...days, idempotencyKey: key })
    expect(() => planFromForm(form({ ...days, baselineStart: "" }), key)).toThrow(/real calendar days/)
    expect(() => planFromForm(form({ ...days, observationEnd: "2026-02-30" }), key)).toThrow(/real calendar days/)
    expect(() => planFromForm(form({ ...days, baselineEnd: "2026-08-30" }), key)).toThrow(/start on or before/)
    expect(() => planFromForm(form({ ...days, observationStart: "2026-09-07" }), key)).toThrow(/after the baseline/)
  })

  it("says whether the plan was declared before or after the work", () => {
    const plan = { id: "p", businessId: "b", opportunityId: "o", goalId: "g", metricDefinition: { id: "m", version: 1, label: "Trial signups", countingSemantics: "EVENT_COUNT", unit: "COUNT", timeZone: "UTC" },
      ...days, declaredByUserId: "u", declaredAt: "2026-08-25T00:00:00.000Z", requestKey: key } satisfies GrowthPlanRead["plan"]
    const before = renderToStaticMarkup(createElement(PlanSummary, { read: { plan, timing: "PRE_DECLARED", firstLinkedExecutionAt: null } }))
    expect(before).toContain("Declared before the work")
    expect(before).toContain("Baseline: 2026-09-01 → 2026-09-07")
    expect(before).not.toContain("will not treat the periods as agreed in advance")
    const late = renderToStaticMarkup(createElement(PlanSummary, { read: { plan, timing: "DECLARED_AFTER_EXECUTION", firstLinkedExecutionAt: "2026-08-20T00:00:00.000Z" } }))
    expect(late).toContain("Declared after the work")
    expect(late).toContain("will not treat the periods as agreed in advance")
  })

  it("offers the plan only on approved initiatives", () => {
    const userId = "00000000-0000-4000-8000-000000000002"
    const base = { id: "00000000-0000-4000-8000-000000000030", businessId: "00000000-0000-4000-8000-000000000001", goalId: "00000000-0000-4000-8000-000000000010", title: "TEST",
      problemStatement: "TEST", audience: "TEST", buyerIntent: "TEST", targetUrl: null, source: "TEST", proposedChange: "TEST", expectedMechanism: "TEST", assumptions: "TEST", uncertainty: "TEST",
      baselineAvailability: "UNKNOWN", ownerUserId: userId, createdByUserId: userId, createdByActor: "OPERATOR", createdAt: "2026-08-20T00:00:00.000Z", updatedAt: "2026-08-21T00:00:00.000Z",
      updatedByUserId: userId, status: "PROPOSED", revision: 1, progress: "NOT_STARTED", executionCount: 0, executions: [], evidence: [], events: [] } satisfies GrowthOpportunity
    const event = (status: "PROPOSED" | "APPROVED", revision: number) => ({ id: `00000000-0000-4000-8000-00000000004${revision}`, status, revision, actor: "OPERATOR" as const, userId, reason: "TEST", conclusion: null, createdAt: "2026-08-21T00:00:00.000Z" })
    const render = (o: GrowthOpportunity) => renderToStaticMarkup(createElement(OpportunityCard, { businessId: base.businessId, opportunity: o, goal: undefined, userId, reload: async () => {} }))
    expect(render({ ...base, events: [event("PROPOSED", 1)] })).not.toContain("Measurement plan")
    const approved = render({ ...base, status: "APPROVED", revision: 2, events: [event("PROPOSED", 1), event("APPROVED", 2)] })
    expect(approved).toContain("Measurement plan")
    // The plan comes before the evaluation it makes possible.
    expect(approved.indexOf("Measurement plan")).toBeLessThan(approved.indexOf("Outcome evaluation"))
  })
})
