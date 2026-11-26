import { describe, expect, it } from "vitest"
import { visibilityInvestigationMessage } from "./visibility-investigation-messages.js"

describe("visibility investigation prompts", () => {
  it("names the investigation and stays read-only", () => {
    const m = visibilityInvestigationMessage("00000000-0000-4000-8000-000000000099", "mentions fell ten points")
    expect(m).toContain("00000000-0000-4000-8000-000000000099")
    expect(m).toContain("mentions fell ten points")
    expect(m).toContain("read_investigation")
    expect(m).toContain("read-only")
  })
})