import { describe, expect, it } from "vitest"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { MemoryRouter } from "react-router"
import { DiscoveryReportView } from "../app/routes/client-discovery-report"
import { CitationSources } from "../app/routes/client-discovery"
import { citationSourceCsv, parseCompetitors, type Batch, type Metrics, type Report } from "../app/lib/acquisition"

// The AI Discovery agency report, rendered without a browser from a TEST
// projection: denominators on every count, the measured surface named, each
// period on its own, referral evidence separate, and SIGNUPS_NOT_MEASURED
// when no conversion event is configured.

const metrics: Metrics = {
  planned: 10, providerAttempts: 12, succeeded: 9, failed: 1, pending: 0, failures: [{ failureClass: "PROVIDER_UNAVAILABLE", count: 1 }],
  eligible: 9, syntheticExcluded: 0, groundingObserved: { n: 8, d: 9 }, reviewed: { n: 7, d: 9 }, candidateSamples: { n: 6, d: 9 },
  mentionRate: { n: 5, d: 9 }, recommendationRate: { n: 3, d: 7 },
  breakdown: { recommended: 3, mentionedNotRecommended: 1, advisedAgainst: 1, recommendationUnclear: 0, notMentioned: 2, mentionUnclear: 0 },
  ownedCitationRate: { n: 2, d: 9 }, competitors: [{ name: "HelpHub", samples: { n: 7, d: 9 } }],
  questions: [{ key: "CD-01", group: "CATEGORY_DISCOVERY", prompt: "What are good TEST support agents?", planned: 5, failed: 0, eligible: 5, reviewed: 5,
    mentioned: 4, recommended: 3, ownedCited: 1, statement: "Recommended in 3 of 5 reviewed samples" }],
  questionsRecommended: { n: 1, d: 2 }, groups: [{ group: "CATEGORY_DISCOVERY", questions: 1, reviewed: 5, recommended: 3 }],
}
const report: Report = {
  question: "How often did the measured AI surface mention or recommend this business?",
  business: { name: "TEST Supportly", websiteUrl: "https://supportly.test/" },
  category: "TEST customer support agents", basis: "PUBLIC_RESEARCH",
  questionSet: { version: 1, specDigest: "a".repeat(64), questions: 30, createdAt: "2026-10-01T00:00:00.000Z" },
  ownedDomains: ["supportly.test"], competitors: ["HelpHub"],
  periods: [{ batchId: "b1", scope: "FULL", setVersion: 1, surface: "Gemini API with Google Search grounding (gemini-3.5-flash-lite)", sampleCount: 5,
    collectedFrom: "2026-10-02T00:00:00.000Z", collectedTo: "2026-10-02T01:00:00.000Z", metrics,
    representative: [{ questionKey: "CD-01", prompt: "What are good TEST support agents?", sample: 1, collectedAt: "2026-10-02T00:00:00.000Z",
      answerText: "1. **Supportly** handles email.\n2. HelpHub suits large teams.", mention: "MENTIONED", recommendation: "RECOMMENDED",
      observationId: "11111111-1111-4111-8111-111111111111", rawDigest: "b".repeat(64), ownedCitations: ["supportly.test"] }] }],
  configurationChanged: [],
  referrals: { provided: true, syntheticExcluded: 1, imports: [{ id: "i1", synthetic: false, propertyRef: "TEST-property", dateStart: "2026-09-01", dateEnd: "2026-09-30",
    timeZone: "UTC", attributionBasis: "SESSION_SOURCE_MEDIUM", conversionEvent: null, rawDigest: "c".repeat(64), importedAt: "2026-10-01T00:00:00.000Z",
    totalSessions: 120, aiSessions: 6, bySource: [{ assistant: "ChatGPT", sources: ["chatgpt.com / referral"], sessions: 6, conversions: null }], signups: "SIGNUPS_NOT_MEASURED" }] },
  limitations: ["Measured surface: Gemini API with Google Search grounding (gemini-3.5-flash-lite). These answers describe that surface only; they do not measure ChatGPT, Claude, Perplexity or any other assistant."],
  detectorVersion: "acq-exact-alias-v1", aiSourcesVersion: "ai-sources-v1",
}

describe("AI Discovery agency report", () => {
  const html = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(DiscoveryReportView, { report })))
  it("answers the report question with denominators on every count", () => {
    expect(html).toContain("How often did the measured AI surface mention or recommend this business?")
    expect(html).toContain("5 of 9")
    expect(html).toContain("3 of 7")
    expect(html).toContain("2 of 9")
    expect(html).toContain("7 of 9")
    expect(html).toContain("Recommended in 3 of 5 reviewed samples")
    expect(html).toContain("Not market share")
  })
  it("names the measured surface and never another assistant's recommendations", () => {
    expect(html).toContain("Gemini API with Google Search grounding (gemini-3.5-flash-lite)")
    expect(html).toContain("do not measure ChatGPT")
  })
  it("keeps referral evidence separate and says signups are not measured", () => {
    expect(html).toContain("AI referral evidence (GA4)")
    expect(html).toContain("SIGNUPS_NOT_MEASURED")
    expect(html).toContain("chatgpt.com / referral")
  })
  it("shows the exact answer with an evidence link and digest", () => {
    expect(html).toContain("1. **Supportly** handles email.")
    expect(html).toContain("/observations/11111111-1111-4111-8111-111111111111")
    expect(html).toContain(`sha256:${"b".repeat(16)}`)
  })
  it("shows no score or percentage", () => {
    expect(html).not.toMatch(/\d+%|score/i)
  })
})

describe("competitor field", () => {
  it("parses one competitor per line", () => {
    expect(parseCompetitors("HelpHub | HelpHub Agent | helphub.test\n\nAda ||ada.test, ada.io | case")).toEqual([
      { name: "HelpHub", aliases: ["HelpHub Agent"], domains: ["helphub.test"], matchCase: false, ambiguity: null },
      { name: "Ada", aliases: [], domains: ["ada.test", "ada.io"], matchCase: true, ambiguity: null },
    ])
  })
})

describe("citation export", () => {
  it("escapes spreadsheet formulas and quotes while preserving sample denominators", () => {
    const csv = citationSourceCsv({ eligibleAnswers: 4, answersWithSources: 2, unresolvedAnswers: 0, groundingObserved: 4,
      domains: [{ domain: "example.test", owner: "COMPETITOR", competitor: '=HYPERLINK("x")', basis: "URI_HOST", answers: 2 }], pages: [] }, { id: "test-batch", createdAt: "2026-10-01", surface: "test" })
    expect(csv).toContain('"domain","example.test","COMPETITOR","\'=HYPERLINK(""x"")","URI_HOST","2","4"')
  })
  it("shows source attribution, coverage and limitations without executing source text", () => {
    const batch: Batch = { id: "batch", setId: "set", setVersion: 1, scope: "FULL", questionCount: 1, sampleCount: 1, provider: "test", requestedModel: "test",
      retrievalRequested: true, maxProviderCalls: 4, createdAt: "2026-10-01T00:00:00.000Z", status: "SUCCEEDED", surface: "test", collectedFrom: null, collectedTo: null, metrics,
      citationSources: { eligibleAnswers: 1, answersWithSources: 1, unresolvedAnswers: 0, groundingObserved: 1,
        domains: [{ domain: "example.test", owner: "COMPETITOR", competitor: "<script>", basis: "PROVIDER_TITLE", answers: 1 }], pages: [] } }
    const html = renderToStaticMarkup(createElement(CitationSources, { batch }))
    expect(html).toContain("example.test")
    expect(html).toContain("domain reported in title")
    expect(html).toContain("support for the answer are not verified")
    expect(html).not.toContain("<script>")
    expect(html).toContain("&lt;script&gt;")
  })
})
