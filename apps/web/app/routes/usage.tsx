// Usage and cost for the account: agent turns and tokens by model and
// business, research provider calls and what OpenRecord charged for them, and
// AI answer checks. Token counts are as providers reported them; estimated
// model cost appears only where the server has prices, and is never a bill.
import { useEffect, useState } from "react"
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts"
import { Skeleton } from "@/components/ui/skeleton"
import { PageHeader, Panel, PanelHeader, StatStrip, type Stat } from "@/components/page"
import { PeriodSelect } from "@/components/period-select"
import { useCssColors } from "@/components/charts"
import { useChrome } from "@/components/app-shell"
import { api } from "@/lib/api"
import { errorMessage } from "@/lib/format"
import { useApi } from "@/lib/use-api"

type Usage = {
  days: number
  agent: { turns: number; promptTokens: number | null; outputTokens: number | null; thoughtTokens: number | null; totalTokens: number | null; toolCalls: number; modelSteps: number; averageMs: number | null; turnsWithoutTokenCounts: number; estimatedUsd: number | null; unpricedTurns: number }
  byModel: Array<{ provider: string; model: string; turns: number; promptTokens: number | null; outputTokens: number | null; thoughtTokens: number | null; totalTokens: number | null; toolCalls: number; estimatedUsd: number | null; priced: boolean }>
  byBusiness: Array<{ businessId: string | null; name: string; turns: number; totalTokens: number | null; toolCalls: number }>
  daily: Array<{ date: string; turns: number; totalTokens: number | null }>
  research: { calls: number; chargedUsd: number; byProvider: Array<{ provider: string; calls: number; failed: number; paidCalls: number; chargedUsd: number }> }
  checks: { answers: number; byProvider: Array<{ provider: string; answers: number }> }
  note: string
}
const PERIODS = [7, 30, 90] as const
const tokens = (v: number | null) => v === null ? "—" : v >= 1_000_000 ? `${(v / 1_000_000).toFixed(1)}M` : v >= 10_000 ? `${Math.round(v / 1000)}k` : v.toLocaleString()
const usd = (v: number | null) => v === null ? "—" : v < 0.01 && v > 0 ? "<$0.01" : `$${v.toFixed(2)}`

function Daily({ rows }: { rows: Usage["daily"] }) {
  const c = useCssColors(["--series-1", "--muted-foreground", "--border", "--card", "--foreground"])
  return (
    <div className="h-44 w-full">
      <ResponsiveContainer>
        <BarChart data={rows.map(r => ({ ...r, label: r.date.slice(5) }))} margin={{ top: 8, right: 4, bottom: 0, left: 0 }} barCategoryGap="20%">
          <CartesianGrid vertical={false} stroke={c["--border"] || "currentColor"} strokeOpacity={0.6} />
          <XAxis dataKey="label" stroke={c["--muted-foreground"] || "currentColor"} fontSize={11} tickLine={false} axisLine={false} interval="preserveStartEnd" />
          <YAxis allowDecimals={false} stroke={c["--muted-foreground"] || "currentColor"} fontSize={11} tickLine={false} axisLine={false} width={28} />
          <Tooltip cursor={{ fill: c["--border"] || "currentColor", opacity: 0.35 }} contentStyle={{ background: c["--card"], border: "none", borderRadius: 10, boxShadow: "var(--float-shadow)", fontSize: 12 }}
            itemStyle={{ color: c["--foreground"] }} formatter={(v: unknown) => [`${v} turn${v === 1 ? "" : "s"}`, "Agent"]} />
          <Bar dataKey="turns" fill={c["--series-1"] || "currentColor"} radius={[4, 4, 0, 0]} maxBarSize={18} isAnimationActive animationDuration={600} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

function Table({ head, rows }: { head: string[]; rows: Array<Array<React.ReactNode>> }) {
  if (!rows.length) return <p className="px-4 pb-4 text-xs text-muted-foreground">Nothing in this period.</p>
  return (
    <div className="overflow-x-auto px-2 pb-2">
      <table className="w-full border-collapse text-xs">
        <thead><tr className="text-muted-foreground">{head.map((h, i) => <th key={h} className={i ? "px-2 py-1.5 text-right font-medium" : "px-2 py-1.5 text-left font-medium"}>{h}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={i} className="border-t border-border/60">{r.map((c, j) => <td key={j} className={j ? "px-2 py-2 text-right tabular-nums" : "px-2 py-2"}>{c}</td>)}</tr>)}</tbody>
      </table>
    </div>
  )
}

export function UsagePage() {
  const { setWorkspace } = useChrome()
  useEffect(() => { setWorkspace(true); return () => setWorkspace(false) }, [setWorkspace])
  const [days, setDays] = useState<(typeof PERIODS)[number]>(30)
  const q = useApi(`usage:${days}`, () => api<Usage>(`/api/usage?days=${days}`))
  const u = q.data
  const stats: Stat[] = u ? [
    { key: "turns", label: "Agent turns", value: u.agent.turns.toLocaleString(), hint: `${u.agent.toolCalls.toLocaleString()} tool calls · ${u.agent.modelSteps.toLocaleString()} model steps` },
    { key: "tokens", label: "Tokens", value: tokens(u.agent.totalTokens), hint: u.agent.turnsWithoutTokenCounts ? `${u.agent.turnsWithoutTokenCounts} turns reported none` : `${tokens(u.agent.promptTokens)} in · ${tokens(u.agent.outputTokens)} out` },
    { key: "cost", label: "Estimated model cost", value: usd(u.agent.estimatedUsd), hint: u.agent.unpricedTurns ? `${u.agent.unpricedTurns} turns on unpriced models` : "At this server's prices" },
    { key: "research", label: "Research charged", value: usd(u.research.chargedUsd), hint: `${u.research.calls.toLocaleString()} provider calls` },
    { key: "checks", label: "AI answers collected", value: u.checks.answers.toLocaleString(), hint: `${u.checks.byProvider.length} provider${u.checks.byProvider.length === 1 ? "" : "s"}` },
  ] : []
  return (
    <div className="rise-in mx-auto w-full max-w-[1200px] space-y-6 px-4 pt-6 pb-10 sm:px-6 lg:px-10">
      <PageHeader title="Usage" description="What the agent, research providers and AI answer checks used across your account. Token counts are as each provider reported them."
        actions={<PeriodSelect value={days} options={PERIODS} onChange={setDays} />} />
      {q.error && !u ? <p role="alert" className="text-sm text-destructive">{errorMessage(q.error)}</p> : !u ? <Skeleton className="h-64 rounded-xl" /> : (
        <>
          <StatStrip stats={stats} />
          <Panel>
            <PanelHeader title="Agent turns per day" description={`Last ${u.days} days`} />
            <div className="px-4 pb-4"><Daily rows={u.daily} /></div>
          </Panel>
          <div className="grid gap-4 lg:grid-cols-2">
            <Panel>
              <PanelHeader title="By model" description="Estimated cost only where this server has the model's prices" />
              <Table head={["Model", "Turns", "Tokens in", "Tokens out", "Est. cost"]}
                rows={u.byModel.map(m => [<span key="m" className="font-medium">{m.model}<span className="block text-[0.6875rem] font-normal text-muted-foreground">{m.provider}</span></span>,
                  m.turns, tokens(m.promptTokens), tokens((m.outputTokens ?? 0) + (m.thoughtTokens ?? 0) || null), m.priced ? usd(m.estimatedUsd) : <span key="p" className="text-muted-foreground">Not priced</span>])} />
            </Panel>
            <Panel>
              <PanelHeader title="By business" />
              <Table head={["Business", "Turns", "Tokens", "Tool calls"]} rows={u.byBusiness.map(b => [b.name, b.turns, tokens(b.totalTokens), b.toolCalls])} />
            </Panel>
            <Panel>
              <PanelHeader title="Research providers" description="Calls on your own connections and public sources are never charged" />
              <Table head={["Provider", "Calls", "Failed", "Charged"]} rows={u.research.byProvider.map(r => [r.provider, r.calls, r.failed, r.paidCalls ? usd(r.chargedUsd) : "—"])} />
            </Panel>
            <Panel>
              <PanelHeader title="AI answers collected" description="Answers saved from AI answer checks, by provider" />
              <Table head={["Provider", "Answers"]} rows={u.checks.byProvider.map(c => [c.provider, c.answers])} />
            </Panel>
          </div>
          <p className="text-xs text-muted-foreground">{u.note}</p>
        </>
      )}
    </div>
  )
}
