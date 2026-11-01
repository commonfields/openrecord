// Approve scheduled AI answer tracking on the team's own AI subscriptions:
// which connected models, how often, and exactly how many questions each run
// asks. Answers are saved as evidence the agent reads; a drop in how often the
// business is named opens an investigation.
import { useState } from "react"
import { MessagesSquareIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Panel } from "@/components/page"
import { api, ApiError } from "@/lib/api"
import { relativeTime } from "@/lib/format"
import { useApi } from "@/lib/use-api"

type EngineRef = { instanceId: string; model: string }
type Status = {
  questions: number; maxAsks: number
  engines: Array<EngineRef & { label: string }>
  schedule: null | { cadence: "DAILY" | "WEEKLY"; engines: EngineRef[]; asksPerRun: number; enabled: boolean; pausedReason: string | null; nextRunAt: string | null; lastAlert: null | { before: { n: number; d: number }; after: { n: number; d: number } } }
}
const base = (id: string) => `/api/businesses/${encodeURIComponent(id)}/ai-answer-schedule`
const key = (e: EngineRef) => `${e.instanceId}:${e.model}`
const PAUSED: Record<string, string> = { ENGINE_UNAVAILABLE: "a chosen model is no longer connected", QUESTIONS_CHANGED: "the question set changed" }

export function AiAnswerTracking({ businessId }: { businessId: string }) {
  const q = useApi(`ai-answer-schedule:${businessId}`, () => api<Status>(base(businessId)))
  const [picked, setPicked] = useState<string[] | null>(null)
  const [cadence, setCadence] = useState<"DAILY" | "WEEKLY">("WEEKLY")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const s = q.data
  if (!s || (!s.engines.length && !s.schedule)) return null
  const chosen = picked ?? (s.schedule?.engines.map(key) ?? s.engines.slice(0, 1).map(key))
  const asks = Math.min(s.maxAsks, s.questions * chosen.length)
  const act = async (f: () => Promise<unknown>) => {
    setBusy(true); setError(null)
    try { await f(); setPicked(null); await q.reload() } catch (e) {
      setError(e instanceof ApiError && e.tag === "NoQuestionSet" ? "Save a set of buyer questions first; tracking asks those." : e instanceof ApiError && e.tag === "EngineUnavailable" ? "One of the chosen models is not connected and ready." : "That did not work. Try again.")
    } finally { setBusy(false) }
  }
  const approve = () => act(() => api(base(businessId), { method: "PUT", body: JSON.stringify({ cadence, engines: s.engines.filter(e => chosen.includes(key(e))).map(e => ({ instanceId: e.instanceId, model: e.model })), acknowledgedAsks: asks }) }))
  const sched = s.schedule
  return (
    <Panel id="ai-answer-tracking" className="space-y-3 p-4">
      <div className="flex items-start gap-2">
        <MessagesSquareIcon aria-hidden className="mt-0.5 size-3.5 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <h2 className="text-xs font-medium">AI answer tracking on your subscriptions</h2>
          <p className="text-[0.6875rem] text-muted-foreground">Ask your saved buyer questions on the AI models your team connected, on a schedule, and keep every answer as evidence. If you are named in fewer answers, the agent opens an investigation.</p>
        </div>
      </div>
      {sched ? (
        <p className="text-xs">
          {sched.enabled ? `On: ${sched.cadence === "DAILY" ? "daily" : "weekly"}, ${sched.asksPerRun} question${sched.asksPerRun === 1 ? "" : "s"} per run${sched.nextRunAt ? `, next ${relativeTime(sched.nextRunAt)}` : ""}.`
            : `Paused${sched.pausedReason ? ` because ${PAUSED[sched.pausedReason] ?? sched.pausedReason.toLowerCase()}; approve again to continue` : ""}.`}
          {sched.lastAlert ? ` Last drop: named in ${sched.lastAlert.before.n} of ${sched.lastAlert.before.d} answers, then ${sched.lastAlert.after.n} of ${sched.lastAlert.after.d}.` : ""}
        </p>
      ) : null}
      {s.engines.length ? (
        <div className="space-y-2">
          <div className="flex flex-wrap gap-3">
            {s.engines.map(e => (
              <label key={key(e)} className="flex items-center gap-1.5 text-xs">
                <input type="checkbox" checked={chosen.includes(key(e))} disabled={!chosen.includes(key(e)) && chosen.length >= 3}
                  onChange={ev => setPicked(ev.currentTarget.checked ? [...chosen, key(e)] : chosen.filter(k => k !== key(e)))} />
                {e.label}
              </label>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select value={cadence} onChange={e => setCadence(e.currentTarget.value as "DAILY" | "WEEKLY")} aria-label="How often" className="h-7 rounded-md border bg-background px-2 text-xs">
              <option value="WEEKLY">Weekly</option><option value="DAILY">Daily</option>
            </select>
            <Button size="sm" disabled={busy || !chosen.length || !s.questions} onClick={() => void approve()}>
              {s.questions ? `Approve: ${asks} question${asks === 1 ? "" : "s"} per run` : "Needs saved buyer questions"}
            </Button>
            {sched ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act(() => api(`${base(businessId)}/enabled`, { method: "POST", body: JSON.stringify({ enabled: !sched.enabled }) }))}>{sched.enabled ? "Pause" : "Resume"}</Button> : null}
          </div>
        </div>
      ) : <p className="text-[0.6875rem] text-muted-foreground">No AI subscription is connected and ready on the bridge right now.</p>}
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
    </Panel>
  )
}
