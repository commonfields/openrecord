import { renderToStaticMarkup } from "react-dom/server"
import { MemoryRouter } from "react-router"
import { describe, expect, it, vi } from "vitest"
import type { OverviewData } from "../app/components/today-overview"
import { GoalProgress } from "../app/components/goal-progress"
import { FunnelMeasurement, GoalEvents, RealtimeAvailability } from "../app/components/measurement-views"
import { OVERVIEW_SECTIONS, overviewPath, overviewSection } from "../app/lib/overview-navigation"

vi.mock("@/lib/use-api", () => ({ useApi: (key: string) => ({ data: key === "decisions" ? { items: [
  { type: "REQUEST_CHECK", business: { id: "other" }, createdAt: "2026-11-01" },
] } : { campaigns: [] }, loading: false, error: null, reload: vi.fn() }) }))
vi.mock("@/components/charts", () => ({ AreaTrendChart: () => <div>Daily history</div> }))
const data = (patch: Partial<OverviewData> = {}): OverviewData => ({
  issues: [], representations: [], activeFacts: 0, search: null, profile: null, opportunities: [], series: null,
  errors: { growth: null, series: null, opportunities: null },
  loading: { issues: false, representations: false, search: false, growth: false }, ...patch,
})
const render = (element: React.ReactNode) => renderToStaticMarkup(<MemoryRouter>{element}</MemoryRouter>)

describe("overview redesign", () => {
  it("gives each analytics section a stable URL and falls back to summary", () => {
    expect(OVERVIEW_SECTIONS.map(s => s.key)).toEqual(["summary", "performance", "revenue", "funnel", "events", "realtime", "answers"])
    expect(overviewPath("business", "summary")).toBe("/businesses/business/results")
    expect(overviewPath("business", "revenue")).toBe("/businesses/business/results/revenue")
    expect(overviewSection("unknown").key).toBe("summary")
  })
  it("does not present unknown goal or work data as a successful empty read", () => {
    const html = render(<GoalProgress businessId="business" days={30} data={data({ errors: { growth: new Error("offline"), series: null, opportunities: new Error("offline") } })} />)
    expect(html).toContain("Your saved goal could not load")
    expect(html).toContain("Work status is unavailable")
    expect(html).not.toContain("No goal set yet")
    expect(html).not.toContain("Nothing under way yet")
  })
  it("scopes the approval summary to this business", () => {
    const html = render(<GoalProgress businessId="business" days={30} data={data()} />)
    expect(html).toContain("Nothing needs you right now")
    expect(html).not.toContain("Review 1 item")
  })
  it("explains the funnel measurement gap without fabricated conversion rates", () => {
    const html = render(<FunnelMeasurement businessId="business" data={data()} />)
    expect(html).toContain("drop-off rates are not available yet")
    expect(html).toContain("not added together")
    expect(html).toContain("No goal event has been defined")
    expect(html).not.toContain("0%")
  })
  it("separates recorded daily goal data from raw events and live visitors", () => {
    const events = render(<GoalEvents businessId="business" data={data()} days={30} formatDate={date => date} />)
    expect(events).toContain("No goal event configured")
    expect(events).toContain("Missing days are not zero")
    const realtime = render(<RealtimeAvailability businessId="business" />)
    expect(realtime).toContain("Live visitor tracking is not available yet")
    expect(realtime).toContain("no active-user count to display")
    expect(realtime).not.toContain("0 active")
  })
})
