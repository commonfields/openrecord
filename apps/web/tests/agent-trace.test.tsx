// The live trace a pending reply shows, folded from run journal events.
import { describe, expect, it } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { RunTrace, initialProgress, progressOf } from "../app/components/agent-trace"
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
  it("folds a finished turn's reasoning into one line", () => {
    const html = renderToStaticMarkup(<RunTrace durationMs={12400} activity={[{ kind: "thought", text: "Plan", ms: 900 }, { kind: "tool", tool: "read_open_issues", text: "3 open issues read" }]} />)
    expect(html).toContain("Thought for 12s")
    expect(html).not.toContain("3 open issues read")
    expect(renderToStaticMarkup(<RunTrace activity={[]} />)).toBe("")
    // Tool steps alone already show in the chat's tools line.
    expect(renderToStaticMarkup(<RunTrace activity={[{ kind: "tool", tool: "read_open_issues", text: "3 open issues read" }]} />)).toBe("")
  })
})
