// W3 daily aggregate import parsing (pure). The GA4 path reuses the proven
// acquisition export parser so unexpected columns, unsafe source values and
// leftover personal data are refused rather than guessed. The operator CSV
// path accepts exactly `date,value` daily rows. Everything else is refused:
// malformed numbers, signed or negative values, duplicate days, dates outside
// the declared range, and files beyond the size bounds.
import { parseCsvLines, sha256Hex, type Ga4Parse, type Ga4Row } from "./acquisition-ga4.js"

export const GROWTH_IMPORT_MAX_BYTES = 1_048_576
export const GROWTH_IMPORT_MAX_ROWS = 10_000
/** One bounded defensible ceiling for a daily aggregate value. */
export const GROWTH_DAY_MAX_VALUE = 999_999_999

export interface GrowthDailyRefusal { readonly reason: string; readonly line: number | null }
export interface GrowthDailyRow { readonly rowNumber: number; readonly day: string; readonly value: number }
export type GrowthDailyParse =
  | { readonly ok: true; readonly rows: ReadonlyArray<GrowthDailyRow>; readonly digest: string }
  | ({ readonly ok: false } & GrowthDailyRefusal)

const isoDay = (s: string): string | null => {
  const m = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(s.trim())
  if (!m) return null
  const d = `${m[1]}-${m[2]}-${m[3]}`
  const t = new Date(`${d}T00:00:00Z`)
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d ? d : null
}
export const validIsoDay = isoDay

const count = (s: string): number | null => (/^\d{1,9}$/.test(s.trim()) ? Number(s.trim()) : null)

/**
 * Operator-supplied daily CSV: header `date,value`, one row per day. A
 * declared range with no row for a day stays a real gap the read model
 * reports; a value outside the declared range is refused at import time.
 */
export const parseDailyCounts = (text: string, range: { readonly dateStart: string; readonly dateEnd: string }): GrowthDailyParse => {
  const refuse = (reason: string, line: number | null = null): GrowthDailyParse => ({ ok: false, reason, line })
  if (text.length === 0 || Buffer.byteLength(text, "utf8") > GROWTH_IMPORT_MAX_BYTES) return refuse("ExportSize")
  const start = isoDay(range.dateStart), end = isoDay(range.dateEnd)
  if (!start || !end || start > end) return refuse("InvalidDateRange")
  const lines = parseCsvLines(text).filter(l => !(l.cells.length === 1 && l.cells[0]!.trim() === "") && !l.cells[0]!.trimStart().startsWith("#"))
  if (lines.length < 1) return refuse("MissingHeader")
  const header = lines[0]!
  const roles: ReadonlyArray<"date" | "value" | undefined> = header.cells.map(c => {
    const v = c.trim().toLowerCase()
    return v === "date" ? "date" : v === "value" ? "value" : undefined
  })
  const unknown = roles.findIndex(r => r === undefined)
  if (unknown !== -1) return refuse("UnexpectedColumn", header.line)
  if (new Set(roles).size !== 2) return refuse("MissingColumn", header.line)
  const dateCell = roles.indexOf("date"), valueCell = roles.indexOf("value")
  const body = lines.slice(1)
  if (body.length > GROWTH_IMPORT_MAX_ROWS) return refuse("TooManyRows")
  const seen = new Set<string>()
  const rows: GrowthDailyRow[] = []
  for (const l of body) {
    if (l.cells.length !== roles.length || dateCell < 0 || valueCell < 0) return refuse("MalformedRow", l.line)
    const day = isoDay(l.cells[dateCell]!.trim())
    if (!day) return refuse("InvalidDate", l.line)
    if (day < start || day > end) return refuse("DateOutsideRange", l.line)
    const raw = l.cells[valueCell]!.trim()
    // Signed forms are refused outright: a deficit is not a measurement.
    if (/^[+-]/.test(raw) || !raw) return refuse("InvalidValue", l.line)
    const value = count(raw)
    if (value === null) return refuse("InvalidValue", l.line)
    if (value > GROWTH_DAY_MAX_VALUE) return refuse("ValueTooLarge", l.line)
    if (seen.has(day)) return refuse("DuplicateRow", l.line)
    seen.add(day)
    rows.push({ rowNumber: rows.length + 1, day, value })
  }
  return { ok: true, rows, digest: sha256Hex(text) }
}

/** GA4 parse result in `parseGa4Export` form, re-shape only. */
export type Ga4MeasurementParse = { readonly ok: true; readonly rows: ReadonlyArray<GrowthDailyRow>; readonly digest: string } | ({ readonly ok: false } & GrowthDailyRefusal)

/**
 * Daily key-event totals from a GA4 aggregate export. The configured key
 * event (the metric definition's `event_name`) selects the `key events`
 * column; everything else in the file is discarded unused. Column-level and
 * row-level validation happens inside `parseGa4Export`.
 */
export const ga4MeasurementRefusal = (p: Ga4Parse): GrowthDailyRefusal | null =>
  p.ok ? null : { reason: p.reason, line: p.line }

export const aggregateGa4KeyEvents = (rows: ReadonlyArray<Ga4Row>): GrowthDailyParse => {
  const byDay = new Map<string, number>()
  for (const r of rows) {
    if (r.conversions === null) return { ok: false, reason: "ConversionColumnMissing", line: null }
    const current = byDay.get(r.day) ?? 0
    const next = current + r.conversions
    if (next > GROWTH_DAY_MAX_VALUE) return { ok: false, reason: "ValueTooLarge", line: null }
    byDay.set(r.day, next)
  }
  const out = [...byDay.entries()].sort(([a], [b]) => a < b ? -1 : 1)
    .map(([day, value], i) => ({ rowNumber: i + 1, day, value }))
  return { ok: true, rows: out, digest: "" }
}

export const coverageOf = (range: { readonly dateStart: string; readonly dateEnd: string }, rows: ReadonlyArray<GrowthDailyRow>): {
  readonly daysInRange: number; readonly daysPresent: number; readonly missingDays: number
  readonly firstValueDay: string | null; readonly lastValueDay: string | null
} => {
  const start = isoDay(range.dateStart)!, end = isoDay(range.dateEnd)!
  const msPerDay = 86_400_000
  const daysInRange = Math.floor((new Date(`${end}T00:00:00Z`).getTime() - new Date(`${start}T00:00:00Z`).getTime()) / msPerDay) + 1
  // File order is not trusted: the first and last value days are min/max days.
  let firstValueDay: string | null = null, lastValueDay: string | null = null
  for (const r of rows) {
    if (firstValueDay === null || r.day < firstValueDay) firstValueDay = r.day
    if (lastValueDay === null || r.day > lastValueDay) lastValueDay = r.day
  }
  return { daysInRange, daysPresent: rows.length, missingDays: Math.max(0, daysInRange - rows.length), firstValueDay, lastValueDay }
}
