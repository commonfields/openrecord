import { describe, expect, it, vi } from "vitest"
import { Effect } from "effect"
import { runConversation } from "./agent.js"
import { AgentModelError, type AgentModel, type ModelResponse } from "./agent-model.js"
import { memoryJournal } from "./agent-run.js"
import { commandTools, EXECUTION_LIMITS, modelRequestBytes } from "./agent-execution-policy.js"
import { agentDeclarations } from "./agent.js"
import { harnessFailureReason } from "./harness-model.js"

const text = (value: string): ModelResponse => ({ candidates: [{ content: { role: "model", parts: [{ text: value }] }, finishReason: "STOP" }] })
const call: ModelResponse = { candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "read_open_issues", args: {} } }] }, finishReason: "STOP" }] }
const result = { summary: "2 reviewed factual errors found", citations: [{ kind: "issue", id: "issue-1", text: "Incorrect opening hours" }], data: { issues: [{ description: "Saturday hours conflict with approved weekday schedule" }] } }

describe("restored local inference recovery", () => {
  it.each(["UNAVAILABLE", "TIMEOUT", "MALFORMED", "CONTEXT_LIMIT"] as const)("recovers %s once without replaying tools", async reason => {
    let requests = 0, dispatches = 0
    const { journal, events } = memoryJournal()
    const model: AgentModel = input => {
      if (++requests === 1) return Effect.succeed(call)
      if (requests === 2) return Effect.fail(new AgentModelError({ reason }))
      expect(input.tools).toEqual([])
      expect(JSON.stringify(input.contents)).toContain("Saturday hours")
      expect(modelRequestBytes(input)).toBeLessThan(EXECUTION_LIMITS.requestBytes)
      return Effect.succeed(text("Partial findings: correct the Saturday hours."))
    }
    const answer = await Effect.runPromise(runConversation({ message: "Review", history: [], model, journal, dispatch: () => { dispatches++; return Effect.succeed(result) } }))
    expect(answer.outcome).toBe("ANSWERED_WITH_GAPS")
    expect(answer.citations).toEqual(result.citations)
    expect(requests).toBe(3); expect(dispatches).toBe(1)
    expect(events.some(e => e.payload["action"] === "ANSWER_RECOVERED")).toBe(true)
  })
  it.each(["RATE_LIMITED", "exhausted", "recovery-tool", "recovery-down"] as const)("returns honest partial findings for %s", async failure => {
    let requests = 0, dispatches = 0
    const model: AgentModel = () => ++requests === 1 || (requests === 3 && failure === "recovery-tool") ? Effect.succeed(call)
      : Effect.fail(new AgentModelError({ reason: failure === "RATE_LIMITED" ? "RATE_LIMITED" : "UNAVAILABLE" }))
    const answer = await Effect.runPromise(runConversation({ message: "Review", history: [], model,
      budget: { modelSteps: failure === "exhausted" ? 2 : 5, toolCalls: 5 }, dispatch: () => { dispatches++; return Effect.succeed(result) } }))
    expect(answer.reply).toContain("full conclusion is still missing")
    expect(answer.reply).toContain(result.summary)
    expect(answer.outcome).toBe("ANSWERED_WITH_GAPS")
    expect(dispatches).toBe(1)
    expect(requests).toBe(failure === "RATE_LIMITED" || failure === "exhausted" ? 2 : 3)
  })
  it.each(["CANCELLED", "UNCONFIGURED"] as const)("never masks %s", async reason => {
    let requests = 0
    const model: AgentModel = () => ++requests === 1 ? Effect.succeed(call) : Effect.fail(new AgentModelError({ reason }))
    expect(await Effect.runPromise(Effect.either(runConversation({ message: "Review", history: [], model, dispatch: () => Effect.succeed(result) })))).toMatchObject({ _tag: "Left", left: { reason } })
  })
  it("reserves time for a tool-free answer", async () => {
    let now = Date.now(), requests = 0
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now)
    try {
      const deadline = now + EXECUTION_LIMITS.runMs
      const model: AgentModel = input => {
        if (++requests === 1) return Effect.succeed(call)
        expect(input.tools).toEqual([])
        return Effect.succeed(text("Partial findings: correct opening hours."))
      }
      const answer = await Effect.runPromise(runConversation({ message: "Review", history: [], model, deadline, dispatch: () => { now = deadline - 70000; return Effect.succeed(result) } }))
      expect(answer.gaps).toContain("Research stopped to reserve time for an answer")
    } finally { clock.mockRestore() }
  })
  it("refuses oversized instruction/schema overhead before inference", async () => {
    let requests = 0
    const model: AgentModel = () => { requests++; return Effect.succeed(text("done")) }
    expect(await Effect.runPromise(Effect.either(runConversation({ message: "Review", history: [], model, system: "x".repeat(EXECUTION_LIMITS.requestBytes + 1), dispatch: () => Effect.succeed(result) })))).toMatchObject({ _tag: "Left", left: { reason: "CONTEXT_LIMIT" } })
    expect(requests).toBe(0)
  })
  it("narrows explicit campaign commands while preserving ordinary capabilities", () => {
    const names = commandTools("/campaign-run Trial", agentDeclarations).map(t => t.name)
    expect(names).toContain("prepare_wordpress_change")
    expect(names).toContain("record_campaign_run")
    expect(names).not.toContain("research_company")
    expect(commandTools("Tell me more", agentDeclarations)).toBe(agentDeclarations)
  })
  it.each([["CANCELLED", "CANCELLED"], ["UNAUTHENTICATED", "UNCONFIGURED"], ["MODEL_UNAVAILABLE", "UNCONFIGURED"], ["TIMEOUT", "TIMEOUT"]])("preserves bridge %s as %s", (reason, expected) => {
    expect(harnessFailureReason(reason)).toBe(expected)
  })
})
