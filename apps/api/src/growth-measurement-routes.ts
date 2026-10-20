// W3 measurement routes: imports bound to metric definitions, per-day series
// reads, and measurement plans. W4 adds the read-only, descriptive outcome
// evaluation of one initiative. Operator-only writes; session reads stay
// scoped to the account's business.
import { HttpRouter, HttpServerRequest } from "@effect/platform"
import { Effect, Schema } from "effect"
import { GrowthEvaluationRepository, GrowthMeasurementRefused, GrowthMeasurementRepository, type Session } from "@openrecord/db"
import { GrowthIsoDay, GrowthMeasurementPlanInput, GrowthMetricImportInput, decodeRouteId } from "@openrecord/contracts"
import { decode, json, operatorSessionFor, readJson, recordFixtureAllowed, type WithSession } from "./record-routes.js"

// Import parse refusals are bad requests; scope misses are 404; anything
// else (idempotency conflicts, refused currencies, unexpected guard hits)
// is a 409.
const badRequest = new Set([
  "InvalidRequest", "InvalidDateRange", "InvalidSeriesRange", "SeriesRangeTooLarge", "InvalidPlanWindow",
  "ExportSize", "TooManyRows", "MissingHeader", "MissingColumn", "UnexpectedColumn", "MalformedRow",
  "InvalidDate", "DateOutsideRange", "DuplicateRow", "InvalidValue", "ValueTooLarge", "ConversionColumnMissing",
  "ConversionEventNotStated", "InvalidConversions", "InvalidProperty", "InvalidTimeZone", "EmptySourceValue",
])
const failure = (e: unknown) => {
  if (e instanceof GrowthMeasurementRefused) {
    const status = badRequest.has(e.reason) ? 422 : e.reason.endsWith("NotFound") ? 404 : 409
    return json(status, { _tag: "GrowthMeasurementRefused", reason: e.reason })
  }
  if (typeof e === "object" && e !== null && "_tag" in e && e._tag === "NotAuthenticated") return json(401, { _tag: "NotAuthenticated" })
  // Test-only detail: production returns no internals.
  const detail = process.env["NODE_ENV"] === "test" && e instanceof Error ? String((e as unknown as { cause?: { message?: string } }).cause?.message ?? e.message) : undefined
  return json(500, { _tag: "GrowthRequestFailed", ...(detail ? { detail } : {}) })
}
type MeasurementResponse = import("@effect/platform/HttpServerResponse").HttpServerResponse

export const growthMeasurementApi = (withSession: WithSession) => {
  const operator = operatorSessionFor(withSession)
  const metric = <E, R>(run: (session: Session, businessId: string, metricDefinitionId: string) => Effect.Effect<MeasurementResponse, E, R>) =>
    operator(session => Effect.gen(function*() {
      const { params } = yield* HttpRouter.RouteContext
      const businessId = params["id"] ?? ""
      const metricDefinitionId = params["defId"] ?? ""
      if (decodeRouteId(businessId)._tag === "Left" || decodeRouteId(metricDefinitionId)._tag === "Left") return yield* json(422, { _tag: "InvalidRequest" })
      return yield* run(session, businessId, metricDefinitionId)
    })).pipe(Effect.catchAll(failure))
  const opportunity = <E, R>(run: (session: Session, businessId: string, opportunityId: string) => Effect.Effect<MeasurementResponse, E, R>) =>
    operator(session => Effect.gen(function*() {
      const { params } = yield* HttpRouter.RouteContext
      const businessId = params["id"] ?? ""
      const opportunityId = params["opportunityId"] ?? ""
      if (decodeRouteId(businessId)._tag === "Left" || decodeRouteId(opportunityId)._tag === "Left") return yield* json(422, { _tag: "InvalidRequest" })
      return yield* run(session, businessId, opportunityId)
    })).pipe(Effect.catchAll(failure))
  return HttpRouter.empty.pipe(
    HttpRouter.post("/api/growth/clients/:id/metrics/:defId/imports", metric((session, businessId, metricDefinitionId) => Effect.gen(function*() {
      const input = decode(GrowthMetricImportInput, yield* readJson)
      if (!input) return yield* json(422, { _tag: "InvalidRequest" })
      if (input.provenance === "SYNTHETIC_FIXTURE" && !recordFixtureAllowed()) return yield* json(422, { _tag: "FixtureDisabled" })
      return yield* json(200, { result: yield* (yield* GrowthMeasurementRepository).importDaily(session, businessId, metricDefinitionId, input) })
    }))),
    HttpRouter.get("/api/growth/clients/:id/metrics/:defId/imports", metric((session, businessId, metricDefinitionId) => Effect.gen(function*() {
      const repo = yield* GrowthMeasurementRepository
      return yield* json(200, { imports: yield* repo.imports(session.accountId, businessId, metricDefinitionId) })
    }))),
    HttpRouter.get("/api/growth/clients/:id/metrics/:defId/series", metric((session, businessId, metricDefinitionId) => Effect.gen(function*() {
      const req = yield* HttpServerRequest.HttpServerRequest
      const query = new URL(req.url, "http://localhost").searchParams
      const start = query.get("start") ?? "", end = query.get("end") ?? ""
      if (!Schema.is(GrowthIsoDay)(start) || !Schema.is(GrowthIsoDay)(end)) return yield* json(422, { _tag: "InvalidRequest" })
      return yield* json(200, { series: yield* (yield* GrowthMeasurementRepository).series(session.accountId, businessId, metricDefinitionId, start, end) })
    }))),
    HttpRouter.post("/api/growth/clients/:id/opportunities/:opportunityId/measurement-plan", opportunity((session, businessId, opportunityId) => Effect.gen(function*() {
      const input = decode(GrowthMeasurementPlanInput, yield* readJson)
      if (!input) return yield* json(422, { _tag: "InvalidRequest" })
      return yield* json(200, { plan: yield* (yield* GrowthMeasurementRepository).declarePlan(session, businessId, opportunityId, input) })
    }))),
    HttpRouter.get("/api/growth/clients/:id/opportunities/:opportunityId/measurement-plan", opportunity((session, businessId, opportunityId) => Effect.gen(function*() {
      const plan = yield* (yield* GrowthMeasurementRepository).plan(session.accountId, businessId, opportunityId)
      return yield* json(200, plan === null ? { plan: null } : { plan })
    }))),
    HttpRouter.get("/api/growth/clients/:id/opportunities/:opportunityId/evaluation", opportunity((session, businessId, opportunityId) => Effect.gen(function*() {
      return yield* json(200, { evaluation: yield* (yield* GrowthEvaluationRepository).evaluate(session.accountId, businessId, opportunityId) })
    }))),
  )
}
