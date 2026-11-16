import { describe, expect, it } from "vitest"
import { claimsOf, linksOf, staticFindings } from "./deliverable-checks.js"

const codes = (f: ReadonlyArray<{ code: string; severity: string }>) => f.map(x => `${x.severity}:${x.code}`).sort()

describe("pre-launch checks on a campaign page", () => {
  it("passes a clean page with a heading, described images, full links and backed claims", () => {
    const html = '<h1>Moderate content in one call</h1><img src="https://cdn.test/a.png" alt="Dashboard"><p>Supports 40 languages.</p><a href="https://moderationapi.com/pricing">Pricing</a><a href="#demo">Book</a>'
    expect(staticFindings("HTML", html, ["languages: 40 languages supported"], true)).toEqual([])
  })
  it("blocks what breaks on a hosted page: relative links, its own form, empty links, placeholders", () => {
    const html = '<h1>Hi [Company]</h1><a href="/pricing">Pricing</a><a href="">x</a><form action="/x"></form>'
    expect(codes(staticFindings("HTML", html, [], true))).toEqual(["BLOCKING:EMPTY_LINK", "BLOCKING:FORM_CANNOT_SUBMIT", "BLOCKING:PLACEHOLDER", "BLOCKING:RELATIVE_LINK"])
    // On the business's own site a relative link and a form are normal.
    expect(codes(staticFindings("HTML", '<h1>Hi</h1><a href="/pricing">Pricing</a><form></form>', [], false))).toEqual([])
  })
  it("warns about unbacked numbers and absolutes, missing headings, image text and scripts", () => {
    const html = '<p>Trusted by 500 teams. The fastest moderation API. Supports 40 languages.</p><img src="https://cdn.test/a.png"><script>x()</script>'
    const found = staticFindings("HTML", html, ["languages: 40 languages"], true)
    expect(codes(found)).toEqual(["WARNING:IMAGE_WITHOUT_TEXT", "WARNING:NO_MAIN_HEADING", "WARNING:SCRIPT_WILL_NOT_RUN", "WARNING:UNSUPPORTED_CLAIM", "WARNING:UNSUPPORTED_CLAIM"])
    expect(found.filter(f => f.code === "UNSUPPORTED_CLAIM").map(f => f.message).join(" ")).not.toContain("40 languages")
  })
  it("never backs an absolute claim with a fact, since it states no number", () => {
    expect(claimsOf("We guarantee accuracy.", ["accuracy: we guarantee accuracy"])).toEqual([{ sentence: "We guarantee accuracy.", backed: false }])
  })
  it("reads links from Markdown too", () => {
    expect(linksOf("MARKDOWN", "See [pricing](https://x.test/p) and [docs](/docs \"Docs\").")).toEqual(["https://x.test/p", "/docs"])
  })
  it("writes its messages as sentences without dot separators", () => {
    const all = staticFindings("HTML", '<p>Best [TODO]</p><a href="/x">x</a><img src="a"><form></form><script></script>', [], true)
    expect(all.every(f => !f.message.includes("·") && /[.!?]$/.test(f.message))).toBe(true)
  })
})
