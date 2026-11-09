import { describe, expect, it } from "vitest"
import { AGENT_TOOL_SPECS } from "../agent-registry.js"
import { CAPABILITY_MANIFESTS, METADATA_NAMES } from "./catalog.js"
import { isEnabled } from "./manifest.js"
import { CORE_CAPABILITIES, makeRouter } from "./router.js"
import { ROUTING_CASES } from "./routing-cases.js"
import { routingReport } from "./routing-eval.js"
import { coreFromUsage, stepReplayReport } from "./step-replay.js"

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

describe("step replay evaluator (M1.5, offline)", () => {
  const run = (id: string, steps: Array<{ context?: string[]; tools: string[] }>) => ({ id, startedAt: "2026-11-01T00:00:00Z", text: "Prepare a WordPress change", steps: steps.map(s => ({ context: s.context ?? [], tools: s.tools })) })
  const runs = [
    run("a", [{ tools: ["read_growth_goal", "prepare_wordpress_change"] }, { context: ["read_reviews: 2 reviews"], tools: ["read_reviews"] }]),
    run("b", [{ tools: ["read_growth_goal", "retired_tool"] }]),
  ]
  const base = { k: 10, core: ["read_growth_goal"], sticky: false, fallback: "none", ignoreGating: false, contextWindow: 6 } as const

  it("counts recorded calls of known capabilities only and routes each step on its own context", () => {
    const r = stepReplayReport(CAPABILITY_MANIFESTS, runs, base)
    expect(r).toMatchObject({ runs: 2, steps: 3, calls: 4, directRecall: 1, runsFullyCovered: 2, extraModelStepsPerRun: 0 })
    const noContext = stepReplayReport(CAPABILITY_MANIFESTS, runs, { ...base, contextWindow: 0, k: 1 })
    expect(noContext.directRecall).toBe(0.75)
    expect(noContext.topMisses).toEqual([["read_reviews", 1]])
  })

  it("learns the core set from usage share, and the find fallback costs a model step", () => {
    expect(coreFromUsage(runs, new Set(CAPABILITY_MANIFESTS.map(m => m.id)), 1)).toEqual(["read_growth_goal"])
    const r = stepReplayReport(CAPABILITY_MANIFESTS, runs, { ...base, core: [], k: 0, fallback: "find" })
    expect(r.directRecall).toBe(0)
    expect(r.recallWithFallback).toBeGreaterThan(0)
    expect(r.extraModelStepsPerRun).toBeGreaterThan(0)
  })
})
