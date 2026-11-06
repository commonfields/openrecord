import { Link, useParams, useSearchParams } from "react-router"
import type { Campaign } from "@openrecord/contracts"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { PageHeader, Panel, PanelHeader } from "@/components/page"
import { Skeleton } from "@/components/ui/skeleton"
import { CampaignRuns } from "@/components/campaign-runs"
import { api } from "@/lib/api"
import { useApi } from "@/lib/use-api"
import { askAgentPath } from "@/lib/nav"
import { CampaignManualEditor } from "./campaigns"

export const campaignAttention = (campaign: Campaign) => {
  const b = campaign.brief
  if (b.status === "CLOSED") return { label: "Review recorded", next: b.nextMove || "Discuss the next experiment with the agent." }
  if (b.tasks.some(t => t.status === "BLOCKED")) return { label: "Blocked", next: "Ask the agent to explain the blocked deliverables." }
  if (b.status === "REVIEW") return { label: "Results review", next: "Review the available evidence with the agent." }
  if (b.status === "ACTIVE") return { label: "Recorded active", next: "Check delivery evidence and what remains to be done." }
  return { label: "Draft plan", next: "Review the plan and ask the agent to prepare the next step." }
}

export function CampaignsPage() {
  const { id = "" } = useParams()
  const [params] = useSearchParams()
  const query = useApi(`campaigns:${id}`, () => api<{ campaigns: Campaign[] }>(`/api/businesses/${encodeURIComponent(id)}/campaigns`), { pollMs: 15000 })
  const list = query.data?.campaigns ?? []
  const selectedId = params.get("campaign")
  const selected = list.find(c => c.id === selectedId)
  const base = `/businesses/${id}/campaigns`
  if (selected && params.get("edit") === "true") return <div className="space-y-4">
    <Button asChild variant="ghost" size="sm"><Link to={`${base}?campaign=${selected.id}`}>Back to campaign</Link></Button>
    <CampaignManualEditor key={selected.id} initialCampaign={selected} />
  </div>
  return <div className="w-full space-y-5 pb-8">
    <PageHeader title={selected ? selected.brief.title : "Campaigns"}
      {...(selectedId ? { back: { to: base, label: "Campaigns" } } : {})}
      description={selected ? "Review the plan, saved work and what needs your attention." : "See what is planned, what is blocked and what to discuss with your agent."}
      actions={<><Button asChild size="sm"><Link to={askAgentPath(id, selected ? `/marketing Work on campaign ${selected.id}. Read its marketing work queue and current proposals, then prepare the next supported step. Do not publish, send or spend without approval.` : "/campaign")}>{selected ? "Continue with agent" : "Plan with agent"}</Link></Button><Button size="sm" variant="ghost" onClick={() => void query.reload()}>Refresh</Button></>} />
    {query.error ? <p role="alert" className="text-sm text-destructive">Campaigns could not refresh. {query.data ? "Showing the last loaded version." : "Try Refresh to load them."}</p> : null}
    {query.loading && !query.data ? <Skeleton className="h-48 rounded-xl" /> : selected ? <CampaignProgress businessId={id} campaign={selected} />
      : selectedId ? !query.error ? <Panel className="p-6 text-sm text-muted-foreground">This campaign is unavailable. <Link to={base} className="underline">See all campaigns</Link></Panel> : null
      : list.length ? <Panel className="overflow-hidden">
        <div className="hidden grid-cols-[2fr_1fr_2fr] gap-6 border-b px-5 py-3 text-xs text-muted-foreground md:grid"><span>Campaign and goal</span><span>Recorded stage</span><span>Next step</span></div>
        <ul className="divide-y">{list.map(c => {
          const attention = campaignAttention(c)
          return <li key={c.id}><Link to={`${base}?campaign=${c.id}`} className="grid gap-3 px-5 py-4 transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:grid-cols-[2fr_1fr_2fr] md:gap-6">
            <div className="min-w-0"><h2 className="text-sm font-medium">{c.brief.title}</h2><p className="mt-1 truncate text-xs text-muted-foreground">{c.brief.goal || "Goal not specified yet"}</p></div>
            <div><Badge variant="outline">{attention.label}</Badge><p className="mt-2 text-xs text-muted-foreground">{c.brief.tasks.length} planned deliverables</p></div>
            <p className="text-xs leading-relaxed text-muted-foreground">{attention.next}</p>
          </Link></li>
        })}</ul>
      </Panel> : !query.error ? <Panel className="space-y-3 p-6"><h2 className="text-sm font-medium">What do you want to achieve?</h2><p className="max-w-xl text-sm text-muted-foreground">Tell the agent your goal. It can save a campaign plan and draft deliverables for you to review here. Nothing launches just by creating a plan.</p><Button asChild size="sm" variant="outline"><Link to={askAgentPath(id, "/campaign")}>Discuss a campaign</Link></Button></Panel> : null}
    {!selectedId && list.length ? <p className="text-xs text-muted-foreground">Stages describe the saved plan, not verified delivery. Open a campaign for preparation status and linked delivery evidence.</p> : null}
  </div>
}

export function CampaignProgress({ businessId, campaign }: { businessId: string; campaign: Campaign }) {
  const b = campaign.brief
  const attention = campaignAttention(campaign)
  const ask = (message: string) => askAgentPath(businessId, `Read marketing campaign ${campaign.id} and its current run. ${message} Do not invent delivery, measurements or attribution.`)
  return <div className="space-y-5">
    <Panel className="space-y-4 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3"><Badge variant="outline">{attention.label}</Badge><Button asChild variant="ghost" size="sm"><Link to={`/businesses/${businessId}/campaigns?campaign=${campaign.id}&edit=true`}>Edit details</Link></Button></div>
      <div className="grid gap-5 sm:grid-cols-2"><Summary label="Goal" value={b.goal} /><Summary label="Audience" value={b.audience} /><Summary label="Offer" value={b.offer} /><Summary label="Message" value={b.message} /></div>
      <p className="text-xs text-muted-foreground">{campaign.created_by_actor === "ASSISTANT" ? "Agent-prepared plan" : "Saved plan"} · revision {campaign.revision}. Drafts and proposed targets are not approved facts or published work.</p>
    </Panel>
    <details className="rounded-xl bg-card p-5 shadow-(--card-shadow)"><summary className="cursor-pointer text-sm font-medium">Distribution · {b.distribution?.primaryChannel || "Not planned yet"}</summary>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <Summary label="Why this channel" value={b.distribution?.rationale ?? ""} />
        <Summary label="Distribution motion" value={b.distribution?.motion === "UNSPECIFIED" ? "" : b.distribution?.motion.toLowerCase().replaceAll("_", " ") ?? ""} />
        <Summary label="Funnel stage" value={b.distribution?.funnelStage === "UNSPECIFIED" ? "" : b.distribution?.funnelStage.toLowerCase() ?? ""} />
        <Summary label="Destination or audience segment" value={b.distribution?.destination ?? ""} />
        <Summary label="Cadence" value={b.distribution?.cadence ?? ""} /><Summary label="Proposed budget · not spending approval" value={b.distribution?.budget ?? ""} />
        <Summary label="Conversion event" value={b.distribution?.conversionEvent ?? ""} /><Summary label="Tracking plan · not verified instrumentation" value={b.distribution?.trackingPlan ?? ""} />
      </div><p className="mt-4 text-xs text-muted-foreground">Planning only. A destination, cadence or review date does not schedule delivery or verify tracking.</p>
    </details>
    <CampaignRuns key={`${campaign.id}:${campaign.revision}`} businessId={businessId} campaignId={campaign.id} />
    <Panel><PanelHeader title="Deliverables and handoffs" description="Saved draft content and team-recorded progress. Marking a task done does not verify publication." />
      <ul className="divide-y px-5">{b.tasks.map(t => <li key={t.id} className="space-y-3 py-4">
        <div className="flex flex-wrap items-start justify-between gap-2"><div><h3 className="text-sm font-medium">{t.title}</h3><p className="mt-1 text-xs text-muted-foreground">{t.channel.toLowerCase()} · {t.owner || "Owner not assigned"}{t.due ? ` · Due ${t.due}` : ""}</p></div><Badge variant="outline">{t.status === "DONE" ? "Recorded done" : t.status.toLowerCase().replaceAll("_", " ")}</Badge></div>
        <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-muted-foreground">{t.note || "No draft or handoff saved yet."}</p>
      </li>)}</ul>{!b.tasks.length ? <p className="px-5 pb-5 text-sm text-muted-foreground">No deliverables saved yet. Ask the agent to prepare them.</p> : null}
    </Panel>
    <Panel className="space-y-4 p-5"><h2 className="text-sm font-medium">Results and next decision</h2>
      <div className="grid gap-5 sm:grid-cols-2"><Summary label="Success metric" value={b.metric} /><Summary label="Baseline" value={b.baseline} fallback="No baseline recorded." /><Summary label="Proposed target" value={b.target} /><Summary label="Review date" value={b.reviewDate} /></div>
      <Summary label="Recorded results" value={b.result} fallback="No results recorded yet. Campaign impact is unknown." />
      {b.result ? <p className="text-xs text-muted-foreground">These are recorded results and references, not independently verified measurements or proof of causation.</p> : null}
      <Summary label="Decision" value={b.decision === "UNDECIDED" ? "No decision recorded" : b.decision.toLowerCase()} />
      {b.learning ? <Summary label="Learning" value={b.learning} /> : null}
      <Summary label="Next step" value={b.nextMove || attention.next} />
      <Button asChild variant="outline" size="sm"><Link to={ask("Review available evidence against the saved target, explain uncertainty, and recommend the next decision for my review.")}>Review results with agent</Link></Button>
    </Panel>
    <details className="rounded-xl bg-card p-5 shadow-(--card-shadow)"><summary className="cursor-pointer text-sm font-medium">Planning context</summary><div className="mt-4 grid gap-4 sm:grid-cols-2"><Summary label="Hypothesis" value={b.hypothesis} /><Summary label="Owner (planning label)" value={b.owner} /><Summary label="Planned launch" value={b.launchDate} /><Summary label="Last saved" value={campaign.updated_at} /></div></details>
  </div>
}

function Summary({ label, value, fallback = "Not specified yet." }: { label: string; value: string; fallback?: string }) {
  return <div><p className="text-xs text-muted-foreground">{label}</p><p className="mt-1 whitespace-pre-wrap break-words text-sm leading-relaxed">{value || fallback}</p></div>
}
