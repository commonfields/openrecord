import { renderToStaticMarkup } from "react-dom/server"
import { MemoryRouter } from "react-router"
import { describe, expect, it } from "vitest"
import type { Report } from "@/lib/acquisition"
import { DiscoverySummary } from "@/components/discovery-overview"

const report = (values: Partial<Report> = {}): Report => ({ periods: [], referrals: { provided: false, imports: [], syntheticExcluded: 0 }, limitations: [], ...values } as Report)
const render = (value: Report) => renderToStaticMarkup(<MemoryRouter><DiscoverySummary businessId="business" report={value} /></MemoryRouter>)

describe("AI discovery overview", () => {
  it("does not turn missing evidence into zero", () => {
    const markup = render(report())
    expect(markup).toContain("AI answer discovery: not measured yet")
    expect(markup).toContain("website sessions and signups: not measured")
  })

  it("separates reviewed sample evidence from imported visits and their limitations", () => {
    const value = report({
      periods: [{ batchId: "batch", scope: "SMOKE", surface: "Example model", collectedFrom: "2026-01-01", collectedTo: "2026-01-02", metrics: { reviewed: { n: 1, d: 2 }, mentionRate: { n: 1, d: 1 }, ownedCitationRate: { n: 1, d: 2 }, failed: 1 } } as Report["periods"][number]],
      referrals: { provided: true, syntheticExcluded: 0, imports: [{ id: "ref", importedAt: "2026-01-03", dateStart: "2026-01-01", dateEnd: "2026-01-02", aiSessions: 2, totalSessions: 12, signups: "SIGNUPS_NOT_MEASURED" } as Report["referrals"]["imports"][number]] },
      limitations: ["Fixture periods contain test fixtures."],
    })
    const markup = render(value)
    expect(markup).toContain("Fixture periods contain test fixtures")
    expect(markup).toContain("1 of 2 successful samples")
    expect(markup).toContain("2 of 12 sessions")
    expect(markup).toContain("Signups not measured")
    expect(markup).toContain("does not show that a sampled AI answer caused")
  })
})
