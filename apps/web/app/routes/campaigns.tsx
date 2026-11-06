import { useState } from "react"
import { Link, useParams } from "react-router"
import { PlusIcon, ArrowRightIcon, CheckCircle2Icon, FlagIcon } from "lucide-react"
import { campaignBlockers, type Campaign, type CampaignBrief, type CampaignDistribution, type CampaignTask } from "@openrecord/contracts"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { DatePicker } from "@/components/ui/date-picker"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { CampaignRuns } from "@/components/campaign-runs"
import { PageHeader, Panel, PanelHeader } from "@/components/page"
import { api } from "@/lib/api"
import { useApi } from "@/lib/use-api"
import { askAgentPath } from "@/lib/nav"

const empty = (): Campaign => ({ id: crypto.randomUUID(), revision: 0, updated_at: "", brief: {
  title: "", goal: "", audience: "", offer: "", message: "", hypothesis: "", metric: "", baseline: "", target: "",
  owner: "", launchDate: "", reviewDate: "", status: "DRAFT", tasks: [], result: "", decision: "UNDECIDED", learning: "", nextMove: "",
} })
const emptyDistribution = (): CampaignDistribution => ({ primaryChannel: "", rationale: "", motion: "UNSPECIFIED", funnelStage: "UNSPECIFIED", destination: "", cadence: "", budget: "", trackingPlan: "", conversionEvent: "" })
const labels: Partial<Record<keyof CampaignBrief, string>> = {
  title: "Campaign name", goal: "Business goal", audience: "Audience / lifecycle stage", offer: "Offer and call to action",
  message: "Core message", hypothesis: "Hypothesis · we believe… because…", metric: "Success metric and data source",
  baseline: "Baseline · or why unavailable", target: "Target and evaluation criteria", owner: "Campaign owner",
  launchDate: "Launch date", reviewDate: "Results review date", result: "Observed results and evidence links",
  learning: "What we learned · include uncertainty", nextMove: "Next experiment or action",
}
function CampaignSelect<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: readonly T[]; onChange: (value: T) => void }) {
  return <Select value={value} onValueChange={next => onChange(next as T)}><SelectTrigger aria-label={label} className="h-9"><SelectValue /></SelectTrigger><SelectContent>{options.map(option => <SelectItem key={option} value={option}>{option.charAt(0) + option.slice(1).toLowerCase().replaceAll("_", " ")}</SelectItem>)}</SelectContent></Select>
}
export function CampaignManualEditor({ initialCampaign }: { initialCampaign?: Campaign }) {
  const { id = "" } = useParams()
  const path = `/api/businesses/${encodeURIComponent(id)}/campaigns`
  const campaigns = useApi(`campaigns:${id}`, () => api<{ campaigns: Campaign[] }>(path))
  const [editing, setEditing] = useState<Campaign | null>(initialCampaign ?? null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const [dirty, setDirty] = useState(false)
  const [pending, setPending] = useState<{ campaign: Campaign | null } | null>(null)
  const list = campaigns.data?.campaigns ?? []
  const open = (c: Campaign | null) => {
    if (dirty) { setPending({ campaign: c }); return }
    setEditing(c); setDirty(false); setError("")
  }
  const change = (patch: Partial<CampaignBrief>) => {
    if (!editing) return
    setEditing({ ...editing, brief: { ...editing.brief, ...patch } }); setDirty(true)
  }
  const save = async () => {
    if (!editing) return
    setSaving(true); setError("")
    try {
      const result = await api<{ campaign: Campaign }>(path, { method: "POST", body: JSON.stringify({ id: editing.id, revision: editing.revision, brief: editing.brief }) })
      setEditing(result.campaign); setDirty(false); await campaigns.reload()
    } catch (e) {
      const body = (e as { body?: { reason?: string }; status?: number })
      setError(body.status === 409 ? "Someone changed this campaign. Keep your draft, then reopen the latest version before saving." : body.body?.reason ?? "Could not save the campaign. Your draft is still here.")
    } finally { setSaving(false) }
  }
  const taskChange = (task: CampaignTask, patch: Partial<CampaignTask>) => change({ tasks: editing!.brief.tasks.map(t => t.id === task.id ? { ...t, ...patch } : t) })
  const field = (key: keyof CampaignBrief) => <label key={key} className="grid gap-2 text-sm font-medium">
    {labels[key]}
    {key === "launchDate" || key === "reviewDate"
      ? <DatePicker label={labels[key]!} value={editing!.brief[key]} onChange={value => change({ [key]: value })} />
      : key === "title" || key === "owner"
      ? <Input maxLength={200} value={editing!.brief[key]} onChange={e => change({ [key]: e.target.value })} />
      : <Textarea maxLength={key === "result" || key === "learning" ? 4000 : key === "metric" || key === "baseline" || key === "target" ? 500 : 2000} value={String(editing!.brief[key])} onChange={e => change({ [key]: e.target.value })} rows={3} />}
  </label>
  const distribution = editing?.brief.distribution ?? emptyDistribution()
  const changeDistribution = (patch: Partial<CampaignDistribution>) => change({ distribution: { ...distribution, ...patch } })
  return <div className="rise-in space-y-6 pb-8">
    <PageHeader title="Campaigns" description="Tell the agent your goal. It prepares the campaign and deliverables here; your team controls external actions." actions={<><Button asChild><Link to={askAgentPath(id, "/campaign")}>Plan with the agent<ArrowRightIcon /></Link></Button><Button variant="outline" onClick={() => open(empty())}><PlusIcon />Manual brief</Button></>} />
    <div className="grid gap-3 sm:grid-cols-3">{[
      ["In motion", list.filter(c => c.brief.status === "ACTIVE").length],
      ["Reviews due", list.filter(c => c.brief.reviewDate && c.brief.reviewDate <= new Date().toISOString().slice(0, 10) && c.brief.status !== "CLOSED").length],
      ["Learning captured", list.filter(c => c.brief.status === "CLOSED").length],
    ].map(([label, count]) => <Panel key={label} className="p-4"><p className="text-xs text-muted-foreground">{label}</p><p className="mt-2 text-2xl font-semibold">{count}</p></Panel>)}</div>
    {campaigns.error ? <p role="alert">Campaigns could not load. <Button variant="outline" onClick={() => void campaigns.reload()}>Retry</Button></p> : null}
    <div className="grid items-start gap-6 lg:grid-cols-[260px_1fr]">
      <Panel className="p-3"><p className="px-2 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Your campaigns</p>
        {campaigns.loading ? <p className="p-2 text-sm">Loading campaigns…</p> : null}
        {!campaigns.loading && !list.length ? <div className="space-y-3 p-3"><FlagIcon className="size-5 text-muted-foreground" /><p className="text-sm">Start with one campaign, not another dashboard.</p><p className="text-xs text-muted-foreground">Define who it is for, what you will ship, and how you will decide what comes next.</p></div> : null}
        {list.map(c => <button key={c.id} onClick={() => open(c)} className={`mb-1 w-full rounded-lg p-3 text-left hover:bg-muted ${editing?.id === c.id ? "bg-muted" : ""}`}><p className="text-sm font-medium">{c.brief.title}</p><p className="mt-1 text-xs text-muted-foreground">{c.brief.status.toLowerCase()} · {c.brief.owner || "No owner"}</p><p className="mt-1 text-xs text-muted-foreground">{c.brief.tasks.filter(t => t.status === "DONE").length}/{c.brief.tasks.length} deliverables complete</p></button>)}
      </Panel>
      {editing ? <div key={editing.id} className="space-y-5">
        <Panel className="p-5"><div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="font-semibold">{editing.brief.title || "New campaign"}</h2><p className="text-xs text-muted-foreground">{dirty ? "Unsaved changes" : editing.revision ? `Saved · revision ${editing.revision}` : "Not saved yet"}{editing.created_by_actor === "ASSISTANT" ? " · Agent-prepared draft" : ""}</p></div><div className="flex gap-2"><CampaignSelect label="Campaign stage" value={editing.brief.status} onChange={status => change({ status })} options={["DRAFT", "ACTIVE", "REVIEW", "CLOSED"]} /><Button disabled={saving} onClick={() => void save()}>{saving ? "Saving…" : "Save campaign"}</Button></div></div>
          {error ? <p role="alert" className="mt-3 text-sm text-destructive">{error}</p> : null}
          {editing.revision > 0 ? <Button asChild variant="outline" className="mt-4"><Link to={askAgentPath(id, `/marketing Work on campaign ${editing.id}. Read its marketing work queue and current revision, then prepare the next permitted step. Preserve existing decisions. Do not publish, send or spend without approval.`)}>Work on this with the agent<ArrowRightIcon /></Link></Button> : <p className="mt-4 text-xs text-muted-foreground">Save the brief first so the agent can read its durable context.</p>}
        </Panel>
        {editing.revision > 0 ? <CampaignRuns key={`${editing.id}:${editing.revision}`} businessId={id} campaignId={editing.id} /> : null}
        <Panel><PanelHeader title="1. Brief" description="Start with the customer and the business outcome, not a channel." /><div className="grid gap-4 p-5 sm:grid-cols-2">{(["title", "owner", "goal", "audience", "offer", "message", "hypothesis", "launchDate"] as const).map(field)}</div></Panel>
        <details className="rounded-xl bg-card p-5 shadow-(--card-shadow)"><summary className="cursor-pointer text-sm font-medium">Distribution details</summary><p className="mt-3 text-xs text-muted-foreground">One primary channel first. These are planning notes, not approval to spend, scheduled delivery or verified tracking.</p><div className="mt-4 grid gap-4 sm:grid-cols-2">
          {([
            ["primaryChannel", "Primary channel", 200], ["rationale", "Why this channel", 1000], ["destination", "Destination or audience segment", 1000],
            ["cadence", "Cadence", 500], ["budget", "Proposed budget", 500], ["conversionEvent", "Conversion event", 500], ["trackingPlan", "Tracking plan", 2000],
          ] as const).map(([key, label, max]) => <label key={key} className="grid gap-2 text-sm font-medium">{label}<Textarea value={distribution[key]} maxLength={max} rows={2} onChange={e => changeDistribution({ [key]: e.target.value })} /></label>)}
          <label className="grid gap-2 text-sm font-medium">Distribution motion<CampaignSelect label="Distribution motion" value={distribution.motion} options={["UNSPECIFIED", "OWNED", "EARNED", "PAID", "PRODUCT_LED", "HYBRID"]} onChange={motion => changeDistribution({ motion })} /></label>
          <label className="grid gap-2 text-sm font-medium">Funnel stage<CampaignSelect label="Funnel stage" value={distribution.funnelStage} options={["UNSPECIFIED", "AWARENESS", "CONSIDERATION", "CONVERSION", "ACTIVATION", "RETENTION", "EXPANSION", "REFERRAL"]} onChange={funnelStage => changeDistribution({ funnelStage })} /></label>
        </div></details>
        <Panel><PanelHeader title="2. Measurement plan" description="Define success before launch. A change after a campaign does not establish causation." /><div className="grid gap-4 p-5 sm:grid-cols-2">{(["metric", "baseline", "target", "reviewDate"] as const).map(field)}</div></Panel>
        <Panel><PanelHeader title="3. Deliverables & handoffs" description="Planning only. Completing a task is a human attestation, not proof a channel published it." /><div className="space-y-4 p-5">{editing.brief.tasks.map(t => <div key={t.id} className="grid gap-3 rounded-lg border p-4 sm:grid-cols-2">
          <label className="grid gap-1 text-xs">Deliverable<Input maxLength={300} value={t.title} onChange={e => taskChange(t, { title: e.target.value })} /></label>
          <label className="grid gap-1 text-xs">Owner / human handoff<Input maxLength={200} value={t.owner} onChange={e => taskChange(t, { owner: e.target.value })} /></label>
          <label className="grid gap-1 text-xs">Due<DatePicker label={`Due date for ${t.title}`} value={t.due} onChange={due => taskChange(t, { due })} /></label>
          <label className="grid gap-1 text-xs">Channel<CampaignSelect label={`Channel for ${t.title}`} value={t.channel} onChange={channel => taskChange(t, { channel })} options={["WEBSITE", "EMAIL", "PAID", "SOCIAL", "OTHER"]} /></label>
          <label className="grid gap-1 text-xs">Status<CampaignSelect label={`Status for ${t.title}`} value={t.status} onChange={status => taskChange(t, { status })} options={["TODO", "IN_PROGRESS", "BLOCKED", "DONE"]} /></label>
          <label className="grid gap-1 text-xs">Blocker, handoff or evidence link<Input maxLength={2000} value={t.note} onChange={e => taskChange(t, { note: e.target.value })} /></label>
          <Button variant="ghost" onClick={() => change({ tasks: editing.brief.tasks.filter(x => x.id !== t.id) })}>Remove deliverable</Button>
        </div>)}<Button variant="outline" disabled={editing.brief.tasks.length >= 100} onClick={() => change({ tasks: [...editing.brief.tasks, { id: crypto.randomUUID(), title: "New deliverable", owner: "", due: "", channel: "WEBSITE", status: "TODO", note: "" }] })}><PlusIcon />Add deliverable</Button></div></Panel>
        <Panel className="p-5"><h3 className="flex items-center gap-2 font-medium"><CheckCircle2Icon className="size-4" />Launch readiness</h3>{campaignBlockers(editing.brief).length ? <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-muted-foreground">{campaignBlockers(editing.brief).map(b => <li key={b}>{b}</li>)}</ul> : <p className="mt-3 text-sm">Planning checks complete. Record ACTIVE only after the real launch; this does not publish anything.</p>}</Panel>
        <Panel><PanelHeader title="4. Results → decision → next move" description="Record what happened, what remains unknown, and what the next campaign should do differently." /><div className="grid gap-4 p-5">{field("result")}<label className="grid gap-2 text-sm font-medium">Decision<CampaignSelect label="Campaign decision" value={editing.brief.decision} onChange={decision => change({ decision })} options={["UNDECIDED", "KEEP", "CHANGE", "STOP", "INCONCLUSIVE"]} /></label>{field("learning")}{field("nextMove")}<Button variant="outline" onClick={() => { if (dirty) { setError("Save your learning before starting the next experiment."); return } const next = empty(); open({ ...next, brief: { ...next.brief, title: `Next: ${editing.brief.title}`.slice(0, 200), goal: editing.brief.goal, audience: editing.brief.audience, hypothesis: editing.brief.nextMove, baseline: editing.brief.result.slice(0, 500) } }) }}>Start the next experiment<ArrowRightIcon /></Button></div></Panel>
      </div> : <Panel className="p-8"><h2 className="font-semibold">Start with a goal, not a form.</h2><p className="mt-2 text-sm text-muted-foreground">Type /campaign followed by what you want to achieve. The agent saves a brief and draft deliverables. Use /campaign-run to prepare supported actions for approval, or /campaign-review to investigate results.</p><Button asChild className="mt-5"><Link to={askAgentPath(id, "/campaign")}>Plan with the agent<ArrowRightIcon /></Link></Button></Panel>}
    </div>
    <ConfirmDialog open={pending !== null} onOpenChange={next => { if (!next) setPending(null) }} title="Discard unsaved campaign changes?" description="Your saved campaign will not change. Unsaved edits will be lost." confirmLabel="Discard changes" cancelLabel="Keep editing" tone="destructive" onConfirm={async () => { if (pending) { setEditing(pending.campaign); setDirty(false); setError(""); setPending(null) } }} />
  </div>
}
