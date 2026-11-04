import { describe, expect, it } from "vitest"
import type { CampaignBrief } from "@openrecord/contracts"
import { campaignRunReport, type CampaignDelivery } from "./campaign-engine.js"

const brief: CampaignBrief = { title: "Campaign", goal: "More demos", audience: "Trials", offer: "Onboarding", message: "Get a result", hypothesis: "Guidance helps", metric: "CRM demos", baseline: "Unknown; first test", target: "Suggested: 10", owner: "Marketing", launchDate: "2026-11-05", reviewDate: "2026-11-12", status: "DRAFT", result: "", decision: "UNDECIDED", learning: "", nextMove: "", tasks: [{ id: "11111111-1111-4111-8111-111111111111", title: "Landing page", channel: "WEBSITE", owner: "Marketing", due: "2026-11-05", status: "DONE", note: "Draft landing page copy" }] }
const receipt = (status: string, observed: boolean | null = null): CampaignDelivery[] => [{ task_id: brief.tasks[0]!.id, wordpress_change_id: "change", status, live_check: { observed } }]
describe("campaign preparation state machine", () => {
  it("does not trust human task completion, approval or publication as live delivery", () => {
    expect(campaignRunReport(brief, 1, 1, []).status).toBe("WAITING_FOR_REVIEW")
    expect(campaignRunReport(brief, 1, 1, receipt("PROPOSED")).status).toBe("WAITING_FOR_APPROVAL")
    expect(campaignRunReport(brief, 1, 1, receipt("PUBLISHED")).status).toBe("VERIFYING")
    expect(campaignRunReport(brief, 1, 1, receipt("PUBLISHED", false)).status).toBe("VERIFYING")
    expect(campaignRunReport(brief, 1, 1, receipt("PUBLISHED", true)).status).toBe("DELIVERY_OBSERVED")
  })
  it("surfaces rejected, failed and undone changes without retrying them", () => {
    for (const status of ["REJECTED", "FAILED", "UNDONE"]) expect(campaignRunReport(brief, 1, 1, receipt(status, true)).status).toBe("BLOCKED")
    expect(campaignRunReport(brief, 2, 1, receipt("PUBLISHED", true)).status).toBe("STALE")
  })
  it("requires concrete drafts and names unsupported channels as handoffs", () => {
    expect(campaignRunReport({ ...brief, tasks: [{ ...brief.tasks[0]!, note: "" }] }, 1, 1, []).tasks[0]!.state).toBe("NEEDS_DRAFT")
    const report = campaignRunReport({ ...brief, tasks: [{ ...brief.tasks[0]!, channel: "EMAIL" }] }, 1, 1, [])
    expect(report.status).toBe("BLOCKED")
    expect(report.tasks[0]!.state).toBe("HUMAN_HANDOFF")
    expect(report.limits.externalCalls).toBe(0)
  })
})
