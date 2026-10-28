import { useEffect } from "react"
import { Link } from "react-router"
import { InboxIcon } from "lucide-react"
import { Skeleton } from "@/components/ui/skeleton"
import { Button } from "@/components/ui/button"
import { EmptyState, PageHeader, Panel } from "@/components/page"
import { InitiativeDecision } from "@/components/setup-flow"
import { AgentProposalCard } from "@/components/agent-chat"
import { DECISIONS_CHANGED, Decisions, notifyDecisionsChanged, type DecisionItem } from "@/lib/api"
import { errorMessage, relativeTime } from "@/lib/format"
import { useApi } from "@/lib/use-api"

/** Everything the agent prepared that needs a person, across every business. */
export function ApprovalsPage() {
  const decisions = useApi("decisions", () => Decisions.list())
  const { reload } = decisions
  useEffect(() => {
    const onChange = () => { void reload() }
    window.addEventListener(DECISIONS_CHANGED, onChange)
    return () => window.removeEventListener(DECISIONS_CHANGED, onChange)
  }, [reload])
  const items = decisions.data?.items ?? []
  const groups = new Map<string, { name: string; items: DecisionItem[] }>()
  for (const item of items) {
    const group = groups.get(item.business.id) ?? { name: item.business.name, items: [] }
    group.items.push(item)
    groups.set(item.business.id, group)
  }

  return (
    <div className="rise-in mx-auto w-full max-w-3xl space-y-6 pb-4">
      <PageHeader
        title="Waiting on you"
        description="What the agent prepared and needs your decision. Approving records your decision; nothing is published or changed without it."
      />
      {decisions.loading && !decisions.data ? <Skeleton className="h-48 rounded-xl" /> : decisions.error && !decisions.data ? (
        <p role="alert" className="text-sm text-destructive">{errorMessage(decisions.error)}</p>
      ) : items.length === 0 ? (
        <EmptyState icon={<InboxIcon />} title="Nothing is waiting on you" description="When the agent proposes an initiative, a re-check or a draft, it appears here and in the chat."
          action={<Button asChild variant="outline"><Link to="/businesses">Open a business</Link></Button>} />
      ) : [...groups.entries()].map(([businessId, group]) => (
        <section key={businessId} className="space-y-3" aria-label={group.name}>
          <h2 className="flex items-center gap-2 text-sm font-medium">
            <Link to={`/businesses/${businessId}/agent`} className="hover:underline">{group.name}</Link>
            <span className="text-muted-foreground">· {group.items.length}</span>
          </h2>
          {group.items.map(item => (
            <div key={`${item.type}:${item.type === "AGENT_PROPOSAL" ? item.proposal.id : item.opportunity.id}`} className="space-y-1">
              <p className="text-[0.6875rem] text-muted-foreground">Proposed {relativeTime(item.createdAt)}</p>
              {item.type === "GROWTH_OPPORTUNITY"
                ? <Panel className="p-5"><InitiativeDecision businessId={businessId} opportunity={item.opportunity} measurement="NONE" onDecided={notifyDecisionsChanged} /></Panel>
                : <AgentProposalCard businessId={businessId} businessName={group.name} proposal={item.proposal} onDone={() => { void reload() }} />}
            </div>
          ))}
        </section>
      ))}
    </div>
  )
}
