import { describe, expect, it, vi } from "vitest"
import { Effect } from "effect"
import { runConversation } from "./agent.js"
import { AgentModelError, type AgentModel, type ModelResponse } from "./agent-model.js"
import { memoryJournal } from "./agent-run.js"
import { EXECUTION_LIMITS, modelRequestBytes } from "./agent-execution-policy.js"

const text = (value: string): ModelResponse => ({ candidates: [{ content: { role: "model", parts: [{ text: value }] }, finishReason: "STOP" }] })
const call: ModelResponse = { candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "read_open_issues", args: {} } }] }, finishReason: "STOP" }] }
const result = { summary: "2 reviewed factual errors found", citations: [{ kind: "issue", id: "issue-1", text: "Incorrect opening hours" }], data: { issues: [{ description: "The site lists Saturday hours; the approved schedule is weekdays only" }] } }

describe("inference recovery after useful tool work", () => {
  it("reserves a tool-free answer phase before the wall-clock deadline", async () => {
    let now = Date.now(), requests = 0, dispatches = 0
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now)
    try {
      const deadline = now + EXECUTION_LIMITS.runMs
      const model: AgentModel = input => {
        if (++requests === 1) return Effect.succeed(call)
        expect(input.tools).toEqual([])
        return Effect.succeed(text("Partial findings: correct the opening hours."))
      }
      const answer = await Effect.runPromise(runConversation({ message: "Review", history: [], model, deadline,
        dispatch: () => { dispatches++; now = deadline - 70000; return Effect.succeed(result) } }))
      expect(answer.gaps).toContain("Research stopped to reserve time for an answer")
      expect(requests).toBe(2)
      expect(dispatches).toBe(1)
    } finally { clock.mockRestore() }
  })
  it("rebuilds a smaller evidence-only request after context exhaustion", async () => {
    let requests = 0
    const model: AgentModel = input => {
      requests++
      if (requests === 1) return Effect.succeed(call)
      if (requests === 2) return Effect.fail(new AgentModelError({ reason: "CONTEXT_LIMIT" }))
      expect(input.tools).toEqual([])
      expect(modelRequestBytes(input)).toBeLessThan(EXECUTION_LIMITS.requestBytes)
      expect(JSON.stringify(input.contents)).toContain("The site lists Saturday hours")
      return Effect.succeed(text("Partial findings: the Saturday opening hours conflict with the approved schedule."))
    }
    const answer = await Effect.runPromise(runConversation({ message: "Review", history: [], model, dispatch: () => Effect.succeed(result) }))
    expect(answer.outcome).toBe("ANSWERED_WITH_GAPS")
    expect(requests).toBe(3)
  })
  it("rejects oversized system/schema overhead before contacting the model", async () => {
    let requests = 0
    const model: AgentModel = () => { requests++; return Effect.succeed(text("done")) }
    const answer = await Effect.runPromise(Effect.either(runConversation({ message: "Review", history: [], model, system: "x".repeat(EXECUTION_LIMITS.requestBytes + 1), dispatch: () => Effect.succeed(result) })))
    expect(answer).toMatchObject({ _tag: "Left", left: { reason: "CONTEXT_LIMIT" } })
    expect(requests).toBe(0)
  })
  it.each(["UNAVAILABLE", "TIMEOUT", "MALFORMED"] as const)("recovers %s using one answer-only request, without repeating tools", async reason => {
    let requests = 0, dispatches = 0
    const { journal, events } = memoryJournal()
    const model: AgentModel = input => {
      requests++
      if (requests === 1) return Effect.succeed(call)
      if (requests === 2) return Effect.fail(new AgentModelError({ reason }))
      expect(input.tools).toEqual([])
      expect(JSON.stringify(input.contents)).toContain("The site lists Saturday hours")
      return Effect.succeed(text("Partial findings: the published Saturday hours conflict with the approved weekday schedule. Correct and verify the page."))
    }
    const answer = await Effect.runPromise(runConversation({ message: "What should we fix?", history: [], model, journal,
      dispatch: () => { dispatches++; return Effect.succeed(result) } }))
    expect(answer.reply).toContain("Saturday hours")
    expect(answer.outcome).toBe("ANSWERED_WITH_GAPS")
    expect(answer.citations).toEqual(result.citations)
    expect(requests).toBe(3)
    expect(dispatches).toBe(1)
    expect(events.some(e => e.payload["action"] === "ANSWER_RECOVERED")).toBe(true)
  })
  it("returns honest partial findings if recovery also fails or tries to execute another tool", async () => {
    for (const callsDuringRecovery of [false, true]) {
      let requests = 0, dispatches = 0
      const model: AgentModel = () => ++requests === 1 ? Effect.succeed(call)
        : requests === 3 && callsDuringRecovery ? Effect.succeed(call) : Effect.fail(new AgentModelError({ reason: "UNAVAILABLE" }))
      const answer = await Effect.runPromise(runConversation({ message: "Review", history: [], model,
        dispatch: () => { dispatches++; return Effect.succeed(result) } }))
      expect(answer.reply).toContain("2 reviewed factual errors found")
      expect(answer.reply).toContain("full conclusion is still missing")
      expect(answer.outcome).toBe("ANSWERED_WITH_GAPS")
      expect(dispatches).toBe(1)
      expect(requests).toBe(3)
    }
  })
  it("never retries rate limits or exhausts the model-step budget", async () => {
    for (const reason of ["RATE_LIMITED", "UNAVAILABLE"] as const) {
      let requests = 0
      const model: AgentModel = () => ++requests === 1 ? Effect.succeed(call) : Effect.fail(new AgentModelError({ reason }))
      const answer = await Effect.runPromise(runConversation({ message: "Review", history: [], model,
        budget: { modelSteps: reason === "RATE_LIMITED" ? 5 : 2, toolCalls: 5 }, dispatch: () => Effect.succeed(result) }))
      expect(requests).toBe(2)
      expect(answer.outcome).toBe("ANSWERED_WITH_GAPS")
    }
  })
  it("does not mask cancellation, revocation, or failures before any findings", async () => {
    for (const reason of ["CANCELLED", "UNCONFIGURED", "UNAVAILABLE"] as const) {
      let requests = 0
      const model: AgentModel = () => reason === "UNAVAILABLE" || ++requests > 1 ? Effect.fail(new AgentModelError({ reason })) : Effect.succeed(call)
      const answer = await Effect.runPromise(Effect.either(runConversation({ message: "Review", history: [], model, dispatch: () => Effect.succeed(result) })))
      expect(answer).toMatchObject({ _tag: "Left", left: { reason } })
    }
  })
  it("recovers empty responses after research instead of discarding completed work", async () => {
    let requests = 0
    const model: AgentModel = () => Effect.succeed(++requests === 1 ? call : requests === 2 ? text("") : text("Partial findings: check the opening hours."))
    const answer = await Effect.runPromise(runConversation({ message: "Review", history: [], model, dispatch: () => Effect.succeed(result) }))
    expect(answer.reply).toContain("opening hours")
    expect(answer.outcome).toBe("ANSWERED_WITH_GAPS")
  })
})
