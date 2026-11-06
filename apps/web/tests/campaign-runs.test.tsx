import { renderToStaticMarkup } from "react-dom/server"
import { MemoryRouter } from "react-router"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Campaign } from "@openrecord/contracts"
import { CampaignDeliverables } from "../app/components/campaign-runs"

const fixture = vi.hoisted(() => ({ runs: [] as unknown[] }))
vi.mock("@/lib/use-api", () => ({ useApi: () => ({ data: { runs: fixture.runs }, loading: false, error: null, reload: vi.fn() }) }))
const campaign = (revision = 2): Campaign => ({ id: "campaign", revision, updated_at: "2026-11-04", brief: {
  title: "Trial activation", goal: "", audience: "", offer: "", message: "", hypothesis: "", metric: "", baseline: "", target: "", owner: "", launchDate: "", reviewDate: "",
  status: "ACTIVE", result: "", decision: "UNDECIDED", learning: "", nextMove: "",
  tasks: [{ id: "email", title: "Welcome email", channel: "EMAIL", owner: "", due: "", status: "DONE", note: "Draft saved" }],
} })
const render = (c = campaign()) => renderToStaticMarkup(<MemoryRouter><CampaignDeliverables businessId="business" campaign={c} /></MemoryRouter>)

describe("campaign deliverables", () => {
  beforeEach(() => { fixture.runs = [] })
  it("offers to start preparation through the agent without claiming a launch", () => {
    const html = render()
    expect(html).toContain("has not started preparing")
    expect(html).toContain("%2Fcampaign-run")
    expect(html).toContain("Recorded done")
    expect(html).toContain("Only &quot;Delivery observed&quot; means the agent checked it went out")
    expect(html).not.toContain("Stop preparation")
  })
  it("merges the current run's state, blockers and handoffs into each deliverable", () => {
    fixture.runs = [{ id: "run", campaignRevision: 2, status: "BLOCKED", missing: ["metric"], tasks: [{ taskId: "email", title: "Welcome email", state: "HUMAN_HANDOFF", nextMove: "Give the owner the draft; no delivery adapter is available." }] }]
    const html = render()
    expect(html).toContain("Needs attention")
    expect(html).toContain("(plan revision 2)")
    expect(html).toContain("Human handoff needed")
    expect(html).toContain("no delivery adapter is available")
    expect(html).toContain("The agent needs: metric.")
    expect(html).toContain("Stop preparation")
    expect(html).not.toContain("Delivery observed</span>")
  })
  it("does not apply an older plan's run states to the current deliverables", () => {
    fixture.runs = [{ id: "run", campaignRevision: 1, status: "STALE", missing: [], tasks: [{ taskId: "email", title: "Welcome email", state: "DELIVERY_OBSERVED", nextMove: "Observed" }] }]
    const html = render()
    expect(html).toContain("Plan changed, prepare again")
    expect(html).toContain("belongs to an older version of the plan")
    expect(html).not.toContain(">Delivery observed<")
  })
  it("does not offer a second stop action on a cancelled run", () => {
    fixture.runs = [{ id: "run", campaignRevision: 2, status: "CANCELLED", missing: [], tasks: [] }]
    const html = render()
    expect(html).toContain("Preparation stopped")
    expect(html).toContain("not cancelled or undone")
    expect(html).not.toContain("Stop preparation")
  })
})
