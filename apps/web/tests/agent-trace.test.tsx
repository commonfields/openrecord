// The live trace a pending reply shows, folded from run journal events.
import { describe, expect, it } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { LiveTrace, RunTrace, initialProgress, progressOf } from "../app/components/agent-trace"
import type { AgentRunEvent } from "../app/lib/api"

let seq = 0
const event = (type: string, payload: Record<string, unknown> = {}): AgentRunEvent => ({ seq: seq++, type, at: new Date().toISOString(), payload })

describe("agent trace", () => {
  it("starts thinking, works while a tool runs, and thinks again before the next step", () => {
    let p = initialProgress()
    expect(p.phase).toBe("thinking")
    p = progressOf([event("RUN_STARTED"), event("CONTEXT_BUILT"), event("MODEL_REQUESTED", { step: 1 }), event("MODEL_THINKING", { text: "Check the open issues" })], p)
    expect(p).toMatchObject({ phase: "thinking", thought: "Check the open issues", trace: [] })
    p = progressOf([event("MODEL_STEP", { step: 1, toolCalls: ["read_open_issues"], thought: "Check the open issues first.", elapsedMs: 1200 }),
      event("TOOL_STARTED", { tool: "read_open_issues", label: "Reading open issues" })], p)
    expect(p).toMatchObject({ phase: "working", current: "Reading open issues", thought: "", trace: [{ kind: "thought", text: "Check the open issues first." }] })
    p = progressOf([event("TOOL_COMPLETED", { tool: "read_open_issues", summary: "3 open issues read" }), event("MODEL_REQUESTED", { step: 2 })], p)
    expect(p).toMatchObject({ phase: "thinking", current: null })
    expect(p.trace.map(t => t.text)).toEqual(["Check the open issues first.", "3 open issues read"])
  })
  it("folds a finished turn's work log into one Worked for row, like T3 Code", () => {
    const html = renderToStaticMarkup(<RunTrace durationMs={72400} activity={[{ kind: "thought", text: "Plan", ms: 900 }, { kind: "tool", tool: "read_open_issues", text: "3 open issues read" }]} />)
    expect(html).toContain("Worked for 1m 12s")
    expect(html).not.toContain("3 open issues read")
    expect(renderToStaticMarkup(<RunTrace activity={[]} />)).toBe("")
    // Reasoning alone reads as thinking.
    expect(renderToStaticMarkup(<RunTrace durationMs={5000} activity={[{ kind: "thought", text: "Plan", ms: 900 }]} />)).toContain("Thought for 5s")
  })
  it("shows a running turn's clock, finished steps and the step under way", () => {
    const p = progressOf([event("MODEL_STEP", { step: 1, toolCalls: ["read_web_page"], thought: "Read their site.", elapsedMs: 900 }),
      event("TOOL_STARTED", { tool: "read_web_page", label: "Reading a web page" })], { ...initialProgress(), startedAt: Date.now() - 8000 })
    const html = renderToStaticMarkup(<LiveTrace progress={p} />)
    expect(html).toMatch(/Working for [89]s/)
    expect(html).toContain("Read their site.")
    expect(html).toContain("Reading a web page")
    expect(html).toContain("lucide-globe")
    expect(renderToStaticMarkup(<LiveTrace progress={initialProgress()} />)).toContain("Thinking for 0s")
  })
})
