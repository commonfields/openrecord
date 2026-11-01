// Scheduled AI-answer tracking for one client: approve once (how often, how
// many samples, the exact model-call ceiling of each run), and OpenRecord
// measures on its own and raises an alert when answers name the business, or
// cite its site, less often than the run before.
import { useState } from "react"
import { toast } from "sonner"
import { BellRingIcon, CalendarClockIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Panel, PanelHeader } from "@/components/page"
import { Tracking, type QuestionSet, type TrackingAlert, type TrackingResponse } from "@/lib/acquisition"
import { relativeTime } from "@/lib/format"
import { useApi } from "@/lib/use-api"

const ALERT_LABEL: Readonly<Record<TrackingAlert["kind"], string>> = {
  BRAND_MENTIONS_DROPPED: "Named less often",
  OWN_CITATIONS_DROPPED: "Own site cited less often",
}
const PAUSE_REASON = (reason: string) => /ceiling|calls/i.test(reason)
  ? "the question set changed, so the approved cost no longer matches"
  : "it could not start a run"
const share = (f: { n: number; d: number }) => `${f.n} of ${f.d}`

export function TrackingSchedulePanel({ clientId, set, maxAttempts }: { clientId: string; set: QuestionSet; maxAttempts: number }) {
  const q = useApi(`tracking:${clientId}`, () => Tracking.get(clientId))
  const [editing, setEditing] = useState(false)
  const data = q.data
  const schedule = data?.schedule ?? null
  return (
    <Panel>
      <PanelHeader icon={<CalendarClockIcon />} title="Track automatically"
        description="Measure these questions on a schedule and get an alert when AI answers mention you less.">
        {schedule ? <Switch aria-label={schedule.enabled ? "Pause tracking" : "Resume tracking"} checked={schedule.enabled}
          onCheckedChange={v => void Tracking.setEnabled(clientId, v).then(() => q.reload(), () => toast.error(v ? "Approve the schedule again to resume it." : "Couldn't pause tracking. Try again."))} /> : null}
      </PanelHeader>
      <div className="space-y-3 px-4 pb-4 text-xs">
        {!data ? <p className="text-muted-foreground">Loading</p> : schedule && !editing ? (
          <>
            <p>
              {schedule.cadence === "DAILY" ? "Every day" : "Every week"}, {schedule.samples} sample{schedule.samples === 1 ? "" : "s"} per question, up to {schedule.maxProviderCalls} model calls a run
              {schedule.estimatedMaxCostUsd !== null ? ` (about $${schedule.estimatedMaxCostUsd.toFixed(2)})` : ""}.
            </p>
            <p className="text-muted-foreground">
              {schedule.pausedReason ? `Paused: ${PAUSE_REASON(schedule.pausedReason)}. Approve it again to resume.`
                : schedule.enabled ? `Next run ${schedule.nextRunAt ? relativeTime(schedule.nextRunAt) : "soon"}. Alerts at a drop of ${schedule.alertDropPoints} points or more.`
                : "Paused."}
            </p>
            {schedule.setId !== set.id ? <p className="text-muted-foreground">It measures an earlier question set. Approve again to track v{set.version}.</p> : null}
            <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => setEditing(true)}>Change or approve again</Button>
          </>
        ) : <ApproveForm clientId={clientId} set={set} maxAttempts={maxAttempts} current={data} onDone={async () => { setEditing(false); await q.reload() }}
          {...(schedule ? { onCancel: () => setEditing(false) } : {})} />}
        {data?.alerts.length ? (
          <div className="space-y-1.5 pt-1">
            <p className="flex items-center gap-1.5 font-medium"><BellRingIcon className="size-3.5" />Alerts</p>
            <ul className="space-y-1.5">
              {data.alerts.map(a => (
                <li key={a.id} className="rounded-lg bg-muted/40 px-3 py-2">
                  <span className="font-medium">{ALERT_LABEL[a.kind]}</span>: {share(a.after)} answers, down from {share(a.before)}
                  <span className="block text-[0.6875rem] text-muted-foreground">
                    {a.createdAt ? relativeTime(a.createdAt) : ""}{a.investigationId ? ", the agent is investigating" : ", from automatic name matching (not reviewed)"}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </Panel>
  )
}

function ApproveForm({ clientId, set, maxAttempts, current, onDone, onCancel }: {
  clientId: string; set: QuestionSet; maxAttempts: number; current: TrackingResponse; onDone: () => Promise<void>; onCancel?: () => void
}) {
  const [cadence, setCadence] = useState<"DAILY" | "WEEKLY">(current.schedule?.cadence ?? "WEEKLY")
  const [samples, setSamples] = useState(current.schedule?.samples ?? 2)
  const [points, setPoints] = useState(current.schedule?.alertDropPoints ?? 15)
  const [approved, setApproved] = useState(false)
  const [busy, setBusy] = useState(false)
  const calls = set.questions.length * samples * maxAttempts
  const cost = current.costPerAttemptUsd !== null ? Math.ceil(calls * current.costPerAttemptUsd * 100) / 100 : null
  const runs = cadence === "DAILY" ? 30 : 4
  return (
    <form className="space-y-3" onSubmit={e => {
      e.preventDefault()
      setBusy(true)
      void Tracking.approve(clientId, { setId: set.id, cadence, samples, acknowledgedMaxProviderCalls: calls, alertDropPoints: points })
        .then(onDone, () => toast.error("Couldn't approve the schedule. Reload and try again."))
        .finally(() => setBusy(false))
    }}>
      <div className="grid grid-cols-3 gap-2">
        <Select value={cadence} onValueChange={v => { setCadence(v as "DAILY" | "WEEKLY"); setApproved(false) }}>
          <SelectTrigger className="h-8 text-xs" aria-label="How often"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="DAILY">Every day</SelectItem><SelectItem value="WEEKLY">Every week</SelectItem></SelectContent>
        </Select>
        <Select value={String(samples)} onValueChange={v => { setSamples(Number(v)); setApproved(false) }}>
          <SelectTrigger className="h-8 text-xs" aria-label="Samples per question"><SelectValue /></SelectTrigger>
          <SelectContent>{[1, 2, 3, 4, 5].map(n => <SelectItem key={n} value={String(n)}>{n} sample{n === 1 ? "" : "s"}</SelectItem>)}</SelectContent>
        </Select>
        <Select value={String(points)} onValueChange={v => setPoints(Number(v))}>
          <SelectTrigger className="h-8 text-xs" aria-label="Alert when the share drops by"><SelectValue /></SelectTrigger>
          <SelectContent>{[10, 15, 20, 25].map(n => <SelectItem key={n} value={String(n)}>Alert at -{n} pts</SelectItem>)}</SelectContent>
        </Select>
      </div>
      <p className="rounded-lg bg-muted/40 px-3 py-2 tabular-nums">
        {set.questions.length} questions × {samples} sample{samples === 1 ? "" : "s"}, with retries: <span className="font-medium">up to {calls} model calls a run</span>
        {cost !== null ? <> (about ${cost.toFixed(2)}, roughly ${(cost * runs).toFixed(2)} a month)</> : ". The cost per call isn't configured, so approval is blocked."}
      </p>
      <label className="flex items-start gap-2">
        <input type="checkbox" className="mt-0.5" checked={approved} onChange={e => setApproved(e.target.checked)} />
        <span>I approve spending up to {calls} model calls on every {cadence === "DAILY" ? "daily" : "weekly"} run until I pause or change this.</span>
      </label>
      <div className="flex gap-2">
        <Button type="submit" size="sm" className="h-8 text-xs" disabled={busy || !approved || cost === null}>Approve schedule</Button>
        {onCancel ? <Button type="button" variant="ghost" size="sm" className="h-8 text-xs" onClick={onCancel}>Cancel</Button> : null}
      </div>
    </form>
  )
}
