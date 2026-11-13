import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { UI_INSTRUCTION, cleanTitle, generateChatTitle, runConversation, trimReply } from "./agent.js"
import { AgentModelError, type AgentModel } from "./agent-model.js"

describe("general chat tool boundary", () => {
  it("asks for a title in its own request, so the answer is never wrapped to carry one", async () => {
    const systems: string[] = []
    const model: AgentModel = input => {
      systems.push(input.system)
      expect(input.tools).toEqual([])
      return Effect.succeed({ candidates: [{ content: { role: "model", parts: [{ text: systems.length === 1 ? '"Launch marketing priorities."' : "Here are the priorities." }] }, finishReason: "STOP" }] })
    }
    const message = "Hello, could you please help me figure out what to do about launching?"
    expect(await Effect.runPromise(generateChatTitle(model, message))).toBe("Launch marketing priorities")
    expect(await Effect.runPromise(runConversation({ message, history: [], model, tools: [], system: "General chat", dispatch: () => Effect.die("No tools") }))).toMatchObject({ reply: "Here are the priorities." })
    expect(systems[0]).toContain("Reply with the title only")
    expect(systems[1]).not.toContain("Reply with the title only")
    expect(systems[1]).not.toContain('"reply"')
  })
  it("gives no title, and never fails the turn, when the title request fails or returns nothing usable", async () => {
    expect(await Effect.runPromise(generateChatTitle(() => Effect.fail(new AgentModelError({ reason: "UNAVAILABLE" })), "Hi"))).toBeUndefined()
    expect(cleanTitle('  "" \n')).toBeUndefined()
    expect(cleanTitle("x".repeat(200))).toHaveLength(80)
  })
  it("keeps a long answer, shortened at a paragraph and never inside an open chart block, and says so", async () => {
    const long = `${"A full paragraph of findings.\n\n".repeat(520)}\`\`\`chart\n{"type":"bar","labels":[${'"x",'.repeat(900)}`
    expect(long.length).toBeGreaterThan(16000)
    const model: AgentModel = () => Effect.succeed({ candidates: [{ content: { role: "model", parts: [{ text: long.slice(0, 19000) }] }, finishReason: "STOP" }] })
    const out = await Effect.runPromise(runConversation({ message: "Everything", history: [], model, tools: [], system: "General chat", dispatch: () => Effect.die("No tools") }))
    expect(out.reply.length).toBeLessThanOrEqual(16000)
    expect(out.reply.endsWith("…")).toBe(true)
    expect(out.reply).not.toContain("```chart")
    expect(out).toMatchObject({ outcome: "ANSWERED_WITH_GAPS", gaps: ["The answer was longer than a reply can be and was shortened"] })
    expect(trimReply("short")).toBe("short")
  })
  it("keeps an answer the provider cut off at its output limit, marked as stopping early", async () => {
    const model: AgentModel = () => Effect.succeed({ candidates: [{ content: { role: "model", parts: [{ text: "The first half of the plan" }] }, finishReason: "MAX_TOKENS" }] })
    expect(await Effect.runPromise(runConversation({ message: "Plan", history: [], model, tools: [], system: "General chat", dispatch: () => Effect.die("No tools") })))
      .toMatchObject({ reply: "The first half of the plan", outcome: "ANSWERED_WITH_GAPS", gaps: ["The model reached its length limit, so the answer may stop early"] })
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
  it("describes generated views only to a client that draws them", async () => {
    const systems: string[] = []
    const model: AgentModel = input => {
      systems.push(input.system ?? "")
      return Effect.succeed({ candidates: [{ content: { role: "model", parts: [{ text: "Hello" }] }, finishReason: "STOP" }] })
    }
    for (const surfaces of [undefined, ["ui"] as const])
      await Effect.runPromise(runConversation({ message: "Hi", history: [], model, tools: [], system: "General chat", surfaces, dispatch: () => Effect.die("No tools") }))
    expect(systems[0]).not.toContain("language ui")
    expect(systems[1]).toContain(UI_INSTRUCTION)
  })
})
