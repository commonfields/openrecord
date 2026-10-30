// The results ledger in plain stages: approved but not done, done and being
// measured, measured with a before/after reading, or decided.
import { describe, expect, it } from "vitest"
import type { GrowthOpportunity, GrowthOutcomeEvaluation } from "@openrecord/contracts"
import { ledgerEntry } from "./agent-results-tools.js"

const event = (status: string, extra: Record<string, unknown> = {}) => ({ id: status, status, revision: 1, actor: "OPERATOR", userId: "u", reason: "ok", conclusion: null, createdAt: "2026-10-01T00:00:00Z", ...extra })
const idea = (over: Partial<GrowthOpportunity>): GrowthOpportunity => ({
  id: "o1", title: "Add pricing FAQ", proposedChange: "Add an FAQ", expectedMechanism: "Answers buyer questions", executions: [], events: [event("APPROVED")], ...over,
} as unknown as GrowthOpportunity)
const evaluation = (over: Partial<GrowthOutcomeEvaluation>) => ({ status: "INDETERMINATE", reasons: [], caveats: [], metric: { label: "Bookings" }, plan: null, baseline: null, observation: null, comparison: null, ...over } as unknown as GrowthOutcomeEvaluation)

describe("results ledger", () => {
  it("says an approved idea isn't done yet, and why it can't be read", () => {
    expect(ledgerEntry(idea({}), evaluation({ reasons: [{ code: "NO_RECORDED_EXECUTION", detail: "", refs: [] }] }))).toMatchObject({
      stage: "APPROVED_NOT_DONE", metric: "Bookings", result: null, notYet: ["nothing has been recorded as done yet"] })
  })

  it("reads a measured idea per day, before and after, as a rounded percent", () => {
    const e = evaluation({ status: "COMPARABLE",
      plan: { baselineStart: "2026-09-01", baselineEnd: "2026-09-28", observationStart: "2026-10-01", observationEnd: "2026-10-28" } as never,
      baseline: { dailyMean: { value: 4, total: 112, days: 28 } } as never, observation: { dailyMean: { value: 5, total: 140, days: 28 } } as never,
      comparison: { basis: "TOTAL_AND_DAILY_MEAN", totalDifference: 28, dailyMeanDifference: 1, dailyMeanPercentChange: 0.25 } })
    expect(ledgerEntry(idea({ executions: [{ type: "CONTENT", performedAt: "2026-09-30T00:00:00Z" }] as never }), e)).toMatchObject({
      stage: "MEASURED", actions: { count: 1 }, plan: { baseline: "2026-09-01 to 2026-09-28" }, result: { before: 4, after: 5, percentChange: 25 } })
  })

  it("carries the person's decision once reviewed", () => {
    const reviewed = idea({ events: [event("APPROVED"), event("REVIEWED", { conclusion: "KEEP", reason: "Bookings rose" })] as never })
    expect(ledgerEntry(reviewed, null)).toMatchObject({ stage: "DECIDED", decision: "KEEP", decisionReason: "Bookings rose" })
  })
})
