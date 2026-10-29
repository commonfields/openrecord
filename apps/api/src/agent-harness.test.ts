import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { MCP_PROHIBITED } from "@openrecord/contracts"
import { agentDeclarations, runConversation } from "./agent.js"
import { AgentModelError, type AgentModel, type ModelResponse } from "./agent-model.js"
import { AGENT_TOOL_SPECS, classifyToolFailure, decisionRefs, mergeDecisions, proposalReceipt, toolLabel } from "./agent-registry.js"
import { buildContext, compactToolResults, type ContextMessage } from "./agent-context.js"
import { interruptionNote, memoryJournal } from "./agent-run.js"
import { AgentInvalidInput, AgentUnknownTool, type AgentToolResult } from "./agent-tools.js"
import { AgentNotInScope } from "./agent-tool-errors.js"

const text = (value: string): ModelResponse => ({ candidates: [{ content: { role: "model", parts: [{ text: value }] }, finishReason: "STOP" }] })
const calls = (...names: string[]): ModelResponse => ({ candidates: [{ content: { role: "model", parts: names.map(name => ({ functionCall: { name, args: {} } })) }, finishReason: "STOP" }] })
const read: AgentToolResult = { summary: "3 open issues read", citations: [{ kind: "issue", id: "issue-fixture-1", text: "Wrong opening hours" }], data: { totalOpen: 3 } }
const saved: AgentToolResult = { summary: "Re-check proposed; approval required", citations: [{ kind: "question", id: "question-fixture", text: "Opening hours" }],
  data: { proposalId: "proposal-fixture", status: "PROPOSED", executed: false, questionId: "question-fixture", note: "free text is not a receipt" } }
const scripted = (responses: ModelResponse[], seen: string[] = []): AgentModel => input => {
  seen.push(JSON.stringify(input.contents))
  return Effect.succeed(responses.shift() ?? text("done"))
}

describe("agent harness run loop (deterministic fixtures, no live model)", () => {
  it("journals working-memory receipts without creating approvals or verified evidence", async () => {
    const { events, journal } = memoryJournal()
    const memory: AgentToolResult = { summary: "Assistant investigation note saved; interpretation remains unverified", citations: [],
      data: { investigationId: "11111111-1111-4111-8111-111111111111", noteId: "22222222-2222-4222-8222-222222222222", saved: true, verified: false } }
    const answer = await Effect.runPromise(runConversation({ message: "Remember this hypothesis", history: [], journal,
      model: scripted([calls("record_investigation_note"), text("The hypothesis is saved as working memory.")]), dispatch: () => Effect.succeed(memory) }))
    expect(answer.decisions).toEqual([])
    const recorded = events.find(e => e.type === "TOOL_COMPLETED")
    expect(recorded?.payload).toMatchObject({ effect: "record", receipt: { noteId: "22222222-2222-4222-8222-222222222222", saved: true } })
    const interrupted = interruptionNote("INTERRUPTED", null, events)
    expect(interrupted.text).toContain("unverified working memory")
    expect(interrupted.text).not.toContain("Saved for your review")
    expect(interrupted.text).not.toContain("Evidence read:")
    expect(interrupted.decisions).toEqual([])
  })

  it("journals context, model steps, tool invocations with server IDs, proposal receipts and verification", async () => {
    const { events, journal } = memoryJournal()
    const answer = await Effect.runPromise(runConversation({ message: "Re-check the opening hours", history: [], journal,
      model: scripted([calls("read_open_issues", "propose_check_run"), text("A re-check awaits your approval.")]),
      dispatch: name => Effect.succeed(name === "propose_check_run" ? saved : read) }))
    expect(answer).toMatchObject({ outcome: "ANSWERED", gaps: [] })
    expect(events.map(e => e.type)).toEqual(["CONTEXT_BUILT", "MODEL_REQUESTED", "MODEL_STEP", "TOOL_STARTED", "TOOL_COMPLETED", "TOOL_STARTED", "TOOL_COMPLETED", "MODEL_REQUESTED", "MODEL_STEP", "VERIFICATION"])
    const started = events.filter(e => e.type === "TOOL_STARTED").map(e => e.payload["invocationId"])
    expect(new Set(started).size).toBe(2)
    expect(started.every(id => typeof id === "string" && /^[0-9a-f-]{36}$/.test(id))).toBe(true)
    const proposal = events.find(e => e.type === "TOOL_COMPLETED" && e.payload["tool"] === "propose_check_run")!
    expect(proposal.payload).toMatchObject({ effect: "propose", receipt: { proposalId: "proposal-fixture", status: "PROPOSED", executed: false, questionId: "question-fixture" } })
    expect(JSON.stringify(proposal.payload)).not.toContain("free text")
    expect(events.find(e => e.payload["tool"] === "read_open_issues" && e.type === "TOOL_COMPLETED")!.payload["receipt"]).toBeUndefined()
  })

  it("gives the model typed, actionable tool failures and keeps run failures out of tool results", async () => {
    expect(classifyToolFailure(new AgentUnknownTool({ tool: "x" }))).toMatchObject({ code: "UNKNOWN_TOOL", retryable: false })
    expect(classifyToolFailure(new AgentInvalidInput({ tool: "x" }))).toMatchObject({ code: "INVALID_INPUT", retryable: true })
    expect(classifyToolFailure({ _tag: "ParseError" })).toMatchObject({ code: "INVALID_INPUT" })
    expect(classifyToolFailure(new AgentNotInScope())).toMatchObject({ code: "NOT_FOUND", retryable: false })
    expect(classifyToolFailure({ _tag: "AgentProposalRefused", reason: "QuestionNotFound" })).toMatchObject({ code: "REFUSED" })
    expect(classifyToolFailure(new Error("db down"))).toMatchObject({ code: "TOOL_FAILED", retryable: true })
    // A stop request mid-run ends the run instead of being shown as missing evidence.
    const { events, journal } = memoryJournal()
    const out = await Effect.runPromise(Effect.either(runConversation({ message: "Read", history: [], journal, model: scripted([calls("read_open_issues")]),
      dispatch: () => Effect.fail(new AgentModelError({ reason: "CANCELLED" })) })))
    expect(out).toMatchObject({ _tag: "Left", left: { reason: "CANCELLED" } })
    expect(events.map(e => e.type)).toEqual(["CONTEXT_BUILT", "MODEL_REQUESTED", "MODEL_STEP", "TOOL_STARTED"])
  })

  it("winds down at the budget: refuses extra calls, asks for a final answer and marks the gap", async () => {
    const seen: string[] = []
    const answer = await Effect.runPromise(runConversation({ message: "Investigate everything", history: [], budget: { modelSteps: 4, toolCalls: 2 },
      model: scripted([calls("read_open_issues", "read_business_truth", "read_representations"), text("Two of three surfaces were checked.")], seen),
      dispatch: () => Effect.succeed(read) }))
    expect(answer.toolCalls.map(t => t.summary)).toEqual([read.summary, read.summary, "Not run: tool budget for this request used up"])
    expect(seen[1]).toContain('"error":"BUDGET_EXHAUSTED"')
    expect(seen[1]).toContain("Do not call more tools")
    expect(answer).toMatchObject({ outcome: "ANSWERED_WITH_GAPS", gaps: ["Budget used up before every check could run"] })
    // A model that keeps calling tools after the final notice cannot end the run with an answer.
    const looping = await Effect.runPromise(Effect.either(runConversation({ message: "loop", history: [], budget: { modelSteps: 3, toolCalls: 9 },
      model: () => Effect.succeed(calls("read_open_issues")), dispatch: () => Effect.succeed(read) })))
    expect(looping).toMatchObject({ _tag: "Left", left: { reason: "TOOL_LIMIT" } })
  })

  it("verifies workflow completion: one reminder for a skipped required tool, then an honest gap", async () => {
    const completion = { requiredTools: ["diagnose_marketing_problems"] }
    const seen: string[] = []
    const fixed = await Effect.runPromise(runConversation({ message: "/setup analyze", history: [], completion,
      model: scripted([text("Your homepage looks fine."), calls("diagnose_marketing_problems"), text("The diagnosis found one problem.")], seen),
      dispatch: () => Effect.succeed(read) }))
    expect(seen[1]).toContain("OpenRecord runtime check: this workflow requires diagnose_marketing_problems")
    expect(fixed).toMatchObject({ reply: "The diagnosis found one problem.", outcome: "ANSWERED", gaps: [] })
    const { events, journal } = memoryJournal()
    const gap = await Effect.runPromise(runConversation({ message: "/setup analyze", history: [], completion, journal,
      model: scripted([text("Looks fine."), text("I could not run the diagnosis.")]), dispatch: () => Effect.succeed(read) }))
    expect(gap).toMatchObject({ reply: "I could not run the diagnosis.", outcome: "ANSWERED_WITH_GAPS", gaps: ["Required step not run: diagnosing marketing problems"] })
    expect(events.filter(e => e.type === "VERIFICATION").map(e => e.payload["passed"])).toEqual([false, false])
  })

  it("compacts older tool results within a run instead of failing on context size", async () => {
    const big: AgentToolResult = { summary: "Large read", citations: [{ kind: "issue", id: "issue-big", text: "Big" }], data: "x".repeat(15000) }
    const seen: string[] = []
    const answer = await Effect.runPromise(runConversation({ message: "Read a lot", history: [],
      model: scripted([calls("read_record_outcomes"), calls("read_record_outcomes"), calls("read_record_outcomes"), calls("read_record_outcomes"), calls("read_record_outcomes"), text("Summary of five reads.")], seen),
      dispatch: () => Effect.succeed(big) }))
    expect(answer.reply).toBe("Summary of five reads.")
    expect(seen.at(-1)).toContain('"compactedEvidence"')
    expect(seen.every(s => s.length <= 64000)).toBe(true)
  })
})

describe("agent context builder", () => {
  const history = (pairs: number): ContextMessage[] => Array.from({ length: pairs }, (_, i) => [
    { role: "user" as const, text: `Question ${i}: ${"detail ".repeat(60)}` },
    { role: "agent" as const, text: `Answer ${i}: ${"finding ".repeat(80)}`, toolCalls: [{ tool: "read_open_issues", summary: `${i} open issues read` }],
      citations: [{ kind: "issue", id: `issue-${i}`, text: `Issue ${i}` }] },
  ]).flat()

  it("keeps recent turns verbatim and compacts older ones with their requests, tool work and evidence references", () => {
    const built = buildContext(history(40), "Continue the plan from the first answer", { historyChars: 24000, verbatimMessages: 8 })
    expect(built.verbatimMessages).toBe(8)
    expect(built.compactedMessages + built.omittedMessages).toBe(72)
    const memory = (built.contents[0]!.parts[0] as { text: string }).text
    expect(memory).toContain("Earlier in this conversation, compacted by OpenRecord")
    // Pair 35 is the newest turn outside the eight-message verbatim window.
    expect(memory).toContain("User asked: Question 35:")
    expect(memory).toContain("issue issue-35")
    expect(memory).toContain("[tool work: 35 open issues read]")
    expect((built.contents[0]!.parts[1] as { text: string }).text).toContain("Question 36:")
    expect(built.chars).toBeLessThanOrEqual(24000 + 2000)
    expect(built.contents.at(-1)).toEqual({ role: "user", parts: [{ text: "Continue the plan from the first answer" }] })
  })

  it("states how many old messages no longer fit and sends short histories unchanged", () => {
    const built = buildContext(history(80), "Next", { historyChars: 12000, verbatimMessages: 4 })
    expect(built.omittedMessages).toBeGreaterThan(0)
    expect((built.contents[0]!.parts[0] as { text: string }).text).toContain(`(${built.omittedMessages} older messages are not shown)`)
    const short = buildContext(history(2), "Next")
    expect(short).toMatchObject({ verbatimMessages: 4, compactedMessages: 0, omittedMessages: 0 })
    expect(JSON.stringify(short.contents)).toContain("Stored evidence references")
  })

  it("never compacts the newest tool round", () => {
    const round = (n: number) => ({ role: "user" as const, parts: [{ functionResponse: { name: "read", response: { untrustedEvidence: { summary: `round ${n}`, citations: [], data: "y".repeat(5000) } } } }] })
    const contents = [{ role: "user" as const, parts: [{ text: "go" }] }, round(1), round(2), round(3)]
    expect(compactToolResults(contents, 8000)).toBe(true)
    expect(JSON.stringify(contents[3])).toContain("untrustedEvidence")
    expect(JSON.stringify(contents[1])).toContain("compactedEvidence")
  })
})

describe("tool registry and interruption notes", () => {
  it("registers every declared tool once, never with an approval or publication name, and labels progress", () => {
    const names = AGENT_TOOL_SPECS.map(s => s.declaration.name)
    expect(new Set(names).size).toBe(names.length)
    for (const d of agentDeclarations) expect(names).toContain(d.name)
    for (const spec of AGENT_TOOL_SPECS) {
      expect(spec.declaration.name).not.toMatch(MCP_PROHIBITED)
      expect(spec.declaration.name).not.toMatch(/approve|decide|execute|publish|record_action|start_batch/)
      expect(spec.replay).toBe(spec.effect === "read" ? "safe" : "deduplicated")
      if (spec.declaration.name.startsWith("propose_") || spec.declaration.name.startsWith("draft_") || spec.declaration.name === "prepare_client_report") expect(spec.effect).toBe("propose")
    }
    // The model no longer supplies retry identity for growth proposals.
    expect(JSON.stringify(agentDeclarations.find(d => d.name === "propose_growth_opportunity"))).not.toContain("idempotencyKey")
    expect(toolLabel("read_growth_goal")).toBe("Reading growth goal")
    expect(proposalReceipt(saved)).toEqual({ proposalId: "proposal-fixture", status: "PROPOSED", executed: false, questionId: "question-fixture" })
  })

  it("explains exactly what a stopped run saved, what was in flight and that nothing final was written", () => {
    const note = interruptionNote("FAILED", "TIMEOUT", [
      { type: "TOOL_STARTED", payload: { invocationId: "a", tool: "read_open_issues", effect: "read" } },
      { type: "TOOL_COMPLETED", payload: { invocationId: "a", tool: "read_open_issues", effect: "read", summary: "3 open issues read", citations: read.citations } },
      { type: "TOOL_STARTED", payload: { invocationId: "b", tool: "propose_check_run", effect: "propose" } },
      { type: "TOOL_COMPLETED", payload: { invocationId: "b", tool: "propose_check_run", effect: "propose", summary: "Re-check proposed; approval required", citations: saved.citations } },
      { type: "TOOL_STARTED", payload: { invocationId: "c", tool: "propose_growth_opportunity", effect: "propose" } },
    ])
    expect(note.text).toBe([
      "This request timed out before it finished.",
      "Saved for your review before stopping: Re-check proposed; approval required.",
      "A save was in progress (proposing growth opportunity) and may not have completed. Check open proposals before asking again.",
      "Evidence read: 3 open issues read.",
      "No final answer was written. Ask again to continue; saved proposals are reused, not duplicated.",
    ].join("\n"))
    expect(note.citations).toEqual([...read.citations, ...saved.citations])
    expect(note.worked).toBe(true)
    expect(interruptionNote("CANCELLED", "CANCELLED", []).worked).toBe(false)
  })

  it("turns proposal receipts into approval cards, and only real IDs", () => {
    const proposal = "6f1d3c1e-8a5b-4c2d-9e7f-0a1b2c3d4e5f", opportunity = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"
    expect(decisionRefs({ proposalId: proposal, status: "PROPOSED" })).toEqual([{ type: "AGENT_PROPOSAL", id: proposal }])
    expect(decisionRefs({ opportunityId: opportunity })).toEqual([{ type: "GROWTH_OPPORTUNITY", id: opportunity }])
    expect(decisionRefs({ proposalId: "proposal-fixture", questionId: proposal })).toEqual([])
    const many = Array.from({ length: 12 }, (_, i) => ({ type: "AGENT_PROPOSAL" as const, id: `${i}` }))
    expect(mergeDecisions([...many.slice(0, 2), ...many])).toHaveLength(10)
    const note = interruptionNote("CANCELLED", "CANCELLED", [
      { type: "TOOL_STARTED", payload: { invocationId: "a", tool: "propose_growth_opportunity", effect: "propose" } },
      { type: "TOOL_COMPLETED", payload: { invocationId: "a", tool: "propose_growth_opportunity", effect: "propose", summary: "Growth hypothesis saved for human review", receipt: { opportunityId: opportunity, status: "PROPOSED" } } },
    ])
    expect(note.decisions).toEqual([{ type: "GROWTH_OPPORTUNITY", id: opportunity }])
  })
})

describe("the model's reasoning (deterministic fixtures, no live model)", () => {
  const thinking = (thought: string, response: ModelResponse): ModelResponse => ({ ...response, candidates: [{ ...response.candidates[0]!,
    content: { role: "model", parts: [{ text: thought, thought: true }, ...response.candidates[0]!.content.parts] } }] })
  it("records each step's reasoning, returns a trace and never sends reasoning back to the model", async () => {
    const { events, journal } = memoryJournal()
    const seen: string[] = []
    const answer = await Effect.runPromise(runConversation({ message: "What is open?", history: [], journal,
      model: scripted([thinking("Start with the open issues.", calls("read_open_issues")), thinking("Three issues; answer now.", text("Three issues are open."))], seen),
      dispatch: () => Effect.succeed(read) }))
    expect(answer.reply).toBe("Three issues are open.")
    expect(events.filter(e => e.type === "MODEL_STEP").map(e => e.payload["thought"])).toEqual(["Start with the open issues.", "Three issues; answer now."])
    expect(answer.activity.map(a => [a.kind, a.text])).toEqual([["thought", "Start with the open issues."], ["tool", "3 open issues read"], ["thought", "Three issues; answer now."]])
    expect(answer.durationMs).toBeGreaterThanOrEqual(0)
    // The second request carries the first step's tool call, not its reasoning.
    expect(seen[1]).toContain("read_open_issues")
    expect(seen[1]).not.toContain("Start with the open issues.")
  })
  it("journals streamed reasoning at most twice a second, bounded per step", async () => {
    const { events, journal } = memoryJournal()
    const model: AgentModel = input => Effect.gen(function*() {
      for (const text of ["Look", "Looking at", "Looking at the issues", "Looking at the issues"]) yield* input.onThought!(text).pipe(Effect.ignore)
      return text("Done.")
    })
    await Effect.runPromise(runConversation({ message: "Hi", history: [], journal, model, dispatch: () => Effect.succeed(read) }))
    // The first snapshot is recorded at once; the rest arrive within the same half second.
    expect(events.filter(e => e.type === "MODEL_THINKING").map(e => e.payload["text"])).toEqual(["Look"])
  })
})
