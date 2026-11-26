import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { readSuggestion, suggestBrief } from "./campaign-brief-suggest.js"

describe("brief suggestions", () => {
  it("reads fenced JSON, bounds lines and drops what it cannot trust", () => {
    const s = readSuggestion('```json\n{"title":" Audit ","goal":"40 demos","reviewDate":"next month","launchDate":"2026-12-01","deliverables":[{"title":"Page","channel":"website"},{"title":"Post","channel":"tiktok"},{"title":""}],"extra":"x"}\n```')!
    expect(s.title).toBe("Audit")
    expect(s.reviewDate).toBe("")
    expect(s.launchDate).toBe("2026-12-01")
    expect(s.deliverables).toEqual([{ title: "Page", channel: "WEBSITE" }, { title: "Post", channel: "OTHER" }])
    expect(s.audience).toBe("")
    expect("extra" in s).toBe(false)
  })
  it("refuses a reply that is not an object, and a review before launch", () => {
    expect(readSuggestion("Sorry, I can't help.")).toBeNull()
    expect(readSuggestion("[1,2]")).toBeNull()
    expect(readSuggestion('{"launchDate":"2026-12-10","reviewDate":"2026-12-01"}')!.reviewDate).toBe("")
  })
  it("sends the description with today's date and no tools", async () => {
    let seen: unknown
    const model = (input: Parameters<Parameters<typeof suggestBrief>[0]>[0]) => {
      seen = input
      return Effect.succeed({ candidates: [{ finishReason: "STOP", content: { role: "model" as const, parts: [{ text: "thinking", thought: true }, { text: '{"title":"T"}' }] } }] })
    }
    const s = await Effect.runPromise(suggestBrief(model, "A campaign", "2026-11-26"))
    expect(s!.title).toBe("T")
    expect(JSON.stringify(seen)).toContain("Today is 2026-11-26")
    expect((seen as { tools: unknown[] }).tools).toEqual([])
  })
  it("asks once more when the first answer is not a brief", async () => {
    let calls = 0
    const model = () => {
      calls++
      return Effect.succeed({ candidates: [{ finishReason: "STOP", content: { role: "model" as const, parts: [{ text: calls === 1 ? "Here you go!" : '{"title":"Second"}' }] } }] })
    }
    expect((await Effect.runPromise(suggestBrief(model, "A campaign", "2026-11-26")))!.title).toBe("Second")
    expect(calls).toBe(2)
  })
})
