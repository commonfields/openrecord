// How a company's public pages changed over time, from two sources:
//
//  - OpenRecord's own snapshots: page.snapshot saves the readable lines of a
//    page; page.changes reads it again and compares with the last snapshot.
//    History builds up from the first snapshot onward.
//  - The public web archive, for what came before: site.history counts the
//    archive's captures of a site by month, and archive.compare reads the
//    archived version of a page nearest a date and compares it with today's.
//
// Capture counts say how often the archive visited, not how popular a site
// is. A difference between versions is what changed on the page, not why.
import { createHash } from "node:crypto"
import { SqlClient } from "@effect/sql"
import { Effect, Schema } from "effect"
import { clean, lines, money, title } from "./html.js"
import { Domain, normalizeDomain, normalizeUrl, PageUrl } from "./inputs.js"
import type { ResearchNetService } from "./net.js"
import { refuse, type AnyCapability, type Observed, type Refused, type RunContext } from "./types.js"

const MAX_LINES = 400
export interface Diff { readonly added: string[]; readonly removed: string[]; readonly unchanged: number }
/** Line-level difference: what the newer version has that the older lacks, and the reverse. */
export const diffLines = (older: ReadonlyArray<string>, newer: ReadonlyArray<string>): Diff => {
  const a = new Set(older), b = new Set(newer)
  return { added: newer.filter(l => !a.has(l)).slice(0, 60), removed: older.filter(l => !b.has(l)).slice(0, 60), unchanged: newer.filter(l => a.has(l)).length }
}
const priceList = (ls: ReadonlyArray<string>) => [...new Set(money(ls.join("\n")).map(m => `${m.currency} ${m.amount}${m.period ? `/${m.period}` : ""}`))].slice(0, 20)
const digest = (ls: ReadonlyArray<string>) => createHash("sha256").update(ls.join("\n")).digest("hex")

const readLines = async (net: ResearchNetService, url: string) => {
  const p = await net.page(url)
  if (p.state !== "OK" || !p.body) return { refused: p.state }
  return { url: p.finalUrl, title: title(p.body), lines: lines(p.body).slice(0, MAX_LINES) }
}

const latestSnapshot = (businessId: string, url: string, before: Date) => Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const r = (yield* sql`SELECT findings, observed_at FROM research_observations WHERE business_id = ${businessId} AND operation IN ('page.snapshot', 'page.changes')
    AND subject = ${url} AND status = 'OBSERVED' AND observed_at < ${before} ORDER BY observed_at DESC LIMIT 1`)[0]
  if (!r) return null
  const f = r["findings"] as { lines?: unknown } | null
  return { lines: Array.isArray(f?.lines) ? (f!.lines as unknown[]).filter((x): x is string => typeof x === "string") : [], at: new Date(r["observed_at"] as string).toISOString() }
})

const snapshotRun = (ctx: RunContext, url: string) => Effect.gen(function*() {
  const now = yield* Effect.tryPromise(() => readLines(ctx.net, url))
  if ("refused" in now) return refuse(now.refused, "The page could not be read now; no snapshot was saved.")
  const prev = yield* latestSnapshot(ctx.businessId, url, ctx.now)
  const changed = prev ? digest(prev.lines) !== digest(now.lines) : null
  return {
    status: "OBSERVED", citations: [{ kind: "web", id: now.url, text: now.title ?? now.url }],
    timeline: prev && changed ? [{ date: ctx.now.toISOString(), event: `Page changed since ${prev.at.slice(0, 10)}: ${now.url}`, label: "SEEN", url: now.url }] : [],
    findings: { label: "SEEN", url: now.url, title: now.title, lines: now.lines, prices: priceList(now.lines), digest: digest(now.lines), changedSincePrevious: changed, previousSnapshotAt: prev?.at ?? null },
    coverage: { lines: now.lines.length, note: "Readable text lines of the page as served now (no JavaScript). Read it again later with page.changes to see what changed." },
  } satisfies Observed
})

const changesRun = (ctx: RunContext, url: string) => Effect.gen(function*() {
  const prev = yield* latestSnapshot(ctx.businessId, url, new Date(ctx.now.getTime() + 1))
  const now = yield* Effect.tryPromise(() => readLines(ctx.net, url))
  if ("refused" in now) return refuse(now.refused, "The page could not be read now.")
  if (!prev) return { status: "NO_DATA", findings: { label: "SEEN", url: now.url, lines: now.lines, prices: priceList(now.lines) },
    coverage: { note: "No earlier OpenRecord snapshot of this page. Save one with page.snapshot (this read can serve as one), or compare with the public archive using archive.compare." } } satisfies Observed
  const d = diffLines(prev.lines, now.lines)
  const pricesThen = priceList(prev.lines), pricesNow = priceList(now.lines)
  return {
    status: "OBSERVED", citations: [{ kind: "web", id: now.url, text: now.title ?? now.url }],
    timeline: d.added.length || d.removed.length ? [{ date: ctx.now.toISOString(), event: `${d.added.length} lines added and ${d.removed.length} removed on ${now.url} since ${prev.at.slice(0, 10)}`, label: "SEEN", url: now.url }] : [],
    findings: { label: "SEEN", url: now.url, since: prev.at, added: d.added, removed: d.removed, unchangedLines: d.unchanged,
      prices: { then: pricesThen, now: pricesNow, changed: pricesThen.join("|") !== pricesNow.join("|") }, lines: now.lines },
    coverage: { comparedWith: `OpenRecord snapshot of ${prev.at.slice(0, 10)}`, note: "Text differences only; layout, images and content loaded by JavaScript are not compared. A change shows what the page says now, not why it changed or what it did." },
  } satisfies Observed
})

// ---------------------------------------------------------------- public web archive

const ARCHIVE = "https://web.archive.org"
const tsDate = (ts: string) => `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}`
const historyRun = async (net: ResearchNetService, domain: string, years: number, now: Date): Promise<Observed | Refused> => {
  const from = `${now.getUTCFullYear() - years}${String(now.getUTCMonth() + 1).padStart(2, "0")}`
  const q = `${ARCHIVE}/cdx/search/cdx?url=${encodeURIComponent(domain)}&output=json&fl=timestamp,statuscode&filter=statuscode:200&collapse=timestamp:8&from=${from}&limit=5000`
  const r = await net.api(q, "json")
  if (r.status === 429) return refuse("RATE_LIMITED", "The public web archive asked OpenRecord to slow down. Try again later.")
  if (!r.body || r.status !== 200) return refuse("UNAVAILABLE", "The public web archive did not answer. Say history is unknown.")
  let rows: unknown
  try { rows = JSON.parse(r.body) } catch { return refuse("MALFORMED", "The archive's answer could not be read.") }
  const caps = (Array.isArray(rows) ? rows.slice(1) : []).filter((x): x is [string, string] => Array.isArray(x) && typeof x[0] === "string" && /^\d{14}$/.test(x[0]))
  if (!caps.length) return { status: "NO_DATA", findings: {}, coverage: { note: "The public archive holds no captures of this home page in the period. Not archived is not new or unknown to the web." } }
  const perMonth = new Map<string, number>()
  for (const [ts] of caps) perMonth.set(`${ts.slice(0, 4)}-${ts.slice(4, 6)}`, (perMonth.get(`${ts.slice(0, 4)}-${ts.slice(4, 6)}`) ?? 0) + 1)
  const first = caps[0]![0], last = caps[caps.length - 1]![0]
  return {
    status: "OBSERVED", citations: [{ kind: "web", id: `${ARCHIVE}/web/*/${domain}`, text: `Public web archive captures of ${domain}` }],
    timeline: [{ date: `${tsDate(first)}T00:00:00.000Z`, event: `Earliest archived home page in the period`, label: "SEEN", url: `${ARCHIVE}/web/${first}/${domain}` }],
    findings: { label: "SEEN", capturesByMonth: [...perMonth.entries()].map(([m, days]) => ({ month: m, daysCaptured: days })), firstCapture: tsDate(first), lastCapture: tsDate(last), daysCaptured: caps.length,
      versions: [caps[0]!, caps[Math.floor(caps.length / 2)]!, caps[caps.length - 1]!].map(([ts]) => ({ date: tsDate(ts), url: `${ARCHIVE}/web/${ts}/https://${domain}/` })) },
    coverage: { since: `${from.slice(0, 4)}-${from.slice(4)}`, note: "How often the public archive captured the home page (one count per day). The archive decides when to capture; more captures do not mean more visitors. Use archive.compare to see what a past version said." },
  }
}

const compareRun = async (net: ResearchNetService, url: string, date: string): Promise<Observed | Refused> => {
  const ts = date.replace(/-/g, "").slice(0, 8)
  const avail = await net.api(`https://archive.org/wayback/available?url=${encodeURIComponent(url)}&timestamp=${ts}`, "json")
  let snap: { url?: string; timestamp?: string } | undefined
  try { snap = (JSON.parse(avail.body ?? "{}") as { archived_snapshots?: { closest?: { url?: string; timestamp?: string; available?: boolean } } }).archived_snapshots?.closest } catch { snap = undefined }
  if (!snap?.timestamp || !/^\d{14}$/.test(snap.timestamp)) return { status: "NO_DATA", findings: {}, coverage: { note: `No archived version of ${url} near ${date}. Unknown, not unchanged.` } }
  const archived = await net.api(`${ARCHIVE}/web/${snap.timestamp}id_/${url}`, "html")
  if (!archived.body) return refuse("UNAVAILABLE", "The archived version could not be read.")
  const then = lines(archived.body).slice(0, MAX_LINES)
  const now = await readLines(net, url)
  const nowLines = "refused" in now ? null : now.lines
  const d = nowLines ? diffLines(then, nowLines) : null
  return {
    status: "OBSERVED",
    citations: [{ kind: "web", id: `${ARCHIVE}/web/${snap.timestamp}/${url}`, text: `Archived ${url} (${tsDate(snap.timestamp)})` }],
    timeline: [{ date: `${tsDate(snap.timestamp)}T00:00:00.000Z`, event: `Archived version of ${url}: ${clean(title(archived.body), 80) ?? "page"}`, label: "SEEN", url: `${ARCHIVE}/web/${snap.timestamp}/${url}` }],
    findings: { label: "SEEN", url, archivedAt: tsDate(snap.timestamp), titleThen: title(archived.body), pricesThen: priceList(then),
      ...(d ? { added: d.added, removed: d.removed, unchangedLines: d.unchanged, pricesNow: priceList(nowLines!) } : { current: "not readable now" }) },
    coverage: { note: "Text of the archived capture compared with the page today. The archive may have captured a partial or JavaScript-dependent page; missing text then is not proof it was absent." },
  }
}

const UrlInput = Schema.Struct({ url: PageUrl })
export const HISTORY_CAPABILITIES: ReadonlyArray<AnyCapability> = [
  { id: "page.snapshot", platform: "history", title: "Save a snapshot of a page (OpenRecord history)", source: "OPENRECORD_SNAPSHOT", label: "SEEN", cache: "day",
    description: "Reads a public page now and saves its text lines and prices, so later reads show what changed. Says whether it changed since the last snapshot.",
    input: UrlInput, subject: (i: typeof UrlInput.Type) => normalizeUrl(i.url)!, run: (ctx, i: typeof UrlInput.Type) => snapshotRun(ctx, normalizeUrl(i.url)!) },
  { id: "page.changes", platform: "history", title: "What changed on a page since OpenRecord last saw it", source: "OPENRECORD_SNAPSHOT", label: "SEEN", cache: "none",
    description: "Lines added and removed and price changes on a page since its last OpenRecord snapshot (pricing, positioning, offers). Without an earlier snapshot it returns today's text to start the history.",
    input: UrlInput, subject: (i: typeof UrlInput.Type) => normalizeUrl(i.url)!, run: (ctx, i: typeof UrlInput.Type) => changesRun(ctx, normalizeUrl(i.url)!) },
  { id: "site.history", platform: "history", title: "Archive history of a website", source: "PUBLIC_ARCHIVE", label: "SEEN", cache: "day",
    description: "How the public web archive captured a site's home page by month over the last 1 to 10 years: first and last capture and links to past versions.",
    input: Schema.Struct({ domain: Domain, years: Schema.optional(Schema.Int.pipe(Schema.between(1, 10))) }), subject: (i: { domain: string }) => normalizeDomain(i.domain)!,
    run: (ctx, i: { domain: string; years?: number | undefined }) => Effect.tryPromise(() => historyRun(ctx.net, normalizeDomain(i.domain)!, i.years ?? 3, ctx.now)) },
  { id: "archive.compare", platform: "history", title: "A page then and now", source: "PUBLIC_ARCHIVE", label: "SEEN", cache: "day",
    description: "Reads the archived version of a page nearest a date (YYYY-MM-DD) and compares it with today's: lines added and removed, title and prices then and now. Use it for pricing, positioning and offer history.",
    input: Schema.Struct({ url: PageUrl, date: Schema.String.pipe(Schema.pattern(/^\d{4}-\d{2}-\d{2}$/)) }), subject: (i: { url: string }) => normalizeUrl(i.url)!,
    run: (ctx, i: { url: string; date: string }) => Effect.tryPromise(() => compareRun(ctx.net, normalizeUrl(i.url)!, i.date)) },
]
