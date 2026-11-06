// A campaign's deliverables as one list: what the plan saved for each, and,
// when the agent has a preparation run for the current plan, where each one
// stands in it. Recorded completion is never shown as observed delivery.
import { useState } from "react"
import { Link } from "react-router"
import type { Campaign } from "@openrecord/contracts"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { Panel, PanelHeader } from "@/components/page"
import { api } from "@/lib/api"
import { useApi } from "@/lib/use-api"
import { askAgentPath } from "@/lib/nav"

interface Run {
  id: string; campaignRevision: number; status: string; missing: string[]
  tasks: { taskId: string; title: string; state: string; nextMove: string }[]
}
type Tone = "supported" | "partial" | "wrong" | "review" | "outline"
const RUN_STATES: Record<string, { label: string; tone: Tone }> = {
  STALE: { label: "Plan changed, prepare again", tone: "partial" },
  CANCELLED: { label: "Preparation stopped", tone: "outline" },
  BLOCKED: { label: "Needs attention", tone: "wrong" },
  WAITING_FOR_APPROVAL: { label: "Needs your approval", tone: "review" },
  WAITING_FOR_REVIEW: { label: "Ready for review", tone: "review" },
  VERIFYING: { label: "Checking delivery", tone: "partial" },
  DELIVERY_OBSERVED: { label: "Delivery observed", tone: "supported" },
  NEEDS_DRAFT: { label: "Draft needed", tone: "outline" },
  DRAFT_READY: { label: "Draft saved", tone: "outline" },
  HUMAN_HANDOFF: { label: "Human handoff needed", tone: "partial" },
}
const runState = (value: string) => RUN_STATES[value] ?? { label: value.charAt(0) + value.slice(1).toLowerCase().replaceAll("_", " "), tone: "outline" as Tone }
const PLAN_STATUS: Record<string, string> = { TODO: "To do", IN_PROGRESS: "In progress", BLOCKED: "Blocked", DONE: "Recorded done" }
const CHANNEL: Record<string, string> = { WEBSITE: "Website", EMAIL: "Email", PAID: "Paid ads", SOCIAL: "Social", OTHER: "Other" }

export function CampaignDeliverables({ businessId, campaign }: { businessId: string; campaign: Campaign }) {
  const base = `/api/businesses/${encodeURIComponent(businessId)}`
  const data = useApi(`campaign-runs:${businessId}:${campaign.id}`, () => api<{ runs: Run[] }>(`${base}/campaigns/${encodeURIComponent(campaign.id)}/runs`), { pollMs: 15000 })
  const [cancelling, setCancelling] = useState<string | null>(null)
  const [error, setError] = useState("")
  const latest = data.data?.runs[0]
  // A run prepared for an older plan says nothing about today's deliverables.
  const current = latest && latest.status !== "STALE" && latest.campaignRevision === campaign.revision ? latest : null
  const byTask = new Map(current?.tasks.map(t => [t.taskId, t]) ?? [])
  const tasks = campaign.brief.tasks
  const discuss = askAgentPath(businessId, `/campaign-run Read campaign ${campaign.id} and its current run. Explain its blockers and prepare the next supported step. Respect cancelled runs. Do not publish or spend without approval.`)

  return (
    <Panel>
      <PanelHeader title="Deliverables" description="The pieces of work this campaign needs. The agent drafts them; anything that goes out waits for your approval." />
      <div className="space-y-3 px-4 pb-4">
        {latest ? <RunStatus run={latest} onStop={latest.status !== "CANCELLED" ? () => setCancelling(latest.id) : null} /> : !data.loading && !data.error ? (
          <p className="text-xs text-muted-foreground">The agent has not started preparing these yet. <Link to={discuss} className="underline underline-offset-2 hover:text-foreground">Ask it to start</Link>.</p>
        ) : null}
        {data.error || error ? <p role="alert" className="text-xs text-destructive">{error || "Preparation status could not load."}</p> : null}
        {tasks.length ? (
          <ul className="divide-y divide-border/60">
            {tasks.map(t => {
              const step = byTask.get(t.id)
              const state = step ? runState(step.state) : null
              const meta = [CHANNEL[t.channel] ?? t.channel, t.owner ? `owner ${t.owner}` : null, t.due ? `due ${t.due}` : null].filter(Boolean).join(", ")
              return (
                <li key={t.id} className="space-y-1.5 py-3">
                  <div className="flex flex-wrap items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <h3 className="text-sm font-medium">{t.title}</h3>
                      <p className="text-xs text-muted-foreground">{meta}</p>
                    </div>
                    {state ? <Badge variant={state.tone}>{state.label}</Badge> : null}
                    <Badge variant={t.status === "BLOCKED" ? "wrong" : "outline"}>{PLAN_STATUS[t.status] ?? t.status}</Badge>
                  </div>
                  {step?.nextMove ? <p className="text-xs leading-relaxed">{step.nextMove}</p> : null}
                  {t.note ? <details className="text-xs"><summary className="cursor-pointer py-1 font-medium">Read draft and notes</summary><p className="whitespace-pre-wrap break-words pt-2 leading-relaxed text-muted-foreground">{t.note}</p></details> : null}
                </li>
              )
            })}
          </ul>
        ) : <p className="text-sm text-muted-foreground">No deliverables saved yet. Ask the agent to prepare them.</p>}
        {tasks.some(t => t.status === "DONE") ? <p className="text-xs text-muted-foreground">Recorded done means someone marked it done. Only "Delivery observed" means the agent checked it went out.</p> : null}
      </div>
      <ConfirmDialog open={cancelling !== null} onOpenChange={open => { if (!open) setCancelling(null) }} title="Stop preparing this campaign?" description="The agent stops preparing deliverables for this plan. It does not cancel proposals already sent for approval, stop a request already in flight, or undo published changes." confirmLabel="Stop preparation" onConfirm={async () => {
        try { await api(`${base}/campaign-runs/cancel`, { method: "POST", body: JSON.stringify({ runId: cancelling }) }); setError(""); await data.reload() }
        catch { setError("Could not stop preparation. Try again."); return false }
      }} />
    </Panel>
  )
}

function RunStatus({ run, onStop }: { run: Run; onStop: (() => void) | null }) {
  const state = runState(run.status)
  return (
    <div className="space-y-1 rounded-lg bg-muted/50 px-3 py-2">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-muted-foreground">Agent preparation:</span>
        <Badge variant={state.tone}>{state.label}</Badge>
        <span className="min-w-0 flex-1 text-muted-foreground">(plan revision {run.campaignRevision})</span>
        {onStop ? <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={onStop}>Stop preparation</Button> : null}
      </div>
      {run.status === "STALE" ? <p role="status" className="text-xs text-muted-foreground">This progress belongs to an older version of the plan. Ask the agent to prepare the current one.</p> : null}
      {run.status === "CANCELLED" ? <p className="text-xs text-muted-foreground">Preparation is stopped. Work already sent out is not cancelled or undone.</p> : null}
      {run.missing.length ? <p className="text-xs text-muted-foreground">The agent needs: {run.missing.join(", ")}.</p> : null}
    </div>
  )
}
