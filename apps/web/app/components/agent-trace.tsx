// What the agent is doing, and what it did. While a turn runs, the run
// journal drives a live trace: "Thinking" while the model works out its next
// step (with its own reasoning when the provider returns it), "Working" with
// the tool it is running, and each finished step, in the chat's existing
// steps style. Once the reply arrives the reasoning folds into one line under
// the answer. Everything shown is the model's own output or the server's
// journal; nothing extra is generated.
import { useState } from "react"
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

// Steps use the chat's existing completed-steps list: small, muted, one check per line.
function Step({ item }: { item: AgentActivity }) {
  if (item.kind === "thought") return <li className="line-clamp-3 whitespace-pre-wrap pl-[1.125rem]">{item.text}</li>
  return (
    <li className="flex items-center gap-1.5">
      {item.failed ? <XIcon className="size-3 shrink-0" aria-label="Not completed" /> : <CheckIcon className="size-3 shrink-0" aria-label="Done" />}
      {item.text}
    </li>
  )
}

/** The trace of a turn still running. */
export function LiveTrace({ progress }: { progress: Progress }) {
  const status = progress.phase === "working" ? progress.current ?? "Working…" : progress.phase === "checking" ? "Checking the answer is complete…" : "Thinking…"
  const steps = progress.thought ? [...progress.trace, { kind: "thought" as const, text: progress.thought, ms: 0 }] : progress.trace
  return (
    <>
      {steps.length ? <ul className="space-y-0.5 text-[0.6875rem] text-muted-foreground" aria-label="Completed steps">
        {steps.map((item, i) => <Step key={i} item={item} />)}
      </ul> : null}
      <p className="thinking text-base leading-relaxed" role="status">{status}</p>
    </>
  )
}

/** The model's reasoning for a finished turn, folded into one line under its answer. */
export function RunTrace({ activity, durationMs }: { activity: ReadonlyArray<AgentActivity>; durationMs?: number | undefined }) {
  const [open, setOpen] = useState(false)
  if (!activity.some(a => a.kind === "thought")) return null
  return (
    <div className="text-[0.6875rem] text-muted-foreground">
      <button type="button" onClick={() => setOpen(v => !v)} aria-expanded={open} className="flex items-center gap-1.5 hover:text-foreground">
        <ChevronRightIcon className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")} />
        Thought{durationMs !== undefined ? ` for ${seconds(durationMs)}` : ""}
      </button>
      {open ? <ul className="mt-0.5 space-y-0.5" aria-label="What the agent did">{activity.map((item, i) => <Step key={i} item={item} />)}</ul> : null}
    </div>
  )
}
