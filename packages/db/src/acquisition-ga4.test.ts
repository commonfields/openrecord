// GA4 export validation (no database). Every export here is a SYNTHETIC test
// fixture; none is real customer evidence.
import { describe, expect, it } from "vitest"
import { AI_SOURCES_VERSION, aiAssistantFor, parseGa4Export, sha256Hex, type Ga4ImportMeta } from "./acquisition-ga4.js"

const META: Ga4ImportMeta = { dataOrigin: "SYNTHETIC_FIXTURE", propertyRef: "TEST-property-1", dateStart: "2026-09-01", dateEnd: "2026-09-30",
  timeZone: "America/New_York", attributionBasis: "SESSION_SOURCE_MEDIUM", conversionEvent: null }
const refused = (text: string, meta: Ga4ImportMeta = META) => {
  const r = parseGa4Export(text, meta)
  if (r.ok) throw new Error("expected refusal")
  return r
}

describe("GA4 export parsing", () => {
  it("parses API-style columns, skips GA4 comment lines, and digests the original text", () => {
    const text = "# TEST export\n# Start date: 20260901\n\ndate,sessionSource,sessionMedium,sessions\n20260901,chatgpt.com,referral,4\n2026-09-02,google,organic,30\n"
    const r = parseGa4Export(text, META)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.rows).toEqual([
      { rowNumber: 1, day: "2026-09-01", sessionSource: "chatgpt.com", sessionMedium: "referral", sessions: 4, conversions: null },
      { rowNumber: 2, day: "2026-09-02", sessionSource: "google", sessionMedium: "organic", sessions: 30, conversions: null },
    ])
    expect(r.digest).toBe(sha256Hex(text))
  })
  it("accepts the GA4 UI combined source / medium column and key events when an event is stated", () => {
    const r = parseGa4Export('Date,Session source / medium,Sessions,Key events\n20260903,"perplexity.ai / referral",2,1\n', { ...META, conversionEvent: "sign_up" })
    expect(r.ok && r.rows[0]).toEqual({ rowNumber: 1, day: "2026-09-03", sessionSource: "perplexity.ai", sessionMedium: "referral", sessions: 2, conversions: 1 })
  })
  it("refuses unexpected columns, which may carry personal data or other metrics", () => {
    expect(refused("date,sessionSource,sessionMedium,sessions,userEmail\n20260901,a,b,1,x@y.test\n").reason).toBe("UnexpectedColumn")
    expect(refused("date,sessionSource,sessions\n20260901,a,1\n").reason).toBe("MissingColumn")
  })
  it("refuses key events without a stated conversion event, and a stated event without the column", () => {
    expect(refused("date,sessionSource,sessionMedium,sessions,keyEvents\n20260901,a,b,1,1\n").reason).toBe("ConversionEventNotStated")
    expect(refused("date,sessionSource,sessionMedium,sessions\n20260901,a,b,1\n", { ...META, conversionEvent: "sign_up" }).reason).toBe("ConversionColumnMissing")
  })
  it("refuses malformed numbers, dates outside the stated range, duplicates and ragged rows, with the line", () => {
    expect(refused("date,sessionSource,sessionMedium,sessions\n20260901,a,b,1.5\n")).toEqual({ ok: false, reason: "InvalidSessions", line: 2 })
    expect(refused("date,sessionSource,sessionMedium,sessions\n20260901,a,b,-1\n").reason).toBe("InvalidSessions")
    expect(refused("date,sessionSource,sessionMedium,sessions\n20261001,a,b,1\n").reason).toBe("DateOutsideRange")
    expect(refused("date,sessionSource,sessionMedium,sessions\n20260231,a,b,1\n").reason).toBe("InvalidDate")
    expect(refused("date,sessionSource,sessionMedium,sessions\n20260901,a,b,1\n20260901,A,B,2\n")).toEqual({ ok: false, reason: "DuplicateRow", line: 3 })
    expect(refused("date,sessionSource,sessionMedium,sessions\n20260901,a,1\n").reason).toBe("MalformedRow")
  })
  it("refuses source values that look like personal data or tracking parameters", () => {
    expect(refused("date,sessionSource,sessionMedium,sessions\n20260901,jane@example.test,email,1\n").reason).toBe("UnsafeSourceValue")
    expect(refused("date,sessionSource,sessionMedium,sessions\n20260901,site.test?uid=9,referral,1\n").reason).toBe("UnsafeSourceValue")
  })
  it("requires a stated property, a valid range and an IANA time zone", () => {
    expect(refused("date,sessionSource,sessionMedium,sessions\n", { ...META, timeZone: "Mars/Olympus" }).reason).toBe("InvalidTimeZone")
    expect(refused("date,sessionSource,sessionMedium,sessions\n", { ...META, dateStart: "2026-10-01" }).reason).toBe("InvalidDateRange")
    expect(refused("date,sessionSource,sessionMedium,sessions\n", { ...META, propertyRef: " " }).reason).toBe("InvalidProperty")
  })
})

describe("AI assistant sources", () => {
  it("maps known assistant referrers by exact host or subdomain only", () => {
    expect(AI_SOURCES_VERSION).toBe("ai-sources-v1")
    expect(aiAssistantFor("chatgpt.com")).toBe("ChatGPT")
    expect(aiAssistantFor("www.perplexity.ai")).toBe("Perplexity")
    expect(aiAssistantFor("gemini.google.com")).toBe("Gemini")
    expect(aiAssistantFor("google")).toBeNull()
    expect(aiAssistantFor("notchatgpt.com")).toBeNull()
  })
})
