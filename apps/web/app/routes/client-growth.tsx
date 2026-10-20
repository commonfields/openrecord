import { useState } from "react"
import { Link, useParams } from "react-router"
import type { GrowthExecutionType, GrowthGoal, GrowthOpportunity, GrowthProfile, GrowthReview } from "@openrecord/contracts"
import { LightbulbIcon, TriangleAlertIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { EmptyState, PageHeader, Panel, PanelHeader } from "@/components/page"
import { GrowthProfileFields } from "@/components/growth-profile-fields"
import { GrowthEvaluationSection } from "@/components/growth-evaluation"
import { GrowthPlanSection } from "@/components/growth-plan"
import { GrowthReportPanel } from "@/components/growth-report-panel"
import { ApiError, Auth } from "@/lib/api"
import { Records } from "@/lib/record"
import { useApi } from "@/lib/use-api"
import { formatDateTime } from "@/lib/format"
import { Growth, GROWTH_CHANNEL_LABELS, GROWTH_EVIDENCE_LABELS, GROWTH_EXECUTION_LABELS, GROWTH_GOAL_LABELS, GROWTH_STATUS_LABELS, executionChannelsFor, executionFromForm, growthAssuranceBadge, growthAssuranceLabel, growthError, growthEvidencePath, growthExecutionActorLabel, localDateTimeInput, profileFromForm } from "@/lib/growth"

function ProfileEditor({ businessId, profile, done }: { businessId: string; profile: GrowthProfile | null; done: () => Promise<void> }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [requestKey] = useState(() => crypto.randomUUID())
  return <form className="grid gap-4 p-5" onSubmit={async e => {
    e.preventDefault(); const form = new FormData(e.currentTarget); setBusy(true); setError(null)
    try { await Growth.save(businessId, profileFromForm(form), requestKey); await done() }
    catch (err) { setError(err instanceof ApiError && err.body["reason"] === "IdempotencyConflict" ? "This save is already recorded. Close and reopen the editor before submitting different content." : growthError(err)) } finally { setBusy(false) }
  }}>
    <GrowthProfileFields profile={profile} />
    <p className="text-xs text-muted-foreground">A goal statement and its metric have separate versions. Existing initiatives keep their original goal and metric.</p>
    {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
    <Button disabled={busy} className="justify-self-start">{busy ? "Saving…" : "Save growth profile"}</Button>
  </form>
}

const OPPORTUNITY_FIELDS = [
  ["title", "Title", 200], ["problemStatement", "Problem statement", 2000], ["audience", "Audience", 1000],
  ["buyerIntent", "Buyer intent", 1000], ["source", "Where did this opportunity come from?", 300],
  ["proposedChange", "Proposed change", 2000], ["expectedMechanism", "Why might this help?", 2000],
  ["assumptions", "Assumptions", 2000], ["uncertainty", "Uncertainty and what to verify", 2000],
] as const
export function OpportunityForm({ businessId, goal, userId, websiteUrl, done }: { businessId: string; goal: GrowthGoal; userId: string; websiteUrl: string; done: () => Promise<void> }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [requestKey] = useState(() => crypto.randomUUID())
  return <form className="grid gap-4" onSubmit={async e => {
    e.preventDefault(); const form = new FormData(e.currentTarget); setBusy(true); setError(null)
    const text = (key: string) => String(form.get(key) ?? "").trim()
    try {
      await Growth.create(businessId, { goalId: goal.id, title: text("title"), problemStatement: text("problemStatement"), audience: text("audience"), buyerIntent: text("buyerIntent"),
        targetUrl: text("targetUrl") || null, source: text("source"), proposedChange: text("proposedChange"), expectedMechanism: text("expectedMechanism"), assumptions: text("assumptions"),
        uncertainty: text("uncertainty"), baselineAvailability: "UNKNOWN", ownerUserId: userId, initialStatus: "PROPOSED", idempotencyKey: requestKey,
        evidence: [{ type: "OPERATOR_HYPOTHESIS", note: "Operator-authored hypothesis. Supporting evidence and baseline impact have not been established." }] })
      await done()
    } catch (err) { setError(growthError(err)) } finally { setBusy(false) }
  }}>
    <p className="text-xs text-muted-foreground">For {GROWTH_GOAL_LABELS[goal.metricDefinition.conversionKind].toLowerCase()}, metric version {goal.metricDefinition.version}. You own this proposal. It starts as a hypothesis with baseline availability unknown.</p>
    {OPPORTUNITY_FIELDS.map(([name, label, max]) => <div className="grid gap-2" key={name}><Label htmlFor={`op-${name}`}>{label}</Label>
      {max > 1000 ? <Textarea id={`op-${name}`} name={name} maxLength={max} required /> : <Input id={`op-${name}`} name={name} maxLength={max} required />}
    </div>)}
    <div className="grid gap-2"><Label htmlFor="op-target">Primary page (optional)</Label><Input id="op-target" name="targetUrl" type="url" placeholder={websiteUrl} maxLength={2000} /></div>
    {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
    <DialogFooter><Button disabled={busy}>{busy ? "Saving…" : "Propose opportunity"}</Button></DialogFooter>
  </form>
}

export function OpportunityCard({ businessId, opportunity: o, goal, userId, reload }: { businessId: string; opportunity: GrowthOpportunity; goal: GrowthGoal | undefined; userId: string; reload: () => Promise<void> }) {
  const [decision, setDecision] = useState<"propose" | "approve" | "cancel" | "review" | null>(null)
  const [reason, setReason] = useState("")
  const [conclusion, setConclusion] = useState<GrowthReview["conclusion"]>("INCONCLUSIVE")
  const [requestKey, setRequestKey] = useState(() => crypto.randomUUID())
  const [expected, setExpected] = useState({ status: o.status, revision: o.revision })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [recording, setRecording] = useState(false)
  const [executionKey, setExecutionKey] = useState(() => crypto.randomUUID())
  const [executionType, setExecutionType] = useState<GrowthExecutionType | "">("")
  const [executionChannel, setExecutionChannel] = useState("")
  const beginExecution = () => { setError(null); setExecutionKey(crypto.randomUUID()); setExecutionType(""); setExecutionChannel(""); setRecording(true) }
  // The channel list follows the action: an incompatible pair is never offered,
  // and a previously chosen channel is cleared when the action changes.
  const chooseExecutionType = (value: string) => {
    const type = value as GrowthExecutionType
    setExecutionType(type)
    if (!(executionChannelsFor(type) as ReadonlyArray<string>).includes(executionChannel)) setExecutionChannel("")
  }
  const beginDecision = (next: "propose" | "approve" | "cancel" | "review") => {
    setDecision(next); setError(null); setReason(""); setRequestKey(crypto.randomUUID())
    setExpected({ status: o.status, revision: o.revision })
  }
  return <Panel><article className="space-y-4 p-5" id={`opportunity-${o.id}`}>
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-sm font-medium">{o.title}</h2><Badge variant={o.status === "APPROVED" ? "supported" : o.status === "PROPOSED" ? "review" : "outline"}>{GROWTH_STATUS_LABELS[o.status]}</Badge></div>
    <p className="text-xs leading-relaxed">{o.problemStatement}</p>
    <p className="text-xs text-muted-foreground">{o.executionCount} recorded executions. {o.progress === "NOT_STARTED" ? "No execution recorded." : "Execution recorded; publication and impact are not implied."}</p>
    <dl className="grid gap-3 text-xs sm:grid-cols-2">
      {[["Audience and intent", `${o.audience}\n${o.buyerIntent}`], ["Proposed change", o.proposedChange], ["Expected mechanism", o.expectedMechanism],
        ["Assumptions", o.assumptions], ["Uncertainty", o.uncertainty], ["Source", o.source]].map(([label, value]) => <div key={label}><dt className="text-muted-foreground">{label}</dt><dd className="mt-1 whitespace-pre-wrap">{value}</dd></div>)}
      <div><dt className="text-muted-foreground">Target page</dt><dd className="mt-1 break-all">{o.targetUrl ? <a href={o.targetUrl} target="_blank" rel="noreferrer" className="underline">{o.targetUrl}</a> : "No primary page"}</dd></div>
      <div><dt className="text-muted-foreground">Goal and baseline</dt><dd className="mt-1">{goal ? `${GROWTH_GOAL_LABELS[goal.metricDefinition.conversionKind]}, ${goal.metricDefinition.label}, metric version ${goal.metricDefinition.version}` : "Historical metric definition"}. Baseline: {o.baselineAvailability.toLowerCase()}.</dd></div>
      <div><dt className="text-muted-foreground">Operator owner</dt><dd className="mt-1">{o.ownerUserId === userId ? "You" : "Another account operator"}</dd></div>
      <div><dt className="text-muted-foreground">Created by</dt><dd className="mt-1">{o.createdByActor === "ASSISTANT" ? "Operator Agent" : "Account operator"}, {formatDateTime(o.createdAt)}</dd></div>
    </dl>
    <ul className="space-y-2" aria-label="Opportunity evidence">{o.evidence.map(e => <li key={e.id} className="flex flex-wrap items-start gap-2 text-xs">
      <Badge variant={e.type === "OBSERVED" ? "supported" : "outline"}>{GROWTH_EVIDENCE_LABELS[e.type]}</Badge><span className="min-w-0 flex-1">{e.note}
        {e.type === "OBSERVED" ? <Link to={growthEvidencePath(businessId, e.reference)} className="ml-1 underline">View stored {e.reference.kind.toLowerCase().replaceAll("_", " ")}</Link> : null}</span>
    </li>)}</ul>
    <details className="text-xs"><summary className="cursor-pointer font-medium">Event history ({o.events.length})</summary><ol className="mt-2 space-y-2 border-l pl-3">{o.events.map(event => <li key={event.id}>
      {event.conclusion ? <p>Conclusion: {event.conclusion.toLowerCase()}</p> : null}<p>{GROWTH_STATUS_LABELS[event.status]} by {event.actor === "ASSISTANT" ? "Operator Agent" : "operator"}, {formatDateTime(event.createdAt)}</p><p className="mt-0.5 text-muted-foreground">{event.reason}</p>
    </li>)}</ol></details>
    {o.executions.length ? <details className="text-xs"><summary className="cursor-pointer font-medium">Execution history ({o.executions.length})</summary>
      <ol className="mt-2 space-y-3 border-l pl-3">{o.executions.map(execution => <li key={execution.id}>
        <p className="flex flex-wrap items-center gap-2"><Badge variant="outline">{GROWTH_CHANNEL_LABELS[execution.channel]}</Badge>
          <Badge variant={execution.assurance === "SYSTEM_VERIFIED" ? "supported" : "outline"}>{growthAssuranceBadge(execution)}</Badge>
          <span className="font-medium">{GROWTH_EXECUTION_LABELS[execution.type]}</span></p>
        <p className="mt-0.5 break-all"><span className="text-muted-foreground">Reference: </span>{execution.target}</p>
        {execution.description ? <p className="mt-0.5 text-muted-foreground">{execution.description}</p> : null}
        <p className="mt-0.5 text-muted-foreground">Asserted by {growthExecutionActorLabel(execution, userId)} on {formatDateTime(execution.recordedAt)}; the operator says the action happened {formatDateTime(execution.performedAt)}. {growthAssuranceLabel(execution)}</p>
      </li>)}</ol></details> : null}
    {o.events.some(event => event.status === "APPROVED") ? <><GrowthPlanSection businessId={businessId} opportunityId={o.id} /><GrowthEvaluationSection businessId={businessId} opportunityId={o.id} /><GrowthReportPanel businessId={businessId} opportunityId={o.id} /></> : null}
    {o.status === "DISCOVERED" ? <Button size="sm" onClick={() => beginDecision("propose")}>Propose for review</Button> : null}
    {o.status === "PROPOSED" ? <div className="flex gap-2"><Button size="sm" onClick={() => beginDecision("approve")}>Approve</Button>
      <Button size="sm" variant="outline" onClick={() => beginDecision("cancel")}>Reject</Button></div> : null}
    {o.status === "APPROVED" ? <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" onClick={beginExecution}>Record execution</Button><Button size="sm" onClick={() => beginDecision("review")}>Record review</Button><Button size="sm" variant="outline" onClick={() => beginDecision("cancel")}>Cancel initiative</Button></div> : null}
    <Dialog open={decision !== null} onOpenChange={open => { if (!open && !busy) setDecision(null) }}><DialogContent><DialogHeader>
      <DialogTitle>{decision === "review" ? "Record review" : decision === "propose" ? "Propose for review" : decision === "approve" ? "Approve opportunity" : "Reject opportunity"}</DialogTitle><DialogDescription>{o.title}. {decision === "review" ? "Record your conclusion and its limits. A review does not verify publication or causal impact." : decision === "cancel" ? "Rejection cancels this opportunity and preserves its history." : decision === "propose" ? "Request human review of this hypothesis." : "Approval records your decision; it does not publish or deliver a change."}</DialogDescription>
    </DialogHeader><form className="grid gap-4" onSubmit={async e => {
      e.preventDefault(); if (!decision) return; setBusy(true); setError(null)
      try {
        const input = { expectedStatus: expected.status, expectedRevision: expected.revision, idempotencyKey: requestKey, reason }
        if (decision === "review") await Growth.review(businessId, o.id, { ...input, conclusion })
        else await Growth.decide(businessId, o.id, decision, input); setDecision(null); await reload() }
      catch (err) { setError(growthError(err)); await reload() } finally { setBusy(false) }
    }}>
      {decision === "review" ? <><Label htmlFor={`conclusion-${o.id}`}>Review conclusion</Label><Select value={conclusion} onValueChange={v => { if (v === "KEEP" || v === "REVERT" || v === "EXTEND" || v === "INCONCLUSIVE") setConclusion(v) }}><SelectTrigger id={`conclusion-${o.id}`}><SelectValue /></SelectTrigger><SelectContent>{(["KEEP", "REVERT", "EXTEND", "INCONCLUSIVE"] as const).map(v => <SelectItem key={v} value={v}>{v.toLowerCase()}</SelectItem>)}</SelectContent></Select></> : null}
      <Label htmlFor={`decision-${o.id}`}>Reason for your decision</Label><Textarea id={`decision-${o.id}`} value={reason} onChange={e => setReason(e.target.value)} maxLength={1000} required />
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
      <DialogFooter><Button type="button" variant="ghost" disabled={busy} onClick={() => setDecision(null)}>Back</Button><Button disabled={busy || !reason.trim()}>{busy ? "Saving…" : decision === "review" ? "Record review" : decision === "propose" ? "Propose for review" : decision === "approve" ? "Approve opportunity" : "Reject opportunity"}</Button></DialogFooter>
    </form></DialogContent></Dialog>
    <Dialog open={recording} onOpenChange={open => { if (!open && !busy) setRecording(false) }}><DialogContent className="max-h-[85vh] overflow-y-auto"><DialogHeader>
      <DialogTitle>Record execution</DialogTitle><DialogDescription>{o.title}. Record what a person actually did for this approved initiative. The entry is operator-attested, does not prove publication and implies no measured outcome.</DialogDescription>
    </DialogHeader><form className="grid gap-4" onSubmit={async e => {
      e.preventDefault(); setBusy(true); setError(null)
      try { await Growth.recordExecution(businessId, o.id, executionFromForm(new FormData(e.currentTarget), executionKey, { type: executionType, channel: executionChannel })); setRecording(false); await reload() }
      catch (err) { setError(growthError(err)); await reload() } finally { setBusy(false) }
    }}>
      <div className="grid gap-2"><Label htmlFor={`execution-type-${o.id}`}>Action performed</Label>
        <Select value={executionType} onValueChange={chooseExecutionType}><SelectTrigger id={`execution-type-${o.id}`}><SelectValue placeholder="Choose the action you performed" /></SelectTrigger>
          <SelectContent>{(Object.keys(GROWTH_EXECUTION_LABELS) as Array<keyof typeof GROWTH_EXECUTION_LABELS>).map(type => <SelectItem key={type} value={type}>{GROWTH_EXECUTION_LABELS[type]}</SelectItem>)}</SelectContent></Select></div>
      <div className="grid gap-2"><Label htmlFor={`execution-channel-${o.id}`}>Channel</Label>
        <Select value={executionChannel} onValueChange={setExecutionChannel}><SelectTrigger id={`execution-channel-${o.id}`}><SelectValue placeholder="Choose the channel" /></SelectTrigger>
          <SelectContent>{(executionChannelsFor(executionType) as ReadonlyArray<keyof typeof GROWTH_CHANNEL_LABELS>).map(channel => <SelectItem key={channel} value={channel}>{GROWTH_CHANNEL_LABELS[channel]}</SelectItem>)}</SelectContent></Select></div>
      <div className="grid gap-2"><Label htmlFor={`execution-target-${o.id}`}>Reference (page, listing, campaign, profile or artifact)</Label><Input id={`execution-target-${o.id}`} name="target" maxLength={500} required />
        <p className="text-xs text-muted-foreground">A plain identifier or an absolute http(s) URL. OpenRecord stores it as your reference and does not fetch it.</p></div>
      <div className="grid gap-2"><Label htmlFor={`execution-description-${o.id}`}>What did you actually do?</Label><Textarea id={`execution-description-${o.id}`} name="description" maxLength={2000} required /></div>
      <div className="grid gap-2"><Label htmlFor={`execution-time-${o.id}`}>Performed at</Label><Input id={`execution-time-${o.id}`} name="performedAt" type="datetime-local" defaultValue={localDateTimeInput(new Date())} required /></div>
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
      <DialogFooter><Button type="button" variant="ghost" disabled={busy} onClick={() => setRecording(false)}>Back</Button><Button disabled={busy}>{busy ? "Saving…" : "Record execution"}</Button></DialogFooter>
    </form></DialogContent></Dialog>
  </article></Panel>
}

export function ClientGrowthPage() {
  const { id = "" } = useParams()
  const state = useApi(`growth:${id}`, async () => {
    const [record, growth, opportunities, user] = await Promise.all([Records.get(id), Growth.profile(id), Growth.list(id), Auth.me()])
    return { record: record.record, ...growth, ...opportunities, user }
  })
  const [editing, setEditing] = useState(false)
  const [creating, setCreating] = useState(false)
  if (state.error) return <EmptyState icon={<TriangleAlertIcon />} title="Growth workspace could not load" description={growthError(state.error)} action={<Button variant="outline" onClick={() => void state.reload()}>Try again</Button>} />
  if (!state.data || state.loading) return <p className="text-xs text-muted-foreground">Loading growth workspace…</p>
  const { record, profile, goals, opportunities, user } = state.data
  return <div className="space-y-5 pb-4">
    <PageHeader title={`${record.profile.name} growth`} back={{ to: `/clients/${id}`, label: "Client record" }}
      description="Choose a goal, investigate evidence, then review specific marketing opportunities."
      meta={<><Link to={`/clients/${id}/growth-measurement`} className="font-medium hover:underline">Measurement imports</Link><Link to={`/clients/${id}/discovery`} className="font-medium hover:underline">AI Discovery</Link><Link to={`/clients/${id}`} className="font-medium hover:underline">Operator Agent</Link><Link to={`/businesses/${id}/overview`} className="font-medium hover:underline">Overview</Link><span>{record.profile.engagement === "DOGFOOD" ? "Owned product" : record.profile.engagement === "FIXTURE" ? "Fixture product" : "Authorized client"}</span></>}
      actions={<Button size="sm" disabled={!profile} onClick={() => setCreating(true)}>Propose opportunity</Button>} />
    <Panel><PanelHeader title="Product and primary goal" description="A human-authored objective with an exact metric definition.">{profile ? <Button size="sm" variant="outline" onClick={() => setEditing(!editing)}>{editing ? "Close editor" : "Edit profile"}</Button> : null}</PanelHeader>
      {!profile || editing ? <ProfileEditor key={profile?.updatedAt ?? "new"} businessId={id} profile={profile} done={async () => { setEditing(false); await state.reload() }} /> : <div className="grid gap-4 p-5 text-xs sm:grid-cols-2">
        <div className="space-y-2"><p className="font-medium">{profile.category}</p><p>{profile.audience}</p><p className="text-muted-foreground">{profile.valueProposition}</p></div>
        <div className="space-y-2"><h2 className="font-medium text-primary">{profile.primaryGoal.statement}</h2>
          <p>{profile.primaryGoal.metricDefinition.label} ({GROWTH_GOAL_LABELS[profile.primaryGoal.metricDefinition.conversionKind]})</p>
          <p>{profile.primaryGoal.metricDefinition.sourceIdentity}: {profile.primaryGoal.metricDefinition.sourceKind === "GA4_AGGREGATE_EXPORT" ? profile.primaryGoal.metricDefinition.eventName : "Operator aggregate CSV"}</p>
          <p>{profile.primaryGoal.metricDefinition.countingSemantics}, {profile.primaryGoal.metricDefinition.unit}{profile.primaryGoal.metricDefinition.currency ? ` (${profile.primaryGoal.metricDefinition.currency})` : ""}. Reporting timezone: {profile.primaryGoal.metricDefinition.reportingTimeZone}.</p>
          <p>Goal version {profile.primaryGoal.version}, metric version {profile.primaryGoal.metricDefinition.version}.</p><p className="text-muted-foreground">Source identity is operator-supplied. No growth outcome is inferred.</p></div>
      </div>}
    </Panel>
    {opportunities.length ? <div className="space-y-4">{opportunities.map(o => <OpportunityCard key={o.id} businessId={id} opportunity={o} goal={goals.find(g => g.id === o.goalId)} userId={user.userId} reload={state.reload} />)}
      <p className="text-xs text-muted-foreground">Showing the latest {opportunities.length} opportunities (up to 50).</p></div> : <EmptyState icon={<LightbulbIcon />} title="No opportunities yet" description="Investigate existing evidence with the Operator Agent, or write a specific hypothesis to review." />}
    <Dialog open={creating} onOpenChange={setCreating}><DialogContent className="max-h-[85vh] overflow-y-auto"><DialogHeader><DialogTitle>Propose an opportunity</DialogTitle><DialogDescription>Describe one specific marketing improvement and what remains uncertain.</DialogDescription></DialogHeader>
      {profile ? <OpportunityForm businessId={id} goal={profile.primaryGoal} userId={user.userId} websiteUrl={record.profile.websiteUrl} done={async () => { setCreating(false); await state.reload() }} /> : null}
    </DialogContent></Dialog>
  </div>
}
