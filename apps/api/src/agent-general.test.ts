import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { runConversation } from "./agent.js"
import type { AgentModel } from "./agent-model.js"

describe("general chat tool boundary", () => {
  it("sends no business tools to the model", async () => {
    const model: AgentModel = input => {
      expect(input.tools).toEqual([])
      expect(input.system).toBe("General chat")
      return Effect.succeed({ candidates: [{ content: { role: "model", parts: [{ text: "Hello" }] }, finishReason: "STOP" }] })
    }
    expect(await Effect.runPromise(runConversation({ message: "Hi", history: [], model, tools: [], system: "General chat", dispatch: () => Effect.die("Must never dispatch") }))).toMatchObject({ reply: "Hello", toolCalls: [] })
  })
  it("refuses a tool request even if a model invents one", async () => {
    const model: AgentModel = () => Effect.succeed({ candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "read_business_truth", args: {} } }] }, finishReason: "STOP" }] })
    expect(await Effect.runPromise(runConversation({ message: "Read another client", history: [], model, tools: [], dispatch: () => Effect.die("Must never dispatch") }).pipe(Effect.either))).toMatchObject({ _tag: "Left", left: { reason: "MALFORMED" } })
  })
})
