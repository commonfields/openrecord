// W3 measurement contracts: daily aggregate imports bound to one immutable W0
// metric definition, plus measurement plans connecting an approved initiative
// to the goal's definition. Import provenance separates operator assertions
// (unauthenticated exports) from fixture data; blobs stay operator-scoped.
// Descriptive coverage only: no lift, no attribution, no causal language.
import { Schema } from "effect"

/** `YYYY-MM-DD`. An invalid calendar date is refused by the parsers. */
export const GrowthIsoDay = Schema.String.pipe(Schema.pattern(/^\d{4}-\d{2}-\d{2}$/), Schema.maxLength(10))
/** Where an import's bytes come from. Every accepted file is evidence the
 * operator supplied; nothing here authenticates the reporting platform. */
export const GrowthImportProvenance = Schema.Literal("OPERATOR_SUPPLIED_EXPORT", "SYNTHETIC_FIXTURE")
export type GrowthImportProvenance = typeof GrowthImportProvenance.Type
/**
 * A daily aggregate import for one definition. `dateStart`/`dateEnd` state the
 * declared coverage; days without a row inside the range stay missing, not
 * fabricated. The time zone always comes from the bound definition.
 */
export const GrowthMetricImportInput = Schema.Struct({
  provenance: GrowthImportProvenance,
  dateStart: GrowthIsoDay,
  dateEnd: GrowthIsoDay,
  /** RFC 4180 CSV. GA4 exports keep their known header; operator files use `date,value`. */
  csv: Schema.String.pipe(Schema.maxLength(2_000_000)),
})
export type GrowthMetricImportInput = typeof GrowthMetricImportInput.Type
export interface GrowthMetricImport {
  readonly id: string
  readonly businessId: string
  readonly metricDefinitionId: string
  readonly sourceKind: "GA4_AGGREGATE_EXPORT" | "OPERATOR_AGGREGATE_EXPORT"
  readonly provenance: GrowthImportProvenance
  readonly propertyRef: string | null
  readonly dateStart: string
  readonly dateEnd: string
  readonly timeZone: string
  readonly rawDigest: string
  readonly rowCount: number
  readonly importedByUserId: string
  readonly importedAt: string
}
export interface GrowthMetricCoverage {
  readonly daysInRange: number
  readonly daysPresent: number
  readonly missingDays: number
  readonly firstValueDay: string | null
  readonly lastValueDay: string | null
}
export const GrowthDayStatus = Schema.Literal("OK", "MISSING", "UNAVAILABLE", "CONFLICT")
export type GrowthDayStatus = typeof GrowthDayStatus.Type
export const GrowthDayOrigin = Schema.NullOr(Schema.Literal("REAL", "SYNTHETIC"))
export type GrowthDayOrigin = typeof GrowthDayOrigin.Type
export interface GrowthSeriesDay {
  /** `OK` carries the resolving import's count; `MISSING` is a declared day
   * without a row; `UNAVAILABLE` sits outside every declared range;
   * `CONFLICT` marks inconsistent counts among covering imports (the newest
   * import still resolves the value). */
  readonly day: string
  readonly value: number | null
  readonly origin: GrowthDayOrigin
  readonly status: GrowthDayStatus
}
export interface GrowthSeriesConflict {
  readonly day: string
  readonly values: ReadonlyArray<number>
}
/** Per-day coverage of one definition. Totals, windows and rates live in W4. */
export interface GrowthSeries {
  readonly businessId: string
  readonly metricDefinitionId: string
  readonly metricLabel: string
  readonly definitionVersion: number
  readonly sourceKind: "GA4_AGGREGATE_EXPORT" | "OPERATOR_AGGREGATE_EXPORT"
  readonly countingSemantics: string
  readonly unit: string
  readonly timeZone: string
  readonly start: string
  readonly end: string
  readonly days: ReadonlyArray<GrowthSeriesDay>
  readonly conflicts: ReadonlyArray<GrowthSeriesConflict>
}
/** Plan timing is derived per read, never stored. */
export const GrowthPlanTiming = Schema.Literal("PRE_DECLARED", "DECLARED_AFTER_EXECUTION")
export type GrowthPlanTiming = typeof GrowthPlanTiming.Type
export const GrowthMeasurementPlanInput = Schema.Struct({
  baselineStart: GrowthIsoDay,
  baselineEnd: GrowthIsoDay,
  observationStart: GrowthIsoDay,
  observationEnd: GrowthIsoDay,
  idempotencyKey: Schema.UUID,
})
export type GrowthMeasurementPlanInput = typeof GrowthMeasurementPlanInput.Type
export interface GrowthMeasurementPlan {
  readonly id: string
  readonly businessId: string
  readonly opportunityId: string
  readonly goalId: string
  readonly metricDefinition: {
    readonly id: string
    readonly version: number
    readonly label: string
    readonly countingSemantics: "EVENT_COUNT" | "SUM"
    readonly unit: "COUNT" | "CURRENCY_MINOR"
    readonly timeZone: string
  }
  readonly baselineStart: string
  readonly baselineEnd: string
  readonly observationStart: string
  readonly observationEnd: string
  readonly declaredByUserId: string
  readonly declaredAt: string
  readonly requestKey: string
}
export interface GrowthPlanRead {
  readonly plan: GrowthMeasurementPlan
  readonly timing: GrowthPlanTiming
  /** Earliest `performed_at` among the initiative's current linked
   * executions, or null while none is linked. */
  readonly firstLinkedExecutionAt: string | null
}
