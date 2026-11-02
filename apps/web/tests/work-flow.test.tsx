import { renderToStaticMarkup } from "react-dom/server"
import { MemoryRouter, Route, Routes } from "react-router"
import { describe, expect, it, vi } from "vitest"
import { WorkPage } from "../app/routes/work"

vi.mock("@/lib/workspace", () => ({ useWorkspace: () => ({ activeBusiness: { name: "Example" } }) }))
vi.mock("@/lib/use-api", () => ({
  useApi: (key: string) => key.startsWith("growth-opps")
    ? { data: { opportunities: [
      { id: "active", title: "Active initiative", status: "APPROVED", proposedChange: "Improve a page", executions: [
        { id: "execution", type: "SOURCE_UPDATED", target: "Pricing", assurance: "SYSTEM_VERIFIED", performedAt: "2026-10-01T00:00:00Z" },
      ] },
      { id: "reviewed", title: "Reviewed initiative", status: "REVIEWED", executions: [] },
    ] }, loading: false, error: null }
    : { data: { proposals: [] }, loading: false, error: null },
}))

describe("work progress", () => {
  it("keeps an approved initiative under way after an action and names the verified claim", () => {
    const markup = renderToStaticMarkup(<MemoryRouter initialEntries={["/businesses/example/work"]}><Routes><Route path="/businesses/:id/work" element={<WorkPage />} /></Routes></MemoryRouter>)
    expect(markup.indexOf("Approved")).toBeLessThan(markup.indexOf("Active initiative"))
    expect(markup.indexOf("Active initiative")).toBeLessThan(markup.indexOf("Reviewed"))
    expect(markup).toContain("Pull request merged")
    expect(markup).not.toContain("Confirmed on the live site")
  })
})
