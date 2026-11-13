import { describe, expect, it } from "vitest"
import { compare, gate, scoreRuns, type JournalEvent, type RecordedRun } from "./run-scorecard.js"

const e = (type: string, payload: Record<string, unknown> = {}): JournalEvent => ({ type, payload })
const step = (prompt: number, cached?: number) => e("MODEL_STEP", { usage: { promptTokens: prompt, outputTokens: 10, thoughtTokens: 5, ...(cached === undefined ? {} : { cachedTokens: cached }) } })
const run = (id: string, over: Partial<RecordedRun>, events: JournalEvent[]): RecordedRun => ({ id, status: "COMPLETED", outcome: "ANSWERED", failureReason: null, business: true, durationMs: 10000, events, ...over })

const RUNS: RecordedRun[] = [
  run("clean", {}, [step(1000, 800), e("TOOL_STARTED", { tool: "read_revenue" }), e("TOOL_COMPLETED", { tool: "read_revenue" }), step(1200, 1000), e("RUN_FINISHED", { gaps: [] })]),
  run("gaps", { outcome: "ANSWERED_WITH_GAPS", durationMs: 40000 }, [step(1000, 0), e("VERIFICATION", { action: "TOOLS_EXPANDED" }),
    e("TOOL_STARTED", { tool: "prepare_page_change" }), e("TOOL_FAILED", { tool: "prepare_page_change", code: "INVALID_INPUT" }),
    e("TOOL_STARTED", { tool: "prepare_page_change" }), e("TOOL_COMPLETED", { tool: "prepare_page_change" }),
    e("TOOL_FAILED", { tool: "read_revenue", code: "BUDGET_EXHAUSTED" }), e("VERIFICATION", { action: "CONTEXT_COMPACTED" }), step(800, 0),
    e("RUN_FINISHED", { gaps: ["Budget used up before every check could run"] })]),
  run("nothing-read", { durationMs: 3000 }, [step(900, 700), e("RUN_FINISHED", { gaps: [] })]),
  run("general", { business: false, durationMs: 2000 }, [step(300), e("RUN_FINISHED", { gaps: [] })]),
  run("failed", { status: "FAILED", outcome: null, failureReason: "TIMEOUT", durationMs: null }, [step(500, 0), e("TOOL_STARTED", { tool: "search_web" }), e("TOOL_FAILED", { tool: "search_web", code: "TOOL_FAILED" })]),
]

describe("a scorecard from recorded runs", () => {
  const card = scoreRuns(RUNS)
  it("counts how runs ended, what they left unchecked and how long they took", () => {
    expect(card).toMatchObject({ runs: 5, answered: 0.8, clean: 0.6, statuses: { COMPLETED: 4, FAILED: 1 }, failureReasons: { TIMEOUT: 1 },
      gaps: [{ gap: "Budget used up before every check could run", runs: 1 }], steps: { p50: 1, p90: 2 }, durationMs: { p50: 3000, p90: 40000 } })
  })
  it("names the tools that fail and separates calls the model got wrong from calls that never ran", () => {
    expect(card.tools).toEqual([
      { tool: "prepare_page_change", calls: 2, failed: 1, invalidInput: 1 }, { tool: "search_web", calls: 1, failed: 1, invalidInput: 0 }, { tool: "read_revenue", calls: 1, failed: 0, invalidInput: 0 }])
    expect(card).toMatchObject({ toolFailureRate: 0.5, invalidInputRate: 0.25, perRun: { toolDetails: 0.2, compactions: 0.2, budgetExhausted: 0.2 } })
  })
  it("flags business answers given with nothing read, never general chats", () => {
    // Three business runs answered; one of them called no tool.
    expect(card.answeredWithoutTools).toBe(0.333)
  })
  it("reports the share of prompt tokens read from cache, and no share when no provider said", () => {
    expect(card.tokens).toMatchObject({ prompt: 5700, cached: 2500, cachedShare: 0.439 })
    expect(scoreRuns([RUNS[3]!]).tokens.cachedShare).toBeNull()
  })
  it("holds limits and shows which way each measure moved against an earlier scorecard", () => {
    expect(gate(card, { minAnswered: 0.9, maxToolFailure: 0.5 })).toEqual([
      { label: "answered", passed: false, value: 0.8, limit: 0.9 }, { label: "tool calls that failed", passed: true, value: 0.5, limit: 0.5 }])
    const rows = compare(scoreRuns(RUNS.slice(0, 1)), card)
    expect(rows.find(r => r.measure === "answered")).toEqual({ measure: "answered", now: "100.0%", before: "80.0%", better: true })
    expect(rows.find(r => r.measure === "tool calls that failed")).toMatchObject({ now: "0.0%", before: "50.0%", better: true })
    expect(compare(card)[0]).toMatchObject({ before: null, better: null })
  })
  it("scores no runs as zeros", () => {
    expect(scoreRuns([])).toMatchObject({ runs: 0, answered: 0, toolFailureRate: 0, tools: [] })
  })
})
