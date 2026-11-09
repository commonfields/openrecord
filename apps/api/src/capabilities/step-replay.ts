import { isEnabled, type CapabilityManifest } from "./manifest.js"
import { makeRouter } from "./router.js"

/**
 * Offline replay of recorded agent turns, step by step. Each step routes on the person's message plus the
 * summaries of tools completed before that model request, which is what a live router would see.
 * The tools the agent then called are the labels. They are an upper bound on need, not ground truth.
 * Run data is supplied by the caller and never stored in the repository.
 */
export interface RecordedStep { readonly context: ReadonlyArray<string>; readonly tools: ReadonlyArray<string> }
export interface RecordedRun { readonly id: string; readonly startedAt: string; readonly text: string; readonly steps: ReadonlyArray<RecordedStep> }

export interface ReplayOptions {
  readonly k: number
  readonly core: ReadonlyArray<string>
  /** Keep every schema loaded earlier in the turn. */
  readonly sticky: boolean
  /**
   * "find": on a miss, simulate one find_capabilities call whose query is the missing capability's title, then load
   * the top 5 results. Optimistic: a real model writes its own query.
   */
  readonly fallback: "none" | "find"
  /** Ignore eval-case gating, to separate gating misses from ranking misses. */
  readonly ignoreGating: boolean
  /** How many of the latest tool summaries form the step context. */
  readonly contextWindow: number
}

/** Capabilities used in at least minShare of the given runs, most used first. */
export const coreFromUsage = (runs: ReadonlyArray<RecordedRun>, known: ReadonlySet<string>, minShare: number) => {
  const counts = new Map<string, number>()
  for (const run of runs) for (const tool of new Set(run.steps.flatMap(s => s.tools))) if (known.has(tool)) counts.set(tool, (counts.get(tool) ?? 0) + 1)
  return [...counts].filter(([, n]) => n / runs.length >= minShare).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([id]) => id)
}

const schemaBytes = (manifests: ReadonlyMap<string, CapabilityManifest>, ids: Iterable<string>) => {
  let total = 0
  for (const id of ids) total += Buffer.byteLength(JSON.stringify({ name: id, description: manifests.get(id)?.whenToUse, parameters: manifests.get(id)?.inputSchema }), "utf8")
  return total
}

export const stepReplayReport = (manifests: ReadonlyArray<CapabilityManifest>, runs: ReadonlyArray<RecordedRun>, o: ReplayOptions) => {
  const used = o.ignoreGating ? manifests.map(m => isEnabled(m) ? m : { ...m, evalCases: [{ id: "ungated", task: "ungated", expectSelected: true }] }) : manifests
  const route = makeRouter(used)
  const byId = new Map(used.map(m => [m.id, m]))
  let calls = 0, direct = 0, recovered = 0, extraSteps = 0, steps = 0, bytes = 0, fullRuns = 0
  const missedBy = new Map<string, number>()
  for (const run of runs) {
    const loaded = new Set<string>()
    let runMissed = false
    for (const step of run.steps) {
      const r = route({ text: run.text, context: step.context.slice(-o.contextWindow).join("\n"), core: o.core, allowedSideEffects: ["none", "internal_write"], k: o.k })
      const now = new Set([...(o.sticky ? loaded : []), ...r.core, ...r.selected])
      let stepNeededFind = false
      for (const tool of step.tools) {
        if (!byId.has(tool)) continue
        calls++
        if (now.has(tool)) { direct++; continue }
        if (o.fallback === "find") {
          const found = route({ text: byId.get(tool)!.title, core: [], allowedSideEffects: ["none", "internal_write"], k: 5 }).selected
          for (const id of found) now.add(id)
          stepNeededFind = true
          if (found.includes(tool)) { recovered++; continue }
        }
        runMissed = true
        missedBy.set(tool, (missedBy.get(tool) ?? 0) + 1)
      }
      if (stepNeededFind) extraSteps++
      steps++
      bytes += schemaBytes(byId, now)
      for (const id of now) loaded.add(id)
    }
    if (!runMissed) fullRuns++
  }
  return {
    runs: runs.length, steps, calls,
    directRecall: direct / calls, recallWithFallback: (direct + recovered) / calls,
    runsFullyCovered: fullRuns, extraModelStepsPerRun: extraSteps / runs.length,
    meanSchemaBytesPerStep: Math.round(bytes / steps),
    topMisses: [...missedBy].sort((a, b) => b[1] - a[1]).slice(0, 8),
  }
}
