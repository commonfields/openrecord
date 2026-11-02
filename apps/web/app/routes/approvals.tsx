import { useEffect, useState, type ReactNode } from "react"
import { Link } from "react-router"
import { InboxIcon } from "lucide-react"
import { Skeleton } from "@/components/ui/skeleton"
import { Button } from "@/components/ui/button"
import { EmptyState, Panel } from "@/components/page"
import { InitiativeDecision } from "@/components/setup-flow"
import { AgentProposalCard, DecisionConversation } from "@/components/agent-chat"
import { useChrome } from "@/components/app-shell"
import { WordPressChangeCard } from "@/components/wordpress"
import { DECISIONS_CHANGED, Decisions, notifyDecisionsChanged, type DecisionItem } from "@/lib/api"
import { errorMessage, relativeTime } from "@/lib/format"
import { useApi } from "@/lib/use-api"
import { cn } from "@/lib/utils"

type InboxItem = { id: string; business: string; businessId?: string; title: string; summary: string; time: string; detail: ReactNode }

function decisionId(item: DecisionItem) {
  return `${item.type}:${item.type === "AGENT_PROPOSAL" ? item.proposal.id : item.type === "WORDPRESS_CHANGE" ? item.change.id : item.opportunity.id}`
}
/** Everything the agent prepared that needs a person, across every business. */
export function ApprovalsPage() {
  const { setWorkspace } = useChrome()
  useEffect(() => { setWorkspace(true); return () => setWorkspace(false) }, [setWorkspace])
  const decisions = useApi("decisions", () => Decisions.list())
  const { reload } = decisions
  useEffect(() => {
    const onChange = () => { void reload() }
    window.addEventListener(DECISIONS_CHANGED, onChange)
    return () => window.removeEventListener(DECISIONS_CHANGED, onChange)
  }, [reload])
  const items = decisions.data?.items ?? []
  const rows: InboxItem[] = items.map(item => ({
    id: decisionId(item), business: item.business.name, businessId: item.business.id,
    title: item.type === "GROWTH_OPPORTUNITY" ? item.opportunity.title : item.type === "WORDPRESS_CHANGE" ? `Website change: ${item.change.targetTitle}` : item.proposal.message,
    summary: item.type === "GROWTH_OPPORTUNITY" ? item.opportunity.problemStatement : item.type === "WORDPRESS_CHANGE" ? item.change.rationale : "Agent proposal",
    time: relativeTime(item.createdAt),
    detail: item.type === "GROWTH_OPPORTUNITY"
      ? <Panel className="p-5 sm:p-6"><InitiativeDecision businessId={item.business.id} opportunity={item.opportunity} measurement="NONE" onDecided={notifyDecisionsChanged} /></Panel>
      : item.type === "WORDPRESS_CHANGE"
      ? <WordPressChangeCard businessId={item.business.id} change={item.change} onDone={() => { void reload() }} />
      : <AgentProposalCard businessId={item.business.id} businessName={item.business.name} proposal={item.proposal} onDone={() => { void reload() }} />,
  }))

  return (
    <div className="rise-in flex h-full min-h-0 w-full flex-col gap-4 px-4 pt-3 pb-3 sm:px-6 lg:px-10">
      {decisions.loading && !decisions.data ? <Skeleton className="h-72 rounded-xl" /> : decisions.error && !decisions.data ? (
        <div className="flex flex-wrap items-center gap-3"><p role="alert" className="text-sm text-destructive">{errorMessage(decisions.error)}</p><Button size="sm" variant="outline" onClick={() => void reload()}>Try again</Button></div>
      ) : rows.length ? <DecisionInbox items={rows} /> : (
        <EmptyState icon={<InboxIcon />} title="Nothing is waiting on you" description="When the agent needs your decision, it will appear here."
          action={<Button asChild variant="outline"><Link to="/businesses">Open a business</Link></Button>} />
      )}
    </div>
  )
}

function DecisionInbox({ items }: { items: InboxItem[] }) {
  const [selectedId, setSelectedId] = useState(items[0]?.id)
  const selected = items.find(item => item.id === selectedId) ?? items[0]
  if (!selected) return null
  return (
    <div className="grid min-h-0 min-w-0 flex-1 gap-4 grid-rows-[minmax(8rem,35%)_minmax(0,1fr)] lg:grid-rows-1 lg:grid-cols-[minmax(16rem,22rem)_minmax(0,1fr)]">
      <Panel className="flex min-h-0 min-w-0 flex-col overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3"><h2 className="text-sm font-medium">Inbox</h2><span className="text-xs text-muted-foreground">{items.length} waiting</span></div>
        <div aria-label="Decisions" className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {items.map(item => (
            <button key={item.id} type="button" aria-pressed={item.id === selected.id} onClick={() => setSelectedId(item.id)} className={cn("w-full rounded-lg px-3 py-3 text-left transition-[background-color,box-shadow] hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", item.id === selected.id && "bg-accent shadow-(--control-shadow)")}>
              <span className="flex items-center justify-between gap-2 text-[0.6875rem] text-muted-foreground"><span className="truncate font-medium">{item.business}</span><span className="shrink-0">{item.time}</span></span>
              <span className="mt-1 block line-clamp-2 text-sm font-medium">{item.title}</span>
              <span className="mt-1 block line-clamp-2 text-xs text-muted-foreground">{item.summary}</span>
            </button>
          ))}
        </div>
      </Panel>
      <section aria-label="Decision details" className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl bg-card shadow-(--card-shadow)">
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 px-4 py-3"><div><h2 className="text-sm font-medium">{selected.business}</h2><p className="text-xs text-muted-foreground">{selected.businessId ? "Ask the agent about this decision below" : "Example decision"}</p></div><span className="text-xs text-muted-foreground">{selected.time}</span></div>
        {selected.businessId ? <DecisionConversation key={selected.id} businessId={selected.businessId} businessName={selected.business} detail={selected.detail} /> : <div className="flex min-h-0 flex-1 flex-col"><div className="min-h-0 flex-1 overflow-y-auto p-4">{selected.detail}</div><div className="shrink-0 p-4 pt-2"><div className="rounded-[10px] bg-card px-3 py-3 text-sm text-muted-foreground shadow-(--control-shadow)">Replies are available for real decisions.</div></div></div>}
      </section>
    </div>
  )
}
