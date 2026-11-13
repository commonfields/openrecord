import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { AGENT_SYSTEM, UI_INSTRUCTION, agentDeclarations, runConversation, turnPlan, voiceFor } from "./agent.js"
import { EXECUTION_LIMITS, modelRequestBytes } from "./agent-execution-policy.js"
import type { AgentModel, ModelInput, ModelResponse } from "./agent-model.js"
import { READING_RULES, systemFor } from "./agent-prompt.js"
import { AGENT_TOOL_SPECS } from "./agent-registry.js"
import { memoryJournal } from "./agent-run.js"
import { declareTools, hasLazySchema, TOOL_DETAILS } from "./agent-tool-cards.js"
import { AgentInvalidInput, type AgentToolResult } from "./agent-tools.js"

const text = (value: string): ModelResponse => ({ candidates: [{ content: { role: "model", parts: [{ text: value }] }, finishReason: "STOP" }] })
const calls = (...list: Array<[string, Record<string, unknown>?]>): ModelResponse =>
  ({ candidates: [{ content: { role: "model", parts: list.map(([name, args]) => ({ functionCall: { name, args: args ?? {} } })) }, finishReason: "STOP" }] })
const read: AgentToolResult = { summary: "Read", citations: [], data: { ok: true } }
const recorded = (responses: ModelResponse[]) => {
  const requests: ModelInput[] = []
  const model: AgentModel = input => { requests.push({ ...input, contents: structuredClone(input.contents) as ModelInput["contents"] }); return Effect.succeed(responses.shift() ?? text("done")) }
  return { model, requests }
}
const declared = (request: ModelInput, name: string) => (request.tools as Array<{ name: string; description: string; parametersJsonSchema: unknown }>).find(t => t.name === name)

describe("what a general business turn costs before any conversation", () => {
  it("fits instructions and a card for every tool in half a request", () => {
    const system = turnPlan(null, "What should we focus on this week?").system + voiceFor(undefined) + UI_INSTRUCTION
    const tools = declareTools(agentDeclarations, new Set())
    expect(tools.map(t => t.name)).toEqual([...agentDeclarations.map(t => t.name), TOOL_DETAILS.name])
    expect(modelRequestBytes({ contents: [], tools, system })).toBeLessThanOrEqual(EXECUTION_LIMITS.requestBytes / 2)
  })

  it("keeps small input schemas on the card and defers only large ones", () => {
    const cards = declareTools(agentDeclarations, new Set())
    const lazy = agentDeclarations.filter(hasLazySchema).map(t => t.name)
    expect(lazy).toContain("prepare_wordpress_change")
    expect(lazy).not.toContain("read_revenue")
    // Every deferred schema belongs to a tool that saves or prepares, or to the one metered research call.
    for (const name of lazy) expect(AGENT_TOOL_SPECS.find(s => s.declaration.name === name)!.effect).not.toBe("read")
    expect(cards.find(t => t.name === "read_revenue")!.parametersJsonSchema).toMatchObject({ properties: { days: {} } })
    expect(cards.find(t => t.name === "prepare_wordpress_change")!.description).toContain("call tool_details")
  })

  it("carries the marketing loop on every ordinary turn, and a command's own guide on that command", () => {
    // No keyword decides it: a request that never says "marketing" gets the same instructions.
    expect(systemFor("How did search do last month?")).toBe(AGENT_SYSTEM)
    expect(systemFor("Work on our onboarding campaign")).toBe(AGENT_SYSTEM)
    expect(AGENT_SYSTEM).toContain("Marketing operating loop:")
    expect(systemFor("/campaign-run Trial")).toContain("For /campaign-run call record_campaign_run")
    expect(systemFor("/status")).not.toContain("Marketing operating loop:")
    expect(systemFor("/status")).toContain("For /status,")
  })
})

describe("tool cards in the run loop (deterministic fixtures, no live model)", () => {
  it("declares a deferred tool in full once the run asks for its details", async () => {
    const { model, requests } = recorded([calls(["tool_details", { names: ["prepare_wordpress_change", "not_a_tool"] }]), text("Ready")])
    const { journal, events } = memoryJournal()
    await Effect.runPromise(runConversation({ message: "Fix the title on the pricing page", history: [], model, journal, dispatch: () => Effect.die("tool_details reads nothing") }))
    const full = agentDeclarations.find(t => t.name === "prepare_wordpress_change")!
    expect(declared(requests[0]!, "prepare_wordpress_change")!.parametersJsonSchema).toEqual({ type: "object" })
    expect(declared(requests[1]!, "prepare_wordpress_change")).toEqual(full)
    expect(JSON.stringify(requests[1]!.contents)).toContain(JSON.stringify(full.description))
    expect(events.find(e => e.payload["action"] === "TOOLS_EXPANDED")?.payload["tools"]).toEqual(["prepare_wordpress_change"])
    expect(events.some(e => e.type === "TOOL_STARTED")).toBe(false)
  })

  it("answers a refused call on a deferred tool with its schema, so one retry is enough", async () => {
    const { model, requests } = recorded([calls(["prepare_wordpress_change", { title: "x" }]), text("Could not prepare it")])
    await Effect.runPromise(runConversation({ message: "Fix the title", history: [], model, dispatch: () => Effect.fail(new AgentInvalidInput({ tool: "prepare_wordpress_change" })) }))
    const refusal = JSON.stringify(requests[1]!.contents.at(-1))
    expect(refusal).toContain("INVALID_INPUT")
    expect(refusal).toContain("Its input schema:")
    expect(declared(requests[1]!, "prepare_wordpress_change")).toEqual(agentDeclarations.find(t => t.name === "prepare_wordpress_change"))
  })

  it("sends a tool's reading rule with its first result only", async () => {
    const { model, requests } = recorded([calls(["read_revenue"]), calls(["read_revenue"]), text("Revenue read")])
    await Effect.runPromise(runConversation({ message: "What did we earn?", history: [], model, dispatch: () => Effect.succeed(read) }))
    const notes = (request: ModelInput) => JSON.stringify(request.contents).split(READING_RULES["read_revenue"]!).length - 1
    expect(notes(requests[1]!)).toBe(1)
    expect(notes(requests[2]!)).toBe(1)
  })
})

describe("a run that reads on and on (deterministic fixtures, no live model)", () => {
  it("is told once, after eight steps, to finish with what the answer needs", async () => {
    const { model, requests } = recorded([...Array.from({ length: 10 }, () => calls(["read_open_issues"])), text("Answered")])
    const answer = await Effect.runPromise(runConversation({ message: "Compare us with two competitors", history: [], model, dispatch: () => Effect.succeed(read) }))
    const notices = requests.map(r => JSON.stringify(r.contents).split("this request has used eight steps").length - 1)
    expect(notices.slice(0, 8)).toEqual(Array(8).fill(0))
    expect(notices.slice(8)).toEqual([1, 1, 1])
    expect(answer.outcome).toBe("ANSWERED")
  })
})

describe("reads and research in one step (deterministic fixtures, no live model)", () => {
  const timed = (order: string[]) => {
    let running = 0, peak = 0
    const dispatch = (name: string) => Effect.gen(function*() {
      running++; peak = Math.max(peak, running); order.push(`start ${name}`)
      yield* Effect.sleep("20 millis")
      running--; order.push(`end ${name}`)
      return read
    })
    return { dispatch, peak: () => peak }
  }

  it("run together and return in the order they were asked for", async () => {
    const order: string[] = []
    const { dispatch, peak } = timed(order)
    const { model, requests } = recorded([calls(["read_revenue"], ["read_search_performance"], ["read_ad_performance"]), text("Read")])
    const answer = await Effect.runPromise(runConversation({ message: "How are we doing?", history: [], model, dispatch }))
    expect(peak()).toBe(3)
    expect(answer.toolCalls.map(c => c.tool)).toEqual(["read_revenue", "read_search_performance", "read_ad_performance"])
    expect((requests[1]!.contents.at(-1)!.parts as Array<{ functionResponse: { name: string } }>).map(p => p.functionResponse.name))
      .toEqual(["read_revenue", "read_search_performance", "read_ad_performance"])
  })

  it("run research on several companies together, three at a time", async () => {
    const { dispatch, peak } = timed([])
    const companies = ["a.example", "b.example", "c.example", "d.example"].map((domain): [string, Record<string, unknown>] => ["research_company", { domain }])
    const { model } = recorded([calls(...companies), text("Compared")])
    await Effect.runPromise(runConversation({ message: "Compare these four", history: [], model, dispatch }))
    expect(peak()).toBe(3)
  })

  it("keep their place when the step also saves, so a read sees what the save wrote", async () => {
    const order: string[] = []
    const { dispatch, peak } = timed(order)
    const { model } = recorded([calls(["remember", { text: "Never discount" }], ["read_proposals"]), text("Saved")])
    await Effect.runPromise(runConversation({ message: "Remember that and show the drafts", history: [], model, dispatch }))
    expect(peak()).toBe(1)
    expect(order).toEqual(["start remember", "end remember", "start read_proposals", "end read_proposals"])
  })
})
