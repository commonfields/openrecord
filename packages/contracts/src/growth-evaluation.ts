// W4 outcome evaluation contracts: a descriptive before/after reading of one
// approved initiative against its goal's exact metric definition. Nothing here
// estimates incremental growth, causal lift, attributed conversions, revenue
// from an action or return on marketing spend: a difference between windows is
// a description of what was recorded, never proof of what caused it.
import type { GrowthEvent, GrowthExecutionType, GrowthStatus } from "./growth.js"
import type { GrowthPlanTiming, GrowthSeriesConflict, GrowthSeriesDay } from "./growth-measurement.js"

/** `COMPARABLE` means only that the two windows are trustworthy to set side by
 * side. `INDETERMINATE` always carries at least one blocking reason. */
export type GrowthEvaluationStatus = "COMPARABLE" | "INDETERMINATE"
/** Blocking: any one of these makes the evaluation `INDETERMINATE`. */
export const GROWTH_EVALUATION_REASONS = [
  "INITIATIVE_NOT_APPROVED", "CURRENCY_AGGREGATION_UNSUPPORTED", "NO_MEASUREMENT_PLAN", "METRIC_DEFINITION_MISMATCH",
  "INVALID_WINDOWS", "PLAN_DECLARED_AFTER_EXECUTION", "NO_RECORDED_EXECUTION", "EXECUTION_TIMING_INCOMPATIBLE",
  "OBSERVATION_INCOMPLETE", "MISSING_DAYS", "UNAVAILABLE_DAYS", "CONFLICTING_DAYS", "SYNTHETIC_DAYS",
] as const
export type GrowthEvaluationReason = typeof GROWTH_EVALUATION_REASONS[number]
/** Non-blocking limitations that still change how the comparison must be read. */
export const GROWTH_EVALUATION_CAVEATS = [
  "OPERATOR_ATTESTED_ONLY", "UNSPECIFIED_ASSURANCE", "MULTIPLE_INITIATIVE_ACTIONS", "OTHER_ACTIONS_IN_PERIOD",
  "ACTIONS_TRUNCATED", "EXECUTION_ON_OBSERVATION_START", "UNEQUAL_WINDOW_LENGTHS", "ZERO_BASELINE",
  "PLAN_REDECLARED", "OTHER_METRIC_VERSIONS_EXCLUDED", "INITIATIVE_CANCELLED",
] as const
export type GrowthEvaluationCaveat = typeof GROWTH_EVALUATION_CAVEATS[number]
export interface GrowthEvaluationFinding<C extends string> {
  readonly code: C
  readonly detail: string
  /** Affected days (metric time zone) or action ids, ascending, when the finding has them. */
  readonly refs: ReadonlyArray<string>
}

export interface GrowthEvaluationMetric {
  readonly id: string
  readonly version: number
  readonly label: string
  readonly conversionKind: string
  readonly sourceKind: "GA4_AGGREGATE_EXPORT" | "OPERATOR_AGGREGATE_EXPORT"
  readonly sourceIdentity: string
  readonly eventName: string | null
  readonly propertyRef: string | null
  readonly countingSemantics: "EVENT_COUNT" | "SUM"
  readonly unit: "COUNT" | "CURRENCY_MINOR"
  readonly currency: string | null
  readonly timeZone: string
}
export interface GrowthEvaluationPlan {
  readonly id: string
  readonly metricDefinitionId: string
  readonly metricDefinitionVersion: number
  readonly baselineStart: string
  readonly baselineEnd: string
  readonly observationStart: string
  readonly observationEnd: string
  readonly declaredAt: string
  readonly declaredByUserId: string
  readonly timing: GrowthPlanTiming
  readonly firstLinkedExecutionAt: string | null
  /** Number of plans declared for this initiative; the latest one is read. */
  readonly declarations: number
}
/** A per-day mean is the valid total over the days that carried a valid value.
 * It is null when no day in the window carried one; missing is never zero. */
export interface GrowthEvaluationMean {
  readonly total: number
  readonly days: number
  readonly value: number
}
export interface GrowthEvaluationWindow {
  readonly role: "BASELINE" | "OBSERVATION"
  readonly start: string
  readonly end: string
  readonly days: number
  /** Days with one real, non-conflicting recorded value. */
  readonly validDays: number
  /** `validDays / days`, rounded to four decimals. */
  readonly coverage: number
  readonly missingDays: ReadonlyArray<string>
  readonly unavailableDays: ReadonlyArray<string>
  readonly conflictingDays: ReadonlyArray<string>
  readonly syntheticDays: ReadonlyArray<string>
  /** Sum of valid days only. Synthetic, conflicting and absent days never contribute. */
  readonly validTotal: number
  readonly dailyMean: GrowthEvaluationMean | null
  readonly series: ReadonlyArray<GrowthSeriesDay>
  readonly conflicts: ReadonlyArray<GrowthSeriesConflict>
}
/** Present only when `COMPARABLE`. `totalDifference` is null when the windows
 * have different lengths, because unequal totals are not comparable. */
export interface GrowthEvaluationComparison {
  readonly basis: "TOTAL_AND_DAILY_MEAN" | "DAILY_MEAN_ONLY"
  readonly totalDifference: number | null
  readonly dailyMeanDifference: number
  /** Null when the baseline mean is zero; a percentage of zero is undefined. */
  readonly dailyMeanPercentChange: number | null
}
export type GrowthEvaluationAssurance = "OPERATOR_ATTESTED" | "SYSTEM_VERIFIED" | "UNSPECIFIED"
export interface GrowthEvaluationAction {
  readonly id: string
  readonly type: GrowthExecutionType
  /** Null for legacy ledger entries recorded before channels existed. */
  readonly channel: string | null
  /** Operator-asserted time the action happened. */
  readonly performedAt: string
  /** When OpenRecord stored the entry; never a substitute for `performedAt`. */
  readonly recordedAt: string
  /** `performedAt` as a calendar day in the metric's time zone. */
  readonly performedDay: string
  readonly phase: "BEFORE_BASELINE" | "BASELINE" | "BETWEEN_WINDOWS" | "OBSERVATION" | "AFTER_OBSERVATION" | "UNPLANNED"
  readonly assurance: GrowthEvaluationAssurance
  readonly actor: string
  readonly reference: string
  readonly description: string | null
  readonly verification: { readonly kind: string; readonly id: string; readonly claim: string } | null
  readonly association: "THIS_INITIATIVE" | "OTHER_INITIATIVE" | "UNLINKED"
  readonly initiative: { readonly id: string; readonly title: string } | null
}
export interface GrowthOutcomeEvaluation {
  readonly businessId: string
  readonly opportunityId: string
  /** Database clock at evaluation time; decides whether windows are complete. */
  readonly evaluatedAt: string
  readonly interpretation: "DESCRIPTIVE_ONLY"
  readonly status: GrowthEvaluationStatus
  readonly reasons: ReadonlyArray<GrowthEvaluationFinding<GrowthEvaluationReason>>
  readonly caveats: ReadonlyArray<GrowthEvaluationFinding<GrowthEvaluationCaveat>>
  readonly initiative: {
    readonly id: string; readonly title: string; readonly status: GrowthStatus; readonly revision: number
    readonly approvedAt: string | null; readonly decisions: ReadonlyArray<GrowthEvent>
  }
  readonly goal: { readonly id: string; readonly version: number; readonly statement: string }
  readonly metric: GrowthEvaluationMetric
  readonly plan: GrowthEvaluationPlan | null
  readonly baseline: GrowthEvaluationWindow | null
  readonly observation: GrowthEvaluationWindow | null
  readonly comparison: GrowthEvaluationComparison | null
  /** Every current ledger entry for the business performed inside the planned
   * period, plus every action linked to this initiative, oldest first. */
  readonly actions: ReadonlyArray<GrowthEvaluationAction>
  readonly assumptions: ReadonlyArray<string>
  readonly limitations: ReadonlyArray<string>
}
