// What the agent is doing, and what it did, as a work log. While a turn runs: "Thinking for 4s" (or "Working for"
// once a tool runs) with a live clock, the finished steps as icon rows, and
// the step under way shimmering at the bottom. Once the reply arrives the
// whole log folds into one "Worked for 12s" row above the answer, which opens
// to the same rows. Everything shown is the model's own reasoning or the
// server's run journal; nothing extra is generated.
import { useEffect, useState, type ReactNode } from "react"
import {
  ChartLineIcon, ChevronRightIcon, FileTextIcon, GaugeIcon, GlobeIcon, ListChecksIcon, MessageCircleQuestionIcon, NetworkIcon,
  PenLineIcon, SearchIcon, TargetIcon, UsersIcon, WrenchIcon, XIcon, type LucideIcon,
} from "lucide-react"
import type { AgentActivity, AgentRunEvent } from "@/lib/api"
import { cn } from "@/lib/utils"

export type Progress = {
  readonly phase: "thinking" | "working" | "checking"
  /** The tool running now, as a present-tense label. */
  readonly current: string | null
  /** The tool running now, by name, for its icon. */
  readonly currentTool?: string | null
  /** The model's reasoning in the step under way, as it streams. */
  readonly thought: string
  /** Finished steps, oldest first: reasoning and tool results. */
  readonly trace: ReadonlyArray<AgentActivity>
  readonly startedAt: number
}
export const initialProgress = (): Progress => ({ phase: "thinking", current: null, currentTool: null, thought: "", trace: [], startedAt: Date.now() })

const str = (v: unknown) => typeof v === "string" ? v : ""
/** Folds journal events into the live trace. */
export function progressOf(events: ReadonlyArray<AgentRunEvent>, current: Progress): Progress {
  let p = current
  for (const e of events) {
    if (e.type === "MODEL_REQUESTED") p = { ...p, phase: "thinking", current: null, currentTool: null, thought: "" }
    else if (e.type === "MODEL_THINKING") p = { ...p, thought: str(e.payload["text"]) }
    else if (e.type === "MODEL_STEP") {
      const thought = str(e.payload["thought"]) || p.thought
      const tools = Array.isArray(e.payload["toolCalls"]) ? e.payload["toolCalls"] : []
      p = { ...p, thought: "", phase: tools.length ? "working" : p.phase,
        trace: thought ? [...p.trace, { kind: "thought", text: thought, ms: Number(e.payload["elapsedMs"] ?? 0) }] : p.trace }
    } else if (e.type === "TOOL_STARTED") p = { ...p, phase: "working", current: str(e.payload["label"]) || "Working", currentTool: str(e.payload["tool"]) || null }
    else if (e.type === "TOOL_COMPLETED" || e.type === "TOOL_FAILED")
      p = { ...p, current: null, currentTool: null, trace: [...p.trace, { kind: "tool", tool: str(e.payload["tool"]), text: str(e.payload["summary"]), ...(e.type === "TOOL_FAILED" ? { failed: true } : {}) }] }
    else if (e.type === "VERIFICATION" && e.payload["action"] === "REMINDED") p = { ...p, phase: "checking", current: null, currentTool: null }
  }
  return p
}

/** "12s", "1m 05s". */
export const elapsed = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000)), m = Math.floor(s / 60)
  return m === 0 ? `${s}s` : `${m}m ${String(s % 60).padStart(2, "0")}s`
}

/** An icon for each tool by what it touches: the web, records, questions, measurements, helpers or proposals. */
export function toolIcon(tool: string): LucideIcon {
  if (tool === "search_web") return SearchIcon
  if (tool === "audit_website") return GaugeIcon
  if (tool === "read_web_page" || tool === "read_web_pages") return GlobeIcon
  if (tool === "map_website") return NetworkIcon
  if (tool === "read_proposals") return FileTextIcon
  if (/session|task|delegate|list_models/.test(tool)) return UsersIcon
  if (/^propose_|^draft_|^prepare_/.test(tool)) return PenLineIcon
  if (/question/.test(tool)) return MessageCircleQuestionIcon
  if (/acquisition|referral|search_performance|competitor|observation|outcomes/.test(tool)) return ChartLineIcon
  if (/goal|opportunit|diagnose/.test(tool)) return TargetIcon
  if (/issue/.test(tool)) return ListChecksIcon
  if (/truth|representation|scope|record/.test(tool)) return FileTextIcon
  return WrenchIcon
}

// Thinking, the way Claude Code shows it: one glyph that grows and settles
// (· ✢ ✳ ✶ ✻ ✽ and back) in the brand's periwinkle. Still when motion is
// reduced, and as a plain ✻ on finished reasoning.
const GLYPHS = ["·", "✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳", "✢"]
export function ThinkingGlyph({ live = true }: { live?: boolean }) {
  const [i, setI] = useState(4)
  useEffect(() => {
    if (!live || window.matchMedia("(prefers-reduced-motion: reduce)").matches || document.documentElement.hasAttribute("data-reduce-motion")) return
    const t = window.setInterval(() => setI(n => (n + 1) % GLYPHS.length), 220)
    return () => window.clearInterval(t)
  }, [live])
  return <span aria-hidden className="inline-flex size-4 items-center justify-center font-mono text-base leading-none text-secondary">{live ? GLYPHS[i] : "✻"}</span>
}

// One work log line on the timeline: a node on the rail and a label. Tool
// steps sit in a small round node; reasoning is a lighter aside with its glyph.
function LogRow({ icon, children, wrap, node = false, className }: { icon: ReactNode; children: ReactNode; wrap?: boolean; node?: boolean; className?: string | undefined }) {
  return (
    <li className={cn("relative flex min-h-7 min-w-0 gap-2 py-0.5 text-sm leading-relaxed text-muted-foreground", wrap ? "items-start" : "items-center", className)}>
      <span className={cn("relative z-10 flex size-6 shrink-0 items-center justify-center [&_svg]:size-3.5",
        node && "rounded-full bg-background text-foreground/70 shadow-(--control-shadow)")}>{icon}</span>
      <span className={cn("min-w-0 flex-1", wrap ? "pt-0.5" : "truncate")}>{children}</span>
    </li>
  )
}
/** The rail the steps hang on: a thin line through the node column. */
const RAIL = "relative flex min-w-0 flex-col before:absolute before:top-3 before:bottom-3 before:left-[11.5px] before:w-px before:bg-border"

function Step({ item, animate = false }: { item: AgentActivity; animate?: boolean }) {
  if (item.kind === "thought") return (
    <LogRow icon={<ThinkingGlyph live={false} />} wrap className={animate ? "step-in" : undefined}>
      <span className="line-clamp-4 whitespace-pre-wrap text-muted-foreground/80 italic">{item.text}</span>
    </LogRow>
  )
  const Icon = toolIcon(item.tool)
  return (
    <LogRow node icon={item.failed ? <XIcon className="text-wrong" aria-label="Not completed" /> : <Icon aria-hidden />} className={animate ? "step-in" : undefined}>
      <span className={item.failed ? "text-wrong/80" : "text-foreground/80"}>{item.text}</span>
    </LogRow>
  )
}

function useNow(live: boolean) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!live) return
    const t = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(t)
  }, [live])
  return now
}

const lastLine = (text: string) => text.trim().split("\n").filter(Boolean).at(-1)?.trim() ?? ""

/** The work log of a turn still running. */
export function LiveTrace({ progress }: { progress: Progress }) {
  const now = useNow(true)
  const working = progress.phase !== "thinking" || progress.trace.some(t => t.kind === "tool")
  const LiveIcon = progress.phase === "working" && progress.currentTool ? toolIcon(progress.currentTool) : null
  const live = progress.phase === "working" ? progress.current ?? "Working" : progress.phase === "checking" ? "Checking the answer is complete" : lastLine(progress.thought) || "Thinking"
  return (
    <div className="w-full" role="status" aria-live="polite">
      <p className="flex h-6 items-baseline gap-1 px-0.5 text-sm text-muted-foreground tabular-nums">
        <span className="thinking">{working ? "Working" : "Thinking"} for {elapsed(now - progress.startedAt)}</span>
      </p>
      <ul className={cn(RAIL, "mt-1")} aria-label="Steps so far">
        {/* Finished steps stay mounted, so only the newest one slides in. */}
        {progress.trace.map((item, i) => <Step key={i} item={item} animate />)}
        {/* The step under way re-enters whenever the agent moves to another tool. */}
        <LogRow key={`live:${progress.trace.length}:${progress.currentTool ?? progress.phase}`} className="step-in" node={!!LiveIcon}
          icon={LiveIcon ? <span className="live-ring flex size-6 items-center justify-center rounded-full"><LiveIcon aria-hidden /></span> : <ThinkingGlyph />}>
          <span className="thinking">{live}</span>
        </LogRow>
      </ul>
    </div>
  )
}

/** A finished turn's work log, folded into one "Worked for 12s" row above its answer. */
export function RunTrace({ activity, durationMs }: { activity: ReadonlyArray<AgentActivity>; durationMs?: number | undefined }) {
  const [open, setOpen] = useState(false)
  // The steps mount on first open (collapsed), then fold open on the next frame; they stay mounted to fold closed.
  const [mounted, setMounted] = useState(false)
  const toggle = () => {
    if (open) return setOpen(false)
    setMounted(true)
    requestAnimationFrame(() => requestAnimationFrame(() => setOpen(true)))
  }
  if (!activity.length) return null
  const worked = activity.some(a => a.kind === "tool")
  const label = `${worked ? "Worked" : "Thought"}${durationMs !== undefined ? ` for ${elapsed(durationMs)}` : ""}`
  const tools = activity.filter(a => a.kind === "tool")
  // Up to four distinct tool icons, so the folded row says what kind of work it was.
  const kinds = [...new Map(tools.map(t => [toolIcon(t.kind === "tool" ? t.tool : ""), t])).keys()].slice(0, 4)
  return (
    <div className="w-full">
      <button type="button" onClick={toggle} aria-expanded={open}
        className="group/worked flex h-6 items-center gap-1 rounded-md px-0.5 text-sm text-muted-foreground tabular-nums hover:text-foreground">
        {label}
        {tools.length ? (
          <span className="ml-1 flex items-center gap-1 text-muted-foreground/70 [&_svg]:size-3">
            {kinds.map((Icon, i) => <Icon key={i} aria-hidden />)}
            <span className="text-xs">{tools.length} step{tools.length === 1 ? "" : "s"}</span>
          </span>
        ) : null}
        <ChevronRightIcon className={cn("size-3.5 shrink-0 opacity-60 transition-transform group-hover/worked:opacity-100", open && "rotate-90")} />
      </button>
      {mounted ? <div className="fold" data-open={open} aria-hidden={!open} inert={!open}>
        <div>
          <ul className={cn(RAIL, "mt-1 max-h-72 overflow-y-auto border-b border-border/60 pb-2")} aria-label="What the agent did">
            {activity.map((item, i) => <Step key={i} item={item} />)}
          </ul>
        </div>
      </div> : null}
    </div>
  )
}
