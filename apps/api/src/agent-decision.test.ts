import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { agentDeclarations, runConversation } from "./agent.js"
import { CORE_TOOLS, decideTurn, viewedArtifact } from "./agent-decision.js"
import type { AgentModel, ModelInput, ModelResponse } from "./agent-model.js"
import { toolEffect } from "./agent-registry.js"
import { memoryJournal } from "./agent-run.js"
import { TOOL_DETAILS } from "./agent-tool-cards.js"
import type { AgentToolResult } from "./agent-tools.js"

const text = (value: string): ModelResponse => ({ candidates: [{ content: { role: "model", parts: [{ text: value }] }, finishReason: "STOP" }] })
const calls = (...list: Array<[string, Record<string, unknown>?]>): ModelResponse =>
  ({ candidates: [{ content: { role: "model", parts: list.map(([name, args]) => ({ functionCall: { name, args: args ?? {} } })) }, finishReason: "STOP" }] })
const read: AgentToolResult = { summary: "Read", citations: [], data: { ok: true } }
const recorded = (responses: ModelResponse[]) => {
  const requests: ModelInput[] = []
  const model: AgentModel = input => { requests.push({ ...input, contents: structuredClone(input.contents) as ModelInput["contents"] }); return Effect.succeed(responses.shift() ?? text("done")) }
  return { model, requests }
}
const names = (r: ModelInput) => (r.tools as Array<{ name: string }>).map(t => t.name)
const ARTIFACT = "0b7e3c2a-9f41-4c55-8a2e-3d6f1b9c7e10"
const viewing = `Make the header navy\n\n[App context, not written by the person: they are looking at artifact ${ARTIFACT} beside the chat. When they ask for a change without naming another piece, it is for artifact ${ARTIFACT}: read it and save the change with edit_artifact as a new version.]`

describe("deciding a business turn (rules, no model)", () => {
  it("reads nothing and keeps every tool for a greeting or a word of thanks", () => {
    for (const m of ["thanks!", "hi there", "ok great"]) expect(decideTurn(m, agentDeclarations)).toMatchObject({ intents: [], tools: null, prefetch: [] })
  })

  it("leaves slash commands to their own tool sets", () => {
    expect(decideTurn("/status", agentDeclarations)).toMatchObject({ tools: null, prefetch: [] })
  })

  it("reads a report's numbers before the first step and declares the report's tools", () => {
    const d = decideTurn("How are we doing against our goal this month? Show traffic and revenue.", agentDeclarations)
    expect(d.intents[0]).toBe("report")
    expect(d.prefetch.map(p => p.name)).toEqual(expect.arrayContaining(["read_search_performance", "read_results", "read_revenue"]))
    expect(d.tools).toEqual(expect.arrayContaining(["read_revenue", "read_ad_performance", "prepare_client_report"]))
    expect(d.tools!.length).toBeLessThan(agentDeclarations.length)
  })

  it("treats a change asked for beside an open piece as writing about that piece, reading it first", () => {
    expect(viewedArtifact(viewing)).toBe(ARTIFACT)
    const d = decideTurn(viewing, agentDeclarations)
    expect(d.intents).toContain("write")
    expect(d.prefetch[0]).toEqual({ name: "read_artifact", args: { artifactId: ARTIFACT } })
    expect(d.tools).toEqual(expect.arrayContaining(["edit_artifact", "read_artifact", "create_artifact"]))
  })

  it("keeps a long brief to its strongest intents instead of every one it touches", () => {
    const brief = "Find which sources AI answers cite when buyers ask about our category: the most-cited domains and pages, which of them name our competitors, and what kind of source each is. Give a plan to earn a mention on the five that matter most."
    const d = decideTurn(brief, agentDeclarations)
    expect(d.intents[0]).toBe("visibility")
    expect(d.intents.length).toBeLessThanOrEqual(2)
    expect(d.tools).toEqual(expect.arrayContaining(["read_acquisition_citations", "read_competitor_appearances", "ask_ai_assistants"]))
  })

  it("only narrows: never declares or reads a tool the turn does not have, and always declares the core and inputless reads", () => {
    const few = agentDeclarations.filter(t => !["read_revenue", "read_search_performance"].includes(t.name))
    const d = decideTurn("How did revenue and search traffic do last month?", few)
    const available = new Set(few.map(t => t.name))
    for (const n of d.tools!) expect(available.has(n)).toBe(true)
    for (const p of d.prefetch) expect(available.has(p.name)).toBe(true)
    for (const n of CORE_TOOLS) if (available.has(n)) expect(d.tools).toContain(n)
    expect(d.tools).toContain("read_local_profile")
  })

  it("reads only before the first step: every prefetched tool is a read that needs no inputs (the open piece aside)", () => {
    const requests = ["How are we doing?", "Which competitors do AI answers cite instead of us?", "Write a landing page for agencies", "Audit our website for SEO",
      "What should we focus on this week?", "How are our Google Ads doing?", "Review the pending proposals", "Tell me something useful about the business please"]
    for (const m of requests) for (const p of decideTurn(m, agentDeclarations).prefetch) {
      expect(toolEffect(p.name)).toBe("read")
      const required = (agentDeclarations.find(t => t.name === p.name)!.parametersJsonSchema as { required?: string[] }).required ?? []
      expect(required).toEqual([])
    }
  })

})

describe("a decided turn in the run loop (deterministic fixtures, no live model)", () => {
  it("runs the decision's reads as the first step without asking the model, then hands their results to its first request", async () => {
    const decision = decideTurn("How are we doing against our goal this month?", agentDeclarations)
    const { model, requests } = recorded([text("Here is where we stand")])
    const dispatched: string[] = []
    const { journal, events } = memoryJournal()
    const reply = await Effect.runPromise(runConversation({ message: "How are we doing against our goal this month?", history: [], model, journal, decision,
      dispatch: name => { dispatched.push(name); return Effect.succeed(read) } }))
    expect(reply.reply).toBe("Here is where we stand")
    expect(requests).toHaveLength(1)
    expect(dispatched.sort()).toEqual(decision.prefetch.map(p => p.name).sort())
    const sent = JSON.stringify(requests[0]!.contents)
    for (const p of decision.prefetch) expect(sent).toContain(`"functionResponse":{"name":"${p.name}"`)
    expect(sent).toContain("skip_thought_signature_validator")
    expect(events.find(e => e.payload["action"] === "DECIDED")?.payload).toMatchObject({ intents: decision.intents, prefetch: decision.prefetch.map(p => p.name) })
    expect(reply.usage).toHaveLength(1)
  })

  it("declares the decided tools, and declares another whole once the model asks for it with tool_details", async () => {
    const decision = decideTurn("Write a landing page for agencies", agentDeclarations)
    const outside = agentDeclarations.map(t => t.name).find(n => !decision.tools!.includes(n))!
    const { model, requests } = recorded([calls(["tool_details", { names: [outside] }]), text("Ready")])
    await Effect.runPromise(runConversation({ message: "Write a landing page for agencies", history: [], model, decision: { ...decision, prefetch: [] }, dispatch: () => Effect.succeed(read) }))
    expect(names(requests[0]!)).not.toContain(outside)
    expect(names(requests[0]!)).toContain(TOOL_DETAILS.name)
    expect(names(requests[0]!).length).toBeLessThan(agentDeclarations.length)
    expect(names(requests[1]!)).toContain(outside)
  })

  it("finds an eligible capability by task, loads its schema and calls the existing dispatcher", async () => {
    const tool = "prepare_wordpress_change"
    const offered = agentDeclarations.filter(t => t.name !== "read_webflow_content")
    const { model, requests } = recorded([
      calls(["find_capabilities", { query: "prepare WordPress page change for approval" }]),
      calls(["tool_details", { names: [tool, "read_webflow_content", "diagnose_marketing_problems"] }]),
      calls([tool]),
      text("Ready"),
    ])
    const dispatched: string[] = []
    await Effect.runPromise(runConversation({ message: "Draft an email to agencies", history: [], model, tools: offered,
      decision: { version: "fixture", intents: ["write"], tools: [], prefetch: [], expand: [] },
      dispatch: name => { dispatched.push(name); return Effect.succeed(read) } }))
    expect(names(requests[0]!)).toContain("find_capabilities")
    expect(names(requests[0]!)).not.toContain(tool)
    expect(JSON.stringify(requests[1]!.contents)).toContain(`"name":"${tool}"`)
    expect(JSON.stringify(requests[1]!.contents)).not.toMatch(/read_webflow_content|diagnose_marketing_problems/)
    expect(requests[2]!.tools).toContainEqual(agentDeclarations.find(t => t.name === tool))
    expect(names(requests[2]!)).not.toContain("read_webflow_content")
    expect(dispatched).toEqual([tool])
  })

  it("orders found capabilities by how they worked here, and answers plainly when nothing fits", async () => {
    const { model, requests } = recorded([
      calls(["find_capabilities", { query: "What are buyers asking AI assistants about us?" }]),
      calls(["find_capabilities", { query: "fly a drone to mars" }]),
      text("Done"),
    ])
    const events: Array<{ type: string; payload: Record<string, unknown> }> = []
    let first: ReadonlyArray<string> = []
    const missed: string[] = []
    await Effect.runPromise(runConversation({ message: "Look into AI answers", history: [], model,
      decision: { version: "fixture", intents: ["visibility"], tools: [], prefetch: [], expand: [] },
      journal: { record: (type, payload) => Effect.sync(() => { events.push({ type, payload }) }) },
      // The first match failed in most of its recent calls here.
      capabilityStats: names => Effect.sync(() => { first = names; return new Map([[names[0]!, { calls: 8, succeeded: 1, medianSeconds: 2 }]]) }),
      recordMissingCapability: query => Effect.sync(() => { missed.push(query) }),
      dispatch: () => Effect.succeed(read) }))
    const found = (step: number) => (requests[step]!.contents.at(-1)!.parts as Array<{ functionResponse?: { response: { capabilities: Array<{ name: string; measured: unknown }>; found: boolean; note: string } } }>)[0]!.functionResponse!.response
    expect(first.length).toBeGreaterThan(1)
    expect(found(1).capabilities.map(c => c.name)).toEqual([...first.slice(1), first[0]])
    expect(found(1).capabilities.at(-1)!.measured).toEqual({ calls: 8, successRate: 0.13, medianSeconds: 2 })
    expect(found(2)).toMatchObject({ capabilities: [], found: false })
    expect(found(2).note).toContain("Do not search again")
    expect(events.filter(e => e.type === "VERIFICATION").map(e => e.payload["action"])).toEqual(expect.arrayContaining(["CAPABILITIES_FOUND", "CAPABILITIES_NOT_FOUND"]))
    expect(events.find(e => e.payload["action"] === "CAPABILITIES_NOT_FOUND")!.payload["query"]).toBe("fly a drone to mars")
    // The miss is saved as a request for the team; a search that found something is not.
    expect(missed).toEqual(["fly a drone to mars"])
  })

  it("declares a writing turn's saves whole from the first step, so creating the piece needs no tool_details step", async () => {
    const decision = decideTurn("Write a short landing page for marketing agencies", agentDeclarations)
    expect(decision.intents[0]).toBe("write")
    expect(decision.prefetch.map(p => p.name)).not.toContain("read_connected_execution_targets")
    const { model, requests } = recorded([text("Drafted")])
    await Effect.runPromise(runConversation({ message: "Write a short landing page for marketing agencies", history: [], model, decision: { ...decision, prefetch: [] }, dispatch: () => Effect.succeed(read) }))
    const full = agentDeclarations.find(t => t.name === "create_artifact")!
    expect((requests[0]!.tools as Array<{ name: string; parametersJsonSchema: unknown }>).find(t => t.name === "create_artifact")!.parametersJsonSchema).toEqual(full.parametersJsonSchema)
  })

  it("leaves an undecided turn exactly as before: every tool, the model's own first step", async () => {
    const { model, requests } = recorded([text("Hello")])
    await Effect.runPromise(runConversation({ message: "thanks!", history: [], model, decision: decideTurn("thanks!", agentDeclarations), dispatch: () => Effect.die("nothing to read") }))
    expect(names(requests[0]!)).toEqual([...agentDeclarations.map(t => t.name), TOOL_DETAILS.name])
  })
})
