import { describe, expect, it } from "vitest"
import { MCP_PROHIBITED, MCP_TOOLS, mcpCallAllowed, type McpGrant } from "./mcp.js"

const grant = (overrides: Partial<McpGrant> = {}): McpGrant => ({
  grantId: "g", accountId: "a", userId: "u", businessId: "b", permissions: ["business:read", "work:read"], runtime: "codex",
  expiresAt: "2026-12-01T00:00:00.000Z", revokedAt: null, ...overrides,
})
const now = new Date("2026-10-25T00:00:00.000Z")

describe("MCP tool contract", () => {
  it("exposes no prohibited capability by name", () => {
    for (const tool of MCP_TOOLS) expect(tool.name, tool.name).not.toMatch(MCP_PROHIBITED)
  })

  it("only reads or proposes, and only proposing tools need the propose permission", () => {
    expect(new Set(MCP_TOOLS.map(t => t.effect))).toEqual(new Set(["read", "propose"]))
    for (const tool of MCP_TOOLS) expect(tool.effect === "propose", tool.name).toBe(tool.permission === "work:propose")
  })

  it("has unique names and names the existing service each tool must delegate to", () => {
    expect(new Set(MCP_TOOLS.map(t => t.name)).size).toBe(MCP_TOOLS.length)
    for (const tool of MCP_TOOLS) expect(tool.backedBy.length, tool.name).toBeGreaterThan(0)
  })

  it("allows a call only under a live, unrevoked grant carrying the tool's permission", () => {
    const read = MCP_TOOLS.find(t => t.name === "list_work")!
    const propose = MCP_TOOLS.find(t => t.name === "propose_initiative")!
    expect(mcpCallAllowed(grant(), read, now)).toBe(true)
    expect(mcpCallAllowed(grant(), propose, now)).toBe(false)
    expect(mcpCallAllowed(grant({ revokedAt: "2026-10-24T00:00:00.000Z" }), read, now)).toBe(false)
    expect(mcpCallAllowed(grant({ expiresAt: "2026-10-24T00:00:00.000Z" }), read, now)).toBe(false)
  })
})
