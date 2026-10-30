import { describe, expect, it } from "vitest"
import { buildContext } from "./agent-context.js"
import { formatResumeContext, RESUME_CONTEXT_LIMIT } from "./agent-resume.js"

describe("business resume context", () => {
  it("keeps saved context in user data, separate from the actual request", () => {
    const built = buildContext([], "Continue", undefined, "Untrusted business brief")
    expect(built.contents).toEqual([{ role: "user", parts: [{ text: "Untrusted business brief" }, { text: "Continue" }] }])
    expect(built.historyChars).toBe("Untrusted business brief".length)
  })

  it("reserves context budget instead of adding unbounded history", () => {
    const built = buildContext([{ role: "user", text: "a".repeat(500) }], "Continue", { historyChars: 100, verbatimMessages: 16 }, "b".repeat(100))
    expect(built.historyChars).toBeLessThanOrEqual(100)
    expect(built.contents.at(-1)?.parts.at(-1)).toEqual({ text: "Continue" })
  })

  it("drops whole lower-priority records and retains valid JSON", () => {
    const text = formatResumeContext({ goal: null, investigations: [{ id: "first", question: "a".repeat(5000) }, { id: "second", question: "b".repeat(5000) }], note: "" })
    expect(text.length).toBeLessThanOrEqual(RESUME_CONTEXT_LIMIT)
    const snapshot = JSON.parse(text.slice(text.indexOf("\n") + 1))
    expect(snapshot.investigations).toHaveLength(1)
    expect(snapshot.investigations[0].id).toBe("first")
    expect(snapshot.omittedInvestigations).toBe(1)
  })
})
