import { renderToStaticMarkup } from "react-dom/server"
import { MemoryRouter } from "react-router"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { CampaignRuns } from "../app/components/campaign-runs"

const fixture = vi.hoisted(() => ({ runs: [] as unknown[] }))
vi.mock("@/lib/use-api", () => ({ useApi: () => ({ data: { runs: fixture.runs }, loading: false, error: null, reload: vi.fn() }) }))
const render = () => renderToStaticMarkup(<MemoryRouter><CampaignRuns businessId="business" campaignId="campaign" /></MemoryRouter>)
describe("campaign run visibility", () => {
  beforeEach(() => { fixture.runs = [] })
  it("offers conversation-first run preparation without claiming a launch", () => {
    const html = render()
    expect(html).toContain("No run yet")
    expect(html).toContain("Continue with the agent")
    expect(html).toContain("%2Fcampaign-run")
    expect(html).not.toContain("Stop internal run")
  })
  it("shows concrete blockers and handoffs rather than successful execution", () => {
    fixture.runs = [{ id: "run", campaignRevision: 2, status: "BLOCKED", missing: ["metric"], tasks: [{ taskId: "email", title: "Welcome email", state: "HUMAN_HANDOFF", nextMove: "Give the owner the draft; no delivery adapter is available." }] }]
    const html = render()
    expect(html).toContain("blocked · brief revision 2")
    expect(html).toContain("human handoff")
    expect(html).toContain("Missing planning context: metric")
    expect(html).toContain("Stop internal run")
  })
  it("does not offer a second stop action on a cancelled run", () => {
    fixture.runs = [{ id: "run", campaignRevision: 1, status: "CANCELLED", missing: [], tasks: [] }]
    const html = render()
    expect(html).toContain("cancelled · brief revision 1")
    expect(html).not.toContain("Stop internal run")
  })
})
