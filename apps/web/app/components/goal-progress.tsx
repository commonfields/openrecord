// The top of the Overview: what the business is working toward, what is
// under way, and what is waiting on a person. Every line comes from a saved
// record (goal, campaigns, approved work, decisions), never from the chat.
import { useEffect, type ReactNode } from "react"
import { Link } from "react-router"
import { ArrowRightIcon, FlagIcon, InboxIcon, ListChecksIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Panel } from "@/components/page"
import { Delta, goalTotals, type OverviewData } from "@/components/today-overview"
import { DECISIONS_CHANGED, Decisions } from "@/lib/api"
import { CAMPAIGN_STAGES, Campaigns, campaignAttention, campaignStage, campaignsKey, deliverableSummary } from "@/lib/campaigns"
import { decisionLabel } from "@/lib/decisions"
import { GROWTH_GOAL_LABELS } from "@/lib/growth"
import { askAgentPath } from "@/lib/nav"
import { relativeTime } from "@/lib/format"
import { useApi } from "@/lib/use-api"

export function GoalProgress({ businessId, data, days }: { businessId: string; data: OverviewData; days: number }) {
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <GoalCard businessId={businessId} data={data} days={days} />
      <UnderWay businessId={businessId} data={data} />
      <WaitingForYou businessId={businessId} />
    </div>
  )
}

function Card({ icon, title, action, children }: { icon: ReactNode; title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <Panel className="flex min-h-56 flex-col p-4">
      <div className="mb-3 flex items-center gap-2">
        <span aria-hidden className="flex size-6 items-center justify-center rounded-md bg-muted text-muted-foreground [&_svg]:size-3.5">{icon}</span>
        <h2 className="min-w-0 flex-1 text-sm font-medium">{title}</h2>
        {action}
      </div>
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </Panel>
  )
}

function SeeAll({ to, label }: { to: string; label: string }) {
  return (
    <Link to={to} className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground">
      {label}<ArrowRightIcon className="size-3" />
    </Link>
  )
}

function GoalCard({ businessId, data, days }: { businessId: string; data: OverviewData; days: number }) {
  const goal = data.profile?.primaryGoal ?? null
  const totals = goalTotals(data.series, days)
  if (data.loading.growth) return <Card icon={<FlagIcon />} title="Your goal"><Skeleton className="h-24 rounded-lg" /></Card>
  if (!goal && data.errors.growth) return <Card icon={<FlagIcon />} title="Your goal"><p role="alert" className="text-sm text-destructive">Your saved goal could not load. Reload the page to try again.</p></Card>
  if (!goal) {
    return (
      <Card icon={<FlagIcon />} title="Your goal">
        <p className="text-sm">No goal set yet.</p>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">Tell the agent what you want more of, such as bookings, leads or sales. Everything else on this page is measured against it.</p>
        <div className="mt-auto pt-4"><Button asChild size="sm"><Link to={askAgentPath(businessId, "Help me set our marketing goal and what we should count as success.")}>Set a goal with the agent</Link></Button></div>
      </Card>
    )
  }
  const comparable = data.series?.days.length === days * 2 && data.series.days.every(day => day.status === "OK" && day.value !== null)
  const metric = goal.metricDefinition.label || GROWTH_GOAL_LABELS[goal.metricDefinition.conversionKind]
  return (
    <Card icon={<FlagIcon />} title="Your goal">
      <p className="text-sm leading-snug text-balance">{goal.statement ? goal.statement.charAt(0).toUpperCase() + goal.statement.slice(1) : `More ${metric.toLowerCase()}`}</p>
      <div className="mt-auto pt-4">
        {totals && totals.reported > 0 ? (
          <>
            <p className="flex items-baseline gap-2">
              <span className="text-2xl font-semibold tracking-tight tabular-nums">{totals.current.toLocaleString()}</span>
              {comparable ? <span className="text-xs"><Delta now={totals.current} prev={totals.previous} goodWhenUp /></span> : null}
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {metric} across {totals.reported} of the last {days} days, from {totals.fromGa4 ? "Google Analytics" : "imported data"}.{totals.synthetic ? " Includes test data." : ""}
            </p>
          </>
        ) : (
          <>
            <p className="text-2xl font-semibold tracking-tight text-muted-foreground">Not measured</p>
            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
              {data.errors.series ? "Measurement could not load." : "No measurements are available for this period."} <Link to={`/businesses/${businessId}/channels`} className="underline underline-offset-2 hover:text-foreground">Connect an account</Link> so progress is measured, not guessed.
            </p>
          </>
        )}
      </div>
    </Card>
  )
}

type WorkRow = { key: string; title: string; stage: string; detail: string; to: string; blocked?: boolean }

function UnderWay({ businessId, data }: { businessId: string; data: OverviewData }) {
  const campaigns = useApi(campaignsKey(businessId), () => Campaigns.list(businessId))
  const base = `/businesses/${businessId}`
  const rows: WorkRow[] = [
    ...(campaigns.data?.campaigns ?? []).filter(c => c.brief.status !== "CLOSED").map(c => {
      const attention = campaignAttention(c)
      return { key: `c:${c.id}`, title: c.brief.title, stage: `Campaign, ${CAMPAIGN_STAGES[campaignStage(c)]!.label.toLowerCase()}`, detail: deliverableSummary(c), to: `${base}/campaigns?campaign=${c.id}`, blocked: attention.tone === "blocked" }
    }),
    ...data.opportunities.filter(o => o.status === "APPROVED").map(o => ({
      key: `o:${o.id}`, title: o.title, stage: "Approved idea",
      detail: o.executionCount ? `${o.executionCount} ${o.executionCount === 1 ? "action" : "actions"} recorded` : "No work recorded yet",
      to: `${base}/work`,
    })),
  ]
  const loading = campaigns.loading && !campaigns.data
  return (
    <Card icon={<ListChecksIcon />} title="Under way" action={rows.length ? <SeeAll to={`${base}/campaigns`} label="Campaigns" /> : null}>
      {loading ? <Skeleton className="h-24 rounded-lg" /> : rows.length ? (
        <ul className="-mx-2 space-y-0.5">
          {rows.slice(0, 4).map(r => (
            <li key={r.key}>
              <Link to={r.to} className="block rounded-lg px-2 py-1.5 transition-colors hover:bg-accent">
                <span className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm">{r.title}</span>
                  {r.blocked ? <Badge variant="wrong">Blocked</Badge> : null}
                </span>
                <span className="block truncate text-xs text-muted-foreground">{r.stage}. {r.detail}.</span>
              </Link>
            </li>
          ))}
          {rows.length > 4 ? <li className="px-2 pt-1 text-xs text-muted-foreground">And {rows.length - 4} more.</li> : null}
        </ul>
      ) : campaigns.error || data.errors.opportunities ? <p className="text-sm">Work status is unavailable.</p> : (
        <>
          <p className="text-sm">Nothing under way yet.</p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">Ask the agent to plan the first campaign toward your goal. You approve each step before anything goes out.</p>
          <div className="mt-auto pt-4"><Button asChild size="sm" variant="outline"><Link to={askAgentPath(businessId, "/campaign")}>Plan a campaign</Link></Button></div>
        </>
      )}
      {campaigns.error && !campaigns.data ? <p role="alert" className="mt-2 text-xs text-destructive">Campaigns could not load. This list may be incomplete.</p> : null}
      {data.errors.opportunities ? <p role="alert" className="mt-2 text-xs text-destructive">Approved ideas could not load. This list may be incomplete.</p> : null}
    </Card>
  )
}

function WaitingForYou({ businessId }: { businessId: string }) {
  const decisions = useApi("decisions", () => Decisions.list())
  const { reload } = decisions
  useEffect(() => {
    const onChange = () => { void reload() }
    window.addEventListener(DECISIONS_CHANGED, onChange)
    return () => window.removeEventListener(DECISIONS_CHANGED, onChange)
  }, [reload])
  const items = (decisions.data?.items ?? []).filter(i => i.business.id === businessId)
  const inbox = `/businesses/${businessId}/inbox`
  return (
    <Card icon={<InboxIcon />} title="Waiting for you" action={items.length ? <SeeAll to={inbox} label="Inbox" /> : null}>
      {decisions.loading && !decisions.data ? <Skeleton className="h-24 rounded-lg" /> : decisions.error && !decisions.data ? (
        <p role="alert" className="text-xs text-destructive">Approvals could not load.</p>
      ) : items.length ? (
        <>
          <ul className="-mx-2 space-y-0.5">
            {items.slice(0, 3).map(item => {
              const label = decisionLabel(item)
              return (
                <li key={`${item.type}:${item.createdAt}:${label.title}`}>
                  <Link to={inbox} className="block rounded-lg px-2 py-1.5 transition-colors hover:bg-accent">
                    <span className="block truncate text-sm">{label.title}</span>
                    <span className="block truncate text-xs text-muted-foreground">{label.kind}, {relativeTime(item.createdAt)}.</span>
                  </Link>
                </li>
              )
            })}
          </ul>
          <div className="mt-auto pt-3">
            <Button asChild size="sm"><Link to={inbox}>Review {items.length === 1 ? "1 item" : `${items.length} items`}</Link></Button>
          </div>
        </>
      ) : (
        <>
          <p className="text-sm">Nothing needs you right now.</p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">When the agent prepares a change, a post or a spend, it waits here for your approval. Nothing goes out before that.</p>
        </>
      )}
    </Card>
  )
}
