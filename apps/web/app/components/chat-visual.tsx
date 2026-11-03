// Visual replies: the agent answers with a chart or stat tiles by writing a
// fenced ```chart block holding a small JSON spec. The chat draws it with the
// app's own chart components and palette; nothing the agent writes runs as
// code or HTML. Every chart has a table view (light-mode contrast needs it),
// a legend from two series, direct labels where they fit, and hover values.
import { useMemo, useState } from "react"
import { Bar, BarChart, CartesianGrid, Cell, LabelList, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"
import { BarChart3Icon, TableIcon } from "lucide-react"
import { Legend, useCssColors } from "@/components/charts"
import { cn } from "@/lib/utils"

export type VisualSpec =
  | { readonly type: "bar" | "line" | "donut"; readonly title: string; readonly unit: string | null; readonly labels: ReadonlyArray<string>; readonly series: ReadonlyArray<{ readonly name: string; readonly values: ReadonlyArray<number | null> }>; readonly note: string | null }
  | { readonly type: "stats"; readonly title: string; readonly stats: ReadonlyArray<{ readonly label: string; readonly value: string; readonly hint: string | null }>; readonly note: string | null }

const MAX_SERIES = 8, MAX_POINTS = 60, MAX_STATS = 6, DONUT_SLICES = 6
const str = (v: unknown, max: number) => typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null
const num = (v: unknown) => typeof v === "number" && Number.isFinite(v) ? v : v === null ? null : undefined

/** The spec in a ```chart block, or null when it is not a valid one (it is then shown as text). */
export function parseVisual(raw: string): VisualSpec | null {
  let j: unknown
  try { j = JSON.parse(raw) } catch { return null }
  if (!j || typeof j !== "object") return null
  const o = j as Record<string, unknown>
  const title = str(o["title"], 120) ?? ""
  const note = str(o["note"], 300)
  if (o["type"] === "stats") {
    if (!Array.isArray(o["stats"])) return null
    const stats = (o["stats"] as unknown[]).slice(0, MAX_STATS).flatMap(s => {
      const x = s as Record<string, unknown>
      const label = str(x?.["label"], 60), value = typeof x?.["value"] === "number" ? String(x["value"]) : str(x?.["value"], 30)
      return label && value ? [{ label, value, hint: str(x["hint"], 80) }] : []
    })
    return stats.length ? { type: "stats", title, stats, note } : null
  }
  if (o["type"] !== "bar" && o["type"] !== "line" && o["type"] !== "donut") return null
  if (!Array.isArray(o["labels"]) || !Array.isArray(o["series"])) return null
  const labels = (o["labels"] as unknown[]).slice(0, MAX_POINTS).map(l => str(l, 40) ?? "")
  if (!labels.length || labels.some(l => !l)) return null
  const series = (o["series"] as unknown[]).slice(0, o["type"] === "donut" ? 1 : MAX_SERIES).flatMap(s => {
    const x = s as Record<string, unknown>
    const name = str(x?.["name"], 60) ?? "Value"
    if (!Array.isArray(x?.["values"])) return []
    const values = labels.map((_, i) => num((x["values"] as unknown[])[i]))
    return values.some(v => v === undefined) ? [] : [{ name, values: values as Array<number | null> }]
  })
  if (!series.length || series.every(s => s.values.every(v => v === null))) return null
  if (o["type"] === "donut" && series[0]!.values.some(v => v !== null && v < 0)) return null
  return { type: o["type"], title, unit: str(o["unit"], 12), labels, series, note }
}

const SERIES_VARS = Array.from({ length: MAX_SERIES }, (_, i) => `--series-${i + 1}`)
const fmt = (v: number | null, unit: string | null) => v === null ? "—" : `${v.toLocaleString(undefined, { maximumFractionDigits: 2 })}${unit === "%" ? "%" : unit ? ` ${unit}` : ""}`

function TableView({ spec }: { spec: Extract<VisualSpec, { labels: unknown }> }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-xs">
        <thead><tr className="text-muted-foreground"><th className="px-2 py-1.5 text-left font-medium"></th>{spec.series.map(s => <th key={s.name} className="px-2 py-1.5 text-right font-medium">{s.name}</th>)}</tr></thead>
        <tbody>{spec.labels.map((l, i) => (
          <tr key={l + i} className="border-t border-border/60"><td className="px-2 py-1.5">{l}</td>{spec.series.map(s => <td key={s.name} className="px-2 py-1.5 text-right tabular-nums">{fmt(s.values[i] ?? null, spec.unit)}</td>)}</tr>
        ))}</tbody>
      </table>
    </div>
  )
}

function Plot({ spec }: { spec: Extract<VisualSpec, { labels: unknown }> }) {
  const css = useCssColors([...SERIES_VARS, "--muted-foreground", "--border", "--card", "--foreground"])
  // Colours resolve after the first paint; until then marks take the text colour.
  const c = (v: string) => css[v] || "currentColor"
  const rows = useMemo(() => spec.labels.map((label, i) => Object.fromEntries([["label", label], ...spec.series.map((s, k) => [`s${k}`, s.values[i] ?? null])])), [spec])
  const axis = { stroke: c("--muted-foreground"), fontSize: 11, tickLine: false, axisLine: false } as const
  const tooltip = <Tooltip cursor={spec.type === "line" ? { stroke: c("--border"), strokeWidth: 1 } : { fill: c("--border"), opacity: 0.35 }}
    contentStyle={{ background: c("--card"), border: "none", borderRadius: 10, boxShadow: "var(--float-shadow)", fontSize: 12, color: c("--foreground") }}
    itemStyle={{ color: c("--foreground") }} labelStyle={{ color: c("--muted-foreground"), marginBottom: 2 }}
    formatter={(v: unknown, _n: unknown, item: { dataKey?: unknown }) => [fmt(typeof v === "number" ? v : null, spec.unit), spec.series[Number(String(item.dataKey ?? "s0").slice(1))]?.name ?? ""]} />
  if (spec.type === "donut") {
    const values = spec.series[0]!.values.map(v => v ?? 0)
    // Past six slices the rest fold into "Other": never a generated colour.
    const order = values.map((v, i) => ({ label: spec.labels[i]!, v })).sort((a, b) => b.v - a.v)
    const slices = order.length > DONUT_SLICES ? [...order.slice(0, DONUT_SLICES - 1), { label: "Other", v: order.slice(DONUT_SLICES - 1).reduce((s, x) => s + x.v, 0) }] : order
    const total = slices.reduce((s, x) => s + x.v, 0)
    return (
      <div className="flex flex-wrap items-center gap-4">
        <div className="h-40 w-40 shrink-0">
          <ResponsiveContainer>
            <PieChart>
              <Pie data={slices} dataKey="v" nameKey="label" innerRadius="62%" outerRadius="100%" paddingAngle={1.5} stroke={c("--card")} strokeWidth={2} isAnimationActive animationDuration={700}>
                {slices.map((s, i) => <Cell key={s.label} fill={s.label === "Other" ? c("--muted-foreground") : c(SERIES_VARS[i]!)} />)}
              </Pie>
              <Tooltip contentStyle={{ background: c("--card"), border: "none", borderRadius: 10, boxShadow: "var(--float-shadow)", fontSize: 12 }} itemStyle={{ color: c("--foreground") }} formatter={(v: unknown) => fmt(typeof v === "number" ? v : null, spec.unit)} />
            </PieChart>
          </ResponsiveContainer>
        </div>
        <Legend items={slices.map((s, i) => ({ label: s.label, cssVar: s.label === "Other" ? "--muted-foreground" : SERIES_VARS[i]!, value: total ? `${fmt(s.v, spec.unit)} · ${Math.round((s.v / total) * 100)}%` : fmt(s.v, spec.unit) }))} />
      </div>
    )
  }
  const many = spec.series.length > 1
  return (
    <div className="h-56 w-full">
      <ResponsiveContainer>
        {spec.type === "bar" ? (
          <BarChart data={rows} margin={{ top: 18, right: 8, bottom: 0, left: 0 }} barGap={2} barCategoryGap="24%">
            <CartesianGrid vertical={false} stroke={c("--border")} strokeOpacity={0.6} />
            <XAxis dataKey="label" {...axis} interval="preserveStartEnd" />
            <YAxis {...axis} width={40} tickFormatter={(v: number) => fmt(v, spec.unit === "%" ? "%" : null)} />
            {tooltip}
            {spec.series.map((s, k) => (
              <Bar key={s.name} dataKey={`s${k}`} fill={c(SERIES_VARS[k]!)} radius={[4, 4, 0, 0]} maxBarSize={36} isAnimationActive animationDuration={600} animationBegin={k * 80}>
                {/* Direct labels for one series that fits: the values are readable without hover. */}
                {!many && rows.length <= 12 ? <LabelList dataKey={`s${k}`} position="top" fontSize={11} fill={c("--foreground")} formatter={(v: unknown) => fmt(typeof v === "number" ? v : null, spec.unit)} /> : null}
              </Bar>
            ))}
          </BarChart>
        ) : (
          <LineChart data={rows} margin={{ top: 12, right: 12, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} stroke={c("--border")} strokeOpacity={0.6} />
            <XAxis dataKey="label" {...axis} interval="preserveStartEnd" />
            <YAxis {...axis} width={40} tickFormatter={(v: number) => fmt(v, spec.unit === "%" ? "%" : null)} />
            {tooltip}
            {spec.series.map((s, k) => (
              <Line key={s.name} dataKey={`s${k}`} stroke={c(SERIES_VARS[k]!)} strokeWidth={2} dot={rows.length <= 12 ? { r: 3, strokeWidth: 0, fill: c(SERIES_VARS[k]!) } : false}
                activeDot={{ r: 5, stroke: c("--card"), strokeWidth: 2 }} connectNulls={false} isAnimationActive animationDuration={900} animationBegin={k * 100} />
            ))}
          </LineChart>
        )}
      </ResponsiveContainer>
    </div>
  )
}

export function ChatVisual({ raw, live = false }: { raw: string; live?: boolean }) {
  const spec = useMemo(() => parseVisual(raw), [raw])
  const [table, setTable] = useState(false)
  if (!spec) return live
    ? <div className="my-3 flex h-24 items-center justify-center gap-2 rounded-[10px] bg-card text-xs text-muted-foreground shadow-(--card-shadow)"><BarChart3Icon className="size-4 animate-pulse" />Drawing chart…</div>
    : <pre className="my-3 overflow-x-auto rounded-[10px] bg-muted/60 p-3 text-xs"><code>{raw}</code></pre>
  return (
    <figure className="step-in my-3 space-y-3 rounded-[12px] bg-card p-4 shadow-(--card-shadow)">
      <figcaption className="flex items-start justify-between gap-3">
        <span className="text-sm font-medium text-foreground">{spec.title}</span>
        {spec.type !== "stats" ? (
          <button type="button" onClick={() => setTable(v => !v)} aria-pressed={table}
            className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[0.6875rem] text-muted-foreground hover:bg-muted hover:text-foreground [&_svg]:size-3">
            {table ? <BarChart3Icon /> : <TableIcon />}{table ? "Chart" : "Table"}
          </button>
        ) : null}
      </figcaption>
      {spec.type === "stats" ? (
        <div className="chips-in grid grid-cols-2 gap-2 sm:grid-cols-3">
          {spec.stats.map(s => (
            <div key={s.label} className="rounded-[10px] bg-muted/50 px-3 py-2.5">
              <p className="text-[0.6875rem] text-muted-foreground">{s.label}</p>
              <p className="text-xl font-semibold tracking-tight tabular-nums">{s.value}</p>
              {s.hint ? <p className="text-[0.6875rem] text-muted-foreground">{s.hint}</p> : null}
            </div>
          ))}
        </div>
      ) : table ? <TableView spec={spec} /> : (
        <>
          <Plot spec={spec} />
          {spec.series.length > 1 && spec.type !== "donut" ? <Legend items={spec.series.map((s, k) => ({ label: s.name, cssVar: SERIES_VARS[k]! }))} /> : null}
        </>
      )}
      {spec.note ? <p className={cn("text-[0.6875rem] text-muted-foreground")}>{spec.note}</p> : null}
    </figure>
  )
}
