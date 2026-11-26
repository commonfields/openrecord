import { describe, expect, it } from "vitest"
import { approvedInitiativeMessage, declinedInitiativeMessage } from "./approved-initiative-messages.js"

describe("approved initiative prompts", () => {
  it("asks for finished work and measurement", () => {
    const m = approvedInitiativeMessage("Pricing guide", "Publish plan table on /pricing")
    expect(m).toContain('I approved "Pricing guide"')
    expect(m).toContain("Publish plan table on /pricing")
    expect(m).toContain("create_artifact")
  })

  it("feeds decline reasons into a revise turn", () => {
    const m = declinedInitiativeMessage("Pricing guide", "Too broad for now")
    expect(m).toContain("declined")
    expect(m).toContain("Too broad for now")
    expect(m).toContain("propose_growth_opportunity")
  })
})