import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { runConversation } from "./agent.js"
import type { AgentModel } from "./agent-model.js"

describe("general chat tool boundary", () => {
  it("interprets a title in the same model response without copying the first message", async () => {
    let calls = 0
    const model: AgentModel = input => {
      calls++
      expect(input.system).toContain('"title"')
      return Effect.succeed({ candidates: [{ content: { role: "model", parts: [{ text: JSON.stringify({ reply: "Here are the priorities.", title: "Launch marketing priorities" }) }] }, finishReason: "STOP" }] })
    }
    expect(await Effect.runPromise(runConversation({ message: "Hello, could you please help me figure out what to do about launching?", history: [], model, generateTitle: true, dispatch: () => Effect.die("No tools") }))).toMatchObject({ reply: "Here are the priorities.", title: "Launch marketing priorities" })
    expect(calls).toBe(1)
  })
  it("sends no business tools to the model", async () => {
    const model: AgentModel = input => {
      expect(input.tools).toEqual([])
      expect(input.system?.startsWith("General chat")).toBe(true)
      return Effect.succeed({ candidates: [{ content: { role: "model", parts: [{ text: "Hello" }] }, finishReason: "STOP" }] })
    }
    expect(await Effect.runPromise(runConversation({ message: "Hi", history: [], model, tools: [], system: "General chat", dispatch: () => Effect.die("Must never dispatch") }))).toMatchObject({ reply: "Hello", toolCalls: [] })
  })
  it("refuses a tool request even if a model invents one", async () => {
    const model: AgentModel = () => Effect.succeed({ candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "read_business_truth", args: {} } }] }, finishReason: "STOP" }] })
    expect(await Effect.runPromise(runConversation({ message: "Read another client", history: [], model, tools: [], dispatch: () => Effect.die("Must never dispatch") }).pipe(Effect.either))).toMatchObject({ _tag: "Left", left: { reason: "MALFORMED" } })
  })
  it("writes in the friendly voice by default, and shorter or deeper when the person asks", async () => {
    const systems: string[] = []
    const model: AgentModel = input => {
      systems.push(input.system ?? "")
      return Effect.succeed({ candidates: [{ content: { role: "model", parts: [{ text: "Hello" }] }, finishReason: "STOP" }] })
    }
    for (const style of [undefined, "concise", "detailed"] as const)
      await Effect.runPromise(runConversation({ message: "Hi", history: [], model, tools: [], system: "General chat", style, dispatch: () => Effect.die("No tools") }))
    for (const system of systems) expect(system).toContain("what it means for their business")
    expect(systems[0]).not.toMatch(/asked for (concise|detailed) answers/)
    expect(systems[1]).toContain("asked for concise answers")
    expect(systems[2]).toContain("asked for detailed answers")
  })
})
