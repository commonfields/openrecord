// What the agent is doing, and what it did. While a turn runs, the run
// journal drives a live trace: "Thinking" while the model works out its next
// step (with its own reasoning when the provider returns it), "Working" with
// the tool it is running, and each finished step. Once the reply arrives the
// trace folds into one quiet line above the answer. Everything shown is the
// model's own output or the server's journal; nothing extra is generated.
import { useEffect, useState } from "react"
import { CheckIcon, ChevronRightIcon, XIcon } from "lucide-react"
import type { AgentActivity, AgentRunEvent } from "@/lib/api"
import { cn } from "@/lib/utils"

export type Progress = {
  readonly phase: "thinking" | "working" | "checking"
  /** The tool running now, as a present-tense label. */
  readonly current: string | null
  /** The model's reasoning in the step under way, as it streams. */
  readonly thought: string
  /** Finished steps, oldest first: reasoning and tool results. */
  readonly trace: ReadonlyArray<AgentActivity>
  readonly startedAt: number
}
export const initialProgress = (): Progress => ({ phase: "thinking", current: null, thought: "", trace: [], startedAt: Date.now() })

const str = (v: unknown) => typeof v === "string" ? v : ""
/** Folds journal events into the live trace. */
export function progressOf(events: ReadonlyArray<AgentRunEvent>, current: Progress): Progress {
  let p = current
  for (const e of events) {
    if (e.type === "MODEL_REQUESTED") p = { ...p, phase: "thinking", current: null, thought: "" }
    else if (e.type === "MODEL_THINKING") p = { ...p, thought: str(e.payload["text"]) }
    else if (e.type === "MODEL_STEP") {
      const thought = str(e.payload["thought"]) || p.thought
      const tools = Array.isArray(e.payload["toolCalls"]) ? e.payload["toolCalls"] : []
      p = { ...p, thought: "", phase: tools.length ? "working" : p.phase,
        trace: thought ? [...p.trace, { kind: "thought", text: thought, ms: Number(e.payload["elapsedMs"] ?? 0) }] : p.trace }
    } else if (e.type === "TOOL_STARTED") p = { ...p, phase: "working", current: str(e.payload["label"]) || "Working" }
    else if (e.type === "TOOL_COMPLETED" || e.type === "TOOL_FAILED")
      p = { ...p, current: null, trace: [...p.trace, { kind: "tool", tool: str(e.payload["tool"]), text: str(e.payload["summary"]), ...(e.type === "TOOL_FAILED" ? { failed: true } : {}) }] }
    else if (e.type === "VERIFICATION" && e.payload["action"] === "REMINDED") p = { ...p, phase: "checking", current: null }
  }
  return p
}

const seconds = (ms: number) => ms < 1000 ? "under a second" : ms < 60000 ? `${Math.round(ms / 1000)}s` : `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`

function useElapsed(since: number) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  return Math.max(0, now - since)
}

function Step({ item }: { item: AgentActivity }) {
  if (item.kind === "thought") return (
    <li className="relative pl-4 before:absolute before:left-[3px] before:top-2 before:size-1 before:rounded-full before:bg-muted-foreground/50">
      <p className="line-clamp-6 whitespace-pre-wrap text-[0.8125rem] leading-relaxed text-muted-foreground">{item.text}</p>
    </li>
  )
  return (
    <li className="flex items-start gap-1.5 text-[0.8125rem] text-muted-foreground">
      {item.failed ? <XIcon className="mt-0.5 size-3 shrink-0" aria-label="Not completed" /> : <CheckIcon className="mt-0.5 size-3 shrink-0" aria-label="Done" />}
      <span className="min-w-0">{item.text}</span>
    </li>
  )
}

/** The trace of a turn still running. */
export function LiveTrace({ progress }: { progress: Progress }) {
  const elapsed = useElapsed(progress.startedAt)
  const status = progress.phase === "working" ? progress.current ?? "Working" : progress.phase === "checking" ? "Checking the answer is complete" : "Thinking"
  return (
    <div className="space-y-2" role="status" aria-live="polite">
      {progress.trace.length ? <ol className="space-y-1.5" aria-label="Steps so far">{progress.trace.map((item, i) => <Step key={i} item={item} />)}</ol> : null}
      {progress.thought ? (
        // Only the latest lines of the reasoning in progress, fading at the top.
        <div className="relative max-h-[4.5rem] overflow-hidden border-l-2 border-border pl-3 [mask-image:linear-gradient(to_bottom,transparent,black_35%)]">
          <p className="flex min-h-full flex-col justify-end whitespace-pre-wrap text-[0.8125rem] leading-relaxed text-muted-foreground">{progress.thought}</p>
        </div>
      ) : null}
      <p className="flex items-baseline gap-2 text-base leading-relaxed">
        <span className="thinking">{status}</span>
        <span className="text-xs tabular-nums text-muted-foreground">{elapsed >= 1000 ? seconds(elapsed) : null}</span>
      </p>
    </div>
  )
}

/** The trace of a finished turn, folded into one line above its answer. */
export function RunTrace({ activity, durationMs }: { activity: ReadonlyArray<AgentActivity>; durationMs?: number | undefined }) {
  const [open, setOpen] = useState(false)
  if (!activity.length) return null
  const thought = activity.some(a => a.kind === "thought")
  const steps = activity.filter(a => a.kind === "tool").length
  const label = [`${thought ? "Thought" : "Worked"}${durationMs !== undefined ? ` for ${seconds(durationMs)}` : ""}`, steps ? `${steps} step${steps === 1 ? "" : "s"}` : null].filter(Boolean).join(" · ")
  return (
    <div>
      <button type="button" onClick={() => setOpen(v => !v)} aria-expanded={open}
        className="group/trace flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground">
        <ChevronRightIcon className={cn("size-3.5 transition-transform", open && "rotate-90")} />
        {label}
      </button>
      {open ? <ol className="mt-2 space-y-1.5 border-l border-border pl-3" aria-label="What the agent did">{activity.map((item, i) => <Step key={i} item={item} />)}</ol> : null}
    </div>
  )
}
