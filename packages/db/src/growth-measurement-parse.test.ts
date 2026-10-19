// W3 daily import parsing (pure, no database): daily count CSVs and GA4
// key-event aggregation. Refusals are named so the repository and routes can
// map them to statuses.
import { describe, expect, it } from "vitest"
import { aggregateGa4KeyEvents, coverageOf, parseDailyCounts, GROWTH_DAY_MAX_VALUE } from "./growth-measurement-parse.js"
import type { Ga4Row } from "./acquisition-ga4.js"

describe("parseDailyCounts", () => {
  it("accepts date,value rows in either column order, skips comments and blanks, and digests raw bytes", () => {
    const a = parseDailyCounts("# shop export\ndate,value\n2026-09-01,5\n2026-09-02,3\n", { dateStart: "2026-09-01", dateEnd: "2026-09-02" })
    expect(a).toMatchObject({ ok: true, rows: [{ rowNumber: 1, day: "2026-09-01", value: 5 }, { rowNumber: 2, day: "2026-09-02", value: 3 }] })
    const b = parseDailyCounts("value,date\n3,2026-09-02\n", { dateStart: "2026-09-01", dateEnd: "2026-09-02" })
    expect(b).toMatchObject({ ok: true, rows: [{ day: "2026-09-02", value: 3 }] })
    expect(a.ok && a.digest).toHaveLength(64)
    expect(a.ok && b.ok && a.digest).not.toBe(b.ok && b.digest)
  })
  it("refuses wrong headers, malformed rows, dates outside the range and duplicate days", () => {
    const range = { dateStart: "2026-09-01", dateEnd: "2026-09-05" }
    expect(parseDailyCounts("day,total\n2026-09-01,5\n", range)).toMatchObject({ ok: false, reason: "UnexpectedColumn" })
    expect(parseDailyCounts("date\n2026-09-01,5\n", range)).toMatchObject({ ok: false, reason: "MissingColumn" })
    expect(parseDailyCounts("date,value,x\n2026-09-01,5,0\n", range)).toMatchObject({ ok: false, reason: "UnexpectedColumn" })
    expect(parseDailyCounts("date,value\n2026-09-01\n", range)).toMatchObject({ ok: false, reason: "MalformedRow" })
    expect(parseDailyCounts("date,value\n2026-09-15,5\n", range)).toMatchObject({ ok: false, reason: "DateOutsideRange" })
    expect(parseDailyCounts("date,value\n2026-13-01,5\n", range)).toMatchObject({ ok: false, reason: "InvalidDate" })
    expect(parseDailyCounts("date,value\n2026-09-01,5\n2026-09-01,6\n", range)).toMatchObject({ ok: false, reason: "DuplicateRow" })
    expect(parseDailyCounts(`date,value\n${Array.from({ length: 10_001 }, (_, i) => `2026-09-01,${i}`).join("\n")}\n`, range)).toMatchObject({ ok: false, reason: "TooManyRows" })
  })
  it("refuses signed, fractional, empty values; the declared range must be a valid span", () => {
    const range = { dateStart: "2026-09-01", dateEnd: "2026-09-05" }
    for (const v of ["-5", "+5", "2.5", "", " 1 000", "1e3", "1000000000"]) expect(parseDailyCounts(`date,value\n2026-09-01,${v}\n`, range)).toMatchObject({ ok: false, reason: "InvalidValue" })
    expect(parseDailyCounts("date,value\n2026-09-01,5\n", { dateStart: "2026-09-05", dateEnd: "2026-09-01" })).toMatchObject({ ok: false, reason: "InvalidDateRange" })
    expect(parseDailyCounts("", range)).toMatchObject({ ok: false, reason: "ExportSize" })
  })
})

describe("aggregateGa4KeyEvents", () => {
  it("sums key-event counts per day across source rows", () => {
    const rows: Ga4Row[] = [
      { rowNumber: 1, day: "2026-09-01", sessionSource: "direct", sessionMedium: "(none)", sessions: 10, conversions: 2 },
      { rowNumber: 2, day: "2026-09-01", sessionSource: "google", sessionMedium: "organic", sessions: 8, conversions: 4 },
      { rowNumber: 3, day: "2026-09-02", sessionSource: "direct", sessionMedium: "(none)", sessions: 7, conversions: 3 },
    ]
    const out = aggregateGa4KeyEvents(rows)
    expect(out.ok ? out.rows : null).toEqual([
      { rowNumber: 1, day: "2026-09-01", value: 6 },
      { rowNumber: 2, day: "2026-09-02", value: 3 },
    ])
  })
  it("refuses when a key-event count is absent and when a daily sum exceeds the ceiling", () => {
    const missing: Ga4Row = { rowNumber: 1, day: "2026-09-01", sessionSource: "direct", sessionMedium: "(none)", sessions: 10, conversions: null }
    expect(aggregateGa4KeyEvents([missing])).toMatchObject({ ok: false, reason: "ConversionColumnMissing" })
    const big: Ga4Row = { rowNumber: 1, day: "2026-09-01", sessionSource: "direct", sessionMedium: "(none)", sessions: 10, conversions: GROWTH_DAY_MAX_VALUE }
    const second: Ga4Row = { rowNumber: 2, day: "2026-09-01", sessionSource: "x", sessionMedium: "y", sessions: 1, conversions: 1 }
    expect(aggregateGa4KeyEvents([big, second])).toMatchObject({ ok: false, reason: "ValueTooLarge" })
  })
})

describe("coverageOf", () => {
  it("counts the declared span, present days and the missing gap", () => {
    const range = { dateStart: "2026-09-01", dateEnd: "2026-09-05" }
    expect(coverageOf(range, [{ rowNumber: 1, day: "2026-09-01", value: 5 }])).toMatchObject({ daysInRange: 5, daysPresent: 1, missingDays: 4, firstValueDay: "2026-09-01", lastValueDay: "2026-09-01" })
    const filled = coverageOf(range, [{ rowNumber: 1, day: "2026-09-01", value: 5 }, { rowNumber: 2, day: "2026-09-04", value: 7 }])
    expect(filled.daysPresent).toBe(2)
    expect(filled.firstValueDay).toBe("2026-09-01")
    expect(filled.lastValueDay).toBe("2026-09-04")
    expect(coverageOf(range, [])).toMatchObject({ daysInRange: 5, daysPresent: 0, missingDays: 5, firstValueDay: null, lastValueDay: null })
  })
})
