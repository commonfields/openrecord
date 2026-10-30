import { describe, expect, it } from "vitest"
import { assessPage } from "../src/page-assessment.js"

describe("single-page assessment", () => {
  it("reports observed content and conversion elements without form values or authority claims", () => {
    const report = assessPage({ url: "https://example.test/pricing", headers: { "x-robots-tag": "noindex" }, html: `
      <html><head><title>Pricing</title><meta name="author" content="Declared author"></head><body><main>
      <h1>Pricing for teams</h1><p>Choose the plan that fits.</p><a href="/demo">Book a demo</a>
      <form><input type="hidden" value="private-value"><button>Request details</button></form>
      <a href="mailto:hello@example.test">Email</a></main></body></html>` })
    expect(report.links.examples).toContainEqual({ label: "Book a demo", url: "https://example.test/demo", location: "MAIN_CONTENT" })
    expect(report.conversion).toEqual({ forms: 1, buttons: ["Request details"], contactLinks: 1 })
    expect(report.checks.some(c => c.code === "NOINDEX")).toBe(true)
    expect(JSON.stringify(report)).not.toContain("private-value")
    expect(report.limitations.join(" ")).toContain("not verified expertise")
  })

  it("does not treat a short page as poor quality or follow untrusted links", () => {
    const report = assessPage({ url: "https://example.test/", headers: {}, html: '<main><h1>Contact</h1><p>Call us.</p><a href="javascript:alert(1)">Bad</a><a href="https://user:password@example.test/">Credentials</a></main>' })
    expect(report.content.words).toBeGreaterThan(0)
    expect(report.links.examples).toEqual([])
    expect(report.checks.some(c => /THIN|WORD_COUNT/.test(c.code))).toBe(false)
    expect(report.limitations.join(" ")).toContain("not followed")
  })
})
