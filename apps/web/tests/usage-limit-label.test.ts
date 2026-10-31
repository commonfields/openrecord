import { describe, expect, it } from "vitest"
import { usageLimitLabel } from "../app/lib/harness"

describe("usage limit status", () => {
  const now = new Date("2026-10-31T08:00:00Z")
  it("says when the limit lifts, with the day when it is not today", () => {
    expect(usageLimitLabel("2026-11-04T06:36:47.000Z", now)).toMatch(/^Usage limit reached, resets Nov 4/)
    expect(usageLimitLabel(new Date(now.getTime() + 60 * 60_000).toISOString(), now)).toMatch(/^Usage limit reached, resets at /)
  })
  it("says only that the limit is reached when the time is unknown or past", () => {
    expect(usageLimitLabel(null, now)).toBe("Usage limit reached")
    expect(usageLimitLabel("2026-10-30T00:00:00Z", now)).toBe("Usage limit reached")
    expect(usageLimitLabel("not a date", now)).toBe("Usage limit reached")
  })
})
