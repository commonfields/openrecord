// Measurement plan for one approved initiative: the before and after periods,
// declared BEFORE the work is done. The plan is what lets the outcome
// evaluation and the client report say the periods were not chosen after the
// fact. Declaring is append-only: the latest declaration is the one in force.
import { useState } from "react"
import { Link } from "react-router"
import type { GrowthPlanRead } from "@openrecord/contracts"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { formatDateTime } from "@/lib/format"
import { Growth, growthError, planFromForm } from "@/lib/growth"
import { ApiError } from "@/lib/api"

const PLAN_FIELDS = [["baselineStart", "Baseline starts"], ["baselineEnd", "Baseline ends"], ["observationStart", "Observation starts"], ["observationEnd", "Observation ends"]] as const
const planError = (e: unknown): string => {
  const reason = e instanceof ApiError && typeof e.body["reason"] === "string" ? e.body["reason"] : ""
  if (reason === "InvalidPlanWindow") return "The periods must not overlap, and each can cover at most one year."
  if (reason === "CurrencyMeasurementRefused") return "Currency metrics cannot be measured yet. Use a count metric."
  if (reason === "PlanOpportunityNotApproved") return "Only an approved initiative can have a measurement plan."
  if (reason === "IdempotencyConflict") return "This request no longer matches. Reopen the form and try again."
  return growthError(e)
}

export function PlanSummary({ read }: { read: GrowthPlanRead }) {
  const { plan, timing } = read
  return <div className="space-y-1" aria-label="Declared measurement plan">
    <p className="flex flex-wrap items-center gap-2">
      <Badge variant={timing === "PRE_DECLARED" ? "supported" : "review"}>{timing === "PRE_DECLARED" ? "Declared before the work" : "Declared after the work"}</Badge>
      <span className="text-muted-foreground">Declared {formatDateTime(plan.declaredAt)}.</span>
    </p>
    <p>Baseline: {plan.baselineStart} → {plan.baselineEnd}. Observation: {plan.observationStart} → {plan.observationEnd}.</p>
    <p className="text-muted-foreground">Metric: {plan.metricDefinition.label}, version {plan.metricDefinition.version}, time zone {plan.metricDefinition.timeZone}.</p>
    {timing === "DECLARED_AFTER_EXECUTION" ? <p className="text-destructive">A recorded action is earlier than this plan, so the outcome evaluation will not treat the periods as agreed in advance.</p> : null}
  </div>
}

export function GrowthPlanSection({ businessId, opportunityId }: { businessId: string; opportunityId: string }) {
  const [read, setRead] = useState<GrowthPlanRead | null | undefined>(undefined)
  const [requestKey, setRequestKey] = useState(() => crypto.randomUUID())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const load = async () => {
    setBusy(true); setError(null)
    try { setRead((await Growth.plan(businessId, opportunityId)).plan) } catch (err) { setError(planError(err)) } finally { setBusy(false) }
  }
  return <details className="text-xs" onToggle={e => { if ((e.currentTarget as HTMLDetailsElement).open && read === undefined && !busy) void load() }}>
    <summary className="cursor-pointer font-medium">Measurement plan</summary>
    <div className="mt-2 space-y-3">
      {busy && read === undefined ? <p className="text-muted-foreground">Loading plan…</p> : null}
      {read ? <PlanSummary read={read} /> : read === null ? <p className="text-muted-foreground">No plan declared yet. Declare the before and after periods <strong>before</strong> you record any work, so the report can show they were not chosen afterwards.</p> : null}
      {read !== undefined ? <form className="grid gap-3" onSubmit={async e => {
        e.preventDefault(); setBusy(true); setError(null)
        try { setRead((await Growth.declarePlan(businessId, opportunityId, planFromForm(new FormData(e.currentTarget), requestKey))).plan); setRequestKey(crypto.randomUUID()) }
        catch (err) { setError(err instanceof Error && !(err instanceof ApiError) ? err.message : planError(err)) } finally { setBusy(false) }
      }}>
        <div className="grid gap-3 sm:grid-cols-2">{PLAN_FIELDS.map(([name, label]) => <div className="grid gap-1" key={name}>
          <Label htmlFor={`plan-${name}-${opportunityId}`}>{label}</Label><Input id={`plan-${name}-${opportunityId}`} name={name} type="date" required /></div>)}</div>
        <p className="text-muted-foreground">Days are counted in the metric's time zone. Declaring again replaces the plan in force and is shown as a re-declaration in the report.
          Daily figures are imported on the <Link to={`/clients/${businessId}/growth-measurement`} className="underline">measurement imports page</Link>.</p>
        {error ? <p role="alert" className="text-destructive">{error}</p> : null}
        <Button size="sm" disabled={busy} className="justify-self-start">{busy ? "Saving…" : read ? "Declare a new plan" : "Declare plan"}</Button>
      </form> : null}
      {read === undefined && error ? <p role="alert" className="text-destructive">{error}</p> : null}
    </div>
  </details>
}
