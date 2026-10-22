// The single GA4 report OpenRecord reads and the strict reading of its answer.
//
// Request: dimensions date and eventName, metrics keyEvents and eventCount,
// an exact eventName filter, one date range, keepEmptyRows. The value stored
// for a day is `keyEvents` (key-event count, the definition's metric), never
// `eventCount`; eventCount is kept in the evidence so the difference is visible.
//
// A day without a row in the response stays absent: it is never treated as
// zero. Zero is recorded only when Google returns a row whose keyEvents is "0".
// Sampled responses and responses that rolled data into "(other)" are refused:
// they are not exact daily counts.
import { canonicalJson, GA4_PROVIDER_METRIC } from "@openrecord/contracts"
import { sha256Hex } from "./oauth.js"

export const GA4_OBSERVATION_SCHEMA = "openrecord.ga4-observation/v1"
/** Rows per page. A filtered date × eventName report has at most one row per day. */
export const GA4_REPORT_PAGE_SIZE = 1000

export interface Ga4ReportRequest {
  readonly property: string
  readonly eventName: string
  readonly dateStart: string
  readonly dateEnd: string
}
export const keyEventReportBody = (r: Ga4ReportRequest, offset = 0) => ({
  dateRanges: [{ startDate: r.dateStart, endDate: r.dateEnd }],
  dimensions: [{ name: "date" }, { name: "eventName" }],
  metrics: [{ name: GA4_PROVIDER_METRIC }, { name: "eventCount" }],
  dimensionFilter: { filter: { fieldName: "eventName", stringFilter: { matchType: "EXACT", value: r.eventName, caseSensitive: true } } },
  keepEmptyRows: true,
  limit: GA4_REPORT_PAGE_SIZE,
  offset,
  returnPropertyQuota: true,
})

export interface Ga4DailyObservation { readonly day: string; readonly keyEvents: number; readonly eventCount: number }
export interface Ga4ReportPage {
  readonly rows: ReadonlyArray<Ga4DailyObservation>
  readonly rowCount: number
  readonly timeZone: string
  readonly currencyCode: string | null
  readonly subjectToThresholding: boolean
  readonly emptyReason: string | null
  readonly quota: Record<string, unknown> | null
}
export type Ga4ReportRefusal = "RESPONSE_SAMPLED" | "RESPONSE_DATA_LOSS" | "RESPONSE_UNEXPECTED" | "PROPERTY_TIME_ZONE_CHANGED"
export type Ga4ReportParse = { readonly ok: true; readonly page: Ga4ReportPage } | { readonly ok: false; readonly reason: Ga4ReportRefusal }

const COUNT = /^(0|[1-9][0-9]{0,9})$/
const MAX_DAILY = 2_147_483_647
const isoOf = (yyyymmdd: string): string | null => {
  if (!/^\d{8}$/.test(yyyymmdd)) return null
  const iso = `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`
  const ms = Date.parse(`${iso}T00:00:00Z`)
  return Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== iso ? null : iso
}
const headerIndex = (headers: unknown, name: string): number =>
  Array.isArray(headers) ? headers.findIndex(h => (h as { name?: unknown })?.name === name) : -1

/**
 * The property-activity probe: the same window with only the date dimension and
 * eventCount, unfiltered. Google's documented semantics (runReport keepEmptyRows)
 * are that only data recorded by the property can be displayed: a day with zero
 * occurrences of the selected key event has no row in the filtered report, even
 * with keepEmptyRows. A day where the property demonstrably recorded other
 * activity (eventCount >= 1) and reports no row for the selected event is
 * therefore an authoritative zero, not a missing measurement. A day with no
 * recorded property activity at all stays absent: nothing is known about it.
 */
export const propertyActivityReportBody = (r: Ga4ReportRequest, offset = 0) => ({
  dateRanges: [{ startDate: r.dateStart, endDate: r.dateEnd }],
  dimensions: [{ name: "date" }],
  metrics: [{ name: "eventCount" }],
  keepEmptyRows: true,
  limit: GA4_REPORT_PAGE_SIZE,
  offset,
  returnPropertyQuota: true,
})

export interface Ga4ActivityDay { readonly day: string; readonly eventCount: number }
export interface Ga4ActivityPage {
  readonly rows: ReadonlyArray<Ga4ActivityDay>
  readonly rowCount: number
  readonly timeZone: string
  readonly subjectToThresholding: boolean
}
export type Ga4ActivityParse = { readonly ok: true; readonly page: Ga4ActivityPage } | { readonly ok: false; readonly reason: Ga4ReportRefusal }

/** Reads one property-activity page against exactly what was asked; anything else is refused, never guessed. */
export const parseActivityReport = (json: unknown, request: Ga4ReportRequest, expectedTimeZone: string): Ga4ActivityParse => {
  const bad = (reason: Ga4ReportRefusal): Ga4ActivityParse => ({ ok: false, reason })
  if (!json || typeof json !== "object") return bad("RESPONSE_UNEXPECTED")
  const body = json as Record<string, unknown>
  const meta = (body["metadata"] && typeof body["metadata"] === "object" ? body["metadata"] : {}) as Record<string, unknown>
  if (Array.isArray(meta["samplingMetadatas"]) && meta["samplingMetadatas"].length > 0) return bad("RESPONSE_SAMPLED")
  if (meta["dataLossFromOtherRow"] === true) return bad("RESPONSE_DATA_LOSS")
  const timeZone = typeof meta["timeZone"] === "string" ? meta["timeZone"] : null
  if (!timeZone) return bad("RESPONSE_UNEXPECTED")
  if (timeZone !== expectedTimeZone) return bad("PROPERTY_TIME_ZONE_CHANGED")
  const dateAt = headerIndex(body["dimensionHeaders"], "date"), countAt = headerIndex(body["metricHeaders"], "eventCount")
  const rows = Array.isArray(body["rows"]) ? body["rows"] as Array<Record<string, unknown>> : []
  if (rows.length > 0 && (dateAt < 0 || countAt < 0)) return bad("RESPONSE_UNEXPECTED")
  const out: Ga4ActivityDay[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    const dims = row["dimensionValues"], mets = row["metricValues"]
    if (!Array.isArray(dims) || !Array.isArray(mets)) return bad("RESPONSE_UNEXPECTED")
    const day = isoOf(String((dims[dateAt] as { value?: unknown })?.value ?? ""))
    const count = String((mets[countAt] as { value?: unknown })?.value ?? "")
    if (!day || day < request.dateStart || day > request.dateEnd || seen.has(day)) return bad("RESPONSE_UNEXPECTED")
    if (!COUNT.test(count) || Number(count) > MAX_DAILY) return bad("RESPONSE_UNEXPECTED")
    seen.add(day)
    out.push({ day, eventCount: Number(count) })
  }
  const rowCount = body["rowCount"] === undefined ? out.length : Number(body["rowCount"])
  if (!Number.isInteger(rowCount) || rowCount < 0) return bad("RESPONSE_UNEXPECTED")
  return { ok: true, page: { rows: out, rowCount, timeZone, subjectToThresholding: meta["subjectToThresholding"] === true } }
}

/** Reads one runReport page against exactly what was asked. Anything else is refused, never guessed. */
export const parseKeyEventReport = (json: unknown, request: Ga4ReportRequest, expectedTimeZone: string): Ga4ReportParse => {
  const bad = (reason: Ga4ReportRefusal): Ga4ReportParse => ({ ok: false, reason })
  if (!json || typeof json !== "object") return bad("RESPONSE_UNEXPECTED")
  const body = json as Record<string, unknown>
  const meta = (body["metadata"] && typeof body["metadata"] === "object" ? body["metadata"] : {}) as Record<string, unknown>
  if (Array.isArray(meta["samplingMetadatas"]) && meta["samplingMetadatas"].length > 0) return bad("RESPONSE_SAMPLED")
  if (meta["dataLossFromOtherRow"] === true) return bad("RESPONSE_DATA_LOSS")
  const timeZone = typeof meta["timeZone"] === "string" ? meta["timeZone"] : null
  if (!timeZone) return bad("RESPONSE_UNEXPECTED")
  if (timeZone !== expectedTimeZone) return bad("PROPERTY_TIME_ZONE_CHANGED")
  const dateAt = headerIndex(body["dimensionHeaders"], "date"), eventAt = headerIndex(body["dimensionHeaders"], "eventName")
  const keyAt = headerIndex(body["metricHeaders"], GA4_PROVIDER_METRIC), countAt = headerIndex(body["metricHeaders"], "eventCount")
  const rows = Array.isArray(body["rows"]) ? body["rows"] as Array<Record<string, unknown>> : []
  if (rows.length > 0 && (dateAt < 0 || eventAt < 0 || keyAt < 0 || countAt < 0)) return bad("RESPONSE_UNEXPECTED")
  const out: Ga4DailyObservation[] = []
  const seen = new Set<string>()
  for (const row of rows) {
    const dims = row["dimensionValues"], mets = row["metricValues"]
    if (!Array.isArray(dims) || !Array.isArray(mets)) return bad("RESPONSE_UNEXPECTED")
    const day = isoOf(String((dims[dateAt] as { value?: unknown })?.value ?? ""))
    const eventName = (dims[eventAt] as { value?: unknown })?.value
    const key = String((mets[keyAt] as { value?: unknown })?.value ?? ""), count = String((mets[countAt] as { value?: unknown })?.value ?? "")
    if (!day || day < request.dateStart || day > request.dateEnd || seen.has(day)) return bad("RESPONSE_UNEXPECTED")
    if (eventName !== request.eventName) return bad("RESPONSE_UNEXPECTED")
    if (!COUNT.test(key) || !COUNT.test(count) || Number(key) > MAX_DAILY || Number(count) > MAX_DAILY) return bad("RESPONSE_UNEXPECTED")
    seen.add(day)
    out.push({ day, keyEvents: Number(key), eventCount: Number(count) })
  }
  const rowCount = body["rowCount"] === undefined ? out.length : Number(body["rowCount"])
  if (!Number.isInteger(rowCount) || rowCount < 0) return bad("RESPONSE_UNEXPECTED")
  return {
    ok: true,
    page: {
      rows: out, rowCount, timeZone,
      currencyCode: typeof meta["currencyCode"] === "string" ? meta["currencyCode"] : null,
      subjectToThresholding: meta["subjectToThresholding"] === true,
      emptyReason: typeof meta["emptyReason"] === "string" ? meta["emptyReason"] : null,
      quota: body["propertyQuota"] && typeof body["propertyQuota"] === "object" ? body["propertyQuota"] as Record<string, unknown> : null,
    },
  }
}

/** The normalized observation: what was asked and what Google reported, without quota or ordering noise.
 *  Optional members appear only when they apply: `derivedZeroDays` lists requested days where Google
 *  reported no row for the selected key event while the property-activity report proves recorded
 *  activity that day (an authoritative zero, never a guess); `activity` carries that probe's normalized
 *  answer; `activitySkipped` names why a needed probe could not establish activity, in which case those
 *  days stay absent (missing), never zero. */
export interface Ga4ObservationEvidence {
  readonly schema: typeof GA4_OBSERVATION_SCHEMA
  readonly request: { readonly property: string; readonly eventName: string; readonly metric: typeof GA4_PROVIDER_METRIC; readonly dateStart: string; readonly dateEnd: string; readonly keepEmptyRows: true }
  readonly response: {
    readonly timeZone: string; readonly currencyCode: string | null; readonly subjectToThresholding: boolean; readonly emptyReason: string | null
    readonly rows: ReadonlyArray<Ga4DailyObservation>
    readonly derivedZeroDays?: ReadonlyArray<string>
    readonly activity?: { readonly rows: ReadonlyArray<Ga4ActivityDay> }
    readonly activitySkipped?: string
  }
}
export type Ga4ActivitySkipReason = "SAMPLED" | "DATA_LOSS" | "THRESHOLDED" | "RESPONSE_UNEXPECTED" | "PROPERTY_TIME_ZONE_CHANGED" | "PROVIDER_ERROR"

const everyRequestedDay = (request: Ga4ReportRequest): string[] => {
  const out: string[] = []
  for (let ms = Date.parse(`${request.dateStart}T00:00:00Z`); ms <= Date.parse(`${request.dateEnd}T00:00:00Z`); ms += 86_400_000) {
    out.push(new Date(ms).toISOString().slice(0, 10))
  }
  return out
}

export const observationEvidence = (
  request: Ga4ReportRequest,
  pages: ReadonlyArray<Ga4ReportPage>,
  activity?: { readonly rows: ReadonlyArray<Ga4ActivityDay>; readonly skipped: Ga4ActivitySkipReason | null } | null,
): Ga4ObservationEvidence => {
  const first = pages[0]!
  const reportedDays = new Set(pages.flatMap(p => p.rows).map(r => r.day))
  // The probe's answer is evidence whenever it ran clean; derivation is offered only from a clean,
  // unskipped probe AND a non-thresholded filtered report (thresholding can hide rows).
  const probeRan = activity !== undefined && activity !== null && activity.skipped === null
  const derivable = probeRan && !pages.some(p => p.subjectToThresholding)
  const derivedZeroDays = derivable
    ? everyRequestedDay(request).filter(d => !reportedDays.has(d)
      && activity!.rows.some(a => a.day === d && a.eventCount >= 1))
    : []
  const withActivity = probeRan
    ? { activity: { rows: activity!.rows }, ...(derivedZeroDays.length > 0 ? { derivedZeroDays } : {}) }
    : {}
  const withSkip = activity !== undefined && activity !== null && activity.skipped !== null ? { activitySkipped: activity.skipped } : {}
  return {
    schema: GA4_OBSERVATION_SCHEMA,
    request: { property: request.property, eventName: request.eventName, metric: GA4_PROVIDER_METRIC, dateStart: request.dateStart, dateEnd: request.dateEnd, keepEmptyRows: true },
    response: {
      timeZone: first.timeZone, currencyCode: first.currencyCode,
      subjectToThresholding: pages.some(p => p.subjectToThresholding), emptyReason: first.emptyReason,
      rows: pages.flatMap(p => p.rows).slice().sort((a, b) => a.day.localeCompare(b.day)),
      ...withActivity, ...withSkip,
    },
  }
}
/** Identical provider answers to the identical question have the same digest. */
export const observationDigest = (evidence: Ga4ObservationEvidence): string => sha256Hex(canonicalJson(evidence))
