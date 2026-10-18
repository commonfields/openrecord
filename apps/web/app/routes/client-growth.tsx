import { useState } from "react"
import { Link, useParams } from "react-router"
import type { GrowthGoal, GrowthOpportunity, GrowthProfile } from "@openrecord/contracts"
import { LightbulbIcon, TriangleAlertIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { EmptyState, PageHeader, Panel, PanelHeader } from "@/components/page"
import { GrowthProfileFields } from "@/components/growth-profile-fields"
import { Auth } from "@/lib/api"
import { Records } from "@/lib/record"
import { useApi } from "@/lib/use-api"
import { formatDateTime } from "@/lib/format"
import { Growth, GROWTH_EVIDENCE_LABELS, GROWTH_GOAL_LABELS, GROWTH_STATUS_LABELS, growthError, growthEvidencePath, profileFromForm } from "@/lib/growth"

function ProfileEditor({ businessId, profile, done }: { businessId: string; profile: GrowthProfile | null; done: () => Promise<void> }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return <form className="grid gap-4 p-5" onSubmit={async e => {
    e.preventDefault(); const form = new FormData(e.currentTarget); setBusy(true); setError(null)
    try { await Growth.save(businessId, profileFromForm(form)); await done() } catch (err) { setError(growthError(err)) } finally { setBusy(false) }
  }}>
    <GrowthProfileFields profile={profile} />
    <p className="text-xs text-muted-foreground">Changing a metric creates a new definition. Existing opportunities keep the definition they were created against.</p>
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
function OpportunityForm({ businessId, goal, userId, websiteUrl, done }: { businessId: string; goal: GrowthGoal; userId: string; websiteUrl: string; done: () => Promise<void> }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [requestKey] = useState(() => crypto.randomUUID())
  return <form className="grid gap-4" onSubmit={async e => {
    e.preventDefault(); const form = new FormData(e.currentTarget); setBusy(true); setError(null)
    const text = (key: string) => String(form.get(key) ?? "").trim()
    try {
      await Growth.create(businessId, { goalId: goal.id, title: text("title"), problemStatement: text("problemStatement"), audience: text("audience"), buyerIntent: text("buyerIntent"),
        targetUrl: text("targetUrl"), source: text("source"), proposedChange: text("proposedChange"), expectedMechanism: text("expectedMechanism"), assumptions: text("assumptions"),
        uncertainty: text("uncertainty"), baselineAvailability: "UNKNOWN", ownerUserId: userId, initialStatus: "PROPOSED", idempotencyKey: requestKey,
        evidence: [{ type: "OPERATOR_HYPOTHESIS", note: "Operator-authored hypothesis. Supporting evidence and baseline impact have not been established." }] })
      await done()
    } catch (err) { setError(growthError(err)) } finally { setBusy(false) }
  }}>
    <p className="text-xs text-muted-foreground">For {GROWTH_GOAL_LABELS[goal.kind].toLowerCase()}, metric version {goal.version}. You own this proposal. It starts as a hypothesis with baseline availability unknown.</p>
    {OPPORTUNITY_FIELDS.map(([name, label, max]) => <div className="grid gap-2" key={name}><Label htmlFor={`op-${name}`}>{label}</Label>
      {max > 1000 ? <Textarea id={`op-${name}`} name={name} maxLength={max} required /> : <Input id={`op-${name}`} name={name} maxLength={max} required />}
    </div>)}
    <div className="grid gap-2"><Label htmlFor="op-target">Target marketing page</Label><Input id="op-target" name="targetUrl" type="url" defaultValue={websiteUrl} maxLength={2000} required /></div>
    {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
    <DialogFooter><Button disabled={busy}>{busy ? "Saving…" : "Propose opportunity"}</Button></DialogFooter>
  </form>
}

function OpportunityCard({ businessId, opportunity: o, goal, userId, reload }: { businessId: string; opportunity: GrowthOpportunity; goal: GrowthGoal | undefined; userId: string; reload: () => Promise<void> }) {
  const [decision, setDecision] = useState<"propose" | "approve" | "cancel" | null>(null)
  const [reason, setReason] = useState("")
  const [requestKey, setRequestKey] = useState(() => crypto.randomUUID())
  const [expected, setExpected] = useState({ status: o.status, revision: o.revision })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const beginDecision = (next: "propose" | "approve" | "cancel") => {
    setDecision(next); setError(null); setReason(""); setRequestKey(crypto.randomUUID())
    setExpected({ status: o.status, revision: o.revision })
  }
  return <Panel><article className="space-y-4 p-5" id={`opportunity-${o.id}`}>
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="text-sm font-medium">{o.title}</h2><Badge variant={o.status === "APPROVED" ? "supported" : o.status === "PROPOSED" ? "review" : "outline"}>{GROWTH_STATUS_LABELS[o.status]}</Badge></div>
    <p className="text-xs leading-relaxed">{o.problemStatement}</p>
    <dl className="grid gap-3 text-xs sm:grid-cols-2">
      {[["Audience and intent", `${o.audience}\n${o.buyerIntent}`], ["Proposed change", o.proposedChange], ["Expected mechanism", o.expectedMechanism],
        ["Assumptions", o.assumptions], ["Uncertainty", o.uncertainty], ["Source", o.source]].map(([label, value]) => <div key={label}><dt className="text-muted-foreground">{label}</dt><dd className="mt-1 whitespace-pre-wrap">{value}</dd></div>)}
      <div><dt className="text-muted-foreground">Target page</dt><dd className="mt-1 break-all"><a href={o.targetUrl} target="_blank" rel="noreferrer" className="underline">{o.targetUrl}</a></dd></div>
      <div><dt className="text-muted-foreground">Goal and baseline</dt><dd className="mt-1">{goal ? `${GROWTH_GOAL_LABELS[goal.kind]}, ${goal.eventName}, metric version ${goal.version}` : "Historical metric definition"}. Baseline: {o.baselineAvailability.toLowerCase()}.</dd></div>
      <div><dt className="text-muted-foreground">Operator owner</dt><dd className="mt-1">{o.ownerUserId === userId ? "You" : "Another account operator"}</dd></div>
      <div><dt className="text-muted-foreground">Created by</dt><dd className="mt-1">{o.createdByActor === "ASSISTANT" ? "Operator Agent" : "Account operator"}, {formatDateTime(o.createdAt)}</dd></div>
    </dl>
    <ul className="space-y-2" aria-label="Opportunity evidence">{o.evidence.map(e => <li key={e.id} className="flex flex-wrap items-start gap-2 text-xs">
      <Badge variant={e.type === "OBSERVED" ? "supported" : "outline"}>{GROWTH_EVIDENCE_LABELS[e.type]}</Badge><span className="min-w-0 flex-1">{e.note}
        {e.type === "OBSERVED" ? <Link to={growthEvidencePath(businessId, e.reference)} className="ml-1 underline">View stored {e.reference.kind.toLowerCase().replaceAll("_", " ")}</Link> : null}</span>
    </li>)}</ul>
    <details className="text-xs"><summary className="cursor-pointer font-medium">Event history ({o.events.length})</summary><ol className="mt-2 space-y-2 border-l pl-3">{o.events.map(event => <li key={event.id}>
      <p>{GROWTH_STATUS_LABELS[event.status]} by {event.actor === "ASSISTANT" ? "Operator Agent" : "operator"}, {formatDateTime(event.createdAt)}</p><p className="mt-0.5 text-muted-foreground">{event.reason}</p>
    </li>)}</ol></details>
    {o.status === "DISCOVERED" ? <Button size="sm" onClick={() => beginDecision("propose")}>Propose for review</Button> : null}
    {o.status === "PROPOSED" ? <div className="flex gap-2"><Button size="sm" onClick={() => beginDecision("approve")}>Approve</Button>
      <Button size="sm" variant="outline" onClick={() => beginDecision("cancel")}>Reject</Button></div> : null}
    <Dialog open={decision !== null} onOpenChange={open => { if (!open && !busy) setDecision(null) }}><DialogContent><DialogHeader>
      <DialogTitle>{decision === "propose" ? "Propose for review" : decision === "approve" ? "Approve opportunity" : "Reject opportunity"}</DialogTitle><DialogDescription>{o.title}. {decision === "cancel" ? "Rejection cancels this opportunity and preserves its history." : decision === "propose" ? "Request human review of this hypothesis." : "Approval records your decision; it does not publish or deliver a change."}</DialogDescription>
    </DialogHeader><form className="grid gap-4" onSubmit={async e => {
      e.preventDefault(); if (!decision) return; setBusy(true); setError(null)
      try { await Growth.decide(businessId, o.id, decision, { expectedStatus: expected.status, expectedRevision: expected.revision, idempotencyKey: requestKey, reason }); setDecision(null); await reload() }
      catch (err) { setError(growthError(err)); await reload() } finally { setBusy(false) }
    }}><Label htmlFor={`decision-${o.id}`}>Reason for your decision</Label><Textarea id={`decision-${o.id}`} value={reason} onChange={e => setReason(e.target.value)} maxLength={1000} required />
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
      <DialogFooter><Button type="button" variant="ghost" disabled={busy} onClick={() => setDecision(null)}>Back</Button><Button disabled={busy || !reason.trim()}>{busy ? "Saving…" : decision === "propose" ? "Propose for review" : decision === "approve" ? "Approve opportunity" : "Reject opportunity"}</Button></DialogFooter>
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
      meta={<><Link to={`/clients/${id}/discovery`} className="font-medium hover:underline">AI Discovery</Link><Link to={`/clients/${id}`} className="font-medium hover:underline">Operator Agent</Link><Link to={`/businesses/${id}/overview`} className="font-medium hover:underline">Overview</Link><span>{record.profile.engagement === "DOGFOOD" ? "Owned product" : record.profile.engagement === "FIXTURE" ? "Fixture product" : "Authorized client"}</span></>}
      actions={<Button size="sm" disabled={!profile} onClick={() => setCreating(true)}>Propose opportunity</Button>} />
    <Panel><PanelHeader title="Product and primary goal" description="A human-authored objective with an exact metric definition.">{profile ? <Button size="sm" variant="outline" onClick={() => setEditing(!editing)}>{editing ? "Close editor" : "Edit profile"}</Button> : null}</PanelHeader>
      {!profile || editing ? <ProfileEditor key={profile?.updatedAt ?? "new"} businessId={id} profile={profile} done={async () => { setEditing(false); await state.reload() }} /> : <div className="grid gap-4 p-5 text-xs sm:grid-cols-2">
        <div className="space-y-2"><p className="font-medium">{profile.category}</p><p>{profile.audience}</p><p className="text-muted-foreground">{profile.valueProposition}</p></div>
        <div className="space-y-2"><h2 className="font-medium text-primary">{GROWTH_GOAL_LABELS[profile.primaryGoal.kind]}</h2><p>GA4 aggregate export: <strong>{profile.primaryGoal.eventName}</strong></p>
          <p>Event count, not distinct people. Reporting timezone: {profile.primaryGoal.reportingTimeZone}.</p><p>Property: {profile.primaryGoal.propertyRef ?? "Not configured"}. Metric version {profile.primaryGoal.version}.</p><p className="text-muted-foreground">No growth outcomes measured here yet.</p></div>
      </div>}
    </Panel>
    {opportunities.length ? <div className="space-y-4">{opportunities.map(o => <OpportunityCard key={o.id} businessId={id} opportunity={o} goal={goals.find(g => g.id === o.goalId)} userId={user.userId} reload={state.reload} />)}
      <p className="text-xs text-muted-foreground">Showing the latest {opportunities.length} opportunities (up to 50).</p></div> : <EmptyState icon={<LightbulbIcon />} title="No opportunities yet" description="Investigate existing evidence with the Operator Agent, or write a specific hypothesis to review." />}
    <Dialog open={creating} onOpenChange={setCreating}><DialogContent className="max-h-[85vh] overflow-y-auto"><DialogHeader><DialogTitle>Propose an opportunity</DialogTitle><DialogDescription>Describe one specific marketing improvement and what remains uncertain.</DialogDescription></DialogHeader>
      {profile ? <OpportunityForm businessId={id} goal={profile.primaryGoal} userId={user.userId} websiteUrl={record.profile.websiteUrl} done={async () => { setCreating(false); await state.reload() }} /> : null}
    </DialogContent></Dialog>
  </div>
}
