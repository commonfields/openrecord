// Work: a plain record of what the agent proposed, what is under way and what
// is done. Nothing here asks for input. Decisions live in Needs you, and the
// next move on anything is a conversation with the agent.
import { Link, useParams } from "react-router"
import { ArrowRightIcon, BriefcaseIcon, CheckCheckIcon } from "lucide-react"
import type { GrowthExecution, GrowthOpportunity } from "@openrecord/contracts"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { EmptyState, PageHeader, Panel, PanelHeader } from "@/components/page"
import { Agent } from "@/lib/api"
import { errorMessage, formatDateTime, relativeTime, sentenceCase } from "@/lib/format"
import { GROWTH_EXECUTION_LABELS, Growth } from "@/lib/growth"
import { askAgentPath } from "@/lib/nav"
import { useApi } from "@/lib/use-api"
import { useWorkspace } from "@/lib/workspace"

export function WorkPage() {
  const { id = "" } = useParams()
  const { activeBusiness } = useWorkspace()
  const opportunities = useApi(`growth-opps-work:${id}`, () => Growth.list(id))
  const proposals = useApi(`agent-proposals:${id}`, () => Agent.proposals(id))
  const list = opportunities.data?.opportunities ?? []
  const reviewed = list.filter(o => o.status === "REVIEWED")
  const underway = list.filter(o => o.status === "APPROVED")
  const waiting = list.filter(o => o.status === "PROPOSED").length + (proposals.data?.proposals.filter(p => p.status === "PROPOSED").length ?? 0)

  return (
    <div className="rise-in w-full space-y-6 pb-4">
      <PageHeader title="Work" description={`What your agent proposed, is working on and finished for ${activeBusiness?.name ?? "this business"}.`} />

      {(opportunities.loading && !opportunities.data) || (proposals.loading && !proposals.data) ? <Skeleton className="h-48 rounded-xl" />
        : (opportunities.error && !opportunities.data) || (proposals.error && !proposals.data) ? (
          <Panel className="flex flex-wrap items-center gap-3 p-4">
            <p role="alert" className="min-w-0 flex-1 text-sm text-destructive">Work could not load: {errorMessage(opportunities.error ?? proposals.error)}</p>
            <Button size="sm" variant="outline" onClick={() => { void opportunities.reload(); void proposals.reload() }}>Try again</Button>
          </Panel>
        ) : list.length === 0 && waiting === 0 ? (
          <EmptyState icon={<BriefcaseIcon />} title="No work yet" description="Tell your agent what you want to achieve. What it proposes and does appears here."
            action={<Button asChild><Link to={`/businesses/${id}/agent`}>Open the agent</Link></Button>} />
        ) : (
          <>
            {waiting ? (
              <Panel className="flex flex-wrap items-center gap-3 p-4">
                <CheckCheckIcon aria-hidden className="size-4 text-primary-ink" />
                <p className="min-w-0 flex-1 text-sm">{waiting === 1 ? "1 proposal is waiting for your decision." : `${waiting} proposals are waiting for your decision.`}</p>
                <Button asChild size="sm"><Link to="/approvals">Review<ArrowRightIcon /></Link></Button>
              </Panel>
            ) : null}

            {underway.length ? (
              <Panel>
                <PanelHeader title="Approved" description="You approved these initiatives. Recorded actions appear here; approval alone does not mean work has started." />
                <ul className="divide-y divide-border/60 px-4 pb-2">
                  {underway.map(o => (
                    <li key={o.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-3">
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium">{o.title}</p>
                        <p className="text-xs text-muted-foreground">{o.proposedChange}</p>
                      </div>
                      {o.executions.length ? <ul className="w-full space-y-1">{o.executions.map(e => <ExecutionReceipt key={e.id} e={e} />)}</ul> : null}
                      <Button asChild size="sm" variant="outline">
                        <Link to={askAgentPath(id, `What's next for “${o.title}”, and what do you need from me?`)}>Ask the agent</Link>
                      </Button>
                    </li>
                  ))}
                </ul>
              </Panel>
            ) : null}

            {reviewed.length ? (
              <Panel>
                <PanelHeader title="Reviewed" description="Recorded actions and their evidence for reviewed initiatives." />
                <ul className="divide-y divide-border/60 px-4 pb-2">
                  {reviewed.map(o => <DoneRow key={o.id} o={o} />)}
                </ul>
              </Panel>
            ) : null}
          </>
        )}
    </div>
  )
}

function DoneRow({ o }: { o: GrowthOpportunity }) {
  const last = o.executions.at(-1)
  return (
    <li className="space-y-2 py-3">
      <div className="flex flex-wrap items-baseline gap-x-3">
        <p className="min-w-0 flex-1 text-sm font-medium">{o.title}</p>
        {last ? <span className="text-xs text-muted-foreground">{relativeTime(last.performedAt)}</span> : null}
      </div>
      {o.executions.length ? <ul className="space-y-1">{o.executions.map(e => <ExecutionReceipt key={e.id} e={e} />)}</ul> : null}
    </li>
  )
}

function ExecutionReceipt({ e }: { e: GrowthExecution }) {
  return (
    <li className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <Badge variant={e.assurance === "SYSTEM_VERIFIED" ? "supported" : "outline"}>{e.assurance === "SYSTEM_VERIFIED" ? "Pull request merged" : "Reported by you"}</Badge>
      <span className="text-foreground">{GROWTH_EXECUTION_LABELS[e.type] ?? sentenceCase(e.type)}</span>
      <span className="min-w-0 truncate">{e.target}</span>
      <span className="ml-auto tabular-nums">{formatDateTime(e.performedAt)}</span>
    </li>
  )
}
