// Manually supplied GA4 export: strict parsing and AI-source classification
// (pure). No OAuth, no tracker, no visitor-level data: only aggregate rows of
// date x session source x session medium, with sessions and, when the
// operator states a configured conversion event, its key-event count.
//
// Anything else is refused rather than guessed: unexpected columns (they may
// carry personal data or other metrics), malformed numbers, dates outside the
// stated range, duplicate rows, and source values that look like personal
// data or URLs with parameters.
import { createHash } from "node:crypto"

export const GA4_MAX_BYTES = 1_048_576
export const GA4_MAX_ROWS = 10_000

export interface Ga4ImportMeta {
  readonly dataOrigin: "GA4_EXPORT" | "SYNTHETIC_FIXTURE"
  readonly propertyRef: string
  readonly dateStart: string
  readonly dateEnd: string
  readonly timeZone: string
  readonly attributionBasis: "SESSION_SOURCE_MEDIUM"
  /** The configured signup/conversion key event, or null when none is configured. */
  readonly conversionEvent: string | null
}
export interface Ga4Row {
  readonly rowNumber: number
  readonly day: string
  readonly sessionSource: string
  readonly sessionMedium: string
  readonly sessions: number
  readonly conversions: number | null
}
export type Ga4Refusal = { readonly reason: string; readonly line: number | null }
export type Ga4Parse = { readonly ok: true; readonly rows: ReadonlyArray<Ga4Row>; readonly digest: string } | ({ readonly ok: false } & Ga4Refusal)

const COLUMNS: Record<string, "date" | "source" | "medium" | "sourceMedium" | "sessions" | "conversions"> = {
  "date": "date",
  "session source": "source", "sessionsource": "source",
  "session medium": "medium", "sessionmedium": "medium",
  "session source / medium": "sourceMedium", "sessionsourcemedium": "sourceMedium",
  "sessions": "sessions",
  "key events": "conversions", "keyevents": "conversions", "conversions": "conversions",
}

export const sha256Hex = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex")

/** RFC 4180-style CSV: quoted fields, doubled quotes, CRLF or LF. */
export const parseCsvLines = (text: string): Array<{ line: number; cells: string[] }> => {
  const out: Array<{ line: number; cells: string[] }> = []
  let row: string[] = [], cell = "", quoted = false, line = 1, rowLine = 1
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++ } else if (ch === '"') quoted = false
      else { if (ch === "\n") line++; cell += ch }
    } else if (ch === '"') quoted = true
    else if (ch === ",") { row.push(cell); cell = "" }
    else if (ch === "\n") { row.push(cell); out.push({ line: rowLine, cells: row }); row = []; cell = ""; line++; rowLine = line }
    else if (ch !== "\r") cell += ch
  }
  if (cell.length || row.length) { row.push(cell); out.push({ line: rowLine, cells: row }) }
  return out
}

const isoDay = (s: string): string | null => {
  const m = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(s.trim())
  if (!m) return null
  const d = `${m[1]}-${m[2]}-${m[3]}`
  const t = new Date(`${d}T00:00:00Z`)
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d ? d : null
}
const count = (s: string): number | null => (/^\d{1,9}$/.test(s.trim()) ? Number(s.trim()) : null)
export const validTimeZone = (tz: string): boolean => {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$|^UTC$/.test(tz) } catch { return false }
}
/** Source values that could carry personal data or tracking parameters. */
const unsafeSource = (s: string) => /@|[?=&]|\s{2,}/.test(s) || s.length > 300

export const validateMeta = (m: Ga4ImportMeta): string | null => {
  if (!m.propertyRef.trim() || m.propertyRef.length > 120) return "InvalidProperty"
  const start = isoDay(m.dateStart), end = isoDay(m.dateEnd)
  if (!start || !end || start > end) return "InvalidDateRange"
  if (!validTimeZone(m.timeZone)) return "InvalidTimeZone"
  if (m.conversionEvent !== null && !/^[A-Za-z0-9_][A-Za-z0-9_ -]{0,99}$/.test(m.conversionEvent)) return "InvalidConversionEvent"
  return null
}

export const parseGa4Export = (text: string, meta: Ga4ImportMeta): Ga4Parse => {
  const refuse = (reason: string, line: number | null = null): Ga4Parse => ({ ok: false, reason, line })
  if (text.length === 0 || Buffer.byteLength(text, "utf8") > GA4_MAX_BYTES) return refuse("ExportSize")
  const metaError = validateMeta(meta)
  if (metaError) return refuse(metaError)
  const start = isoDay(meta.dateStart)!, end = isoDay(meta.dateEnd)!
  // GA4 downloads open with "#" comment lines (property, date range); skip them and blanks.
  const lines = parseCsvLines(text).filter(l => !(l.cells.length === 1 && l.cells[0]!.trim() === "") && !l.cells[0]!.trimStart().startsWith("#"))
  if (lines.length < 1) return refuse("MissingHeader")
  const header = lines[0]!
  const roles = header.cells.map(c => COLUMNS[c.trim().toLowerCase()])
  const unknown = roles.findIndex(r => r === undefined)
  if (unknown !== -1) return refuse("UnexpectedColumn", header.line)
  if (new Set(roles).size !== roles.length) return refuse("DuplicateColumn", header.line)
  const has = (r: string) => roles.includes(r as never)
  const split = has("source") && has("medium")
  if (!has("date") || !has("sessions") || has("source") !== has("medium") || split === has("sourceMedium")) return refuse("MissingColumn", header.line)
  if (has("conversions") !== (meta.conversionEvent !== null)) return refuse(has("conversions") ? "ConversionEventNotStated" : "ConversionColumnMissing", header.line)
  const body = lines.slice(1)
  if (body.length > GA4_MAX_ROWS) return refuse("TooManyRows")
  const seen = new Set<string>()
  const rows: Ga4Row[] = []
  for (const l of body) {
    if (l.cells.length !== roles.length) return refuse("MalformedRow", l.line)
    const get = (r: string) => l.cells[roles.indexOf(r as never)]!.trim()
    const day = isoDay(get("date"))
    if (!day) return refuse("InvalidDate", l.line)
    if (day < start || day > end) return refuse("DateOutsideRange", l.line)
    let source: string, medium: string
    if (has("sourceMedium")) {
      const parts = get("sourceMedium").split(" / ")
      if (parts.length !== 2) return refuse("InvalidSourceMedium", l.line)
      source = parts[0]!.trim(); medium = parts[1]!.trim()
    } else { source = get("source"); medium = get("medium") }
    if (!source || !medium) return refuse("InvalidSourceMedium", l.line)
    if (unsafeSource(source) || unsafeSource(medium)) return refuse("UnsafeSourceValue", l.line)
    const sessions = count(get("sessions"))
    if (sessions === null) return refuse("InvalidSessions", l.line)
    let conversions: number | null = null
    if (has("conversions")) {
      conversions = count(get("conversions"))
      if (conversions === null) return refuse("InvalidConversions", l.line)
    }
    const key = `${day}\u0000${source.toLowerCase()}\u0000${medium.toLowerCase()}`
    if (seen.has(key)) return refuse("DuplicateRow", l.line)
    seen.add(key)
    rows.push({ rowNumber: rows.length + 1, day, sessionSource: source, sessionMedium: medium, sessions, conversions })
  }
  return { ok: true, rows, digest: sha256Hex(text) }
}

// ---------------------------------------------------------------------------
// AI assistant sources. A GA4 session attributed to one of these sources is
// AI-attributed referral traffic as GA4 recorded it, nothing more: it is not
// tied to any sampled answer and says nothing about causality.
// ---------------------------------------------------------------------------

export const AI_SOURCES_VERSION = "ai-sources-v1"
export const AI_SOURCE_RULES: ReadonlyArray<{ readonly assistant: string; readonly hosts: ReadonlyArray<string> }> = [
  { assistant: "ChatGPT", hosts: ["chatgpt.com", "chat.openai.com", "openai.com"] },
  { assistant: "Perplexity", hosts: ["perplexity.ai", "perplexity"] },
  { assistant: "Gemini", hosts: ["gemini.google.com", "bard.google.com"] },
  { assistant: "Microsoft Copilot", hosts: ["copilot.microsoft.com", "copilot.cloud.microsoft"] },
  { assistant: "Claude", hosts: ["claude.ai"] },
  { assistant: "DeepSeek", hosts: ["chat.deepseek.com", "deepseek.com"] },
  { assistant: "Meta AI", hosts: ["meta.ai"] },
  { assistant: "Grok", hosts: ["grok.com"] },
]

export const aiAssistantFor = (sessionSource: string): string | null => {
  const s = sessionSource.trim().toLowerCase().replace(/^www\./, "")
  const rule = AI_SOURCE_RULES.find(r => r.hosts.some(h => s === h || s.endsWith(`.${h}`)))
  return rule?.assistant ?? null
}
