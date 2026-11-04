import { renderToStaticMarkup } from "react-dom/server"
import { MemoryRouter } from "react-router"
import { describe, expect, it, vi } from "vitest"
import type { Campaign } from "@openrecord/contracts"
import { CampaignProgress, campaignAttention } from "../app/routes/campaign-progress"

vi.mock("@/components/campaign-runs", () => ({ CampaignRuns: () => <div>Preparation status</div> }))
const campaign = (): Campaign => ({ id: "campaign", revision: 2, updated_at: "2026-11-04", created_by_actor: "ASSISTANT", brief: {
  title: "Trial activation", goal: "More activated trials", audience: "New trials", offer: "Try the guide", message: "Get started", hypothesis: "A guide may help",
  metric: "Activated accounts", baseline: "", target: "", owner: "", launchDate: "", reviewDate: "", status: "DRAFT", tasks: [], result: "", decision: "UNDECIDED", learning: "", nextMove: "",
} })
describe("campaign progress view", () => {
  it("defaults to a read-only summary with conversation actions, not a form", () => {
    const html = renderToStaticMarkup(<MemoryRouter><CampaignProgress businessId="business" campaign={campaign()} /></MemoryRouter>)
    expect(html).toContain("More activated trials")
    expect(html).toContain("Edit details")
    expect(html).toContain("No results recorded yet. Campaign impact is unknown.")
    expect(html).toContain("No deliverables saved yet")
    expect(html).toContain("Review results with agent")
    expect(html).not.toMatch(/<input|<textarea|<select/)
  })
  it("does not present recorded completion as observed delivery", () => {
    const c = campaign()
    c.brief.tasks = [{ id: "task", title: "Email", channel: "EMAIL", owner: "", due: "", status: "DONE", note: "Draft email" }]
    const html = renderToStaticMarkup(<MemoryRouter><CampaignProgress businessId="business" campaign={c} /></MemoryRouter>)
    expect(html).toContain("Recorded done")
    expect(html).toContain("does not verify publication")
    expect(campaignAttention(c).label).toBe("Draft plan")
    c.brief.status = "ACTIVE"
    expect(campaignAttention(c).label).toBe("Recorded active")
  })
  it("prioritizes blockers over a recorded active stage", () => {
    const c = campaign()
    c.brief.status = "ACTIVE"
    c.brief.tasks = [{ id: "task", title: "Page", channel: "WEBSITE", owner: "", due: "", status: "BLOCKED", note: "No access" }]
    expect(campaignAttention(c).label).toBe("Blocked")
  })
})
