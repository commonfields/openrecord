import { describe, expect, it } from "vitest"
import { agentDeclarations } from "./agent.js"
import { commandTools, modelRequestBytes } from "./agent-execution-policy.js"

describe("complete model request budgeting and command-scoped capabilities", () => {
  it("counts system instructions, schemas and UTF-8 evidence bytes, not history alone", () => {
    const request = { system: "System", tools: [{ name: "read", schema: "x".repeat(5000) }], contents: [{ role: "user" as const, parts: [{ text: "你好" }] }] }
    expect(modelRequestBytes(request)).toBe(Buffer.byteLength(JSON.stringify(request), "utf8"))
    expect(modelRequestBytes(request)).toBeGreaterThan(JSON.stringify(request.contents).length + 5000)
  })
  it("narrows campaign execution to needed tools while retaining the real WordPress reader", () => {
    const tools = commandTools("/campaign-run Trial activation", agentDeclarations)
    const names = tools.map(t => t.name)
    expect(names).toContain("read_wordpress_content")
    expect(names).toContain("record_campaign_run")
    expect(names).toContain("prepare_wordpress_change")
    expect(names).not.toContain("record_campaign_draft")
    expect(names).not.toContain("research_company")
    expect(JSON.stringify(tools).length).toBeLessThan(JSON.stringify(agentDeclarations).length / 2)
  })
  it("keeps planning capabilities and leaves ambiguous conversation unchanged", () => {
    const names = commandTools("/campaign More demos", agentDeclarations).map(t => t.name)
    expect(names).toContain("record_campaign_draft")
    expect(names).toContain("record_campaign_revision")
    expect(names).toContain("research_company")
    expect(commandTools("Tell me more", agentDeclarations)).toBe(agentDeclarations)
  })
})
