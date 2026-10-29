import { describe, expect, it } from "vitest"
import { followupToolSpecs } from "./agent-followups.js"
import { FOLLOWUP_LIMITS } from "./agent-followup-policy.js"

describe("background investigation authority", () => {
  it("has a fixed read-only allowlist without proposals, execution or delegation", () => {
    const tools = followupToolSpecs()
    expect(tools.length).toBeGreaterThan(0)
    expect(tools.every(tool => tool.effect === "read")).toBe(true)
    const names = tools.map(tool => tool.declaration.name)
    expect(names).toContain("read_investigation")
    expect(names).toContain("read_proposals")
    for (const name of ["wait_for_investigation", "record_investigation_note", "delegate_task", "propose_growth_opportunity", "measure_web_performance", "read_web_page"]) expect(names).not.toContain(name)
  })
  it("caps daily wake-ups, model rounds and tool calls", () => {
    expect(FOLLOWUP_LIMITS).toMatchObject({ wakeUpsPer24Hours: 1, modelSteps: 3, toolCalls: 4, timeoutSeconds: 120, readOnly: true })
  })
})
