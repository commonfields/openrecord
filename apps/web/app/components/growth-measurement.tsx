// W3 measurement console: import daily aggregates against one immutable metric
// definition, review what each import covered, and read the resolved per-day
// series. Standalone on purpose: planning/execution surfaces live elsewhere.
// Descriptive language only — coverage, provenance and gaps, never impact.
import { useMemo, useState } from "react"
import type { GrowthMetricCoverage, GrowthMetricImport, GrowthSeries } from "@openrecord/contracts"
import { TriangleAlertIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { EmptyState, Panel, PanelHeader } from "@/components/page"
import type { GrowthGoal } from "@openrecord/contracts"
import { ApiError, api } from "@/lib/api"
import { Ga4Panel } from "@/components/growth-ga4"

type ImportResult = { result: { import: GrowthMetricImport; coverage: GrowthMetricCoverage; replayed: boolean } }
const STATUS_LABELS = { OK: "Reported", MISSING: "Missing", UNAVAILABLE: "No import", CONFLICT: "Conflicting" } as const

export const measurementError = (err: unknown): string => {
  if (!(err instanceof ApiError)) return "The measurement request failed. Try again."
  const reason = typeof err.body["reason"] === "string" ? err.body["reason"] : ""
  const reasons: Record<string, string> = {
    ExportSize: "The CSV is larger than 1 MB. Export fewer days at a time.",
    TooManyRows: "The CSV has more than 10,000 rows.",
    MissingHeader: "The first CSV row must be exactly `date,value` for operator files.",
    MissingColumn: "The CSV header needs one `date` and one `value` column.",
    UnexpectedColumn: "Unexpected CSV column. Only `date,value` is accepted for operator files.",
    MalformedRow: "A CSV row has the wrong number of columns.",
    InvalidDate: "A CSV date is not a real calendar day (YYYY-MM-DD).",
    DateOutsideRange: "A CSV row is dated outside the declared range. Adjust the range or the row.",
    DuplicateRow: "The CSV has two rows for the same day. One row per day, please.",
    InvalidValue: "A CSV value is not a plain non-negative whole number. Signed or fractional values are refused.",
    ValueTooLarge: "A value exceeds the supported daily ceiling.",
    InvalidDateRange: "The declared range is not a valid day span (start ≤ end).",
    InvalidSeriesRange: "The series range is not a valid day span (start ≤ end).",
    SeriesRangeTooLarge: "The series range is longer than 400 days. Use a smaller window.",
    InvalidPlanWindow: "Plan windows must not overlap and each window is limited to one year.",
    CurrencyMeasurementRefused: "Currency aggregation (SUM) is not implemented yet; measurement is count-only for now.",
    PlanOpportunityNotApproved: "Measurement plans require an approved initiative.",
    IdempotencyConflict: "This request replays an earlier import with different content. Use a new file or range.",
    MetricDefinitionNotFound: "That metric definition does not exist in this workspace.",
    ConversionColumnMissing: "The GA4 export is missing its key-events column while the metric defines one.",
    ConversionEventNotStated: "The GA4 export states a key-events column but the metric definition has no event; align the definition.",
    FixtureDisabled: "Synthetic fixtures are disabled for this environment.",
  }
  return reasons[reason] ?? `The measurement import was refused (${reason || err.tag}).`
}

const dateShift = (days: number): string => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10)

const PROVENANCE_LABELS = { OPERATOR_SUPPLIED_EXPORT: "Operator export", SYNTHETIC_FIXTURE: "Synthetic fixture", AUTHENTICATED_PROVIDER_API: "Read from Google Analytics" } as const

function ImportForm({ businessId, definitionId, sourceKind, done }: { businessId: string; definitionId: string; sourceKind: string; done: (imported: GrowthMetricImport, coverage: GrowthMetricCoverage, replayed: boolean) => Promise<void> }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return <form className="grid gap-3 p-5" onSubmit={async e => {
    e.preventDefault()
    const form = new FormData(e.currentTarget)
    setBusy(true); setError(null)
    try {
      const input = { provenance: String(form.get("provenance")), dateStart: String(form.get("dateStart")), dateEnd: String(form.get("dateEnd")), csv: String(form.get("csv") ?? "") }
      const { result } = await api<ImportResult>(`/api/growth/clients/${encodeURIComponent(businessId)}/metrics/${encodeURIComponent(definitionId)}/imports`, { method: "POST", body: JSON.stringify(input) })
      await done(result.import, result.coverage, result.replayed)
    } catch (err) { setError(measurementError(err)) } finally { setBusy(false) }
  }}>
    <p className="text-xs text-muted-foreground">
      {sourceKind === "GA4_AGGREGATE_EXPORT"
        ? "Paste a GA4 aggregate export (date × source/medium rows). Daily key events for the metric's configured event are imported; sessions and source rows are not stored."
        : "Paste your daily CSV with the header `date,value`, one row per reported day."}
      The reporting time zone always comes from the metric definition; it is never taken from the file.
    </p>
    <div className="grid gap-3 sm:grid-cols-3">
      <div className="grid gap-2"><Label htmlFor="import-provenance">Source of the file</Label>
        <Select name="provenance" defaultValue="OPERATOR_SUPPLIED_EXPORT">
          <SelectTrigger id="import-provenance"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="OPERATOR_SUPPLIED_EXPORT">Operator-supplied export</SelectItem>
            <SelectItem value="SYNTHETIC_FIXTURE">Synthetic fixture (synthetic data)</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="grid gap-2"><Label htmlFor="import-start">Coverage start</Label><Input id="import-start" name="dateStart" type="date" required defaultValue={dateShift(-7)} /></div>
      <div className="grid gap-2"><Label htmlFor="import-end">Coverage end</Label><Input id="import-end" name="dateEnd" type="date" required defaultValue={dateShift(0)} /></div>
    </div>
    <div className="grid gap-2"><Label htmlFor="import-csv">CSV content</Label><Textarea id="import-csv" name="csv" rows={6} required placeholder={sourceKind === "GA4_AGGREGATE_EXPORT" ? "# GA4 export\ndate,session source,session medium,sessions,key events" : "date,value"} /></div>
    {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
    <Button disabled={busy} className="justify-self-start">{busy ? "Importing…" : "Import daily aggregate"}</Button>
  </form>
}

function SeriesPanel({ businessId, definitionId, label, version, timeZone }: { businessId: string; definitionId: string; label: string; version: number; timeZone: string }) {
  const [start, setStart] = useState(dateShift(-13))
  const [end, setEnd] = useState(dateShift(0))
  const [series, setSeries] = useState<GrowthSeries | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const load = async (from: string, to: string) => {
    setBusy(true); setError(null)
    try { setSeries(await api<{ series: GrowthSeries }>(`/api/growth/clients/${encodeURIComponent(businessId)}/metrics/${encodeURIComponent(definitionId)}/series?start=${from}&end=${to}`).then(r => r.series)) }
    catch (err) { setError(measurementError(err)) } finally { setBusy(false) }
  }
  return <Panel>
    <PanelHeader title="Resolved daily series" description={`Newest reported import wins per day. ${label}, metric version ${version}; ${timeZone}.`} />
    <div className="flex flex-wrap items-end gap-2 p-5 pb-3">
      <div className="grid gap-1"><Label htmlFor="series-start">From</Label><Input id="series-start" type="date" value={start} onChange={e => setStart(e.target.value)} /></div>
      <div className="grid gap-1"><Label htmlFor="series-end">To</Label><Input id="series-end" type="date" value={end} onChange={e => setEnd(e.target.value)} /></div>
      <Button size="sm" disabled={busy} onClick={() => void load(start, end)}>{busy ? "Loading…" : "Load series"}</Button>
    </div>
    {error ? <p role="alert" className="px-5 pb-3 text-xs text-destructive">{error}</p> : null}
    {series ? <div className="px-5 pb-5">
      {series.conflicts.length > 0 ? <p role="alert" className="mb-3 text-xs text-destructive">
        {series.conflicts.length} day(s) have conflicting counts across imports (newest import resolves the value; the disagreement stays listed).
      </p> : null}
      {series.revisions?.length ? <p className="mb-3 text-xs text-muted-foreground">
        Google Analytics revised {series.revisions.length} day(s) after first collecting them ({series.revisions.map(r => `${r.day}: ${r.values.join(" → ")}`).join("; ")}). The newest figure is used; earlier ones stay on record.
      </p> : null}
      <ul className="grid gap-1 text-xs" aria-label="Daily series">
        {series.days.map(d => <li key={d.day} className="flex items-center gap-2">
          <span className="w-24 shrink-0 tabular-nums">{d.day}</span>
          <span className="w-16 shrink-0 tabular-nums">{d.value === null ? "—" : d.value.toLocaleString()}</span>
          {d.origin ? <Badge variant={d.origin === "REAL" ? "supported" : "review"}>{d.provider === "GA4_DATA_API" ? "google analytics" : d.origin.toLowerCase()}</Badge> : null}
          <span className="text-muted-foreground">{STATUS_LABELS[d.status]}</span>
        </li>)}
      </ul>
    </div> : null}
  </Panel>
}

export function GrowthMeasurement({ businessId, goals, ga4Status = null }: { businessId: string; goals: ReadonlyArray<GrowthGoal>; ga4Status?: string | null }) {
  const definitions = useMemo(() => {
    const byId = new Map<string, { id: string; label: string; version: number; sourceKind: string; timeZone: string; propertyRef: string | null; eventName: string | null }>()
    for (const g of goals) {
      const d = g.metricDefinition
      if (d.countingSemantics !== "EVENT_COUNT") continue
      if (!byId.has(d.id)) byId.set(d.id, { id: d.id, label: d.label, version: d.version, sourceKind: d.sourceKind, timeZone: d.reportingTimeZone, propertyRef: d.propertyRef, eventName: d.eventName })
    }
    return [...byId.values()]
  }, [goals])
  const [defId, setDefId] = useState(definitions[0]?.id ?? "")
  const [imports, setImports] = useState<ReadonlyArray<GrowthMetricImport> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const definition = definitions.find(d => d.id === defId)
  const loadImports = async (id: string) => {
    setBusy(true); setError(null)
    try { setImports(await api<{ imports: ReadonlyArray<GrowthMetricImport> }>(`/api/growth/clients/${encodeURIComponent(businessId)}/metrics/${encodeURIComponent(id)}/imports`).then(r => r.imports)) }
    catch (err) { setError(measurementError(err)) } finally { setBusy(false) }
  }
  if (definitions.length === 0) return <Panel><EmptyState icon={<TriangleAlertIcon />} title="No count metrics yet" description="Measurement imports need a metric definition with EVENT_COUNT counting and a COUNT unit. Currency metrics are not measured yet." /></Panel>
  return <div className="space-y-5">
    <Panel>
      <PanelHeader title="Daily measurement imports" description="Bind daily aggregates to an immutable metric definition. Replays of identical files are idempotent; conflicting exports stay visible in the series." />
      <div className="flex flex-wrap items-end gap-2 p-5 pb-3">
        <div className="grid min-w-60 gap-2"><Label htmlFor="definition">Metric definition</Label>
          <Select value={defId} onValueChange={v => { setDefId(v); setNotice(null) }}>
            <SelectTrigger id="definition"><SelectValue /></SelectTrigger>
            <SelectContent>{definitions.map(d => <SelectItem key={d.id} value={d.id}>{d.label} (v{d.version})</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <Button size="sm" disabled={busy || !defId} onClick={() => void loadImports(defId)}>{busy ? "Loading…" : "Show imports"}</Button>
      </div>
      {error ? <p role="alert" className="px-5 pb-3 text-xs text-destructive">{error}</p> : null}
      {notice ? <p className="px-5 pb-3 text-xs text-muted-foreground">{notice}</p> : null}
      {definition ? <p className="px-5 pb-3 text-xs text-muted-foreground">{definition.sourceKind === "GA4_AGGREGATE_EXPORT" ? "GA4 aggregate export" : "Operator aggregate CSV"}, reporting time zone {definition.timeZone}. Currency aggregation is refused until implemented.</p> : null}
      {imports !== null ? <div className="px-5 pb-3">
        {imports.length === 0 ? <p className="text-xs text-muted-foreground">No imports for this definition yet.</p> : <ul className="divide-y text-xs" aria-label="Imports">
          {imports.map(i => <li key={i.id} className="flex flex-wrap items-center gap-2 py-2">
            <Badge variant={i.provenance === "SYNTHETIC_FIXTURE" ? "review" : "supported"}>{PROVENANCE_LABELS[i.provenance]}</Badge>
            <span className="tabular-nums">{i.dateStart} → {i.dateEnd}</span>
            <span>{i.rowCount} days, {i.timeZone}</span>
            <span className="text-muted-foreground">digest {i.rawDigest.slice(0, 10)}…</span>
          </li>)}
        </ul>}
      </div> : null}
      {definition ? <ImportForm businessId={businessId} definitionId={definition.id} sourceKind={definition.sourceKind} done={async (imported, coverage, replayed) => {
        setNotice(`${replayed ? "Replayed import — same bytes, unchanged record" : "Imported"}: ${imported.id.slice(0, 8)}… (${coverage.daysPresent}/${coverage.daysInRange} days reported${coverage.missingDays ? `, ${coverage.missingDays} missing` : ""}). Raw bytes are preserved and the file is replay-safe by digest.`)
        await loadImports(defId)
      }} /> : null}
    </Panel>
    <Ga4Panel businessId={businessId} definition={definition} callbackStatus={ga4Status} />
    {definition ? <SeriesPanel businessId={businessId} definitionId={definition.id} label={definition.label} version={definition.version} timeZone={definition.timeZone} /> : null}
  </div>
}
