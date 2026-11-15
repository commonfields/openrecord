import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { runConversation } from "./agent.js"
import type { AgentModel, ModelResponse } from "./agent-model.js"
import { memoryJournal } from "./agent-run.js"
import type { AgentToolResult } from "./agent-tools.js"
import { leaveBlank } from "./agent-blanks.js"

const text = (value: string): ModelResponse => ({ candidates: [{ content: { role: "model", parts: [{ text: value }] }, finishReason: "STOP" }] })
const calls = (...names: string[]): ModelResponse => ({ candidates: [{ content: { role: "model", parts: names.map(name => ({ functionCall: { name, args: {} } })) }, finishReason: "STOP" }] })
const read: AgentToolResult = { summary: "3 open issues read", citations: [], data: { totalOpen: 3 } }

describe("notes the person sends while a run works (steering)", () => {
  it("hands a note to the next model step as the person's instruction, once, and returns it with the reply", async () => {
    const { events, journal, pending } = memoryJournal()
    const seen: string[] = []
    const responses = [calls("read_open_issues"), calls("read_open_issues"), text("Done, and only for the pricing page as you asked.")]
    const model: AgentModel = input => {
      seen.push(JSON.stringify(input.contents))
      return Effect.succeed(responses.shift() ?? text("done"))
    }
    // The person writes while the first tool runs.
    const dispatch = () => Effect.sync(() => {
      if (seen.length === 1) pending.push({ id: "note-1", text: "Only the pricing page, please" })
      return read
    })
    const answer = await Effect.runPromise(runConversation({ message: "Check the open issues", history: [], journal, model, dispatch }))
    expect(seen[1]).toContain("Only the pricing page, please")
    expect(seen[1]).toContain("latest instruction")
    // Taken once: the step after does not see it handed over again.
    expect(seen[2]!.split("Only the pricing page, please").length - 1).toBe(1)
    expect(answer.notes).toEqual(["Only the pricing page, please"])
    expect(events.find(e => e.type === "VERIFICATION" && e.payload["action"] === "NOTES_READ")?.payload).toMatchObject({ noteIds: ["note-1"] })
  })

  it("leaves a run with no notes exactly as it was", async () => {
    const { events, journal } = memoryJournal()
    const answer = await Effect.runPromise(runConversation({ message: "Check the open issues", history: [], journal,
      model: (() => { const r = [calls("read_open_issues"), text("Three are open.")]; return () => Effect.succeed(r.shift() ?? text("done")) })(),
      dispatch: () => Effect.succeed(read) }))
    expect(answer.notes).toBeUndefined()
    expect(events.some(e => e.payload["action"] === "NOTES_READ")).toBe(false)
  })

  it("shows a blank at once, carries on with the assumption, and keeps it on the reply", async () => {
    const { events, journal } = memoryJournal()
    const ask: ModelResponse = { candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "leave_blank", args: { question: "Say no credit card is needed?", options: ["Yes", "No"], assumed: "No" } } }] }, finishReason: "STOP" }] }
    const responses = [ask, text("The page is drafted. I assumed you do not want to promise no credit card.")]
    const answer = await Effect.runPromise(runConversation({ message: "Draft the landing page", history: [], journal,
      model: () => Effect.succeed(responses.shift() ?? text("done")),
      dispatch: (_name, args) => leaveBlank(args) }))
    const done = events.find(e => e.type === "TOOL_COMPLETED" && e.payload["tool"] === "leave_blank")
    expect(done?.payload["blank"]).toMatchObject({ question: "Say no credit card is needed?", options: ["Yes", "No"], assumed: "No" })
    expect(answer.blanks?.[0]).toMatchObject({ question: "Say no credit card is needed?", assumed: "No" })
  })

  it("refuses a blank without an assumption, so the work never waits on one", async () => {
    await expect(Effect.runPromise(leaveBlank({ question: "Which audience?", options: ["Agencies"] }))).rejects.toBeDefined()
  })
})
