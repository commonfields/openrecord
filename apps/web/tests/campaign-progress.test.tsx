import { renderToStaticMarkup } from "react-dom/server"
import { MemoryRouter } from "react-router"
import { describe, expect, it, vi } from "vitest"
import type { Campaign } from "@openrecord/contracts"
import { CampaignProgress } from "../app/routes/campaign-progress"
import { campaignAttention, deliverableSummary } from "../app/lib/campaigns"

vi.mock("@/components/campaign-runs", () => ({ CampaignDeliverables: () => <div>Deliverables list</div> }))
const campaign = (): Campaign => ({ id: "campaign", revision: 2, updated_at: "2026-11-04", created_by_actor: "ASSISTANT", brief: {
  title: "Trial activation", goal: "More activated trials", audience: "New trials", offer: "Try the guide", message: "Get started", hypothesis: "A guide may help",
  metric: "Activated accounts", baseline: "", target: "", owner: "", launchDate: "", reviewDate: "", status: "DRAFT", tasks: [], result: "", decision: "UNDECIDED", learning: "", nextMove: "",
} })
const render = (c: Campaign) => renderToStaticMarkup(<MemoryRouter><CampaignProgress businessId="business" campaign={c} /></MemoryRouter>)

describe("campaign progress view", () => {
  it("shows stage, next step, plan and results without a form", () => {
    const html = render(campaign())
    for (const stage of ["Plan", "Do the work", "Check results", "Decide"]) expect(html).toContain(stage)
    expect(html).toContain("Next step")
    expect(html).toContain("More activated trials")
    expect(html).toContain("Edit details")
    expect(html).toContain("No results recorded yet. Impact is unknown.")
    expect(html).toContain("Review results with agent")
    expect(html).toContain("Deliverables list")
    expect(html).not.toMatch(/<input|<textarea|<select|<details/)
    expect(html).not.toContain("·")
  })
  it("does not present a recorded stage as observed delivery", () => {
    const c = campaign()
    c.brief.tasks = [{ id: "task", title: "Email", channel: "EMAIL", owner: "", due: "", status: "DONE", note: "Draft email" }]
    expect(campaignAttention(c).label).toBe("Planning")
    expect(deliverableSummary(c)).toBe("1 of 1 deliverable recorded done")
    c.brief.status = "ACTIVE"
    expect(campaignAttention(c).label).toBe("Doing the work")
    expect(render(c)).toContain("is not proof the campaign caused it")
  })
  it("prioritizes blockers over a recorded active stage", () => {
    const c = campaign()
    c.brief.status = "ACTIVE"
    c.brief.tasks = [{ id: "task", title: "Page", channel: "WEBSITE", owner: "", due: "", status: "BLOCKED", note: "No access" }]
    expect(campaignAttention(c).label).toBe("Blocked")
    expect(render(c)).toContain("Blocked")
  })
  it("keeps distribution details folded and never implies spend, scheduling or verified tracking", () => {
    const c = campaign()
    c.brief = { ...c.brief, distribution: { primaryChannel: "Email to consenting trial users", rationale: "Start with existing demand", motion: "OWNED", funnelStage: "ACTIVATION",
      destination: "Onboarding booking page", cadence: "One welcome email", budget: "Suggested: no paid spend", trackingPlan: "Tagged links and CRM booking event", conversionEvent: "Qualified booking" } }
    const html = render(c)
    expect(html).toContain("Email to consenting trial users")
    expect(html).toContain("More plan details")
    // Folded by default: the budget and tracking notes are not rendered until opened.
    expect(html).not.toContain("Suggested: no paid spend")
    expect(html).not.toMatch(/<input|<textarea|<select|<details/)
  })
})
