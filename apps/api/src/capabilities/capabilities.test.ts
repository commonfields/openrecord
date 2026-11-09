import { describe, expect, it } from "vitest"
import { AGENT_TOOL_SPECS } from "../agent-registry.js"
import { CAPABILITY_MANIFESTS, METADATA_NAMES } from "./catalog.js"
import { isEnabled } from "./manifest.js"
import { CORE_CAPABILITIES, makeRouter } from "./router.js"
import { ROUTING_CASES } from "./routing-cases.js"
import { routingReport } from "./routing-eval.js"

describe("capability manifests (M1.5, shadow only)", () => {
  it("describes every registered agent tool exactly once, with no stale metadata", () => {
    expect(CAPABILITY_MANIFESTS.map(m => m.id).sort()).toEqual(AGENT_TOOL_SPECS.map(s => s.declaration.name).sort())
    expect([...METADATA_NAMES].sort()).toEqual(AGENT_TOOL_SPECS.map(s => s.declaration.name).sort())
  })

  it("never labels an agent tool as an external or irreversible effect; proposals require approval", () => {
    for (const m of CAPABILITY_MANIFESTS) {
      expect(["none", "internal_write"]).toContain(m.sideEffect)
      const spec = AGENT_TOOL_SPECS.find(s => s.declaration.name === m.id)!
      expect(m.permission.requiresApproval).toBe(spec.effect === "propose")
      expect(m.idempotency).toBe(spec.replay === "safe" ? "safe_read" : "request_key")
    }
  })

  it("routing cases only name registered capabilities", () => {
    const ids = new Set(CAPABILITY_MANIFESTS.map(m => m.id))
    for (const c of ROUTING_CASES) for (const n of [...c.expect, ...(c.avoid ?? [])]) expect(ids.has(n), `${c.id}: ${n}`).toBe(true)
  })
})

describe("capability router (M1.5, shadow only)", () => {
  const route = makeRouter(CAPABILITY_MANIFESTS)

  it("is deterministic and always loads the core set", () => {
    const input = { text: "Prepare a WordPress change to the homepage title", allowedSideEffects: ["none", "internal_write"] as const }
    expect(route(input)).toEqual(route(input))
    expect(route(input).core).toEqual([...CORE_CAPABILITIES])
    expect(route({ ...input, text: "" }).selected).toEqual([])
  })

  it("denies by default: disallowed side effects, disabled, unavailable and workflow-only capabilities are never selected", () => {
    const readOnly = route({ text: "Create a campaign draft and save a note and prepare a WordPress change", allowedSideEffects: ["none"] })
    for (const id of [...readOnly.core, ...readOnly.selected]) expect(CAPABILITY_MANIFESTS.find(m => m.id === id)!.sideEffect).toBe("none")
    const disabled = CAPABILITY_MANIFESTS.filter(m => !isEnabled(m)).map(m => m.id)
    expect(disabled.length).toBeGreaterThan(0)
    const everything = route({ text: CAPABILITY_MANIFESTS.map(m => m.title).join(" "), allowedSideEffects: ["none", "internal_write"], k: 200 })
    for (const id of disabled) expect(everything.selected).not.toContain(id)
    expect(everything.selected).not.toContain("propose_first_improvement")
    const unavailable = route({ text: "Prepare a WordPress change", allowedSideEffects: ["none", "internal_write"], unavailable: new Set(["prepare_wordpress_change"]) })
    expect(unavailable.selected).not.toContain("prepare_wordpress_change")
    expect(unavailable.filtered).toContainEqual({ id: "prepare_wordpress_change", reason: "unavailable" })
  })

  it("smoke check on authored, in-distribution cases (not evidence of real-turn quality)", () => {
    const declarations = AGENT_TOOL_SPECS.filter(s => s.scope === "general").map(s => s.declaration)
    const report = routingReport(CAPABILITY_MANIFESTS, declarations, ROUTING_CASES)
    expect(report.recall).toBeGreaterThanOrEqual(0.95)
    expect(report.meanRoutedBytes).toBeLessThan(report.meanBaselineBytes / 2)
  })
})
