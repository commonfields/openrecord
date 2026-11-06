// The scenario checks themselves: each scenario's good answer passes and its bad answer fails,
// so a live run measures the model, not a broken grader.
import { describe, expect, it } from "vitest"
import { SCENARIOS, MARKETING_DRAFT_SCENARIO, grade } from "./scenarios.js"

describe("agent quality scenarios", () => {
  it.each(SCENARIOS.map(s => [s.id, s] as const))("%s: the good answer passes and the bad one fails", (_id, s) => {
    expect(grade(s, s.examples.good.reply, s.examples.good.tools, s.examples.good.calls)).toMatchObject({ passed: true, failed: [] })
    const bad = grade(s, s.examples.bad.reply, s.examples.bad.tools, s.examples.bad.calls)
    expect(bad.passed).toBe(false)
    expect(bad.failed.length).toBeGreaterThan(0)
  })
  it("has unique ids and evidence for the tools it requires", () => {
    expect(new Set(SCENARIOS.map(s => s.id)).size).toBe(SCENARIOS.length)
    for (const s of SCENARIOS) expect(Object.keys(s.evidence).length).toBeGreaterThan(0)
  })
  it("distinguishes 'Nothing was published' from a positive publication claim", () => {
    const s = MARKETING_DRAFT_SCENARIO, good = s.examples.good
    expect(grade(s, "Prepared a preview, not saved to a business. Nothing was published, sent or spent.", good.tools, good.calls).passed).toBe(true)
    expect(grade(s, "Prepared a preview. I published the campaign.", good.tools, good.calls).passed).toBe(false)
  })
})
