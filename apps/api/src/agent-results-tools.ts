// read_results: the results ledger. For each approved idea (initiative): what
// was done and when, the measurement declared before it, and how the metric
// moved between the baseline and observation windows, or why it can't be
// compared yet. Built on the growth evaluation, which only describes what was
// recorded; a before/after difference is never presented as proof of cause.
import { Effect, JSONSchema, Option, Schema } from "effect"
import { BusinessRepository, GrowthEvaluationRepository, GrowthRepository } from "@openrecord/db"
import type { GrowthOpportunity, GrowthOutcomeEvaluation } from "@openrecord/contracts"
import type { AgentToolDef, AgentToolResult } from "./agent-tools.js"
import { AgentNotInScope } from "./agent-tool-errors.js"

const scoped = (accountId: string, businessId: string) => Effect.gen(function*() {
  if (!(yield* (yield* BusinessRepository).getScoped(accountId, businessId))) return yield* Effect.fail(new AgentNotInScope())
})

const Input = Schema.Struct({ limit: Schema.optional(Schema.Int.pipe(Schema.between(1, 8))) })

const READING: Readonly<Record<string, string>> = {
  NO_MEASUREMENT_PLAN: "no measurement was declared for it",
  NO_RECORDED_EXECUTION: "nothing has been recorded as done yet",
  OBSERVATION_INCOMPLETE: "the observation window hasn't ended yet",
  PLAN_DECLARED_AFTER_EXECUTION: "the measurement was declared after the change, so it can't be read fairly",
  MISSING_DAYS: "some days have no data",
  UNAVAILABLE_DAYS: "some days are unavailable",
  CONFLICTING_DAYS: "some days have conflicting numbers",
  SYNTHETIC_DAYS: "some days are test data",
  CURRENCY_AGGREGATION_UNSUPPORTED: "money metrics can't be compared yet",
  METRIC_DEFINITION_MISMATCH: "the metric changed since the plan",
  INVALID_WINDOWS: "the windows are invalid",
  EXECUTION_TIMING_INCOMPATIBLE: "the change happened inside a measurement window",
  INITIATIVE_NOT_APPROVED: "it isn't approved",
}

/** One ledger line: done, measuring, measured or decided, in plain words. */
export const ledgerEntry = (o: GrowthOpportunity, e: GrowthOutcomeEvaluation | null) => {
  const reviewed = [...o.events].reverse().find(ev => ev.status === "REVIEWED")
  const approved = [...o.events].reverse().find(ev => ev.status === "APPROVED")
  const done = o.executions.length
  const stage = reviewed ? "DECIDED" : e?.status === "COMPARABLE" ? "MEASURED" : done && e?.plan ? "MEASURING" : done ? "DONE_NOT_MEASURED" : "APPROVED_NOT_DONE"
  const change = e?.comparison?.dailyMeanPercentChange ?? null
  return {
    id: o.id, title: o.title, stage, approvedAt: approved?.createdAt ?? null,
    proposedChange: o.proposedChange.slice(0, 300), expectedMechanism: o.expectedMechanism.slice(0, 300),
    actions: { count: done, last: o.executions.at(-1) ? { type: o.executions.at(-1)!.type, at: o.executions.at(-1)!.performedAt } : null },
    ...(e ? {
      metric: e.metric.label,
      plan: e.plan ? { baseline: `${e.plan.baselineStart} to ${e.plan.baselineEnd}`, observation: `${e.plan.observationStart} to ${e.plan.observationEnd}` } : null,
      result: e.status === "COMPARABLE" && e.comparison && e.baseline?.dailyMean && e.observation?.dailyMean
        ? { before: e.baseline.dailyMean.value, after: e.observation.dailyMean.value, perDay: true, percentChange: change === null ? null : Math.round(change * 1000) / 10,
            caveats: e.caveats.map(c => c.code) }
        : null,
      notYet: e.status === "INDETERMINATE" ? e.reasons.map(r => READING[r.code] ?? r.code.toLowerCase().replace(/_/g, " ")) : [],
    } : {}),
    ...(reviewed ? { decision: reviewed.conclusion, decisionReason: reviewed.reason.slice(0, 300), decidedAt: reviewed.createdAt } : {}),
  }
}

export const readResults = (accountId: string, businessId: string, input: typeof Input.Type) => Effect.gen(function*() {
  yield* scoped(accountId, businessId)
  const all = yield* (yield* GrowthRepository).list(accountId, businessId, 20)
  const picked = all.filter(o => o.status === "APPROVED" || o.status === "REVIEWED").slice(0, input.limit ?? 6)
  const evaluations = yield* Effect.serviceOption(GrowthEvaluationRepository)
  const entries = yield* Effect.forEach(picked, o => Option.isNone(evaluations) ? Effect.succeed(ledgerEntry(o, null))
    : evaluations.value.evaluate(accountId, businessId, o.id).pipe(Effect.map(e => ledgerEntry(o, e)), Effect.orElseSucceed(() => ledgerEntry(o, null))))
  const count = (s: string) => entries.filter(e => e.stage === s).length
  const measured = entries.filter(e => "result" in e && e.result)
  return {
    summary: entries.length === 0 ? "No approved ideas yet, so there are no results to report"
      : [`${entries.length} approved idea${entries.length === 1 ? "" : "s"}`,
         measured.length ? `${measured.length} measured` : "", count("MEASURING") ? `${count("MEASURING")} being measured` : "",
         count("APPROVED_NOT_DONE") ? `${count("APPROVED_NOT_DONE")} not done yet` : "", count("DECIDED") ? `${count("DECIDED")} decided` : ""].filter(Boolean).join(", "),
    citations: entries.map(e => ({ kind: "growth_opportunity", id: e.id, text: e.title })),
    data: {
      source: "OpenRecord's results ledger: approved ideas, the actions recorded for them, measurement plans declared before the change, and before/after readings of the goal's metric.",
      entries,
      note: "A before/after difference describes what was recorded; other things changed too, so never call it proof that the idea caused it. Say what is still unknown and when it will be known.",
    },
  } satisfies AgentToolResult
})

export const RESULTS_AGENT_TOOLS: ReadonlyArray<AgentToolDef> = [{
  name: "read_results",
  description: "Read the results ledger: each approved idea with what was done and when, the measurement declared before the change, and how the goal's metric moved per day between the baseline and observation windows, or why it can't be compared yet (not done, still measuring, no plan, missing data). Use it to report what worked, in the weekly brief, and before proposing something already tried. Read-only.",
  parameters: JSONSchema.make(Input),
  decode: raw => Schema.decodeUnknown(Input, { onExcessProperty: "error" })(raw),
  run: readResults,
}]
