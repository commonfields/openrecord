// W4 evaluation rules (pure, no database): both business types share one
// evaluator; every negative scenario yields INDETERMINATE with a named reason,
// and nothing in the output claims lift, attribution or success.
import { describe, expect, it } from "vitest"
import type { GrowthEvent, GrowthGoal, GrowthPlanRead, GrowthSeries, GrowthSeriesDay } from "@openrecord/contracts"
import { daysInclusive, evaluateGrowthOutcome, localDay, type GrowthEvaluationActionRow, type GrowthEvaluationInput } from "./growth-evaluation-rules.js"

const business = "00000000-0000-4000-8000-000000000001"
const user = "00000000-0000-4000-8000-000000000002"
const opportunityId = "00000000-0000-4000-8000-000000000030"
const definitionId = "00000000-0000-4000-8000-000000000020"

const softwareGoal: GrowthGoal = {
  id: "00000000-0000-4000-8000-000000000010", businessId: business, version: 1, statement: "Increase trial signups", createdByUserId: user, createdAt: "2026-08-01T00:00:00.000Z",
  metricDefinition: { id: definitionId, businessId: business, version: 1, createdByUserId: user, createdAt: "2026-08-01T00:00:00.000Z",
    conversionKind: "SIGNUP", label: "Trial signups", sourceKind: "GA4_AGGREGATE_EXPORT", sourceIdentity: "TEST GA4", propertyRef: "TEST property",
    eventName: "trial_signup", countingSemantics: "EVENT_COUNT", unit: "COUNT", currency: null, reportingTimeZone: "UTC" },
}
const serviceGoal: GrowthGoal = {
  ...softwareGoal, statement: "Increase bookings",
  metricDefinition: { id: definitionId, businessId: business, version: 1, createdByUserId: user, createdAt: "2026-08-01T00:00:00.000Z",
    conversionKind: "BOOKING", label: "Bookings", sourceKind: "OPERATOR_AGGREGATE_EXPORT", sourceIdentity: "TEST booking system", propertyRef: null,
    eventName: null, countingSemantics: "EVENT_COUNT", unit: "COUNT", currency: null, reportingTimeZone: "Asia/Makassar" },
}
const events: ReadonlyArray<GrowthEvent> = [
  { id: "00000000-0000-4000-8000-000000000041", status: "PROPOSED", revision: 1, actor: "OPERATOR", userId: user, reason: "Opportunity created", conclusion: null, createdAt: "2026-08-20T00:00:00.000Z" },
  { id: "00000000-0000-4000-8000-000000000042", status: "APPROVED", revision: 2, actor: "OPERATOR", userId: user, reason: "TEST approval", conclusion: null, createdAt: "2026-08-21T00:00:00.000Z" },
]
const plan = (goal: GrowthGoal, overrides: Partial<GrowthPlanRead["plan"]> = {}, timing: GrowthPlanRead["timing"] = "PRE_DECLARED"): GrowthPlanRead => ({
  plan: { id: "00000000-0000-4000-8000-000000000050", businessId: business, opportunityId, goalId: goal.id,
    metricDefinition: { id: goal.metricDefinition.id, version: goal.metricDefinition.version, label: goal.metricDefinition.label, countingSemantics: "EVENT_COUNT", unit: "COUNT", timeZone: goal.metricDefinition.reportingTimeZone },
    baselineStart: "2026-09-01", baselineEnd: "2026-09-07", observationStart: "2026-09-09", observationEnd: "2026-09-15",
    declaredByUserId: user, declaredAt: "2026-08-22T00:00:00.000Z", requestKey: "00000000-0000-4000-8000-000000000051", ...overrides },
  timing, firstLinkedExecutionAt: "2026-09-08T10:00:00.000Z",
})
const dayList = (start: string, end: string) => Array.from({ length: daysInclusive(start, end) }, (_, i) => new Date(Date.parse(`${start}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10))
const series = (goal: GrowthGoal, start: string, end: string, values: ReadonlyArray<number | Partial<GrowthSeriesDay>>): GrowthSeries => ({
  businessId: business, metricDefinitionId: goal.metricDefinition.id, metricLabel: goal.metricDefinition.label, definitionVersion: goal.metricDefinition.version,
  sourceKind: goal.metricDefinition.sourceKind, countingSemantics: "EVENT_COUNT", unit: "COUNT", timeZone: goal.metricDefinition.reportingTimeZone, start, end,
  days: dayList(start, end).map((day, i) => {
    const v = values[i % values.length]!
    return typeof v === "number" ? { day, value: v, origin: "REAL", status: "OK" } : { day, value: null, origin: null, status: "MISSING", ...v }
  }),
  conflicts: [],
})
const action = (overrides: Partial<GrowthEvaluationActionRow> = {}): GrowthEvaluationActionRow => ({
  id: "00000000-0000-4000-8000-000000000060", type: "SOURCE_UPDATED", channel: "WEBSITE", performedAt: "2026-09-08T10:00:00.000Z", recordedAt: "2026-09-08T10:05:00.000Z",
  assurance: "OPERATOR_ATTESTED", actor: "HUMAN", reference: "https://signup.test/pricing", description: "TEST clarified pricing page",
  verification: null, association: "THIS_INITIATIVE", initiative: { id: opportunityId, title: "TEST initiative" }, ...overrides,
})
const input = (goal: GrowthGoal, overrides: Partial<GrowthEvaluationInput> = {}): GrowthEvaluationInput => {
  const p = overrides.plan === undefined ? plan(goal) : overrides.plan
  return {
    businessId: business, asOf: "2026-10-01T00:00:00.000Z",
    opportunity: { id: opportunityId, title: "TEST initiative", goalId: goal.id, status: "APPROVED", revision: 2, events },
    goal, plan: p, planDeclarations: 1,
    baseline: p ? series(goal, p.plan.baselineStart, p.plan.baselineEnd, [4, 5, 6]) : null,
    observation: p ? series(goal, p.plan.observationStart, p.plan.observationEnd, [7, 8, 9]) : null,
    actions: [action()], actionsTruncated: false, excludedDefinitions: [],
    ...overrides,
  }
}
const codes = (e: ReturnType<typeof evaluateGrowthOutcome>) => e.reasons.map(r => r.code)
const caveatCodes = (e: ReturnType<typeof evaluateGrowthOutcome>) => e.caveats.map(c => c.code)

describe("evaluateGrowthOutcome: comparable acceptance scenarios", () => {
  it("software: approved website change, operator-attested, signups, complete real windows", () => {
    const e = evaluateGrowthOutcome(input(softwareGoal))
    expect(e.status).toBe("COMPARABLE")
    expect(e.reasons).toEqual([])
    expect(e.interpretation).toBe("DESCRIPTIVE_ONLY")
    expect(e.metric).toMatchObject({ label: "Trial signups", sourceKind: "GA4_AGGREGATE_EXPORT", countingSemantics: "EVENT_COUNT", unit: "COUNT", timeZone: "UTC", version: 1 })
    // 4,5,6,4,5,6,4 = 34 ; 7,8,9,7,8,9,7 = 55
    expect(e.baseline).toMatchObject({ days: 7, validDays: 7, coverage: 1, validTotal: 34, dailyMean: { total: 34, days: 7, value: 4.86 }, missingDays: [], syntheticDays: [] })
    expect(e.observation).toMatchObject({ days: 7, validDays: 7, validTotal: 55, dailyMean: { value: 7.86 } })
    expect(e.comparison).toEqual({ basis: "TOTAL_AND_DAILY_MEAN", totalDifference: 21, dailyMeanDifference: 3, dailyMeanPercentChange: 61.8 })
    expect(caveatCodes(e)).toEqual(["OPERATOR_ATTESTED_ONLY"])
    expect(e.actions[0]).toMatchObject({ performedDay: "2026-09-08", phase: "BETWEEN_WINDOWS", assurance: "OPERATOR_ATTESTED", recordedAt: "2026-09-08T10:05:00.000Z" })
    expect(e.initiative.approvedAt).toBe("2026-08-21T00:00:00.000Z")
  })

  it("service: listing update, bookings from operator CSV, same evaluator, metric time zone decides the day", () => {
    // 23:30 UTC on 09-07 is 07:30 on 09-08 in Asia/Makassar (UTC+8): between the windows.
    const e = evaluateGrowthOutcome(input(serviceGoal, { actions: [action({ type: "LISTING_UPDATED", channel: "THIRD_PARTY_PROFILE", reference: "TEST booking listing", performedAt: "2026-09-07T23:30:00.000Z" })] }))
    expect(e.status).toBe("COMPARABLE")
    expect(e.metric).toMatchObject({ label: "Bookings", sourceKind: "OPERATOR_AGGREGATE_EXPORT", timeZone: "Asia/Makassar" })
    expect(e.actions[0]).toMatchObject({ performedDay: "2026-09-08", phase: "BETWEEN_WINDOWS", channel: "THIRD_PARTY_PROFILE" })
    // Same instant read in UTC falls on the last baseline day.
    expect(localDay("2026-09-07T23:30:00.000Z", "UTC")).toBe("2026-09-07")
  })

  it("is deterministic: identical input yields an identical evaluation", () => {
    expect(JSON.stringify(evaluateGrowthOutcome(input(softwareGoal)))).toBe(JSON.stringify(evaluateGrowthOutcome(input(softwareGoal))))
  })

  it("never emits causal or success fields", () => {
    const e = evaluateGrowthOutcome(input(softwareGoal))
    const keys = JSON.stringify(Object.keys(e)) + JSON.stringify(Object.keys(e.comparison ?? {}))
    for (const banned of ["lift", "attribut", "roi", "success", "incremental", "effect", "impact", "revenue"]) expect(keys.toLowerCase()).not.toContain(banned)
    expect(["COMPARABLE", "INDETERMINATE"]).toContain(e.status)
    expect(e.limitations.join(" ")).toContain("does not estimate incremental growth, causal lift")
  })
})

describe("evaluateGrowthOutcome: negative scenarios are INDETERMINATE with reasons", () => {
  it("missing days are listed, never zero, and block the comparison", () => {
    const p = plan(softwareGoal)
    const e = evaluateGrowthOutcome(input(softwareGoal, { observation: series(softwareGoal, p.plan.observationStart, p.plan.observationEnd, [7, {}, 9]) }))
    expect(e.status).toBe("INDETERMINATE")
    expect(codes(e)).toEqual(["MISSING_DAYS"])
    expect(e.reasons[0]!.refs).toEqual(["2026-09-10", "2026-09-13"])
    expect(e.observation).toMatchObject({ validDays: 5, validTotal: 39, dailyMean: { total: 39, days: 5, value: 7.8 }, missingDays: ["2026-09-10", "2026-09-13"] })
    expect(e.comparison).toBeNull()
  })

  it("days outside every import are unavailable", () => {
    const p = plan(softwareGoal)
    const e = evaluateGrowthOutcome(input(softwareGoal, { baseline: series(softwareGoal, p.plan.baselineStart, p.plan.baselineEnd, [{ status: "UNAVAILABLE" }]) }))
    expect(codes(e)).toEqual(["UNAVAILABLE_DAYS"])
    expect(e.baseline).toMatchObject({ validDays: 0, dailyMean: null, coverage: 0 })
  })

  it("conflicting imports block and the conflicting value is not counted", () => {
    const p = plan(softwareGoal)
    const s = series(softwareGoal, p.plan.baselineStart, p.plan.baselineEnd, [4])
    const conflicted: GrowthSeries = { ...s, days: s.days.map((d, i) => i === 2 ? { ...d, value: 9, status: "CONFLICT" } : d), conflicts: [{ day: "2026-09-03", values: [4, 9] }] }
    const e = evaluateGrowthOutcome(input(softwareGoal, { baseline: conflicted }))
    expect(codes(e)).toEqual(["CONFLICTING_DAYS"])
    expect(e.baseline).toMatchObject({ validDays: 6, validTotal: 24, conflictingDays: ["2026-09-03"], conflicts: [{ day: "2026-09-03", values: [4, 9] }] })
  })

  it("synthetic data is never substituted for observed data", () => {
    const p = plan(softwareGoal)
    const s = series(softwareGoal, p.plan.observationStart, p.plan.observationEnd, [7])
    const e = evaluateGrowthOutcome(input(softwareGoal, { observation: { ...s, days: s.days.map(d => ({ ...d, origin: "SYNTHETIC" as const })) } }))
    expect(codes(e)).toEqual(["SYNTHETIC_DAYS"])
    expect(e.observation).toMatchObject({ validDays: 0, validTotal: 0, dailyMean: null })
    expect(e.observation!.syntheticDays).toHaveLength(7)
  })

  it("a plan or series bound to a different metric version is refused, never mixed", () => {
    const otherVersion = { ...plan(softwareGoal) }
    const e = evaluateGrowthOutcome(input(softwareGoal, { plan: { ...otherVersion, plan: { ...otherVersion.plan, metricDefinition: { ...otherVersion.plan.metricDefinition, id: "00000000-0000-4000-8000-000000000021", version: 2 } } } }))
    expect(codes(e)).toContain("METRIC_DEFINITION_MISMATCH")
    const p = plan(softwareGoal)
    const foreign = { ...series(softwareGoal, p.plan.baselineStart, p.plan.baselineEnd, [4]), definitionVersion: 2 }
    const f = evaluateGrowthOutcome(input(softwareGoal, { baseline: foreign, excludedDefinitions: [{ id: "00000000-0000-4000-8000-000000000021", version: 2, label: "Trial signups" }] }))
    expect(codes(f)).toEqual(["METRIC_DEFINITION_MISMATCH"])
    expect(f.baseline).toBeNull()
    expect(caveatCodes(f)).toContain("OTHER_METRIC_VERSIONS_EXCLUDED")
  })

  it("a plan declared after execution is not treated as pre-declared", () => {
    const e = evaluateGrowthOutcome(input(softwareGoal, { plan: plan(softwareGoal, { declaredAt: "2026-09-08T12:00:00.000Z" }, "DECLARED_AFTER_EXECUTION") }))
    expect(codes(e)).toEqual(["PLAN_DECLARED_AFTER_EXECUTION"])
    expect(e.plan?.timing).toBe("DECLARED_AFTER_EXECUTION")
  })

  it("overlapping actions stay visible; the initiative's own action inside a window blocks", () => {
    const other = action({ id: "00000000-0000-4000-8000-000000000061", type: "CAMPAIGN_SENT", channel: "EMAIL", performedAt: "2026-09-10T08:00:00.000Z", association: "OTHER_INITIATIVE", initiative: { id: "00000000-0000-4000-8000-000000000031", title: "TEST other" } })
    const legacy = action({ id: "00000000-0000-4000-8000-000000000062", channel: null, assurance: "UNSPECIFIED", actor: "UNKNOWN", performedAt: "2026-09-03T08:00:00.000Z", association: "UNLINKED", initiative: null })
    const overlap = evaluateGrowthOutcome(input(softwareGoal, { actions: [legacy, action(), other] }))
    expect(overlap.status).toBe("COMPARABLE")
    expect(caveatCodes(overlap)).toEqual(["OPERATOR_ATTESTED_ONLY", "UNSPECIFIED_ASSURANCE", "OTHER_ACTIONS_IN_PERIOD"])
    expect(overlap.caveats.find(c => c.code === "OTHER_ACTIONS_IN_PERIOD")!.refs).toEqual([legacy.id, other.id])
    expect(overlap.actions.map(a => a.phase)).toEqual(["BASELINE", "BETWEEN_WINDOWS", "OBSERVATION"])
    const second = action({ id: "00000000-0000-4000-8000-000000000063", performedAt: "2026-09-12T08:00:00.000Z" })
    const mixed = evaluateGrowthOutcome(input(softwareGoal, { actions: [action(), second] }))
    expect(codes(mixed)).toEqual(["EXECUTION_TIMING_INCOMPATIBLE"])
    expect(mixed.reasons[0]!.refs).toEqual([second.id])
    expect(caveatCodes(mixed)).toContain("MULTIPLE_INITIATIVE_ACTIONS")
  })

  it("an action inside the baseline, or no action at all, is incompatible", () => {
    expect(codes(evaluateGrowthOutcome(input(softwareGoal, { actions: [action({ performedAt: "2026-09-05T12:00:00.000Z" })] })))).toEqual(["EXECUTION_TIMING_INCOMPATIBLE"])
    expect(codes(evaluateGrowthOutcome(input(softwareGoal, { actions: [] })))).toEqual(["NO_RECORDED_EXECUTION"])
    const onStart = evaluateGrowthOutcome(input(softwareGoal, { actions: [action({ performedAt: "2026-09-09T09:00:00.000Z" })] }))
    expect(onStart.status).toBe("COMPARABLE")
    expect(caveatCodes(onStart)).toContain("EXECUTION_ON_OBSERVATION_START")
  })

  it("unequal window lengths compare per-day means only", () => {
    const p = plan(softwareGoal, { baselineStart: "2026-08-25" })
    const e = evaluateGrowthOutcome(input(softwareGoal, { plan: p, baseline: series(softwareGoal, "2026-08-25", "2026-09-07", [5]) }))
    expect(e.status).toBe("COMPARABLE")
    expect(e.comparison).toEqual({ basis: "DAILY_MEAN_ONLY", totalDifference: null, dailyMeanDifference: 2.86, dailyMeanPercentChange: 57.1 })
    expect(caveatCodes(e)).toContain("UNEQUAL_WINDOW_LENGTHS")
  })

  it("a zero baseline yields no percentage", () => {
    const p = plan(softwareGoal)
    const e = evaluateGrowthOutcome(input(softwareGoal, { baseline: series(softwareGoal, p.plan.baselineStart, p.plan.baselineEnd, [0]) }))
    expect(e.comparison).toMatchObject({ dailyMeanPercentChange: null, totalDifference: 55 })
    expect(caveatCodes(e)).toContain("ZERO_BASELINE")
  })

  it("an incomplete observation window, missing plan, unapproved initiative and currency metric are named", () => {
    expect(codes(evaluateGrowthOutcome(input(softwareGoal, { asOf: "2026-09-15T12:00:00.000Z" })))).toEqual(["OBSERVATION_INCOMPLETE"])
    const noPlan = evaluateGrowthOutcome(input(softwareGoal, { plan: null }))
    expect(codes(noPlan)).toEqual(["NO_MEASUREMENT_PLAN"])
    expect(noPlan.actions[0]!.phase).toBe("UNPLANNED")
    const proposed = evaluateGrowthOutcome(input(softwareGoal, { opportunity: { id: opportunityId, title: "TEST", goalId: softwareGoal.id, status: "PROPOSED", revision: 1, events: [events[0]!] } }))
    expect(codes(proposed)).toContain("INITIATIVE_NOT_APPROVED")
    const currencyGoal: GrowthGoal = { ...serviceGoal, metricDefinition: { ...serviceGoal.metricDefinition, conversionKind: "PURCHASE", countingSemantics: "SUM", unit: "CURRENCY_MINOR", currency: "USD" } as GrowthGoal["metricDefinition"] }
    const currency = evaluateGrowthOutcome(input(currencyGoal, { plan: null, baseline: null, observation: null }))
    expect(codes(currency)).toEqual(["CURRENCY_AGGREGATION_UNSUPPORTED", "NO_MEASUREMENT_PLAN"])
    expect(currency.baseline).toBeNull()
  })

  it("windows that touch or invert are invalid", () => {
    const e = evaluateGrowthOutcome(input(softwareGoal, { plan: plan(softwareGoal, { observationStart: "2026-09-07" }) }))
    expect(codes(e)).toContain("INVALID_WINDOWS")
    expect(e.baseline).toBeNull()
  })
})
