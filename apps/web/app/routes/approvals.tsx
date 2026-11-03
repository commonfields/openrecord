import { useEffect, useState, type ReactNode } from "react"
import { Link, useParams } from "react-router"
import { InboxIcon } from "lucide-react"
import { Skeleton } from "@/components/ui/skeleton"
import { Button } from "@/components/ui/button"
import { EmptyState, Panel } from "@/components/page"
import { InitiativeDecision } from "@/components/setup-flow"
import { AgentProposalCard, DecisionConversation } from "@/components/agent-chat"
import { useChrome } from "@/components/app-shell"
import { WordPressChangeCard } from "@/components/wordpress"
import { DECISIONS_CHANGED, Decisions, Issues, notifyDecisionsChanged, type DecisionItem, type IssueWithEvidence } from "@/lib/api"
import { occurrenceHref } from "@/lib/issues"
import { errorMessage, relativeTime } from "@/lib/format"
import { useApi } from "@/lib/use-api"
import { cn } from "@/lib/utils"
import { useWorkspace } from "@/lib/workspace"
import { AskAgentButton } from "@/components/workspace-agent"

type InboxItem = { id: string; business: string; businessId?: string; conversationId?: string; kind: string; title: string; summary: string; time: string; detail: ReactNode }

function decisionId(item: DecisionItem) {
  return `${item.type}:${item.type === "AGENT_PROPOSAL" ? item.proposal.id : item.type === "WORDPRESS_CHANGE" ? item.change.id : item.opportunity.id}`
}
/** One business's inbox: its decisions, plus AI answers waiting for review. */
export function BusinessInboxPage() {
  const { id = "" } = useParams()
  return <ApprovalsPage key={id} businessId={id} />
}

/** Everything the agent prepared that needs a person: for one business, or across every business. */
export function ApprovalsPage({ businessId }: { businessId?: string } = {}) {
  const { setWorkspace } = useChrome()
  const { activeBusiness } = useWorkspace()
  useEffect(() => { setWorkspace(true); return () => setWorkspace(false) }, [setWorkspace])
  const decisions = useApi("decisions", () => Decisions.list())
  const issues = useApi(businessId ? `inbox-issues:${businessId}` : null, () => Issues.list(businessId ?? ""))
  const { reload } = decisions
  useEffect(() => {
    const onChange = () => { void reload() }
    window.addEventListener(DECISIONS_CHANGED, onChange)
    return () => window.removeEventListener(DECISIONS_CHANGED, onChange)
  }, [reload])
  const items = (decisions.data?.items ?? []).filter(item => !businessId || item.business.id === businessId)
  const decisionRows: InboxItem[] = items.map(item => ({
    id: decisionId(item), business: item.business.name, businessId: item.business.id, ...(item.conversationId ? { conversationId: item.conversationId } : {}),
    kind: item.type === "GROWTH_OPPORTUNITY" ? "Proposed work" : item.type === "WORDPRESS_CHANGE" ? "Website change" : "Agent proposal",
    title: item.type === "GROWTH_OPPORTUNITY" ? item.opportunity.title : item.type === "WORDPRESS_CHANGE" ? `Website change: ${item.change.targetTitle}` : item.proposal.message,
    summary: item.type === "GROWTH_OPPORTUNITY" ? item.opportunity.problemStatement : item.type === "WORDPRESS_CHANGE" ? item.change.rationale : "Agent proposal",
    time: relativeTime(item.createdAt),
    detail: item.type === "GROWTH_OPPORTUNITY"
      ? <Panel className="p-5 sm:p-6"><InitiativeDecision businessId={item.business.id} opportunity={item.opportunity} measurement="NONE" onDecided={notifyDecisionsChanged} /></Panel>
      : item.type === "WORDPRESS_CHANGE"
      ? <WordPressChangeCard businessId={item.business.id} change={item.change} onDone={() => { void reload() }} />
      : <AgentProposalCard businessId={item.business.id} businessName={item.business.name} proposal={item.proposal} onDone={() => { void reload() }} />,
  }))
  const businessName = activeBusiness && activeBusiness.id === businessId ? activeBusiness.name : "this business"
  const rows = [...decisionRows, ...(businessId ? (issues.data?.issues ?? []).map(issue => issueInboxItem(businessId, issue, businessName)) : [])]

  return (
    <div className="rise-in flex h-full min-h-0 w-full flex-col gap-4 px-4 pt-3 pb-3 sm:px-6 lg:px-10">
      {businessId && issues.error && !issues.data ? <div className="flex flex-wrap items-center gap-3"><p role="alert" className="flex-1 text-sm text-destructive">AI answer issues could not load. Other decisions may still appear.</p><Button size="sm" variant="outline" onClick={() => void issues.reload()}>Try again</Button></div> : null}
      {(decisions.loading && !decisions.data) || (businessId && issues.loading && !issues.data) ? <Skeleton className="h-72 rounded-xl" /> : decisions.error && !decisions.data ? (
        <div className="flex flex-wrap items-center gap-3"><p role="alert" className="text-sm text-destructive">{errorMessage(decisions.error)}</p><Button size="sm" variant="outline" onClick={() => void reload()}>Try again</Button></div>
      ) : rows.length ? <DecisionInbox items={rows} /> : businessId && issues.error && !issues.data ? null : (
        <EmptyState icon={<InboxIcon />} title="Nothing is waiting on you" description="When the agent needs your decision, it will appear here."
          action={businessId
            ? <AskAgentButton businessId={businessId} variant="outline" className="h-8 text-xs" request="What should we work on next? Check our results and channels and propose the most useful next step for me to approve.">Ask the agent what to do next</AskAgentButton>
            : <Button asChild variant="outline"><Link to="/businesses">Open a business</Link></Button>} />
      )}
    </div>
  )
}

export function issueInboxItem(businessId: string, issue: IssueWithEvidence, businessName = "this business"): InboxItem {
  const label = issue.state === "NEEDS_REVIEW" ? "Needs review" : issue.state === "WRONG" ? "Marked wrong" : issue.state === "PARTIAL" ? "Marked partially correct" : "Not enough information"
  return {
    id: `issue:${issue.claim_id}`, business: businessName, businessId, kind: "AI answer", title: issue.claim_text,
    summary: `AI answer · ${label}`, time: relativeTime(issue.collected_at),
    detail: <Panel className="space-y-3 p-5"><div><p className="text-xs text-muted-foreground">{label}</p><h2 className="mt-1 text-sm font-medium">{issue.claim_text}</h2></div>
      {issue.question_prompt ? <p className="text-xs text-muted-foreground">Question: {issue.question_prompt}</p> : null}
      <p className="whitespace-pre-wrap text-sm">{issue.answer_text}</p>
      <p className="text-xs text-muted-foreground">{issue.facts.length ? `${issue.facts.length} fact${issue.facts.length === 1 ? "" : "s"} linked to this claim.` : "No fact is linked to this claim."} {issue.citation_evidence.length ? `${issue.citation_evidence.length} citation${issue.citation_evidence.length === 1 ? "" : "s"} recorded.` : "No citation evidence recorded."}</p>
      <Button asChild size="sm" variant="outline"><Link to={occurrenceHref(businessId, issue)}>{issue.state === "NEEDS_REVIEW" ? "Review this answer" : "View evidence and follow-up"}</Link></Button>
    </Panel>,
  }
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
              <span className="flex items-center justify-between gap-2 text-[0.6875rem] text-muted-foreground"><span className="truncate font-medium">{item.business} · {item.kind}</span><span className="shrink-0">{item.time}</span></span>
              <span className="mt-1 block line-clamp-2 text-sm font-medium">{item.title}</span>
              <span className="mt-1 block line-clamp-2 text-xs text-muted-foreground">{item.summary}</span>
            </button>
          ))}
        </div>
      </Panel>
      <section aria-label="Decision details" className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl bg-card shadow-(--card-shadow)">
        <div className="flex shrink-0 flex-wrap items-start justify-between gap-2 px-4 py-3"><div className="min-w-0 flex-1"><p className="text-xs text-muted-foreground">{selected.business} · {selected.kind} · {selected.time}</p><h2 className="mt-1 text-sm font-medium">{selected.title}</h2><p className="mt-1 text-xs text-muted-foreground">{selected.summary}</p></div></div>
        {selected.businessId && selected.conversationId ? <DecisionConversation key={selected.id} businessId={selected.businessId} businessName={selected.business} conversationId={selected.conversationId} detail={selected.detail} /> : <div className="flex min-h-0 flex-1 flex-col"><div className="min-h-0 flex-1 overflow-y-auto p-4">{selected.detail}</div><p className="shrink-0 px-4 pb-4 text-xs text-muted-foreground">The originating conversation is unavailable for this item.</p></div>}
      </section>
    </div>
  )
}
