import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { AccountActionCard } from "../app/components/account-action"
import type { AccountAction } from "../app/lib/api"

const action: AccountAction = {
  id: "action", provider: "google_ads", kind: "CREATE_SEARCH_AD", status: "PROPOSED", proposedBy: "ASSISTANT",
  target: { campaignName: "Bookings", adGroupName: "Haircuts" }, before: {},
  after: { headlines: ["Book a haircut"], descriptions: ["An approved description"], finalUrl: "https://salon.test/book", path1: "book", path2: "now", status: "PAUSED" },
  rationale: "A booking-led experiment", failure: null, result: null, createdAt: "2026-11-06T00:00:00Z", decidedAt: null,
}
const render = (patch: Partial<AccountAction> = {}) => renderToStaticMarkup(<AccountActionCard businessId="business" action={{ ...action, ...patch }} />)
describe("approval-gated account actions", () => {
  it("shows the complete ad and its paused state before approval", () => {
    const html = render()
    for (const text of ["Book a haircut", "An approved description", "https://salon.test/book", "book/now", "Created paused", "Approve and apply", "Reject"]) expect(html).toContain(text)
    expect(html).not.toContain(">Undo<")
  })
  it.each(["EXECUTING", "UNDOING", "FAILED", "UNDONE"] as const)("does not offer execution retries for %s", status => {
    const html = render({ status, failure: status === "FAILED" ? "ProviderUnavailable" : null })
    expect(html).not.toContain("Approve and apply")
    expect(html).not.toContain(">Undo<")
    if (status === "FAILED") expect(html).toContain("outcome may be unknown")
  })
  it("offers undo only on a verified completed action", () => {
    expect(render({ status: "DONE" })).toContain("Undo")
  })
})
