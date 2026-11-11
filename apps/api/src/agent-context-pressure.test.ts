import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { compactToolResults } from "./agent-context.js"
import { runConversation } from "./agent.js"
import { modelRequestBytes, EXECUTION_LIMITS, narrowTools } from "./agent-execution-policy.js"
import type { AgentModel, ModelContent } from "./agent-model.js"
import { memoryJournal } from "./agent-run.js"

const answer = { candidates: [{ content: { role: "model" as const, parts: [{ text: "Prepared the next step using the evidence; no external action was executed." }] }, finishReason: "STOP" }] }
const round = (text: string): ModelContent => ({ role: "user", parts: [{ functionResponse: { name: "read_results", response: {
  untrustedEvidence: { summary: "12 bookings observed; attribution unknown", citations: [{ kind: "campaign", id: "campaign-1", text: "Source campaign" }],
    data: { campaignId: "campaign-1", revision: 7, before: 9, after: 12, currency: "USD", status: "OBSERVED", detail: text } },
} } }] })

describe("inference context pressure", () => {
  it("fits UTF-8 bytes, not just JavaScript character counts", () => {
    const contents = [round("客".repeat(4000))]
    expect(JSON.stringify(contents).length).toBeLessThan(8000)
    expect(Buffer.byteLength(JSON.stringify(contents))).toBeGreaterThan(8000)
    expect(compactToolResults(contents, 8000)).toBe(true)
    const text = JSON.stringify(contents)
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(8000)
    expect(text).toContain('"before":9')
    expect(text).toContain('"after":12')
    expect(text).toContain('"revision":7')
    expect(text).toContain('"partial":true')
    expect(text).toContain("not complete denominators")
  })

  it("projects an oversized newest batch while retaining response pairing and receipts", () => {
    const contents: ModelContent[] = [{ role: "user", parts: [{ text: "Prepare the next step" }] }, { role: "model", parts: [
      { functionCall: { name: "record_campaign_revision", args: { campaignId: "campaign-1", expectedRevision: 6, changes: { message: "Keep this exact copy" } } } },
    ] }, round("x".repeat(15000))]
    const originalCall = JSON.stringify(contents[1])
    expect(compactToolResults(contents, 4000)).toBe(true)
    expect(JSON.stringify(contents[1])).toBe(originalCall)
    expect(JSON.stringify(contents[2])).toContain('"campaignId":"campaign-1"')
    expect(JSON.stringify(contents[2])).toContain('"revision":7')
    expect(JSON.stringify(contents[2])).toContain("do not repeat a write")
  })

  it("continues real loop inference after a six-read batch rather than forcing a partial recovery", async () => {
    const tools = [{ name: "read_results", description: "schema overhead ".repeat(5400), parametersJsonSchema: {} }]
    let steps = 0, dispatches = 0
    const { journal, events } = memoryJournal()
    const model: AgentModel = request => {
      expect(modelRequestBytes(request)).toBeLessThanOrEqual(EXECUTION_LIMITS.requestBytes)
      if (++steps === 1) return Effect.succeed({ candidates: [{ content: { role: "model", parts: Array.from({ length: 6 }, () => ({ functionCall: { name: "read_results", args: {} } })) }, finishReason: "STOP" }] })
      expect(request.tools).toHaveLength(1)
      expect(JSON.stringify(request.contents)).toContain("compactedEvidence")
      expect(JSON.stringify(request.contents)).toContain('"after":12')
      return Effect.succeed(answer)
    }
    const result = await Effect.runPromise(runConversation({ message: "Check our results and prepare the next step", history: [], model, tools, journal,
      dispatch: () => { dispatches++; return Effect.succeed({ summary: "12 bookings; attribution unknown", citations: [], data: { campaignId: "campaign-1", revision: 7, before: 9, after: 12, detail: "x".repeat(10000) } }) },
    }))
    expect(result.outcome).toBe("ANSWERED")
    expect(result.gaps).toEqual([])
    expect(steps).toBe(2)
    expect(dispatches).toBe(6)
    expect(events.some(e => e.payload["action"] === "CONTEXT_COMPACTED")).toBe(true)
    expect(events.some(e => e.payload["action"] === "MODEL_FAILED")).toBe(false)
    expect(events.filter(e => e.type === "MODEL_REQUESTED").every(e => Number(e.payload["requestBytes"]) <= EXECUTION_LIMITS.requestBytes)).toBe(true)
  })

  it("allocates initial history after schemas and UTF-8 overhead without changing the current request", async () => {
    const tools = [{ name: "read_results", description: "schema ".repeat(10000), parametersJsonSchema: {} }]
    const message = "Continue the campaign, preserving the approved offer"
    const model: AgentModel = request => {
      expect(modelRequestBytes(request)).toBeLessThanOrEqual(EXECUTION_LIMITS.requestBytes)
      expect(JSON.stringify(request.contents)).toContain(message)
      return Effect.succeed(answer)
    }
    const result = await Effect.runPromise(runConversation({ message, history: Array.from({ length: 20 }, () => ({ role: "user" as const, text: "客".repeat(1000) })),
      model, tools, dispatch: () => Effect.die("No dispatch expected"),
    }))
    expect(result.context.budgetChars).toBeLessThan(32000)
    expect(result.context.omitted + result.context.compacted).toBeGreaterThan(0)
  })

  it("refuses impossible envelopes without changing a user request or tool-call arguments", () => {
    const contents: ModelContent[] = [{ role: "user", parts: [{ text: "x".repeat(5000) }] }, { role: "model", parts: [{ functionCall: { name: "record_campaign_revision", args: { content: "Exact draft" } } }] }]
    const original = JSON.stringify(contents)
    expect(compactToolResults(contents, 100)).toBe(false)
    expect(JSON.stringify(contents)).toBe(original)
  })

  it("narrows tools to used, core and relevant ones only as far as the evidence needs", () => {
    const decl = (name: string, description: string) => ({ name, description, parametersJsonSchema: {} })
    const tools = [decl("read_reviews", "Customer reviews"), decl("read_growth_goal", "The goal"), decl("read_competitors", "Competitors named in AI answers"),
      decl("prepare_page_change", "Edit a page"), decl("read_results", "Results")]
    const all = narrowTools(tools, { used: new Set(), text: "who are our competitors", fits: () => true })
    expect(all.map(t => t.name)).toEqual(["read_growth_goal", "read_competitors"])
    const tight = narrowTools(tools, { used: new Set(["read_results"]), text: "who are our competitors", fits: list => list.length <= 2 })
    expect(tight.map(t => t.name)).toEqual(["read_growth_goal", "read_results"])
  })

  it("declares fewer tools rather than stopping research when the schemas leave no room for evidence", async () => {
    const big = (name: string) => ({ name, description: "schema ".repeat(4200), parametersJsonSchema: {} })
    const tools = [big("read_results"), big("read_reviews"), big("read_ad_performance"), big("prepare_page_change")]
    let steps = 0
    const { journal, events } = memoryJournal()
    const model: AgentModel = request => {
      expect(modelRequestBytes(request)).toBeLessThanOrEqual(EXECUTION_LIMITS.requestBytes)
      if (++steps === 1) return Effect.succeed({ candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "read_results", args: {} } }] }, finishReason: "STOP" }] })
      expect(request.tools.map(t => (t as { name: string }).name)).toContain("read_results")
      expect(request.tools.length).toBeLessThan(tools.length)
      expect(JSON.stringify(request.contents)).toContain('"after":12')
      return Effect.succeed(answer)
    }
    const result = await Effect.runPromise(runConversation({ message: "Check our results", history: [], model, tools, journal,
      dispatch: () => Effect.succeed({ summary: "12 bookings; attribution unknown", citations: [], data: { campaignId: "campaign-1", revision: 7, before: 9, after: 12, detail: "x".repeat(14000) } }) }))
    expect(result.outcome).toBe("ANSWERED")
    expect(result.gaps).toEqual([])
    expect(events.some(e => e.type === "MODEL_REQUESTED" && Number(e.payload["toolsNarrowed"]) > 0)).toBe(true)
    expect(events.some(e => e.payload["action"] === "MODEL_FAILED")).toBe(false)
  })
})
