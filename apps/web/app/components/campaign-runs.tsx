import { useState } from "react"
import { Link } from "react-router"
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
const label = (value: string) => value.toLowerCase().replaceAll("_", " ")
export function CampaignRuns({ businessId, campaignId }: { businessId: string; campaignId: string }) {
  const base = `/api/businesses/${encodeURIComponent(businessId)}`
  const data = useApi(`campaign-runs:${businessId}:${campaignId}`, () => api<{ runs: Run[] }>(`${base}/campaigns/${encodeURIComponent(campaignId)}/runs`))
  const [cancelling, setCancelling] = useState<string | null>(null)
  const [error, setError] = useState("")
  const latest = data.data?.runs[0]
  return <Panel><PanelHeader title="Campaign machinery" description="Saved preparation runs and current adapter receipts—not a claim that the campaign launched." />
    <div className="space-y-3 p-5">
      <div className="flex flex-wrap gap-2"><Button asChild variant="outline"><Link to={askAgentPath(businessId, `/campaign-run Read campaign ${campaignId} and start or resume its saved preparation run. Do not publish or spend without approval.`)}>Continue with the agent</Link></Button><Button variant="ghost" onClick={() => void data.reload()}>Refresh receipts</Button></div>
      {data.loading && !data.data ? <p className="text-sm text-muted-foreground">Loading runs…</p> : null}
      {data.error || error ? <p role="alert" className="text-sm text-destructive">{error || "Campaign runs could not load."}</p> : null}
      {latest ? <div className="space-y-3"><p className="text-sm font-medium">{label(latest.status)} · brief revision {latest.campaignRevision}</p>
        {latest.missing.length ? <p className="text-xs text-muted-foreground">Missing planning context: {latest.missing.join(", ")}</p> : null}
        <ul className="divide-y">{latest.tasks.map(task => <li key={task.taskId} className="space-y-1 py-3"><p className="text-sm font-medium">{task.title} · {label(task.state)}</p><p className="text-xs text-muted-foreground">{task.nextMove}</p></li>)}</ul>
        {latest.status !== "CANCELLED" ? <Button variant="outline" onClick={() => setCancelling(latest.id)}>Stop internal run</Button> : null}
      </div> : !data.loading && !data.error ? <p className="text-sm text-muted-foreground">No run yet. The agent can start one from this saved brief and surface exactly what needs review or a human handoff.</p> : null}
    </div>
    <ConfirmDialog open={cancelling !== null} onOpenChange={open => { if (!open) setCancelling(null) }} title="Stop this internal campaign run?" description="This blocks further delivery links. It does not cancel external proposals, stop a provider request already in flight, or undo published changes." confirmLabel="Stop run" onConfirm={async () => {
      try { await api(`${base}/campaign-runs/cancel`, { method: "POST", body: JSON.stringify({ runId: cancelling }) }); setError(""); await data.reload() }
      catch { setError("Could not stop the run. Try again."); return false }
    }} />
  </Panel>
}
