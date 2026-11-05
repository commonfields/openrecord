import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import { CampaignBrief, campaignBlockers, campaignTransitionError } from "@openrecord/contracts"

export const brief = (): CampaignBrief => ({
  title: "Activation nurture", goal: "Increase activated trials", audience: "New trials", offer: "Book onboarding",
  message: "Get to your first result", hypothesis: "Onboarding help reduces setup friction", metric: "Activated trials / CRM",
  baseline: "20% last month", target: "25% over four weeks", owner: "Marketing lead", launchDate: "2026-11-05", reviewDate: "2026-12-05",
  status: "DRAFT", tasks: [{ id: "11111111-1111-4111-8111-111111111111", title: "Review nurture sequence", owner: "Lifecycle lead", due: "2026-11-04", channel: "EMAIL", status: "DONE", note: "Reviewed manually" }],
  result: "", decision: "UNDECIDED", learning: "", nextMove: "",
})
describe("marketing campaign planning contract", () => {
  it("allows incomplete drafts but blocks an unprepared launch", () => {
    const c = { ...brief(), audience: "", tasks: [] }
    expect(campaignTransitionError(c)).toBeNull()
    expect(campaignBlockers(c)).toContain("Choose an audience")
    expect(campaignTransitionError({ ...c, status: "ACTIVE" })).not.toBeNull()
    expect(campaignTransitionError({ ...brief(), status: "ACTIVE" })).toBeNull()
  })
  it("blocks incomplete deliverables and premature closure", () => {
    const c = brief()
    expect(campaignTransitionError({ ...c, status: "ACTIVE", tasks: [{ ...c.tasks[0]!, status: "BLOCKED" }] })).not.toBeNull()
    expect(campaignTransitionError({ ...c, status: "CLOSED" })).not.toBeNull()
    expect(campaignTransitionError({ ...c, status: "CLOSED", decision: "INCONCLUSIVE", result: "Insufficient sample", learning: "Need a longer window", nextMove: "Extend two weeks" })).toBeNull()
  })
  it("rejects impossible dates, reversed windows and duplicate deliverables", () => {
    expect(campaignTransitionError({ ...brief(), launchDate: "2026-02-30" })).toBe("Invalid launch date")
    expect(campaignTransitionError({ ...brief(), reviewDate: "2026-01-01" })).not.toBeNull()
    const c = brief()
    expect(campaignTransitionError({ ...c, tasks: [...c.tasks, ...c.tasks] })).toBe("Duplicate deliverable IDs")
  })
  it("bounds inputs and rejects extra authority fields", () => {
    expect(Schema.decodeUnknownEither(CampaignBrief, { onExcessProperty: "error" })({ ...brief(), approved: true })._tag).toBe("Left")
    expect(Schema.decodeUnknownEither(CampaignBrief)({ ...brief(), title: " " })._tag).toBe("Left")
    expect(Schema.decodeUnknownEither(CampaignBrief)({ ...brief(), tasks: Array(101).fill(brief().tasks[0]) })._tag).toBe("Left")
  })
})
