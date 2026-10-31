// The weekly brief as a report: its bold-headed parts, the closing line about
// a missing connection, and plain text when it isn't in the usual shape.
import { describe, expect, it } from "vitest"
import { briefParts } from "../app/lib/brief"

const brief = `**What changed**

No comparable figures are available for this week or the preceding period.

**Do this next**

Set one primary growth goal and its metric.

**What we did and what it changed**

No ideas have been approved or actions recorded, so there is no before-and-after result to report.

For a sharper brief next week, connect Stripe to show revenue and paying customers.`

describe("brief parts", () => {
  it("splits the brief into its sections and lifts out the connection line", () => {
    const parts = briefParts(brief)
    expect(parts.sections.map(s => [s.kind, s.title])).toEqual([
      ["changed", "What changed"], ["next", "Do this next"], ["results", "What we did and what it changed"],
    ])
    expect(parts.sections[1]!.body).toBe("Set one primary growth goal and its metric.")
    expect(parts.sections[2]!.body).toBe("No ideas have been approved or actions recorded, so there is no before-and-after result to report.")
    expect(parts.note).toBe("For a sharper brief next week, connect Stripe to show revenue and paying customers.")
  })

  it("reads headings written inline with a colon, and the investigations part", () => {
    const parts = briefParts("**What changed**: signups rose from 30 to 38.\n\n**What we're investigating**\n\n- Why trials stall on day two.")
    expect(parts.sections.map(s => s.kind)).toEqual(["changed", "investigating"])
    expect(parts.sections[0]!.body).toBe("signups rose from 30 to 38.")
    expect(parts.note).toBeNull()
  })

  it("keeps a last paragraph that isn't about a connection inside its section", () => {
    const parts = briefParts("**What we did and what it changed**\n\nThe FAQ went live.\n\nWe will know more next week.")
    expect(parts.note).toBeNull()
    expect(parts.sections[0]!.body).toBe("The FAQ went live.\n\nWe will know more next week.")
  })

  it("returns no sections for text that isn't in the usual shape, so it shows as written", () => {
    expect(briefParts("Signups rose this week.").sections).toEqual([])
    expect(briefParts("An opening line first.\n\n**What changed**\n\nSignups rose.").sections).toEqual([])
  })
})
