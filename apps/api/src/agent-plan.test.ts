import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { runConversation } from "./agent.js"
import type { ModelResponse } from "./agent-model.js"
import { memoryJournal } from "./agent-run.js"
import { updatePlan } from "./agent-plan.js"

const text = (value: string): ModelResponse => ({ candidates: [{ content: { role: "model", parts: [{ text: value }] }, finishReason: "STOP" }] })
const call = (name: string, args: Record<string, unknown>): ModelResponse => ({ candidates: [{ content: { role: "model", parts: [{ functionCall: { name, args } }] }, finishReason: "STOP" }] })

describe("a visible plan", () => {
  it("shows the plan at once, ticks steps off as the run updates it, and keeps the last one on the reply", async () => {
    const { events, journal } = memoryJournal()
    const responses = [
      call("update_plan", { steps: [{ step: "Read the pricing page", status: "in_progress" }, { step: "Draft the FAQ", status: "pending" }] }),
      call("update_plan", { steps: [{ step: "Read the pricing page", status: "completed" }, { step: "Draft the FAQ", status: "in_progress" }] }),
      call("update_plan", { steps: [{ step: "Read the pricing page", status: "completed" }, { step: "Draft the FAQ", status: "completed" }] }),
      text("The FAQ is drafted."),
    ]
    const answer = await Effect.runPromise(runConversation({ message: "Write a pricing FAQ", history: [], journal,
      model: () => Effect.succeed(responses.shift() ?? text("done")),
      dispatch: (_name, args) => updatePlan(args) }))
    const shown = events.filter(e => e.type === "TOOL_COMPLETED" && e.payload["tool"] === "update_plan").map(e => e.payload["plan"])
    expect(shown).toHaveLength(3)
    expect(shown[0]).toEqual({ steps: [{ step: "Read the pricing page", status: "in_progress" }, { step: "Draft the FAQ", status: "pending" }] })
    expect(answer.plan?.steps.map(s => s.status)).toEqual(["completed", "completed"])
  })

  it("refuses two steps in progress at once and an empty plan", async () => {
    await expect(Effect.runPromise(updatePlan({ steps: [{ step: "One", status: "in_progress" }, { step: "Two", status: "in_progress" }] }))).rejects.toBeDefined()
    await expect(Effect.runPromise(updatePlan({ steps: [] }))).rejects.toBeDefined()
    await expect(Effect.runPromise(updatePlan({ steps: [{ step: "One", status: "done" }] }))).rejects.toBeDefined()
  })
})
