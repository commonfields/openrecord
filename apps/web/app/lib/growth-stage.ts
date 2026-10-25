// The operator's mental model of one initiative, derived strictly from
// persisted evidence: Goal → Plan → Execute → Measure → Report.
//
// Rules the stage model must never break:
// - "done" is claimed only from persisted facts (a declared plan, a recorded
//   execution, a published report). An evaluation is never assumed to have run
//   because evaluation is computed on demand, not stored.
// - A blocked or degraded stage says why in operator language and never invents
//   completion, verification or causation.
import type { GrowthPlanRead, GrowthOpportunity, GrowthReportSummary } from "@openrecord/contracts"

export type GrowthStageKey = "goal" | "decision" | "plan" | "execute" | "measure" | "report"
export type GrowthStageState = "done" | "current" | "todo" | "attention"

export interface GrowthStage {
  readonly key: GrowthStageKey
  readonly label: string
  readonly state: GrowthStageState
  /** What this stage holds right now, stated from evidence only. */
  readonly detail: string
  /** The next available action, when there is one. */
  readonly next?: string
  /** A blocking or degrading condition the operator should know about. */
  readonly caveat?: string
}

export type GrowthStageInputs = {
  /** The initiative's status ("APPROVED" gates plan/measure/report). */
  readonly status: GrowthOpportunity["status"]
  /** A goal with an exact metric definition exists for this initiative. */
  readonly hasGoal: boolean
  /** Latest declared measurement plan; undefined while not loaded. */
  readonly plan: GrowthPlanRead | null | undefined
  /** Current linked executions, with their assurance. */
  readonly opportunity: Pick<GrowthOpportunity, "executionCount" | "executions" | "progress">
  /** Number of daily imports bound to the initiative's metric definition; null while unknown or failed to load. */
  readonly imports: number | null
  /** Published report versions; undefined while not loaded. */
  readonly reports: ReadonlyArray<GrowthReportSummary> | undefined
}

const stage = (
  key: GrowthStageKey,
  label: string,
  state: GrowthStageState,
  detail: string,
  next?: string,
  caveat?: string,
): GrowthStage => ({ key, label, state, detail, ...(next ? { next } : {}), ...(caveat ? { caveat } : {}) })

const reported = (reports: ReadonlyArray<GrowthReportSummary> | undefined) => {
  const published = (reports ?? []).filter(r => !r.superseded)
  if (published.length === 0) return null
  return published.reduce((latest, r) => (r.version > latest.version ? r : latest))
}

/** One stage per key, in workflow order. Pure and unit-tested.
 *
 * An initiative that no human has approved yet does not show the five
 * delivery stages at all — four "available after approval" chips would be
 * noise. It shows Goal and the pending human decision, because "proposed" is
 * not "approved" and the only available action is the decision itself. */
export const growthStages = (input: GrowthStageInputs): ReadonlyArray<GrowthStage> => {
  const approved = input.status === "APPROVED" || input.status === "REVIEWED"
  if (!approved) {
    const goal: GrowthStage = input.hasGoal
      ? stage("goal", "Goal", "done", "Goal and metric defined for this client")
      : stage("goal", "Goal", "todo", "No goal set", "Set the goal and metric first")
    const decision: GrowthStage = input.status === "DISCOVERED"
      ? stage("decision", "Decision", "current", "Agent-suggested hypothesis — no human has reviewed it", "Propose it for review")
      : input.status === "PROPOSED"
        ? stage("decision", "Decision", "current", "Waiting for a human decision", "Approve or reject this initiative")
        : stage("decision", "Decision", "attention", `Cancelled — ${input.status.toLowerCase()}`)
    return [goal, decision]
  }
  const plan = input.plan
  const { executionCount, executions } = input.opportunity
  const verified = executions.filter(e => e.assurance === "SYSTEM_VERIFIED").length
  const attested = executionCount - verified
  const latestReport = reported(input.reports)
  const stages: GrowthStage[] = []

  // Goal: an initiative always carries a goal id, and the workspace editor
  // keeps the statement and metric versioned.
  stages.push(
    input.hasGoal
      ? stage("goal", "Goal", "done", "Goal and metric defined for this client")
      : stage("goal", "Goal", "todo", "No goal set", "Set the goal and metric first"),
  )

  // Plan: done only when a declaration exists; a post-hoc declaration stays
  // visible as degraded, never silently promoted.
  if (plan === undefined) {
    stages.push(stage("plan", "Plan", "todo", "Checking for a declared plan…"))
  } else if (plan === null) {
    stages.push(stage("plan", "Plan", "current", "No periods declared yet", "Declare the before and after periods",
      "Declaring before recording work keeps the report able to say the periods were agreed in advance."))
  } else if (plan.timing === "PRE_DECLARED") {
    stages.push(stage("plan", "Plan", "done", `Declared before the work · ${plan.plan.baselineStart} → ${plan.plan.observationEnd}`))
  } else {
    stages.push(stage("plan", "Plan", "attention", "Declared after the work was recorded",
      undefined, "A recorded action is earlier than this plan, so the report will not treat the periods as agreed in advance."))
  }

  // Execute: recorded actions with their proof level. A count is evidence; a
  // merged pull request is still only a system-verified merge.
  if (executionCount === 0) {
    stages.push(stage("execute", "Execute", "current", "No work recorded yet", "Record what was actually done"))
  } else {
    const assurance = verified > 0 && attested > 0
      ? `${verified} system-verified · ${attested} operator-attested`
      : verified > 0
        ? "System-verified merge confirmed — not live publication"
        : "Operator-attested — not independently verified"
    stages.push(stage("execute", "Execute", "done", `${executionCount} recorded ${executionCount === 1 ? "action" : "actions"} · ${assurance}`))
  }

  // Measure: a stored evaluation does not exist, so "done" comes only from a
  // published report's status; otherwise the stage asks for evaluation.
  if (latestReport) {
    stages.push(
      latestReport.status === "COMPARABLE"
        ? stage("measure", "Measure", "done", "Figures evaluated as comparable — a statement about data quality, not success")
        : stage("measure", "Measure", "attention", "Figures evaluated as indeterminate — the reasons are listed in the report"),
    )
  } else if (input.imports === 0) {
    stages.push(stage("measure", "Measure", "todo", "No daily figures for this metric yet",
      "Import daily figures (CSV export or Google Analytics)"))
  } else {
    stages.push(stage("measure", "Measure", "current", "Daily figures available — not yet evaluated",
      "Run the outcome evaluation"))
  }

  // Report: done only from a published, immutable version.
  if (latestReport) {
    stages.push(stage("report", "Report", "done",
      `Version ${latestReport.version} published · immutable` + (latestReport.share?.status === "ACTIVE" ? " · share link active" : ""),
      "Publish a new version to update it"))
  } else if (executionCount === 0) {
    stages.push(stage("report", "Report", "todo", "Nothing to report yet",
      undefined, "A report lists recorded actions; record the work first."))
  } else {
    stages.push(stage("report", "Report", "current", "Preview available — publishing freezes the evidence", "Preview the client report"))
  }

  return stages
}

/** One line for the client list: identity from the profile, progress from
 * persisted initiative state. Never invented activity. */
export type ClientGrowthSummary = {
  readonly hasGoal: boolean
  readonly goalStatement: string | null
  readonly metricLabel: string | null
  readonly total: number
  readonly approved: number
  /** System-verified executions across current executions. */
  readonly verified: number
  readonly reviewConcluded: number
}

export const clientGrowthSummary = (opportunities: ReadonlyArray<GrowthOpportunity>, goalStatement: string | null, metricLabel: string | null): ClientGrowthSummary => {
  const approved = opportunities.filter(o => o.status === "APPROVED" || o.status === "REVIEWED")
  return {
    hasGoal: goalStatement !== null,
    goalStatement,
    metricLabel,
    total: opportunities.length,
    approved: approved.length,
    verified: opportunities.reduce((n, o) => n + o.executions.filter(e => e.assurance === "SYSTEM_VERIFIED").length, 0),
    reviewConcluded: opportunities.filter(o => o.status === "REVIEWED").length,
  }
}

/** The line under the client name in the list; empty string means nothing to claim. */
export const clientGrowthLine = (s: ClientGrowthSummary | null): string => {
  if (!s) return ""
  if (!s.hasGoal && s.total === 0) return "No marketing goal yet"
  const parts: string[] = []
  if (s.hasGoal && s.goalStatement) parts.push(s.goalStatement)
  if (s.total > 0) {
    const counts = s.approved > 0 ? `${s.approved} of ${s.total} approved` : `${s.total} awaiting review`
    parts.push(`${s.total} ${s.total === 1 ? "initiative" : "initiatives"} · ${counts}`)
    if (s.verified > 0) parts.push(`${s.verified} verified ${s.verified === 1 ? "execution" : "executions"}`)
  }
  return parts.join(" · ")
}
