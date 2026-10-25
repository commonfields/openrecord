// W4 outcome evaluation section for one initiative card. Loads on demand and
// renders the descriptive read model as-is: windows, gaps, actions and the
// limits of interpretation. It never labels an initiative as a success or
// credits it with a change.
import { useState } from "react"
import type { GrowthEvaluationWindow, GrowthOutcomeEvaluation } from "@openrecord/contracts"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { formatDateTime } from "@/lib/format"
import { GROWTH_CHANNEL_LABELS, GROWTH_EVALUATION_ASSURANCE_LABELS, GROWTH_EVALUATION_CAVEAT_LABELS, GROWTH_EVALUATION_PHASE_LABELS, GROWTH_EVALUATION_REASON_LABELS, GROWTH_EXECUTION_LABELS, Growth, growthError } from "@/lib/growth"

const signed = (n: number) => `${n > 0 ? "+" : ""}${n.toLocaleString()}`

function WindowSummary({ label, w }: { label: string; w: GrowthEvaluationWindow }) {
  const gaps = [["missing", w.missingDays], ["no import", w.unavailableDays], ["conflicting", w.conflictingDays], ["synthetic", w.syntheticDays]] as const
  return <div className="space-y-1">
    <p className="font-medium">{label}: {w.start} → {w.end} ({w.days} days)</p>
    <p>{w.validDays} of {w.days} days carry a valid recorded value ({Math.round(w.coverage * 100)}% coverage).</p>
    <p>Valid total {w.validTotal.toLocaleString()}{w.dailyMean ? `; ${w.dailyMean.value.toLocaleString()} per valid day` : "; no valid day, so no per-day figure"}.</p>
    {gaps.filter(([, list]) => list.length).map(([name, list]) => <p key={name} className="text-destructive">{list.length} {name}: {list.join(", ")}</p>)}
  </div>
}

export function EvaluationView({ evaluation: e }: { evaluation: GrowthOutcomeEvaluation }) {
  return <div className="space-y-3" aria-label="Outcome evaluation">
    <p className="flex flex-wrap items-center gap-2">
      <Badge variant={e.status === "COMPARABLE" ? "supported" : "review"}>{e.status === "COMPARABLE" ? "Measurements comparable" : "Indeterminate"}</Badge>
      <span className="text-muted-foreground">Descriptive before/after reading, evaluated {formatDateTime(e.evaluatedAt)}. It does not show what caused any change.</span>
    </p>
    <p>Goal (version {e.goal.version}): {e.goal.statement}. Metric: {e.metric.label}, version {e.metric.version}, {e.metric.countingSemantics}/{e.metric.unit}{e.metric.currency ? ` ${e.metric.currency}` : ""} from {e.metric.sourceIdentity}{e.metric.eventName ? ` (${e.metric.eventName})` : ""}; days in {e.metric.timeZone}.</p>
    {e.plan ? <p>Plan declared {formatDateTime(e.plan.declaredAt)} — {e.plan.timing === "PRE_DECLARED" ? "before any linked action" : "after a linked action was performed"}{e.plan.declarations > 1 ? `; latest of ${e.plan.declarations} declarations` : ""}.</p> : null}
    {e.reasons.length ? <div><p className="font-medium">Why no comparison is shown</p>
      <ul className="mt-1 list-disc space-y-1 pl-4" aria-label="Blocking reasons">{e.reasons.map(r => <li key={r.code}><span className="font-medium">{GROWTH_EVALUATION_REASON_LABELS[r.code]}.</span> {r.detail}</li>)}</ul></div> : null}
    {e.baseline || e.observation ? <div className="grid gap-3 sm:grid-cols-2">
      {e.baseline ? <WindowSummary label="Baseline" w={e.baseline} /> : null}
      {e.observation ? <WindowSummary label="Observation" w={e.observation} /> : null}
    </div> : null}
    {e.comparison && e.baseline?.dailyMean && e.observation?.dailyMean ? <p className="rounded-md border p-2">
      Recorded per-day mean: {e.baseline.dailyMean.value.toLocaleString()} in the baseline, {e.observation.dailyMean.value.toLocaleString()} in the observation window
      (difference {signed(e.comparison.dailyMeanDifference)}{e.comparison.dailyMeanPercentChange === null ? "" : `, ${signed(e.comparison.dailyMeanPercentChange)}%`}).
      {e.comparison.totalDifference === null ? " Totals are not compared because the windows differ in length." : ` Totals differ by ${signed(e.comparison.totalDifference)}.`}
      {" "}This describes recorded values only; it is not growth caused by this initiative.
    </p> : null}
    <div><p className="font-medium">Recorded actions in the period ({e.actions.length})</p>
      <ol className="mt-1 space-y-2 border-l pl-3" aria-label="Recorded actions">{e.actions.map(a => <li key={a.id}>
        <p className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">{a.channel && a.channel in GROWTH_CHANNEL_LABELS ? GROWTH_CHANNEL_LABELS[a.channel as keyof typeof GROWTH_CHANNEL_LABELS] : "No channel"}</Badge>
          <Badge variant={a.assurance === "SYSTEM_VERIFIED" ? "supported" : "outline"}>{GROWTH_EVALUATION_ASSURANCE_LABELS[a.assurance]}</Badge>
          <span className="font-medium">{GROWTH_EXECUTION_LABELS[a.type]}</span>
          <span className="text-muted-foreground">{a.association === "THIS_INITIATIVE" ? "this initiative" : a.initiative ? `another initiative: ${a.initiative.title}` : "not linked to an initiative"}</span>
        </p>
        <p className="mt-0.5 break-all">{a.reference}</p>
        <p className="mt-0.5 text-muted-foreground">Performed {formatDateTime(a.performedAt)} ({a.performedDay}, {GROWTH_EVALUATION_PHASE_LABELS[a.phase]}); recorded {formatDateTime(a.recordedAt)}.</p>
      </li>)}</ol></div>
    {e.caveats.length ? <div><p className="font-medium">Read with care</p>
      <ul className="mt-1 list-disc space-y-1 pl-4" aria-label="Caveats">{e.caveats.map(c => <li key={c.code}><span className="font-medium">{GROWTH_EVALUATION_CAVEAT_LABELS[c.code]}.</span> {c.detail}</li>)}</ul></div> : null}
    <details><summary className="cursor-pointer">Assumptions and limitations</summary>
      <ul className="mt-1 list-disc space-y-1 pl-4 text-muted-foreground">{[...e.assumptions, ...e.limitations].map(text => <li key={text}>{text}</li>)}</ul></details>
  </div>
}

export function GrowthEvaluationSection({ businessId, opportunityId }: { businessId: string; opportunityId: string }) {
  const [evaluation, setEvaluation] = useState<GrowthOutcomeEvaluation | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const load = async () => {
    setBusy(true); setError(null)
    try { setEvaluation((await Growth.evaluation(businessId, opportunityId)).evaluation) } catch (err) { setError(growthError(err)) } finally { setBusy(false) }
  }
  return <details className="text-xs" onToggle={e => { if ((e.currentTarget as HTMLDetailsElement).open && !evaluation && !busy) void load() }}>
    <summary className="cursor-pointer font-medium">Outcome evaluation</summary>
    <div className="mt-2 space-y-2">
      {busy && !evaluation ? <p className="text-muted-foreground">Evaluating…</p> : null}
      {error ? <p role="alert" className="text-destructive">{error}</p> : null}
      {evaluation ? <><EvaluationView evaluation={evaluation} /><Button size="sm" variant="outline" disabled={busy} onClick={() => void load()}>{busy ? "Evaluating…" : "Re-evaluate"}</Button></> : null}
    </div>
  </details>
}
