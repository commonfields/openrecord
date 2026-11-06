// Campaigns: one push toward the goal, planned and prepared by the agent and
// approved by you. The list says where each campaign stands and what comes
// next; a campaign opens to its stage, next step, plan, deliverables and
// results. Nothing here is a form; changes go through the agent.
import { useState, type ReactNode } from "react"
import { Link, useParams, useSearchParams } from "react-router"
import { ChevronDownIcon, ChevronRightIcon, SparklesIcon } from "lucide-react"
import type { Campaign, GrowthOpportunity } from "@openrecord/contracts"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Skeleton } from "@/components/ui/skeleton"
import { PageHeader, Panel, PanelHeader, StepFlow } from "@/components/page"
import { CampaignDeliverables } from "@/components/campaign-runs"
import { CAMPAIGN_STAGES, Campaigns, campaignAttention, campaignStage, campaignsKey, deliverableSummary } from "@/lib/campaigns"
import { Growth } from "@/lib/growth"
import { askAgentPath } from "@/lib/nav"
import { useApi } from "@/lib/use-api"
import { cn } from "@/lib/utils"
import { CampaignManualEditor } from "./campaigns"


const continuePrompt = (id: string) => `/marketing Work on campaign ${id}. Read its marketing work queue and current proposals, then prepare the next supported step. Do not publish, send or spend without approval.`
const fromIdeaPrompt = (o: GrowthOpportunity) => `/campaign Plan a campaign for the approved idea "${o.title}" (${o.id}). Use its goal, audience and proposed change. Do not publish, send or spend without approval.`

export function CampaignsPage() {
  const { id = "" } = useParams()
  const [params] = useSearchParams()
  const query = useApi(campaignsKey(id), () => Campaigns.list(id), { pollMs: 15000 })
  const list = query.data?.campaigns ?? []
  const selectedId = params.get("campaign")
  const selected = list.find(c => c.id === selectedId)
  const base = `/businesses/${id}/campaigns`
  if (selected && params.get("edit") === "true") return <div className="space-y-4">
    <Button asChild variant="ghost" size="sm"><Link to={`${base}?campaign=${selected.id}`}>Back to campaign</Link></Button>
    <CampaignManualEditor key={selected.id} initialCampaign={selected} />
  </div>
  return (
    <div className="rise-in w-full space-y-5 pb-8">
      <PageHeader title={selected ? selected.brief.title : "Campaigns"}
        {...(selectedId ? { back: { to: base, label: "Campaigns" } } : {})}
        description={selected ? selected.brief.goal || "Goal not set yet." : "A campaign is one push toward your goal. The agent plans it, prepares the work and checks the results. You approve anything that goes out."}
        {...(selectedId || !list.length ? {} : { actions: <Button asChild size="sm"><Link to={askAgentPath(id, "/campaign")}>Plan a campaign</Link></Button> })} />
      {query.error ? (
        <div className="flex flex-wrap items-center gap-3">
          <p role="alert" className="text-sm text-destructive">Campaigns could not load. {query.data ? "Showing the last loaded version." : ""}</p>
          <Button size="sm" variant="outline" onClick={() => void query.reload()}>Try again</Button>
        </div>
      ) : null}
      {query.loading && !query.data ? <Skeleton className="h-48 rounded-xl" />
        : selected ? <CampaignProgress businessId={id} campaign={selected} />
        : selectedId ? !query.error ? <Panel className="p-6 text-sm text-muted-foreground">This campaign is unavailable. <Link to={base} className="underline">See all campaigns</Link></Panel> : null
        : list.length ? <CampaignList businessId={id} campaigns={list} />
        : !query.error ? <NoCampaigns businessId={id} /> : null}
    </div>
  )
}

/** Four small segments: where the saved plan is. */
function StageMeter({ campaign }: { campaign: Campaign }) {
  const at = campaignStage(campaign)
  return (
    <span className="flex items-center gap-1" aria-label={`Stage ${at + 1} of ${CAMPAIGN_STAGES.length}: ${CAMPAIGN_STAGES[at]!.label}`}>
      {CAMPAIGN_STAGES.map((s, i) => <span key={s.status} aria-hidden className={cn("h-1 w-6 rounded-full", i <= at ? "bg-primary" : "bg-muted-foreground/20")} />)}
    </span>
  )
}

function CampaignList({ businessId, campaigns }: { businessId: string; campaigns: Campaign[] }) {
  const base = `/businesses/${businessId}/campaigns`
  return (
    <Panel className="overflow-hidden">
      <div className="hidden grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,2fr)_1rem] gap-6 border-b border-border/60 px-5 py-2.5 text-xs text-muted-foreground md:grid">
        <span>Campaign</span><span>Stage</span><span>Next step</span><span />
      </div>
      <ul className="divide-y divide-border/60">
        {campaigns.map(c => {
          const attention = campaignAttention(c)
          return (
            <li key={c.id}>
              <Link to={`${base}?campaign=${c.id}`} className="grid items-center gap-3 px-5 py-4 transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,2fr)_1rem] md:gap-6">
                <div className="min-w-0">
                  <h2 className="truncate text-sm font-medium">{c.brief.title}</h2>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">{c.brief.goal || "Goal not set yet"}</p>
                </div>
                <div className="space-y-1.5">
                  <span className="flex items-center gap-2">
                    <span className="text-xs font-medium">{CAMPAIGN_STAGES[campaignStage(c)]!.label}</span>
                    {attention.tone === "blocked" ? <Badge variant="wrong">Blocked</Badge> : null}
                  </span>
                  <StageMeter campaign={c} />
                </div>
                <div className="min-w-0 text-xs leading-relaxed">
                  <p>{attention.next}</p>
                  <p className="text-muted-foreground">{deliverableSummary(c)}.</p>
                </div>
                <ChevronRightIcon aria-hidden className="hidden size-4 text-muted-foreground md:block" />
              </Link>
            </li>
          )
        })}
      </ul>
    </Panel>
  )
}

function HowItWorks() {
  return <StepFlow steps={CAMPAIGN_STAGES.map(s => ({ key: s.status, label: s.label, hint: s.hint, state: "todo" as const }))} />
}

function NoCampaigns({ businessId }: { businessId: string }) {
  const ideas = useApi(`growth-opps:${businessId}`, () => Growth.list(businessId))
  const approved = (ideas.data?.opportunities ?? []).filter(o => o.status === "APPROVED")
  return (
    <div className="space-y-5">
      <Panel className="space-y-4 p-5">
        <div>
          <h2 className="text-sm font-medium">No campaigns yet</h2>
          <p className="mt-1 max-w-prose text-xs leading-relaxed text-muted-foreground">Tell the agent what you want more of. It saves a plan here with the audience, the message and each piece of work, then prepares the work for you to approve. Creating a plan never publishes, sends or spends anything.</p>
        </div>
        <Button asChild size="sm"><Link to={askAgentPath(businessId, "/campaign")}>Plan a campaign with the agent</Link></Button>
      </Panel>
      {approved.length ? (
        <Panel>
          <PanelHeader title="Start from an idea you approved" description="The agent can turn any of these into a campaign plan." />
          <ul className="divide-y divide-border/60 px-4 pb-1">
            {approved.slice(0, 5).map(o => (
              <li key={o.id} className="flex flex-wrap items-center gap-3 py-3">
                <SparklesIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm">{o.title}</p>
                  {o.proposedChange ? <p className="truncate text-xs text-muted-foreground">{o.proposedChange}</p> : null}
                </div>
                <Button asChild size="sm" variant="outline"><Link to={askAgentPath(businessId, fromIdeaPrompt(o))}>Turn into a campaign</Link></Button>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}
      <section className="space-y-3">
        <div>
          <h2 className="text-sm font-medium">How a campaign works</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">Every campaign moves through the same four stages. You see each one here.</p>
        </div>
        <HowItWorks />
      </section>
    </div>
  )
}

export function CampaignProgress({ businessId, campaign }: { businessId: string; campaign: Campaign }) {
  const b = campaign.brief
  const attention = campaignAttention(campaign)
  const at = campaignStage(campaign)
  const ask = (message: string) => askAgentPath(businessId, `Read marketing campaign ${campaign.id} and its current run. ${message} Do not invent delivery, measurements or attribution.`)
  const d = b.distribution
  const decision = b.decision === "UNDECIDED" ? "" : b.decision.charAt(0) + b.decision.slice(1).toLowerCase()
  return (
    <div className="space-y-5">
      <StepFlow steps={CAMPAIGN_STAGES.map((s, i) => ({ key: s.status, label: s.label, hint: s.hint, state: i < at || b.status === "CLOSED" ? "done" as const : i === at ? "current" as const : "todo" as const }))} />

      <Panel className="flex flex-wrap items-center gap-3 p-4">
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 text-xs text-muted-foreground">Next step{attention.tone === "blocked" ? <Badge variant="wrong">Blocked</Badge> : null}</p>
          <p className="mt-0.5 text-sm">{b.nextMove || attention.next}</p>
        </div>
        <Button asChild size="sm"><Link to={askAgentPath(businessId, continuePrompt(campaign.id))}>Continue with agent</Link></Button>
      </Panel>

      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <CampaignDeliverables key={`${campaign.id}:${campaign.revision}`} businessId={businessId} campaign={campaign} />
        <Panel>
          <PanelHeader title="The plan" description={`${campaign.created_by_actor === "ASSISTANT" ? "Prepared by the agent" : "Saved plan"}, revision ${campaign.revision}.`}>
            <Button asChild variant="ghost" size="sm"><Link to={`/businesses/${businessId}/campaigns?campaign=${campaign.id}&edit=true`}>Edit details</Link></Button>
          </PanelHeader>
          <dl className="grid gap-4 px-4 pt-2 pb-4">
            <Summary label="Goal" value={b.goal} />
            <Summary label="Who it is for" value={b.audience} />
            <Summary label="Offer" value={b.offer} />
            <Summary label="Message" value={b.message} />
            <Summary label="Main channel" value={d?.primaryChannel ?? ""} />
          </dl>
        </Panel>
      </div>

      <Panel>
        <PanelHeader title="Results" description="What was measured against the target. A change after a campaign is not proof the campaign caused it." />
        <div className="space-y-4 px-4 pt-2 pb-4">
          <dl className="grid gap-4 sm:grid-cols-4">
            <Summary label="Success metric" value={b.metric} />
            <Summary label="Before" value={b.baseline} fallback="No baseline recorded." />
            <Summary label="Target" value={b.target} />
            <Summary label="Review date" value={b.reviewDate} />
          </dl>
          <dl className="grid gap-4">
            <Summary label="What happened" value={b.result} fallback="No results recorded yet. Impact is unknown." />
            {decision ? <Summary label="Decision" value={decision} /> : null}
            {b.learning ? <Summary label="Learning" value={b.learning} /> : null}
          </dl>
          <Button asChild variant="outline" size="sm"><Link to={ask("Review available evidence against the saved target, explain uncertainty, and recommend the next decision for my review.")}>Review results with agent</Link></Button>
        </div>
      </Panel>

      <MoreDetails>
        <dl className="grid gap-4 sm:grid-cols-2">
          <Summary label="Why this channel" value={d?.rationale ?? ""} />
          <Summary label="Hypothesis" value={b.hypothesis} />
          <Summary label="Kind of channel" value={d && d.motion !== "UNSPECIFIED" ? d.motion.toLowerCase().replaceAll("_", " ") : ""} />
          <Summary label="Funnel stage" value={d && d.funnelStage !== "UNSPECIFIED" ? d.funnelStage.toLowerCase() : ""} />
          <Summary label="Where people land" value={d?.destination ?? ""} />
          <Summary label="How often" value={d?.cadence ?? ""} />
          <Summary label="Proposed budget (not approval to spend)" value={d?.budget ?? ""} />
          <Summary label="What counts as a conversion" value={d?.conversionEvent ?? ""} />
          <Summary label="Tracking plan (not yet verified)" value={d?.trackingPlan ?? ""} />
          <Summary label="Owner" value={b.owner} />
          <Summary label="Planned launch" value={b.launchDate} />
          <Summary label="Last saved" value={campaign.updated_at} />
        </dl>
        <p className="mt-4 text-xs text-muted-foreground">These are planning notes. A date or cadence here does not schedule anything, and a budget here does not allow spending.</p>
      </MoreDetails>
    </div>
  )
}

function MoreDetails({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <Panel>
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger className="flex w-full items-center gap-2 px-4 py-3 text-left text-xs font-medium transition-colors hover:bg-accent">
          <ChevronDownIcon aria-hidden className={cn("size-3.5 text-muted-foreground transition-transform", !open && "-rotate-90")} />
          More plan details
          <span className="font-normal text-muted-foreground">Channel reasoning, budget, tracking and dates</span>
        </CollapsibleTrigger>
        <CollapsibleContent className="px-4 pt-1 pb-4">{children}</CollapsibleContent>
      </Collapsible>
    </Panel>
  )
}

function Summary({ label, value, fallback = "Not set yet." }: { label: string; value: string; fallback?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={cn("mt-0.5 whitespace-pre-wrap break-words text-sm leading-relaxed", !value && "text-muted-foreground")}>{value || fallback}</dd>
    </div>
  )
}
