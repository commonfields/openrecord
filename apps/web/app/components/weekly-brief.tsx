// This week, at the top of Results: the agent's weekly growth brief laid out
// as a report. The goal trend and the one thing to do next lead; what changed,
// what earlier work changed and open investigations follow as their own cards.
// The idea it saved is ready to approve, and its chat is a click away.
import { useEffect, useRef, useState, type ReactNode } from "react"
import { Link } from "react-router"
import { toast } from "sonner"
import { ActivityIcon, CalendarIcon, HistoryIcon, MessageSquareIcon, PlugIcon, RefreshCwIcon, SearchIcon, TargetIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Panel } from "@/components/page"
import { ChatMarkdown } from "@/components/chat-markdown"
import { InitiativeCard } from "@/components/agent-chat"
import { ThinkingGlyph } from "@/components/agent-trace"
import { chatPath } from "@/lib/agent-chats"
import { Briefs, briefFailure, briefParts, type Brief, type BriefSection, type BriefSectionKind } from "@/lib/brief"
import { relativeTime } from "@/lib/format"
import { useApi } from "@/lib/use-api"
import { cn } from "@/lib/utils"
import { AreaTrendChart } from "@/components/charts"
import type { OverviewData } from "@/components/today-overview"

const SECTION_ICON: Record<BriefSectionKind, ReactNode> = {
  changed: <ActivityIcon />,
  next: <TargetIcon />,
  results: <HistoryIcon />,
  investigating: <SearchIcon />,
  other: <ActivityIcon />,
}
const BODY = "text-sm leading-6 [&_li]:my-1 [&_p]:my-2 [&_p:first-child]:mt-0 [&_ul]:my-2"

export function WeeklyBrief({ businessId, overview }: { businessId: string; overview: OverviewData }) {
  const q = useApi(`brief:${businessId}`, () => Briefs.get(businessId))
  const [busy, setBusy] = useState(false)
  const running = q.data?.brief?.status === "RUNNING"
  // While one is being written, check back every few seconds.
  const reload = useRef(q.reload)
  reload.current = q.reload
  useEffect(() => {
    if (!running) return
    const t = window.setInterval(() => { void reload.current() }, 4000)
    return () => window.clearInterval(t)
  }, [running])
  if (!q.data) return q.loading ? <Skeleton className="h-40 rounded-xl" /> : null
  const { brief, previous, schedule } = q.data
  const shown: Brief | null = brief?.status === "READY" ? brief : previous
  const act = async (f: () => Promise<unknown>) => { setBusy(true); try { await f(); await q.reload() } catch { toast.error("Could not update the weekly brief. Try again.") } finally { setBusy(false) } }

  const parts = shown?.text ? briefParts(shown.text) : null
  const next = parts?.sections.find(s => s.kind === "next") ?? null
  const rest = parts?.sections.filter(s => s !== next) ?? []
  const initiatives = shown?.decisions.filter(d => d.type === "GROWTH_OPPORTUNITY") ?? []
  const savedProposal = shown?.decisions.some(d => d.type === "AGENT_PROPOSAL") ?? false
  const decisions = (
    <>
      {initiatives.map(d => <InitiativeCard key={d.id} businessId={businessId} opportunityId={d.id} />)}
      {savedProposal ? <Button asChild size="sm" variant="secondary"><Link to="/approvals">Review what it saved</Link></Button> : null}
    </>
  )

  return (
    <Panel id="brief">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3 border-b border-border/60 px-5 py-4 sm:px-6">
        <div className="min-w-0 flex-1">
          <h2 id="brief-title" className="text-base font-semibold tracking-tight">This week</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {shown?.finishedAt ? `Your agent's brief, updated ${relativeTime(shown.finishedAt)}` : "Your agent's weekly brief"}
            {schedule.enabled ? `. Next one ${relativeTime(schedule.nextRunAt)}` : ""}
          </p>
        </div>
        {/* The same compact controls as the toolbars above other cards. */}
        <div className="flex flex-wrap items-center gap-2">
          <Select value={schedule.enabled ? "weekly" : "off"} disabled={busy} onValueChange={v => void act(() => Briefs.schedule(businessId, v === "weekly"))}>
            <SelectTrigger className="h-8 w-[8.5rem] text-xs" aria-label="How often the brief is written">
              <CalendarIcon className="size-3.5 text-muted-foreground" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end">
              <SelectItem value="weekly">Every week</SelectItem>
              <SelectItem value="off">Off</SelectItem>
            </SelectContent>
          </Select>
          {shown?.conversationId ? (
            <Button asChild variant="outline" size="sm" className="h-8 text-xs">
              <Link to={chatPath({ businessId, id: shown.conversationId })}><MessageSquareIcon />Ask about it</Link>
            </Button>
          ) : null}
          <Button variant="outline" size="sm" className="h-8 text-xs" disabled={busy || running} onClick={() => void act(() => Briefs.run(businessId))}>
            <RefreshCwIcon />{shown ? "Write a new one" : "Write it now"}
          </Button>
        </div>
      </div>

      <div className="space-y-4 px-5 py-5 sm:px-6">
        {running ? (
          <p role="status" className="flex items-center gap-1.5 text-sm text-muted-foreground"><ThinkingGlyph /><span className="thinking">Reading this week's numbers and writing the brief</span></p>
        ) : brief?.status === "FAILED" ? (
          <p role="alert" className="text-sm text-destructive">{briefFailure(brief.failure)}</p>
        ) : null}

        {/* The goal trend and the one action lead, side by side on wide screens. */}
        <div className={cn("grid gap-4", next && "lg:grid-cols-5")}>
          <div className={cn("min-w-0", next && "lg:col-span-3")}><WeeklyMeasurement data={overview} /></div>
          {next ? (
            <section aria-labelledby="brief-next" className="flex min-w-0 flex-col gap-3 rounded-[10px] bg-card shadow-(--card-shadow) p-4 lg:col-span-2">
              <SectionTitle id="brief-next" icon={SECTION_ICON.next} accent>{next.title}</SectionTitle>
              <ChatMarkdown text={next.body} className={BODY} />
              {initiatives.length || savedProposal ? <div className="mt-auto space-y-2">{decisions}</div> : null}
            </section>
          ) : null}
        </div>

        {parts && parts.sections.length ? (
          <>
            {rest.length ? (
              <div className={cn("grid gap-4", rest.length > 1 && "md:grid-cols-2", rest.length > 2 && "xl:grid-cols-3")}>
                {rest.map(s => <SectionCard key={s.title} section={s} />)}
              </div>
            ) : null}
            {!next && (initiatives.length || savedProposal) ? <div className="space-y-2">{decisions}</div> : null}
            {parts.note ? (
              <p className="flex items-start gap-2 rounded-[10px] bg-card shadow-(--card-shadow) px-3.5 py-2.5 text-xs leading-5 text-muted-foreground">
                <PlugIcon className="mt-0.5 size-3.5 shrink-0" /><span>{parts.note.replace(/\*\*/g, "")}</span>
              </p>
            ) : null}
          </>
        ) : shown?.text ? (
          // Not in the usual shape: show it as written.
          <>
            <ChatMarkdown text={shown.text} className="max-w-3xl text-[0.9375rem] leading-7 [&_li]:my-1.5 [&_p]:my-3" />
            {decisions}
          </>
        ) : !running && brief?.status !== "FAILED" ? (
          <p className="text-sm text-muted-foreground">Your first brief will appear here: what changed, the one thing to do next, and what earlier work changed.</p>
        ) : null}
      </div>
    </Panel>
  )
}

// A section's heading: its icon in a small tile, then the title. The one
// action ("Do this next") gets the navy tile.
function SectionTitle({ id, icon, accent, children }: { id: string; icon: ReactNode; accent?: boolean; children: ReactNode }) {
  return (
    <h3 id={id} className="flex items-center gap-2 text-[0.8125rem] font-medium">
      <span className={cn("flex size-6 shrink-0 items-center justify-center rounded-md [&_svg]:size-3.5", accent ? "bg-primary-ink text-primary-foreground" : "bg-muted text-muted-foreground")}>{icon}</span>
      {children}
    </h3>
  )
}

function SectionCard({ section }: { section: BriefSection }) {
  const id = `brief-${section.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`
  return (
    <section aria-labelledby={id} className="min-w-0 space-y-3 rounded-[10px] bg-card shadow-(--card-shadow) p-4">
      <SectionTitle id={id} icon={SECTION_ICON[section.kind]}>{section.title}</SectionTitle>
      <ChatMarkdown text={section.body} className={BODY} />
    </section>
  )
}

/** The goal-metric block at the top of "This week": a labelled 7-day trend
 * with honest gap reporting. Exported for tests. */
export function WeeklyMeasurement({ data }: { data: OverviewData }) {
  const series = data.series
  if (data.loading.growth) return <Skeleton className="h-36 rounded-lg" />
  const days = [...(series?.days ?? [])].sort((a, b) => a.day.localeCompare(b.day)).slice(-7)
  const observed = days.filter(d => (d.status === "OK" || d.status === "CONFLICT") && d.value !== null)
  if (!series || !observed.length) return <div className="h-full rounded-[10px] bg-card shadow-(--card-shadow) px-4 py-4 text-sm text-muted-foreground">
    <p className="font-medium text-foreground">No goal measurements for the last 7 days</p>
    <p className="mt-1">Connect or import your goal data to see its trend here.</p>
  </div>
  const rows = days.map(d => ({ date: d.day, value: (d.status === "OK" || d.status === "CONFLICT") && d.value !== null ? d.value : "" }))
  const formatDate = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" })
  const hasConflict = days.some(d => d.status === "CONFLICT")
  // A 7-day total only means something for counts; money is shown by its trend.
  const total = series.unit === "COUNT" ? observed.reduce((sum, d) => sum + (d.value ?? 0), 0) : null
  return <div className="h-full rounded-[10px] bg-card shadow-(--card-shadow) px-4 py-4">
    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
      <div>
        <p className="text-xs font-medium text-muted-foreground">{series.metricLabel}</p>
        {total !== null ? <p className="mt-1 text-2xl font-semibold tabular-nums tracking-tight">{total.toLocaleString()}</p> : null}
        <p className="mt-0.5 text-xs text-muted-foreground">Daily measurements over the last 7 days, through yesterday</p>
      </div>
      <span className="rounded-full bg-muted px-2 py-0.5 text-[0.6875rem] text-muted-foreground">{observed.length} of 7 days reported</span>
    </div>
    <div className="mt-3" role="img" aria-label={`${series.metricLabel}, daily measurements for the last seven days; ${observed.length} of seven days reported`}>
      <AreaTrendChart data={rows} dataKey="value" label={series.metricLabel} height={150} formatDate={formatDate} formatValue={v => v.toLocaleString()} />
    </div>
    <p className="mt-2 text-xs text-muted-foreground">{observed.length < 7 ? "Gaps are days without a reported measurement. " : ""}{hasConflict ? "Some days have conflicting imports; the latest reported values are shown. " : ""}This trend does not establish what caused a change.</p>
  </div>
}
