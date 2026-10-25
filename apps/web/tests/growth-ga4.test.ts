// W8: the Google Analytics panel and report wording say what is known (who
// allowed read access, what Google reported, when) and never more.
import { describe, expect, it } from "vitest"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { GA4_SYNC_ERROR_CODES, type Ga4BindingHealth } from "@openrecord/contracts"
import { Ga4Health } from "../app/components/growth-ga4"
import { GA4_CALLBACK_COPY, GA4_CONNECTION_COPY, GA4_FRESHNESS_COPY, GA4_SYNC_ERROR_COPY, ga4CoverageLine, ga4Error } from "../app/lib/growth-ga4"
import { REPORT_LIMITATIONS, REPORT_PROVIDER_LIMITATION, reportLimitations, reportSourceLabel } from "../app/lib/growth-report"
import { ApiError } from "../app/lib/api"

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const health = (over: Partial<Ga4BindingHealth> = {}): Ga4BindingHealth => ({
  binding: { id: id(1), businessId: id(2), connectionId: id(3), property: "properties/111111", propertyDisplayName: "TEST Salon site", propertyTimeZone: "Asia/Makassar",
    metricDefinitionId: id(4), metricDefinitionVersion: 1, eventName: "book_appointment", providerMetric: "keyEvents", keyEventCountingMethod: "ONCE_PER_EVENT", createdByUserId: id(5), createdAt: "2026-10-01T00:00:00.000Z" },
  connectionStatus: "ACTIVE", connectionEmail: "agency@example.test", freshness: "FRESH", lastSuccessfulSyncAt: "2026-10-21T01:00:00.000Z", lastAttemptAt: "2026-10-21T01:00:00.000Z",
  lastErrorCode: null, openJob: null, latestCompleteDay: "2026-10-21",
  coverage: { start: "2026-09-24", end: "2026-10-21", days: 28, reported: 25, missing: 2, unavailable: 1, conflicting: 0, revised: 3 },
  recentJobs: [], recentRuns: [], ...over,
})
const render = (h: Ga4BindingHealth) => renderToStaticMarkup(createElement(Ga4Health, { health: h }))

describe("Google Analytics panel", () => {
  it("states the property, key event, identity, freshness and coverage without claiming ownership or impact", () => {
    const html = render(health())
    expect(html).toContain("TEST Salon site")
    expect(html).toContain("book_appointment")
    expect(html).toContain("agency@example.test")
    expect(html).toContain("Up to date")
    expect(html).toContain("2 missing (Google reported no figure; not counted as zero)")
    expect(html).toContain("3 revised by Google since first collected")
    // "Last successful synchronization" describes the sync, so only outcome claims are refused here.
    expect(html.replace("Last successful synchronization", "")).not.toMatch(/\bowns?\b|owner of|improv|success|caused|lift|attribut/i)
  })
  it("explains a stopped connection and a failed attempt in plain language", () => {
    const html = render(health({ connectionStatus: "REAUTHORIZATION_REQUIRED", freshness: "STALE", lastErrorCode: "AUTHORIZATION_REVOKED" }))
    expect(html).toContain("Needs reconnecting")
    expect(html).toContain("Figures already collected are kept")
    expect(html).toContain(GA4_FRESHNESS_COPY.STALE)
    expect(html).toContain("Reconnect Google Analytics")
  })
  it("has words for every sync error code, connection state and callback status", () => {
    for (const code of GA4_SYNC_ERROR_CODES) expect(GA4_SYNC_ERROR_COPY[code], code).toBeTruthy()
    for (const c of Object.values(GA4_CONNECTION_COPY)) expect(c.detail).not.toMatch(/owns|owner/i)
    expect(GA4_CALLBACK_COPY["connected"]!.text).toContain("read-only")
    for (const status of ["consent_denied", "scope_refused", "state_invalid", "state_expired", "state_reused", "identity_mismatch"]) expect(GA4_CALLBACK_COPY[status]!.ok).toBe(false)
    expect(ga4Error(new ApiError(409, { _tag: "GrowthGa4Refused", reason: "PropertyNotAccessible" }))).toContain("cannot read that property")
    expect(ga4CoverageLine(health({ coverage: { start: "a", end: "b", days: 3, reported: 3, missing: 0, unavailable: 0, conflicting: 0, revised: 0 } }))).toBe("a to b: 3 of 3 days reported.")
  })
})

describe("report wording for authenticated measurement", () => {
  it("keeps the operator-export limitation for uploaded files and replaces it only when Google Analytics was read", () => {
    expect(reportLimitations([{ provenance: "OPERATOR_SUPPLIED_EXPORT" }])).toEqual(REPORT_LIMITATIONS)
    const mixed = reportLimitations([{ provenance: "OPERATOR_SUPPLIED_EXPORT" }, { provenance: "AUTHENTICATED_PROVIDER_API" }])
    expect(mixed).toHaveLength(REPORT_LIMITATIONS.length)
    expect(mixed[mixed.length - 1]).toBe(REPORT_PROVIDER_LIMITATION)
    expect(REPORT_PROVIDER_LIMITATION).toContain("keeps the figures as they were when it was published")
  })
  it("labels each data import by where it came from", () => {
    expect(reportSourceLabel({ provenance: "SYNTHETIC_FIXTURE" })).toBe("sample data")
    expect(reportSourceLabel({ provenance: "OPERATOR_SUPPLIED_EXPORT" })).toBe("operator-supplied")
    expect(reportSourceLabel({ provenance: "AUTHENTICATED_PROVIDER_API", observation: { property: "properties/1", eventName: "sign_up", collectedAt: "2026-10-21T01:00:00.000Z" } }))
      .toBe("read from Google Analytics (properties/1, key event sign_up, collected 2026-10-21T01:00:00.000Z)")
  })
})
