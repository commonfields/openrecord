import { commandTools } from "../agent-execution-policy.js"
import type { ToolDeclaration } from "../agent-registry.js"
import type { CapabilityManifest } from "./manifest.js"
import { makeRouter, type RouteInput } from "./router.js"
import type { RoutingCaseDef } from "./routing-cases.js"

const bytes = (decls: ReadonlyArray<unknown>) => Buffer.byteLength(JSON.stringify(decls), "utf8")

/** Offline shadow comparison: router selection against today's declared tool set, per routing case. */
export const routingReport = (manifests: ReadonlyArray<CapabilityManifest>, declarations: ReadonlyArray<ToolDeclaration>, cases: ReadonlyArray<RoutingCaseDef>,
  options: Omit<RouteInput, "text"> = { allowedSideEffects: ["none", "internal_write"] }) => {
  const route = makeRouter(manifests)
  const byName = new Map(declarations.map(d => [d.name, d]))
  const rows = cases.map(c => {
    const r = route({ ...options, text: c.task })
    const loaded = new Set([...r.core, ...r.selected])
    const baseline = commandTools(c.task, declarations)
    return {
      id: c.id,
      hits: c.expect.filter(e => loaded.has(e)).length, expected: c.expect.length,
      missed: c.expect.filter(e => !loaded.has(e)),
      avoidViolations: (c.avoid ?? []).filter(a => loaded.has(a)),
      routedTools: loaded.size, routedBytes: bytes([...loaded].map(n => byName.get(n)).filter(Boolean)),
      baselineTools: baseline.length, baselineBytes: bytes(baseline),
      baselineHits: c.expect.filter(e => baseline.some(d => d.name === e)).length,
    }
  })
  const sum = (f: (r: typeof rows[number]) => number) => rows.reduce((s, r) => s + f(r), 0)
  return {
    cases: rows.length,
    recall: sum(r => r.hits) / sum(r => r.expected),
    baselineRecall: sum(r => r.baselineHits) / sum(r => r.expected),
    avoidViolations: sum(r => r.avoidViolations.length),
    meanRoutedBytes: Math.round(sum(r => r.routedBytes) / rows.length),
    meanBaselineBytes: Math.round(sum(r => r.baselineBytes) / rows.length),
    misses: rows.filter(r => r.missed.length).map(r => ({ id: r.id, missed: r.missed })),
    rows,
  }
}
