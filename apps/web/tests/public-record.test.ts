import { describe, expect, it } from "vitest"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { PublicRecordView } from "../app/routes/public-record"
import type { PublicAnswer, PublicRecord } from "../app/lib/record"
import { safeRecordUrl } from "../app/lib/record"
import { SearchSuggestions } from "../app/components/search-suggestions"

// The client-facing record, rendered without a browser from a TEST
// projection: exact raw evidence, human labels, visible INDETERMINATE
// reasons and the causality disclosure; no score, no workspace chrome.

const DISCLOSURE = "This shows what OpenRecord observed before and after the change. It does not prove that the edit caused the model's new answer."
const answered = (answer: string, decision: "MATCHES" | "CONTRADICTS" | "UNKNOWN", observed = true): PublicAnswer => ({
  status: "ANSWERED", checkedAt: "2026-10-08T10:00:00.000Z", surface: "Gemini API", model: "gemini-2.5-flash",
  question: "Is breakfast included at TEST Acme Hotel?", fact: { label: "Breakfast included", value: "Yes" },
  searchSuggestionsHtml: null,
  retrieval: { requested: true, observed, tool: observed ? "Google Search grounding" : null }, syntheticFixture: false, answer,
  citations: [{ url: "https://old-listing.test/acme", title: "old-listing.test" }], evidenceDigest: "a".repeat(64),
  judgment: { decision, label: decision === "MATCHES" ? "Matches the approved fact" : decision === "CONTRADICTS" ? "Contradicts the approved fact" : "Unknown — the answer could not be judged against the approved fact", reviewedAt: "2026-10-08T12:00:00.000Z", reviewedBy: "Reviewed by the agency" },
})
const summaryOf = (answers: PublicAnswer[]) => {
  const reviewed = answers.filter(a => a.status === "ANSWERED")
  const contradict = reviewed.filter(a => a.judgment.decision === "CONTRADICTS").length
  const matches = reviewed.filter(a => a.judgment.decision === "MATCHES").length
  const unknown = reviewed.filter(a => a.judgment.decision === "UNKNOWN").length
  return { total: answers.length, reviewed: reviewed.length, contradict, matches, unknown, statement: `${contradict} contradicted, ${matches} matched.` }
}
const record: PublicRecord = {
  client: { name: "TEST Acme Hotel", website: "https://acme-hotel.test/" },
  checkedBy: "OpenRecord", fixture: true, lastCheckedAt: "2026-10-15T10:00:00.000Z",
  surface: { name: "Gemini API", model: "gemini-2.5-flash", retrievalTool: "Google Search grounding" },
  disclosure: DISCLOSURE,
  facts: [
    { position: 1, fact: { label: "Breakfast included", subject: "TEST Acme Hotel", value: "Yes", source: "https://acme-hotel.test/rooms", approvedAt: "2026-10-01T00:00:00.000Z" },
      question: "Is breakfast included at TEST Acme Hotel?",
      samples: [answered("Yes — breakfast is included.", "MATCHES")], summary: summaryOf([answered("Yes — breakfast is included.", "MATCHES")]), pendingActions: [],
      comparison: { before: { samples: [answered("Breakfast is available for an additional €20 <script>alert(1)</script>", "CONTRADICTS")],
          summary: summaryOf([answered("x", "CONTRADICTS")]) },
        actions: [{ performedAt: "2026-10-10T12:00:00.000Z", note: "Agency updated /rooms on 10 Oct.", links: ["https://acme-hotel.test/rooms"] }],
        after: { samples: [answered("Yes — breakfast is included.", "MATCHES")], summary: summaryOf([answered("x", "MATCHES")]) },
        outcome: "OBSERVED_CORRECTED",
        explanation: "Observed corrected. The earlier answers contradicted the approved fact; the later answers match it." } },
    { position: 2, fact: { label: "Check-in time", subject: "TEST Acme Hotel", value: "3:00 PM", source: null, approvedAt: "2026-10-01T00:00:00.000Z" },
      question: "What time is check-in at TEST Acme Hotel?",
      samples: [answered("Check-in is at 3 PM.", "MATCHES", false)], summary: summaryOf([answered("x", "MATCHES")]), pendingActions: [],
      comparison: { before: { samples: [answered("Check-in is at noon.", "CONTRADICTS")], summary: summaryOf([answered("x", "CONTRADICTS")]) },
        actions: [], after: { samples: [answered("Check-in is at 3 PM.", "MATCHES", false)], summary: summaryOf([answered("x", "MATCHES")]) },
        outcome: "INDETERMINATE",
        explanation: "Indeterminate — this answer did not use live web retrieval." } },
    { position: 3, fact: { label: "Airport shuttle", subject: "TEST Acme Hotel", value: "Yes", source: null, approvedAt: "2026-10-01T00:00:00.000Z" },
      question: "Does TEST Acme Hotel have an airport shuttle?",
      samples: [answered("It is unclear.", "UNKNOWN")], summary: summaryOf([answered("x", "UNKNOWN")]), comparison: null, pendingActions: [] },
  ],
}

describe("public client record", () => {
  it("isolates provider suggestion HTML without scripts or parent-origin access", () => {
    const widget = renderToStaticMarkup(createElement(SearchSuggestions, { html: '<div>TEST suggestion</div><script>parent.document.body.textContent="unsafe"</script>' }))
    expect(widget).toContain('sandbox="allow-popups allow-popups-to-escape-sandbox"')
    expect(widget).toContain('referrerPolicy="no-referrer"')
    expect(widget).toContain("Content-Security-Policy")
    expect(widget).not.toContain("allow-scripts")
    expect(widget).not.toContain("allow-same-origin")
    expect(widget).not.toContain("<script>")
    expect(renderToStaticMarkup(createElement(SearchSuggestions, { html: null }))).toBe("")
  })
  it("rejects unsafe citation schemes and embedded credentials in operator links", () => {
    for (const url of ["javascript:alert(1)", "data:text/html,hi", "https://secret:credential@source.test/"]) expect(safeRecordUrl(url)).toBeNull()
    expect(safeRecordUrl("https://source.test/page")).toBe("https://source.test/page")
  })
  const html = renderToStaticMarkup(createElement(PublicRecordView, { record }))
  it("shows the header, the surface and the visible causality disclosure", () => {
    expect(html).toContain("TEST Acme Hotel")
    expect(html).toContain("Checked by OpenRecord")
    expect(html).toContain("Last checked 15 Oct 2026")
    expect(html).toContain("Observed AI surface: Gemini API (gemini-2.5-flash) with Google Search grounding")
    expect(html).toContain(DISCLOSURE.replace("'", "&#x27;"))
    expect(html).toContain("Test fixture — not a real business record.")
  })
  it("shows exact raw answers, sources, human judgments, the action and the outcome", () => {
    expect(html).toContain("Breakfast is available for an additional €20 &lt;script&gt;alert(1)&lt;/script&gt;")
    expect(html).not.toContain("<script>")
    expect(html).toContain('href="https://old-listing.test/acme" target="_blank" rel="noreferrer noopener"')
    expect(html).toContain("CONTRADICTS")
    expect(html).toContain("MATCHES")
    expect(html).toContain("UNKNOWN")
    expect(html).toContain("Reviewed by the agency")
    expect(html).toContain("Agency updated /rooms on 10 Oct.")
    expect(html).toContain("Observed corrected")
    expect(html).toContain("Is breakfast included at TEST Acme Hotel?")
  })
  it("keeps INDETERMINATE and missing retrieval visible", () => {
    expect(html).toContain("Indeterminate")
    expect(html).toContain("Indeterminate — this answer did not use live web retrieval.")
    expect(html).toContain("Requested, but this answer did not use it")
  })
  it("has no score, chart, navigation or account controls", () => {
    expect(html).not.toMatch(/score|percent|%|<nav|sign out|dashboard/i)
  })
})

describe("record product copy", () => {
  it("never claims causation or a score outside the disclosure", async () => {
    const fs = await import("node:fs")
    for (const file of ["../app/routes/public-record.tsx", "../app/routes/client.tsx", "../app/routes/clients.tsx"]) {
      const text = fs.readFileSync(new URL(file, import.meta.url), "utf8")
      expect(text, file).not.toMatch(/\bscore\b|visibility score|caused by|thanks to our|igris/i)
    }
  })
})
