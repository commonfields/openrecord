// Agent tool harness: registry, lookup, and input validation.
// Pure unit tests (no database): lookup and decode run before any
// repository, so no layers are provided here.
import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { AGENT_TOOLS, decodeAgentInput, findAgentTool } from "./agent-tools.js"

const lookup = (tool: string) => Effect.runPromise(Effect.either(findAgentTool(tool)))
const decode = (tool: string, input: unknown) =>
  Effect.runPromise(
    Effect.either(Effect.flatMap(findAgentTool(tool), (def) => decodeAgentInput(def, input))),
  )

describe("agent tool harness", () => {
  it("registers exactly the read-only toolset", () => {
    expect(AGENT_TOOLS.map((t) => t.name).sort()).toEqual([
      "audit_website",
      "compare_acquisition_batches",
      "discover_buyer_questions",
      "map_website",
      "read_acquisition_citations",
      "read_acquisition_overview",
      "read_ad_performance",
      "read_ai_referral_evidence",
      "read_business_truth",
      "read_buyer_question_results",
      "read_competitor_appearances",
      "read_discovery_scopes",
      "read_growth_goal",
      "read_growth_opportunities",
      "read_issue",
      "read_observation",
      "read_open_issues",
      "read_proposals",
      "read_record_outcomes",
      "read_representations",
      "read_results",
      "read_search_performance",
      "read_web_page",
      "read_web_pages",
      "search_web",
    ])
    for (const tool of AGENT_TOOLS) {
      expect(tool.name).toMatch(/^[a-z_]+$/)
      expect(tool.description.length).toBeGreaterThan(0)
    }
  })

  it("rejects unknown tools before touching any decoder or repository", async () => {
    for (const tool of ["record_intervention", "run_ai_answer_checks", "drop_tables", ""]) {
      const result = await lookup(tool)
      expect(result._tag).toBe("Left")
      if (result._tag === "Left") expect(result.left._tag).toBe("AgentUnknownTool")
    }
  })

  it("rejects excess properties and out-of-range inputs", async () => {
    // Excess properties fail closed (mirrors the provider registry rule).
    for (const input of [{ limit: 5, seed: 1 }, { limit: 5, systemPrompt: "x" }]) {
      const result = await decode("read_business_truth", input)
      expect(result._tag).toBe("Left")
      if (result._tag === "Left") expect(result.left._tag).toBe("AgentInvalidInput")
    }
    for (const input of [{ limit: 0 }, { limit: 21 }, { limit: 2.5 }, { limit: "5" }]) {
      const result = await decode("read_business_truth", input)
      expect(result._tag).toBe("Left")
      if (result._tag === "Left") expect(result.left._tag).toBe("AgentInvalidInput")
    }
    const badId = await decode("read_observation", { observationId: "not-a-uuid" })
    expect(badId._tag).toBe("Left")
    if (badId._tag === "Left") expect(badId.left._tag).toBe("AgentInvalidInput")
  })

  it("accepts empty input where every field is optional", async () => {
    for (const tool of ["read_business_truth", "read_record_outcomes"]) {
      const result = await decode(tool, {})
      expect(result._tag).toBe("Right")
    }
  })
})
