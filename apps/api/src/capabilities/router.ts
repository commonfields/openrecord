import { tokens } from "../research/catalog.js"
import { isEnabled, type CapabilityManifest, type SideEffect } from "./manifest.js"

export const ROUTER_VERSION = "keyword-v1"
/** Loaded every step: orientation reads that most turns need. */
export const CORE_CAPABILITIES = ["read_business_truth", "read_growth_goal", "read_objective_investigations", "read_proposals", "read_decision_feedback"] as const
export const DEFAULT_K = 10

export interface RouteInput {
  readonly text: string
  /** Side effects permitted for this turn. Deny by default: anything not listed is filtered out. */
  readonly allowedSideEffects: ReadonlyArray<SideEffect>
  /** Capabilities unavailable for this business now (no connection, no credit), by id. */
  readonly unavailable?: ReadonlySet<string>
  readonly workflow?: boolean
  readonly k?: number
}
export interface RouteResult {
  readonly routerVersion: string
  readonly core: ReadonlyArray<string>
  readonly selected: ReadonlyArray<string>
  /** Ranked candidates that passed the filter, with scores, for tracing. */
  readonly candidates: ReadonlyArray<{ readonly id: string; readonly score: number }>
  readonly filtered: ReadonlyArray<{ readonly id: string; readonly reason: "disabled" | "side_effect" | "unavailable" | "workflow_only" }>
}

interface Indexed { readonly m: CapabilityManifest; readonly id: ReadonlyArray<string>; readonly title: ReadonlyArray<string>; readonly text: ReadonlyArray<string> }
const index = (manifests: ReadonlyArray<CapabilityManifest>): ReadonlyArray<Indexed> =>
  manifests.map(m => ({ m, id: tokens(m.id.replaceAll("_", " ")), title: tokens(m.title), text: tokens(`${m.whenToUse} ${m.namespace}`) }))

/**
 * Deterministic per-step selection: hard filter (fail closed), then keyword rank, then stable tie-break by id.
 * Ranking reads only manifest text, never eval case text. Selection grants nothing; execution re-checks authority.
 */
export const makeRouter = (manifests: ReadonlyArray<CapabilityManifest>) => {
  const indexed = index(manifests)
  const known = new Set(manifests.map(m => m.id))
  return (input: RouteInput): RouteResult => {
    const allowed = new Set(input.allowedSideEffects)
    const filtered: Array<RouteResult["filtered"][number]> = []
    const pass = indexed.filter(({ m }) => {
      const reason = !isEnabled(m) ? "disabled" : m.workflowOnly && !input.workflow ? "workflow_only"
        : !allowed.has(m.sideEffect) ? "side_effect" : input.unavailable?.has(m.id) ? "unavailable" : null
      if (reason) filtered.push({ id: m.id, reason })
      return reason === null
    })
    const core = CORE_CAPABILITIES.filter(id => known.has(id) && pass.some(x => x.m.id === id))
    const words = tokens(input.text)
    const scored = pass.filter(x => !core.includes(x.m.id as typeof CORE_CAPABILITIES[number])).map(x => {
      const score = words.reduce((s, t) => s + (x.id.includes(t) ? 4 : 0) + (x.title.includes(t) ? 3 : 0) + (x.text.includes(t) ? 1 : 0), 0)
      return { id: x.m.id, score }
    }).filter(c => c.score > 0).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    return { routerVersion: ROUTER_VERSION, core, selected: scored.slice(0, input.k ?? DEFAULT_K).map(c => c.id), candidates: scored, filtered }
  }
}
