import { describe, expect, it } from "vitest"
import { decodeLabPerformance } from "./agent-performance-tools.js"

const result = (audits: unknown) => ({ lighthouseResult: { fetchTime: "2026-10-29T01:00:00Z", lighthouseVersion: "12.0", finalUrl: "https://example.test/page?temporary=hidden", audits } })
describe("PageSpeed lab evidence", () => {
  it("keeps numeric lab evidence distinct from missing metrics and field data", () => {
    const decoded = decodeLabPerformance(result({ "largest-contentful-paint": { numericValue: 2000 }, "cumulative-layout-shift": { numericValue: 0 } }))
    expect(decoded?.metrics.find(m => m.id === "largest-contentful-paint")).toMatchObject({ value: 2000, unit: "ms" })
    expect(decoded?.metrics.find(m => m.id === "cumulative-layout-shift")?.value).toBe(0)
    expect(decoded?.metrics.find(m => m.id === "total-blocking-time")?.value).toBeNull()
    expect(decoded?.finalUrl).toBe("https://example.test/page")
    expect(JSON.stringify(decoded)).not.toContain("hidden")
  })
  it("refuses provider errors, invalid measurements and empty results", () => {
    expect(decodeLabPerformance({})).toBeNull()
    expect(decodeLabPerformance(result({}))).toBeNull()
    expect(decodeLabPerformance(result({ "largest-contentful-paint": { numericValue: -1 } }))).toBeNull()
    expect(decodeLabPerformance({ lighthouseResult: { ...result({}).lighthouseResult, runtimeError: { code: "FAILED" } } })).toBeNull()
  })
})
