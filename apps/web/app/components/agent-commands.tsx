import { useMemo, type ReactNode } from "react"
import { Link } from "react-router"
import { ArrowRightIcon, ListChecksIcon, ClipboardListIcon, FileBarChartIcon, CompassIcon } from "lucide-react"
import type { GrowthOpportunity } from "@openrecord/contracts"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { buildActions, goalTotals, useOverviewData } from "@/components/today-overview"
import { Agent } from "@/lib/api"
import { growthPath } from "@/lib/growth"
import { Channels, type SetupView } from "@/lib/setup"
import { useApi } from "@/lib/use-api"
import { cn } from "@/lib/utils"

export type AgentCommand = "setup" | "status" | "plan" | "report"

export const COMMANDS: ReadonlyArray<{ readonly key: AgentCommand; readonly description: string; readonly icon: ReactNode }> = [
  { key: "setup", description: "Understand and configure this business", icon: <CompassIcon /> },
  { key: "status", description: "Current work, channels and blockers", icon: <ListChecksIcon /> },
  { key: "plan", description: "What to do next, most important first", icon: <ClipboardListIcon /> },
  { key: "report", description: "What was done, verified and measured", icon: <FileBarChartIcon /> },
]

// Exact phrasings only: anything looser goes to the conversational agent, so a
// command never fires on a sentence that merely contains the word.
const PHRASES: ReadonlyArray<readonly [AgentCommand, RegExp]> = [
  ["setup", /^(let'?s )?(set ?up|onboard)( (my|this|the) (business|company|workspace))?[.!]?$/i],
  ["status", /^(status|what'?s the status|where are we|show (me )?(the )?status)\??$/i],
  ["plan", /^(plan|what should (i|we) do next|what'?s next|next steps?)\??$/i],
  ["report", /^(report|show (me )?(the )?(report|results)|how are we doing)\??$/i],
]

/** A typed application command, or null when the text is a message for the agent. */
export const parseCommand = (text: string): AgentCommand | null => {
  const t = text.trim()
  const slash = /^\/(\w+)\s*$/.exec(t)
  if (slash) return COMMANDS.find(c => c.key === slash[1]!.toLowerCase())?.key ?? null
  return PHRASES.find(([, re]) => re.test(t))?.[0] ?? null
}

/** Commands matching what has been typed after "/", for the composer menu. */
export const commandMatches = (text: string) => {
  const m = /^\/(\w*)$/.exec(text.trim())
  return m ? COMMANDS.filter(c => c.key.startsWith(m[1]!.toLowerCase())) : []
}

/* ---------------------------------------------------------------- cards */

function Card({ title, children, footer }: { title: string; children: ReactNode; footer?: ReactNode }) {
  return (
    <section aria-label={title} className="space-y-3 rounded-2xl bg-card p-5 text-left shadow-(--card-shadow) animate-in fade-in duration-300">
      <p className="text-sm font-medium">{title}</p>
      {children}
      {footer ? <div className="flex flex-wrap gap-2 pt-1">{footer}</div> : null}
    </section>
  )
}

function Row({ label, value, to, tone }: { label: string; value: ReactNode; to?: string; tone?: "gap" | "ok" | "unknown" | undefined }) {
  const body = (
    <>
      {tone ? <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", tone === "gap" ? "bg-wrong" : tone === "ok" ? "bg-supported" : "bg-unknown")} /> : null}
      <span className="min-w-0 flex-1 text-muted-foreground">{label}</span>
      <span className="text-right font-medium">{value}</span>
    </>
  )
  return to
    ? <Link to={to} className="-mx-2 flex items-center gap-2 rounded-md px-2 py-1 text-xs transition-colors hover:bg-foreground/[0.03]">{body}</Link>
    : <div className="flex items-center gap-2 py-1 text-xs">{body}</div>
}

const STEP_LABEL: Record<SetupView["step"], string> = { DISCOVER: "Reading your website", CONFIRM: "Waiting for you to confirm the brief", CONNECT: "Review channels", PROPOSE: "Ready to suggest a first initiative", DONE: "Complete" }

const workCounts = (opps: ReadonlyArray<GrowthOpportunity>) => ({
  proposed: opps.filter(o => o.status === "PROPOSED").length,
  approved: opps.filter(o => o.status === "APPROVED" && o.progress === "NOT_STARTED").length,
  done: opps.filter(o => o.progress === "EXECUTED").length,
  verified: opps.flatMap(o => o.executions).filter(e => e.assurance === "SYSTEM_VERIFIED").length,
  attested: opps.flatMap(o => o.executions).filter(e => e.assurance === "OPERATOR_ATTESTED").length,
})

export function StatusCard({ businessId, setup }: { businessId: string; setup: SetupView | null }) {
  const inventory = useApi(`channels:${businessId}`, () => Channels.get(businessId))
  const data = useOverviewData(businessId, 30)
  const proposals = useApi(`agent-proposals:${businessId}`, () => Agent.proposals(businessId))
  if (inventory.loading && !inventory.data) return <Card title="Status"><Skeleton className="h-24" /></Card>
  const channels = inventory.data?.inventory.channels ?? []
  const w = workCounts(data.opportunities)
  const blockers = [
    ...channels.filter(c => c.state === "REVOKED" || c.state === "UNHEALTHY").map(c => `${c.label}: ${c.note}`),
    ...(setup?.discovery.status === "FAILED" ? ["Your homepage couldn't be read."] : []),
    ...(!data.profile ? ["No goal is set, so results can't be measured."] : []),
  ]
  const openAgent = proposals.data?.proposals.filter(p => p.status === "PROPOSED").length ?? 0
  return (
    <Card title="Status" footer={<Button asChild size="sm" variant="outline"><Link to={`/businesses/${businessId}/work`}>Open work<ArrowRightIcon /></Link></Button>}>
      <div>
        <Row label="Setup" value={setup ? STEP_LABEL[setup.step] : "Not started. Type /setup"} />
        <Row label="Channels connected" value={`${channels.filter(c => c.state === "CONNECTED").length} of ${channels.length}`} to={`/businesses/${businessId}/channels`} />
        <Row label="Waiting for your decision" value={w.proposed + openAgent} to={`/businesses/${businessId}/work`} tone={w.proposed + openAgent ? "gap" : undefined} />
        <Row label="Approved, not started" value={w.approved} to={`/businesses/${businessId}/work`} />
        <Row label="Work recorded" value={`${w.done} · ${w.verified} verified, ${w.attested} attested`} to={`/businesses/${businessId}/work`} />
      </div>
      {blockers.length ? (
        <ul className="space-y-1 rounded-xl bg-wrong-soft/60 p-3 text-xs">
          {blockers.map(b => <li key={b}>{b}</li>)}
        </ul>
      ) : <p className="text-xs text-muted-foreground">Nothing is blocked.</p>}
    </Card>
  )
}

export function PlanCard({ businessId, setup }: { businessId: string; setup: SetupView | null }) {
  const data = useOverviewData(businessId, 30)
  const { issues, representations, search, opportunities, activeFacts } = data
  const actions = useMemo(() => buildActions(businessId, { issues, representations, search, opportunities }, { activeFacts, checks: null, hasGoal: !!data.profile, goalLoading: data.loading.growth }),
    [businessId, issues, representations, search, opportunities, activeFacts, data.profile, data.loading.growth])
  const loading = data.loading.issues || data.loading.representations || data.loading.search
  return (
    <Card title="Plan" footer={<Button asChild size="sm" variant="outline"><Link to={`/businesses/${businessId}/work`}>Open work<ArrowRightIcon /></Link></Button>}>
      {loading ? <Skeleton className="h-24" /> : (
        <>
          {!setup ? <p className="text-xs text-muted-foreground">Start with /setup so the plan knows your goal and channels.</p> : null}
          {actions.length ? (
            <ol className="space-y-1">
              {actions.slice(0, 5).map((a, i) => (
                <li key={a.key}>
                  <Link to={a.to} className="-mx-2 flex items-start gap-2.5 rounded-md px-2 py-1.5 text-xs transition-colors hover:bg-foreground/[0.03]">
                    <span className="mt-px w-4 shrink-0 text-muted-foreground tabular-nums">{i + 1}.</span>
                    <span className="min-w-0 flex-1"><span className="block font-medium">{a.title}</span><span className="block text-muted-foreground">{a.detail}</span></span>
                    <span className="shrink-0 font-medium text-primary-ink">{a.cta}</span>
                  </Link>
                </li>
              ))}
            </ol>
          ) : <p className="text-xs text-muted-foreground">Nothing is waiting. Run a check to see what AI assistants say today.</p>}
        </>
      )}
    </Card>
  )
}

export function ReportCard({ businessId }: { businessId: string }) {
  const data = useOverviewData(businessId, 30)
  const inventory = useApi(`channels:${businessId}`, () => Channels.get(businessId))
  if (data.loading.growth || data.loading.search) return <Card title="Report"><Skeleton className="h-28" /></Card>
  const w = workCounts(data.opportunities)
  const totals = goalTotals(data.series, 30)
  const label = data.profile?.primaryGoal.metricDefinition.label ?? "Goal metric"
  const fixes = data.search?.verifiedFixes ?? 0
  const unsupported = (inventory.data?.inventory.channels ?? []).filter(c => c.state === "UNSUPPORTED" || c.state === "DISCOVERED").map(c => c.label)
  const unknowns = [
    ...(totals?.any ? [] : [`${label} has no measurements yet, so no change can be shown.`]),
    ...(totals?.synthetic ? ["Some measurements are test data."] : []),
    ...(unsupported.length ? [`No integration reads ${unsupported.slice(0, 4).join(", ")}${unsupported.length > 4 ? " and others" : ""}.`] : []),
  ]
  return (
    <Card title="Report" footer={<>
      <Button asChild size="sm" variant="outline"><Link to={`/businesses/${businessId}/results`}>Results<ArrowRightIcon /></Link></Button>
      <Button asChild size="sm" variant="ghost"><Link to={growthPath(businessId)}>Client reports</Link></Button>
    </>}>
      <div className="space-y-3 text-xs">
        <div>
          <p className="font-medium">What we did</p>
          <p className="text-muted-foreground">{w.done ? `${w.done} ${w.done === 1 ? "initiative has" : "initiatives have"} recorded work.` : "No work has been recorded yet."}</p>
        </div>
        <div>
          <p className="font-medium">What was independently verified</p>
          <p className="text-muted-foreground">{w.verified || fixes ? `${w.verified} changes confirmed by read-back${fixes ? ` and ${fixes} website fixes re-checked live` : ""}. ${w.attested} more are attested by you only.` : w.attested ? `Nothing yet. ${w.attested} recorded ${w.attested === 1 ? "change is" : "changes are"} attested by you, not verified.` : "Nothing yet."}</p>
        </div>
        <div>
          <p className="font-medium">What changed in measured numbers</p>
          <p className="text-muted-foreground">{totals?.any ? `${label}: ${totals.current.toLocaleString()} in the last 30 days, ${totals.previous.toLocaleString()} in the 30 before. A change over time does not show what caused it.` : `${label}: no data yet.`}</p>
        </div>
        <div>
          <p className="font-medium">Still unknown</p>
          {unknowns.length ? <ul className="list-disc space-y-0.5 pl-4 text-muted-foreground">{unknowns.map(u => <li key={u}>{u}</li>)}</ul> : <p className="text-muted-foreground">Nothing flagged.</p>}
        </div>
      </div>
    </Card>
  )
}
