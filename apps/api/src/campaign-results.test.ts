import { describe, expect, it } from "vitest"
import { MIN_DAYS_LIVE, MIN_VIEWS, sufficiencyOf, targetNumber } from "./campaign-results.js"

describe("campaign results", () => {
  it("is not enough to judge before a week live and a hundred views, and says why in sentences", () => {
    expect(sufficiencyOf([])).toEqual({ sufficient: false, reasons: ["No campaign page is live, so there is nothing to read yet."] })
    const thin = sufficiencyOf([{ daysLive: 2, views: 40 }])
    expect(thin.sufficient).toBe(false)
    expect(thin.reasons).toEqual([`Live for 2 days; at least ${MIN_DAYS_LIVE} are needed to judge.`, `40 views recorded; at least ${MIN_VIEWS} are needed to judge.`])
    expect(thin.reasons.join(" ")).not.toContain("·")
    expect(sufficiencyOf([{ daysLive: 9, views: 60 }, { daysLive: 3, views: 50 }]).sufficient).toBe(true)
  })
  it("reads a number out of a written target, or none", () => {
    expect(targetNumber("Suggested: 10 qualified demo requests by 2026-12-21")).toBe(10)
    expect(targetNumber("1,200 signups")).toBe(1200)
    expect(targetNumber("More demos")).toBeNull()
  })
})
