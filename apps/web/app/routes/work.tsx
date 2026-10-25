import { Link, useParams } from "react-router"
import { ArrowRightIcon, BriefcaseIcon } from "lucide-react"
import type { GrowthExecution, GrowthOpportunity } from "@openrecord/contracts"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { EmptyState, PageHeader, Panel, PanelHeader } from "@/components/page"
import { InitiativeDecision } from "@/components/setup-flow"
import { NextActions, useOverviewData } from "@/components/today-overview"
import { Agent } from "@/lib/api"
import { formatDateTime, sentenceCase } from "@/lib/format"
import { GROWTH_EXECUTION_LABELS, Growth, growthPath } from "@/lib/growth"
import { useApi } from "@/lib/use-api"
import { useWorkspace } from "@/lib/workspace"

export function WorkPage() {
  const { id = "" } = useParams()
  const { activeBusiness } = useWorkspace()
  const opportunities = useApi(`growth-opps-work:${id}`, () => Growth.list(id))
  const proposals = useApi(`agent-proposals:${id}`, () => Agent.proposals(id))
  const overview = useOverviewData(id, 30)
  const list = opportunities.data?.opportunities ?? []
  const waiting = list.filter(o => o.status === "PROPOSED")
  const approved = list.filter(o => o.status === "APPROVED")
  const done = list.filter(o => o.status === "REVIEWED" || o.executions.length > 0)
  const agentWaiting = proposals.data?.proposals.filter(p => p.status === "PROPOSED").length ?? 0

  return (
    <div className="rise-in mx-auto w-full max-w-4xl space-y-6 pb-4">
      <PageHeader
        title="Work"
        description={`What is proposed, approved and done for ${activeBusiness?.name ?? "this business"}. Nothing is published or changed without your approval.`}
        actions={<Button asChild variant="outline" size="sm"><Link to={growthPath(id)}>Growth workspace<ArrowRightIcon /></Link></Button>}
      />

      {opportunities.loading && !opportunities.data ? <Skeleton className="h-48 rounded-xl" /> : list.length === 0 && agentWaiting === 0 ? (
        <EmptyState icon={<BriefcaseIcon />} title="No work yet" description="Type /setup in the agent to get a first proposed initiative, or /plan to see what to do next."
          action={<Button asChild><Link to={`/businesses/${id}/agent`}>Open the agent</Link></Button>} />
      ) : (
        <>
          {waiting.length || agentWaiting ? (
            <section className="space-y-3">
              <h2 className="text-sm font-medium">Waiting for your decision</h2>
              {waiting.map(o => (
                <Panel key={o.id} className="p-5"><InitiativeDecision businessId={id} opportunity={o} measurement="NONE" /></Panel>
              ))}
              {agentWaiting ? (
                <Panel className="flex items-center gap-3 p-4 text-xs">
                  <span className="flex-1">The agent prepared {agentWaiting} {agentWaiting === 1 ? "item" : "items"} for your review.</span>
                  <Button asChild size="sm" variant="outline"><Link to={`/businesses/${id}/agent`}>Review in the agent</Link></Button>
                </Panel>
              ) : null}
            </section>
          ) : null}

          {approved.length ? (
            <Panel>
              <PanelHeader title="Approved" description="Make the change, then record it so it can be verified or compared." />
              <ul className="divide-y divide-border/60 px-4 pb-2">
                {approved.map(o => <InitiativeRow key={o.id} businessId={id} o={o} />)}
              </ul>
            </Panel>
          ) : null}

          {done.length ? (
            <Panel>
              <PanelHeader title="Done" description="Recorded work and how strongly each change is proven." />
              <ul className="divide-y divide-border/60 px-4 pb-2">
                {done.map(o => <InitiativeRow key={o.id} businessId={id} o={o} />)}
              </ul>
            </Panel>
          ) : null}
        </>
      )}

      <NextActions businessId={id} data={overview} checks={null} />
    </div>
  )
}

function InitiativeRow({ businessId, o }: { businessId: string; o: GrowthOpportunity }) {
  return (
    <li className="space-y-2 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 text-xs font-medium">{o.title}</span>
        {o.executions.length === 0 ? (
          <Button asChild size="sm" variant="outline"><Link to={`${growthPath(businessId)}#opportunity-${o.id}`}>Record the work</Link></Button>
        ) : (
          <Link to={`${growthPath(businessId)}#opportunity-${o.id}`} className="text-xs font-medium text-primary-ink hover:underline">Details</Link>
        )}
      </div>
      {o.executions.length ? (
        <ul className="space-y-1">
          {o.executions.map(e => <ExecutionReceipt key={e.id} e={e} />)}
        </ul>
      ) : <p className="text-[0.6875rem] text-muted-foreground">{o.proposedChange}</p>}
    </li>
  )
}

function ExecutionReceipt({ e }: { e: GrowthExecution }) {
  return (
    <li className="flex flex-wrap items-center gap-2 text-[0.6875rem] text-muted-foreground">
      <Badge variant={e.assurance === "SYSTEM_VERIFIED" ? "supported" : "outline"}>{e.assurance === "SYSTEM_VERIFIED" ? "Verified by read-back" : "Attested by you"}</Badge>
      <span className="text-foreground">{GROWTH_EXECUTION_LABELS[e.type] ?? sentenceCase(e.type)}</span>
      <span className="truncate">{e.target}</span>
      <span className="ml-auto tabular-nums">{formatDateTime(e.performedAt)}</span>
    </li>
  )
}
