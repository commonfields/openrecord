// A scorecard built from recorded runs: what the agent actually did for real
// requests, read from the run journal. The scripted scenarios ask whether a
// model can answer a fixed question well; this asks how the whole loop behaves
// in use, so a change to the instructions, tool cards or limits can be judged
// against what happened before it.
//
// Only counts and identifiers are read. A request's text, the evidence and the
// answer are never part of a scorecard, so one can be kept or compared without
// holding anyone's data.

export interface JournalEvent { readonly type: string; readonly payload: Record<string, unknown> }
export interface RecordedRun {
  readonly id: string
  readonly status: string
  readonly outcome: string | null
  readonly failureReason: string | null
  readonly business: boolean
  readonly durationMs: number | null
  readonly events: ReadonlyArray<JournalEvent>
}

export interface Scorecard {
  readonly runs: number
  /** Share of runs that ended with an answer, and with an answer that named no gap. */
  readonly answered: number
  readonly clean: number
  readonly statuses: Readonly<Record<string, number>>
  readonly failureReasons: Readonly<Record<string, number>>
  readonly gaps: ReadonlyArray<{ readonly gap: string; readonly runs: number }>
  readonly steps: { readonly p50: number; readonly p90: number }
  readonly toolCalls: { readonly p50: number; readonly p90: number }
  readonly durationMs: { readonly p50: number; readonly p90: number }
  /** Business runs answered without a single tool call: an answer from nothing read. */
  readonly answeredWithoutTools: number
  readonly tools: ReadonlyArray<{ readonly tool: string; readonly calls: number; readonly failed: number; readonly invalidInput: number }>
  readonly toolFailureRate: number
  /** Failed calls the model got wrong itself: a card that did not say enough to call its tool. */
  readonly invalidInputRate: number
  readonly perRun: { readonly toolDetails: number; readonly compactions: number; readonly narrowed: number; readonly paced: number; readonly budgetExhausted: number; readonly recovered: number; readonly partial: number }
  readonly tokens: { readonly prompt: number; readonly cached: number; readonly output: number; readonly thought: number; readonly cachedShare: number | null }
}

const quantile = (values: ReadonlyArray<number>, q: number) => {
  if (!values.length) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]!
}
const spread = (values: ReadonlyArray<number>) => ({ p50: quantile(values, 0.5), p90: quantile(values, 0.9) })
const share = (part: number, whole: number) => whole ? Math.round(part / whole * 1000) / 1000 : 0
const num = (v: unknown) => typeof v === "number" && Number.isFinite(v) ? v : 0
const tally = (keys: ReadonlyArray<string>) => keys.reduce<Record<string, number>>((all, k) => ({ ...all, [k]: (all[k] ?? 0) + 1 }), {})

export const scoreRuns = (runs: ReadonlyArray<RecordedRun>): Scorecard => {
  const of = (run: RecordedRun, type: string) => run.events.filter(e => e.type === type)
  const actions = (run: RecordedRun, action: string) => of(run, "VERIFICATION").filter(e => e.payload["action"] === action).length
  const completed = runs.filter(r => r.status === "COMPLETED")
  const tools = new Map<string, { calls: number; failed: number; invalidInput: number }>()
  let prompt = 0, cached = 0, output = 0, thought = 0, cachedKnown = false
  for (const run of runs) {
    for (const e of run.events) {
      if (e.type === "TOOL_COMPLETED" || e.type === "TOOL_FAILED") {
        const name = String(e.payload["tool"] ?? "")
        // A refused call past the budget never ran, so it says nothing about the tool.
        if (!name || e.payload["code"] === "BUDGET_EXHAUSTED") continue
        const row = tools.get(name) ?? { calls: 0, failed: 0, invalidInput: 0 }
        row.calls++
        if (e.type === "TOOL_FAILED") { row.failed++; if (e.payload["code"] === "INVALID_INPUT") row.invalidInput++ }
        tools.set(name, row)
      }
      if (e.type === "MODEL_STEP") {
        const usage = (e.payload["usage"] ?? {}) as Record<string, unknown>
        prompt += num(usage["promptTokens"]); output += num(usage["outputTokens"]); thought += num(usage["thoughtTokens"])
        if (typeof usage["cachedTokens"] === "number") { cached += usage["cachedTokens"]; cachedKnown = true }
      }
    }
  }
  const toolRows = [...tools].map(([tool, row]) => ({ tool, ...row })).sort((a, b) => b.failed - a.failed || b.calls - a.calls || a.tool.localeCompare(b.tool))
  const calls = toolRows.reduce((n, r) => n + r.calls, 0), failed = toolRows.reduce((n, r) => n + r.failed, 0)
  const gapCounts = tally(completed.flatMap(r => [...new Set(of(r, "RUN_FINISHED").flatMap(e => (e.payload["gaps"] as ReadonlyArray<string> | undefined) ?? []))]))
  const per = (count: (run: RecordedRun) => number) => share(runs.reduce((n, r) => n + count(r), 0), runs.length)
  const businessAnswers = completed.filter(r => r.business)
  return {
    runs: runs.length,
    answered: share(completed.length, runs.length),
    clean: share(completed.filter(r => r.outcome === "ANSWERED").length, runs.length),
    statuses: tally(runs.map(r => r.status)),
    failureReasons: tally(runs.flatMap(r => r.status !== "COMPLETED" && r.failureReason ? [r.failureReason] : [])),
    gaps: Object.entries(gapCounts).map(([gap, n]) => ({ gap, runs: n })).sort((a, b) => b.runs - a.runs || a.gap.localeCompare(b.gap)),
    steps: spread(runs.map(r => of(r, "MODEL_STEP").length)),
    toolCalls: spread(runs.map(r => of(r, "TOOL_STARTED").length)),
    durationMs: spread(runs.flatMap(r => r.durationMs === null ? [] : [r.durationMs])),
    answeredWithoutTools: share(businessAnswers.filter(r => !of(r, "TOOL_STARTED").length).length, businessAnswers.length),
    tools: toolRows,
    toolFailureRate: share(failed, calls),
    invalidInputRate: share(toolRows.reduce((n, r) => n + r.invalidInput, 0), calls),
    perRun: {
      toolDetails: per(r => actions(r, "TOOLS_EXPANDED")), compactions: per(r => actions(r, "CONTEXT_COMPACTED")),
      narrowed: per(r => of(r, "MODEL_REQUESTED").filter(e => num(e.payload["toolsNarrowed"]) > 0).length), paced: per(r => actions(r, "PACED")),
      budgetExhausted: per(r => of(r, "TOOL_FAILED").filter(e => e.payload["code"] === "BUDGET_EXHAUSTED").length ? 1 : 0),
      recovered: per(r => actions(r, "ANSWER_RECOVERED")), partial: per(r => actions(r, "PARTIAL_FINDINGS_RETURNED")),
    },
    tokens: { prompt, cached, output, thought, cachedShare: cachedKnown && prompt ? share(cached, prompt) : null },
  }
}

export interface Gate { readonly label: string; readonly passed: boolean; readonly value: number; readonly limit: number }
/** Limits a scorecard must hold, each given as a share from 0 to 1. Absent limits are not checked. */
export const gate = (card: Scorecard, limits: { readonly minAnswered?: number | undefined; readonly minClean?: number | undefined; readonly maxToolFailure?: number | undefined; readonly maxInvalidInput?: number | undefined; readonly maxAnsweredWithoutTools?: number | undefined }): ReadonlyArray<Gate> => [
  ...(limits.minAnswered === undefined ? [] : [{ label: "answered", passed: card.answered >= limits.minAnswered, value: card.answered, limit: limits.minAnswered }]),
  ...(limits.minClean === undefined ? [] : [{ label: "answered with no gap", passed: card.clean >= limits.minClean, value: card.clean, limit: limits.minClean }]),
  ...(limits.maxToolFailure === undefined ? [] : [{ label: "tool calls that failed", passed: card.toolFailureRate <= limits.maxToolFailure, value: card.toolFailureRate, limit: limits.maxToolFailure }]),
  ...(limits.maxInvalidInput === undefined ? [] : [{ label: "tool calls with invalid input", passed: card.invalidInputRate <= limits.maxInvalidInput, value: card.invalidInputRate, limit: limits.maxInvalidInput }]),
  ...(limits.maxAnsweredWithoutTools === undefined ? [] : [{ label: "business answers with nothing read", passed: card.answeredWithoutTools <= limits.maxAnsweredWithoutTools, value: card.answeredWithoutTools, limit: limits.maxAnsweredWithoutTools }]),
]

const pct = (v: number) => `${(v * 100).toFixed(1)}%`
/** The measures a change is judged on, with the change against an earlier scorecard when one is given. */
export const compare = (now: Scorecard, before?: Scorecard): ReadonlyArray<{ readonly measure: string; readonly now: string; readonly before: string | null; readonly better: boolean | null }> => {
  const row = (measure: string, pick: (c: Scorecard) => number, show: (v: number) => string, higherIsBetter: boolean) => {
    const a = pick(now), b = before ? pick(before) : null
    return { measure, now: show(a), before: b === null ? null : show(b), better: b === null || a === b ? null : (a > b) === higherIsBetter }
  }
  const count = (v: number) => String(Math.round(v * 100) / 100)
  return [
    row("answered", c => c.answered, pct, true), row("answered with no gap", c => c.clean, pct, true),
    row("business answers with nothing read", c => c.answeredWithoutTools, pct, false),
    row("tool calls that failed", c => c.toolFailureRate, pct, false), row("tool calls with invalid input", c => c.invalidInputRate, pct, false),
    row("model steps, median", c => c.steps.p50, count, false), row("model steps, 90th percentile", c => c.steps.p90, count, false),
    row("seconds, median", c => c.durationMs.p50 / 1000, count, false), row("seconds, 90th percentile", c => c.durationMs.p90 / 1000, count, false),
    row("tool_details calls per run", c => c.perRun.toolDetails, count, false), row("context shortened per run", c => c.perRun.compactions, count, false),
    row("runs that used their whole budget", c => c.perRun.budgetExhausted, pct, false), row("answers recovered after a provider failure", c => c.perRun.recovered, pct, false),
    row("prompt tokens read from cache", c => c.tokens.cachedShare ?? 0, pct, true),
  ]
}
