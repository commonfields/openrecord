// W3 measurement repository: daily aggregate imports bound to one immutable
// metric definition, per-day coverage reads, and measurement plans. The
// database guards (0032) carry the binding rules; this layer adds idempotent
// request identities, digest replay, per-day conflict resolution and derived
// plan timing. Descriptive only: coverage and declarations, never lift or
// attribution.
import { Context, Data, Effect, Layer, Schema } from "effect"
import { PgClient } from "@effect/sql-pg"
import type { SqlError } from "@effect/sql/SqlError"
import {
  GrowthIsoDay, GrowthMeasurementPlanInput, GrowthMetricImportInput, GrowthImportProvenance, decodeRouteId,
  type GrowthMeasurementPlanInput as PlanInput, type GrowthMetricImportInput as ImportInput,
  type GrowthMetricCoverage, type GrowthMetricImport, type GrowthPlanRead,
  type GrowthSeries, type GrowthSeriesConflict, type GrowthSeriesDay,
} from "@openrecord/contracts"
import { decodeRow, type RowDecodeError } from "./row-codecs.js"
import { parseGa4Export } from "./acquisition-ga4.js"
import { aggregateGa4KeyEvents, coverageOf, parseDailyCounts, type GrowthDailyRow } from "./growth-measurement-parse.js"
import type { Session } from "./auth.js"

export class GrowthMeasurementRefused extends Data.TaggedError("GrowthMeasurementRefused")<{ readonly reason: string }> {}
export type GrowthMeasurementEffect<A> = Effect.Effect<A, SqlError | RowDecodeError | GrowthMeasurementRefused>

export interface GrowthMetricImportResult {
  readonly import: GrowthMetricImport
  readonly coverage: GrowthMetricCoverage
  readonly replayed: boolean
}

const DefinitionDoc = Schema.Struct({
  id: Schema.UUID, businessId: Schema.UUID, version: Schema.Int, conversionKind: Schema.String, label: Schema.String,
  sourceKind: Schema.Literal("GA4_AGGREGATE_EXPORT", "OPERATOR_AGGREGATE_EXPORT"), sourceIdentity: Schema.String,
  eventName: Schema.NullOr(Schema.String), countingSemantics: Schema.String, unit: Schema.String,
  currency: Schema.NullOr(Schema.String), reportingTimeZone: Schema.String, propertyRef: Schema.NullOr(Schema.String),
  createdByUserId: Schema.UUID, createdAt: Schema.String,
})
type Definition = typeof DefinitionDoc.Type
const ImportDocument = Schema.Struct({
  id: Schema.UUID, businessId: Schema.UUID, metricDefinitionId: Schema.UUID,
  sourceKind: Schema.Literal("GA4_AGGREGATE_EXPORT", "OPERATOR_AGGREGATE_EXPORT"), provenance: GrowthImportProvenance,
  propertyRef: Schema.NullOr(Schema.String), dateStart: Schema.String, dateEnd: Schema.String, timeZone: Schema.String,
  rawDigest: Schema.String, rowCount: Schema.Int, importedByUserId: Schema.UUID, importedAt: Schema.String,
})
type ImportDoc = typeof ImportDocument.Type
const PlanDocumentCodec = Schema.Struct({
  id: Schema.UUID, businessId: Schema.UUID, opportunityId: Schema.UUID, goalId: Schema.UUID,
  metricDefinition: Schema.Struct({ id: Schema.UUID, version: Schema.Int, label: Schema.String, countingSemantics: Schema.Literal("EVENT_COUNT", "SUM"), unit: Schema.Literal("COUNT", "CURRENCY_MINOR"), timeZone: Schema.String }),
  baselineStart: Schema.String, baselineEnd: Schema.String, observationStart: Schema.String, observationEnd: Schema.String,
  declaredByUserId: Schema.UUID, declaredAt: Schema.String, requestKey: Schema.UUID,
})
type PlanDocument = typeof PlanDocumentCodec.Type

const msPerDay = 86_400_000
const dayMs = (d: string) => Date.parse(`${d}T00:00:00Z`)
const betweenDays = (start: string, end: string): number | null => {
  const a = dayMs(start), b = dayMs(end)
  return Number.isNaN(a) || Number.isNaN(b) ? null : Math.round((b - a) / msPerDay)
}

/** Guard errors raised under races become refused requests, not 500s. */
const guardReasons: ReadonlyArray<{ readonly needle: string; readonly reason: string }> = [
  { needle: "plan requires an approved initiative", reason: "PlanOpportunityNotApproved" },
  { needle: "plan metric mismatch", reason: "PlanMetricMismatch" },
  { needle: "import timezone mismatch", reason: "ImportTimezoneMismatch" },
  { needle: "import source kind mismatch", reason: "ImportSourceKindMismatch" },
  { needle: "import property reference mismatch", reason: "ImportPropertyRefMismatch" },
  { needle: "import row outside declared range", reason: "ImportRowOutsideRange" },
  { needle: "SUM/CURRENCY_MINOR aggregation is not implemented", reason: "CurrencyMeasurementRefused" },
]
const guard = <A, R>(effect: Effect.Effect<A, SqlError, R>): Effect.Effect<A, SqlError | GrowthMeasurementRefused, R> => effect.pipe(
  Effect.mapError(e => {
    const message = String((e as unknown as { cause?: { message?: string } }).cause?.message ?? "")
    for (const { needle, reason } of guardReasons) if (message.includes(needle)) return new GrowthMeasurementRefused({ reason })
    return e
  }))

export class GrowthMeasurementRepository extends Context.Tag("GrowthMeasurementRepository")<GrowthMeasurementRepository, {
  readonly imports: (accountId: string, businessId: string, metricDefinitionId: string, limit?: number) => GrowthMeasurementEffect<ReadonlyArray<ImportDoc>>
  readonly importDaily: (session: Session, businessId: string, metricDefinitionId: string, input: ImportInput) => GrowthMeasurementEffect<GrowthMetricImportResult>
  readonly series: (accountId: string, businessId: string, metricDefinitionId: string, start: string, end: string) => GrowthMeasurementEffect<GrowthSeries>
  readonly declarePlan: (session: Session, businessId: string, opportunityId: string, input: PlanInput) => GrowthMeasurementEffect<GrowthPlanRead>
  readonly plan: (accountId: string, businessId: string, opportunityId: string) => GrowthMeasurementEffect<GrowthPlanRead | null>
}>() {}

export const GrowthMeasurementRepositoryLive = Layer.effect(GrowthMeasurementRepository, Effect.map(PgClient.PgClient, sql => {
  const refuse = (reason: string) => Effect.fail(new GrowthMeasurementRefused({ reason }))
  const parse = <A, I>(schema: Schema.Schema<A, I>, input: unknown) => Schema.decodeUnknown(schema, { onExcessProperty: "error" })(input).pipe(
    Effect.mapError(() => new GrowthMeasurementRefused({ reason: "InvalidRequest" })))
  const scope = (accountId: string, businessId: string) => Effect.gen(function*() {
    const rows = yield* sql`SELECT b.id FROM businesses b JOIN record_profiles r ON r.business_id=b.id WHERE b.id=${businessId} AND b.account_id=${accountId}`
    if (!rows.length) return yield* refuse("GrowthNotFound")
  })
  const member = (session: Session, businessId: string) => Effect.gen(function*() {
    yield* scope(session.accountId, businessId)
    const rows = yield* sql`SELECT 1 FROM account_users WHERE account_id=${session.accountId} AND user_id=${session.userId}`
    if (!rows.length) return yield* refuse("GrowthNotFound")
  })
  const definition = (businessId: string, metricDefinitionId: string) => Effect.gen(function*() {
    const rows = yield* sql`SELECT document FROM growth_metric_documents WHERE id=${metricDefinitionId} AND business_id=${businessId}`
    if (!rows[0]) return yield* refuse("MetricDefinitionNotFound")
    return yield* decodeRow(DefinitionDoc, "growth_metric_definitions", rows[0]["document"])
  })
  const uuidParam = (value: string, reason: string) =>
    decodeRouteId(value)._tag === "Left" ? refuse(reason) : Effect.void
  const readImportDoc = (businessId: string, id: string) => Effect.gen(function*() {
    const rows = yield* sql`SELECT document FROM growth_metric_import_documents WHERE id=${id} AND business_id=${businessId}`
    if (!rows[0]) return yield* refuse("GrowthNotFound")
    return yield* decodeRow(ImportDocument, "growth_metric_imports", rows[0]["document"])
  })
  const readPlanDoc = (businessId: string, id: string) => Effect.gen(function*() {
    const rows = yield* sql`SELECT document FROM growth_measurement_plan_documents WHERE id=${id} AND business_id=${businessId}`
    if (!rows[0]) return yield* refuse("GrowthNotFound")
    return yield* decodeRow(PlanDocumentCodec, "growth_measurement_plans", rows[0]["document"])
  })
  const firstLinkedExecutionAt = (businessId: string, opportunityId: string) => Effect.gen(function*() {
    const rows = yield* sql`SELECT MIN(i.performed_at) AS first_at FROM growth_initiative_actions a
      JOIN interventions i ON i.id=a.intervention_id AND i.business_id=a.business_id
      WHERE a.opportunity_id=${opportunityId} AND a.business_id=${businessId}
      AND NOT EXISTS (SELECT 1 FROM interventions c WHERE c.supersedes_id=i.id)`
    const raw = rows[0]?.["first_at"]
    if (raw == null) return null
    const d = raw instanceof Date ? raw : new Date(String(raw))
    return Number.isNaN(d.getTime()) ? null : d.toISOString()
  })
  const asTiming = (plan: PlanDocument, firstAt: string | null): GrowthPlanRead => {
    const declared = Date.parse(plan.declaredAt)
    const afterFirst = firstAt !== null && !Number.isNaN(declared) && declared > Date.parse(firstAt)
    return { plan, timing: afterFirst ? "DECLARED_AFTER_EXECUTION" : "PRE_DECLARED", firstLinkedExecutionAt: firstAt }
  }
  /** One parse per import attempt, chosen by the definition's source kind. */
  const parseFor = (input: ImportInput, def: Definition): GrowthMeasurementEffect<{
    readonly rows: ReadonlyArray<GrowthDailyRow>; readonly digest: string; readonly coverage: GrowthMetricCoverage
  }> => Effect.gen(function*() {
    const start = input.dateStart, end = input.dateEnd
    const span = betweenDays(start, end)
    if (span === null || span < 0) return yield* refuse("InvalidDateRange")
    if (def.sourceKind === "GA4_AGGREGATE_EXPORT") {
      if (def.propertyRef === null || def.eventName === null) return yield* refuse("InvalidRequest")
      const parsed = parseGa4Export(input.csv, {
        dataOrigin: input.provenance === "SYNTHETIC_FIXTURE" ? "SYNTHETIC_FIXTURE" : "GA4_EXPORT",
        propertyRef: def.propertyRef, dateStart: start, dateEnd: end, timeZone: def.reportingTimeZone,
        attributionBasis: "SESSION_SOURCE_MEDIUM", conversionEvent: def.eventName,
      })
      if (!parsed.ok) return yield* refuse(parsed.reason)
      const aggregated = aggregateGa4KeyEvents(parsed.rows)
      if (!aggregated.ok) return yield* refuse(aggregated.reason)
      return { rows: aggregated.rows, digest: parsed.digest, coverage: coverageOf({ dateStart: start, dateEnd: end }, aggregated.rows) }
    }
    const parsed = parseDailyCounts(input.csv, { dateStart: start, dateEnd: end })
    if (!parsed.ok) return yield* refuse(parsed.reason)
    return { rows: parsed.rows, digest: parsed.digest, coverage: coverageOf({ dateStart: start, dateEnd: end }, parsed.rows) }
  })
  return {
    imports: (accountId, businessId, metricDefinitionId, limit = 50) => Effect.gen(function*() {
      yield* scope(accountId, businessId)
      yield* uuidParam(metricDefinitionId, "InvalidRequest")
      const rows = yield* sql`SELECT document FROM growth_metric_import_documents WHERE business_id=${businessId} AND metric_definition_id=${metricDefinitionId}
        ORDER BY imported_at DESC, id DESC LIMIT ${Math.min(100, Math.max(1, limit))}`
      return yield* Effect.forEach(rows, row => decodeRow(ImportDocument, "growth_metric_imports", row["document"]))
    }),
    importDaily: (session, businessId, metricDefinitionId, rawInput) => sql.withTransaction(Effect.gen(function*() {
      yield* member(session, businessId)
      const input = yield* parse(GrowthMetricImportInput, rawInput)
      yield* uuidParam(metricDefinitionId, "InvalidRequest")
      // Serializing per business makes the digest replay decision observe
      // previously committed files before any new import is inserted.
      yield* sql`SELECT business_id FROM record_profiles WHERE business_id=${businessId} FOR UPDATE`
      const def = yield* definition(businessId, metricDefinitionId)
      if (def.countingSemantics !== "EVENT_COUNT" || def.unit !== "COUNT" || def.currency !== null) return yield* refuse("CurrencyMeasurementRefused")
      const parsed = yield* parseFor(input, def)
      const existing = yield* sql`SELECT id FROM growth_metric_imports WHERE business_id=${businessId} AND raw_digest=${parsed.digest}`
      if (existing[0]) {
        const doc = yield* readImportDoc(businessId, String(existing[0]["id"]))
        if (doc.metricDefinitionId === metricDefinitionId && doc.provenance === input.provenance
          && doc.dateStart === input.dateStart && doc.dateEnd === input.dateEnd) {
          return { import: doc, coverage: parsed.coverage, replayed: true }
        }
        return yield* refuse("IdempotencyConflict")
      }
      const inserted = yield* guard(sql`INSERT INTO growth_metric_imports(business_id,metric_definition_id,source_kind,provenance,property_ref,date_start,date_end,time_zone,raw_text,raw_digest,row_count,imported_by_user_id)
        VALUES(${businessId},${metricDefinitionId},${def.sourceKind},${input.provenance},${def.propertyRef},${input.dateStart},${input.dateEnd},${def.reportingTimeZone},${input.csv},${parsed.digest},${parsed.rows.length},${session.userId})
        RETURNING id`)
      const id = String(inserted[0]!["id"])
      for (const row of parsed.rows) {
        yield* guard(sql`INSERT INTO growth_metric_rows(import_id,business_id,day,value) VALUES(${id},${businessId},${row.day},${row.value})`)
      }
      const doc = yield* readImportDoc(businessId, id)
      return { import: doc, coverage: parsed.coverage, replayed: false }
    })),
    series: (accountId, businessId, metricDefinitionId, start, end) => Effect.gen(function*() {
      yield* scope(accountId, businessId)
      yield* uuidParam(metricDefinitionId, "InvalidRequest")
      if (!Schema.is(GrowthIsoDay)(start) || !Schema.is(GrowthIsoDay)(end)) return yield* refuse("InvalidRequest")
      const span = betweenDays(start, end)
      if (span === null || span < 0) return yield* refuse("InvalidSeriesRange")
      if (span > 400) return yield* refuse("SeriesRangeTooLarge")
      const def = yield* definition(businessId, metricDefinitionId)
      const resolved = yield* sql`WITH period AS (SELECT generate_series(${start}::date, ${end}::date, interval '1 day')::date AS day),
        covering AS (
          -- Coverage is any import whose declared range contains the day;
          -- value comes only from its row when one exists.
          SELECT p.day, i.id, i.imported_at, i.provenance, r.value
          FROM period p
          JOIN growth_metric_imports i ON i.business_id=${businessId} AND i.metric_definition_id=${metricDefinitionId}
            AND i.date_start <= p.day AND i.date_end >= p.day
          LEFT JOIN growth_metric_rows r ON r.business_id=i.business_id AND r.import_id=i.id AND r.day=p.day
        ), ranked AS (
          SELECT day, value, provenance,
            row_number() OVER (PARTITION BY day ORDER BY (value IS NULL), imported_at DESC, id DESC) AS rn
          FROM covering
        )
        SELECT day::text AS day, value, provenance FROM ranked WHERE rn = 1 ORDER BY day`
      const conflictRows = yield* sql`SELECT r.day::text AS day, array_agg(DISTINCT r.value)::int[] AS values
        FROM growth_metric_imports i
        JOIN growth_metric_rows r ON r.business_id=i.business_id AND r.import_id=i.id
        WHERE i.business_id=${businessId} AND i.metric_definition_id=${metricDefinitionId}
          AND i.date_start <= ${end}::date AND i.date_end >= ${start}::date
          AND r.day BETWEEN ${start}::date AND ${end}::date
        GROUP BY r.day HAVING count(DISTINCT r.value) > 1 ORDER BY r.day`
      const conflicts: GrowthSeriesConflict[] = conflictRows.map(row => ({
        day: String(row["day"]),
        values: [...((row["values"] as unknown as ReadonlyArray<number>) ?? [])].map(Number).sort((a, b) => a - b),
      }))
      const conflicting = new Set(conflicts.map(c => c.day))
      const resolvedByDay = new Map<string, { value: number | null; provenance: GrowthImportProvenance }>()
      for (const row of resolved) {
        resolvedByDay.set(String(row["day"]), {
          value: row["value"] == null ? null : Number(row["value"]),
          provenance: String(row["provenance"] ?? "") as GrowthImportProvenance,
        })
      }
      const days: GrowthSeriesDay[] = []
      for (let ms = dayMs(start); ms <= dayMs(end); ms += msPerDay) {
        const day = new Date(ms).toISOString().slice(0, 10)
        const found = resolvedByDay.get(day)
        if (!found) { days.push({ day, value: null, origin: null, status: "UNAVAILABLE" }); continue }
        if (found.value === null) { days.push({ day, value: null, origin: null, status: "MISSING" }); continue }
        days.push({
          day, value: found.value,
          origin: found.provenance === "OPERATOR_SUPPLIED_EXPORT" ? "REAL" : "SYNTHETIC",
          status: conflicting.has(day) ? "CONFLICT" : "OK",
        })
      }
      return {
        businessId, metricDefinitionId, metricLabel: def.label, definitionVersion: def.version, sourceKind: def.sourceKind,
        countingSemantics: def.countingSemantics, unit: def.unit, timeZone: def.reportingTimeZone, start, end, days, conflicts,
      } satisfies GrowthSeries
    }),
    declarePlan: (session, businessId, opportunityId, raw) => sql.withTransaction(Effect.gen(function*() {
      yield* member(session, businessId)
      const input = yield* parse(GrowthMeasurementPlanInput, raw)
      yield* uuidParam(opportunityId, "InvalidRequest")
      const baselineSpan = betweenDays(input.baselineStart, input.baselineEnd)
      const observationSpan = betweenDays(input.observationStart, input.observationEnd)
      if (baselineSpan === null || observationSpan === null || baselineSpan < 0 || observationSpan < 0
        || baselineSpan > 365 || observationSpan > 365 || input.observationStart <= input.baselineEnd) return yield* refuse("InvalidPlanWindow")
      const locked = yield* sql`SELECT id FROM growth_opportunities WHERE id=${opportunityId} AND business_id=${businessId} FOR UPDATE`
      if (!locked.length) return yield* refuse("OpportunityNotFound")
      const bound = yield* sql`SELECT e.status AS status, g.metric_definition_id AS definition_id,
          d.counting_semantics AS counting_semantics, d.unit AS unit
        FROM growth_opportunities o
        JOIN growth_goals g ON g.id=o.goal_id AND g.business_id=o.business_id
        JOIN growth_metric_definitions d ON d.id=g.metric_definition_id AND d.business_id=o.business_id
        JOIN LATERAL (SELECT status FROM growth_opportunity_events e WHERE e.opportunity_id=o.id AND e.business_id=o.business_id ORDER BY revision DESC LIMIT 1) e ON true
        WHERE o.id=${opportunityId} AND o.business_id=${businessId}`
      if (!bound[0]) return yield* refuse("OpportunityNotFound")
      if (String(bound[0]["counting_semantics"]) !== "EVENT_COUNT" || String(bound[0]["unit"]) !== "COUNT") return yield* refuse("CurrencyMeasurementRefused")
      if (String(bound[0]["status"]) !== "APPROVED") return yield* refuse("PlanOpportunityNotApproved")
      const planDefinitionId = String(bound[0]["definition_id"])
      const replay = yield* sql`SELECT id FROM growth_measurement_plans WHERE opportunity_id=${opportunityId} AND request_key=${input.idempotencyKey}`
      if (replay[0]) {
        const doc = yield* readPlanDoc(businessId, String(replay[0]["id"]))
        const matches = doc.baselineStart === input.baselineStart && doc.baselineEnd === input.baselineEnd
          && doc.observationStart === input.observationStart && doc.observationEnd === input.observationEnd
        if (!matches) return yield* refuse("IdempotencyConflict")
        return asTiming(doc, yield* firstLinkedExecutionAt(businessId, opportunityId))
      }
      const inserted = yield* guard(sql`INSERT INTO growth_measurement_plans(opportunity_id,business_id,metric_definition_id,baseline_start,baseline_end,observation_start,observation_end,declared_by_user_id,request_key)
        VALUES(${opportunityId},${businessId},${planDefinitionId},${input.baselineStart},${input.baselineEnd},${input.observationStart},${input.observationEnd},${session.userId},${input.idempotencyKey}) RETURNING id`)
      const doc = yield* readPlanDoc(businessId, String(inserted[0]!["id"]))
      return asTiming(doc, yield* firstLinkedExecutionAt(businessId, opportunityId))
    })),
    plan: (accountId, businessId, opportunityId) => Effect.gen(function*() {
      yield* scope(accountId, businessId)
      yield* uuidParam(opportunityId, "InvalidRequest")
      const rows = yield* sql`SELECT id FROM growth_measurement_plan_documents
        WHERE opportunity_id=${opportunityId} AND business_id=${businessId} ORDER BY declared_at DESC, id DESC LIMIT 1`
      if (!rows[0]) return null
      const doc = yield* readPlanDoc(businessId, String(rows[0]["id"]))
      return asTiming(doc, yield* firstLinkedExecutionAt(businessId, opportunityId))
    }),
  } satisfies Context.Tag.Service<GrowthMeasurementRepository>
}))
