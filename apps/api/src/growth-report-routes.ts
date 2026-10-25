// W5 client report routes. Operator routes are session- and origin-scoped
// like every growth route; the public route accepts only a report share
// capability and answers unknown and revoked links identically. Report
// content is sensitive: every response is no-store, public ones noindex.
import { HttpRouter } from "@effect/platform"
import { Effect } from "effect"
import { GrowthMeasurementRefused, GrowthReportRepository, type Session } from "@openrecord/db"
import { GrowthReportPublishInput, decodeRouteId } from "@openrecord/contracts"
import { decode, json, operatorSessionFor, readJson, type WithSession } from "./record-routes.js"

const PRIVATE_HEADERS = { "cache-control": "no-store" }
const PUBLIC_HEADERS = { "cache-control": "no-store", "x-robots-tag": "noindex, nofollow", "referrer-policy": "no-referrer" }
// Conflicts (409): IdempotencyConflict, StaleReport, ReportEvidenceChanged, ReportInitiativeNotApproved.
const failure = (e: unknown) => {
  if (e instanceof GrowthMeasurementRefused) {
    const status = e.reason === "InvalidRequest" ? 422 : e.reason.endsWith("NotFound") ? 404 : 409
    return json(status, { _tag: "GrowthReportRefused", reason: e.reason }, PRIVATE_HEADERS)
  }
  if (typeof e === "object" && e !== null && "_tag" in e && e._tag === "NotAuthenticated") return json(401, { _tag: "NotAuthenticated" }, PRIVATE_HEADERS)
  const detail = process.env["NODE_ENV"] === "test" && e instanceof Error ? String((e as unknown as { cause?: { message?: string } }).cause?.message ?? e.message) : undefined
  return json(500, { _tag: "GrowthRequestFailed", ...(detail ? { detail } : {}) }, PRIVATE_HEADERS)
}
type Response = import("@effect/platform/HttpServerResponse").HttpServerResponse

export const growthReportApi = (withSession: WithSession) => {
  const operator = operatorSessionFor(withSession)
  const scoped = <E, R>(param: string, run: (session: Session, businessId: string, id: string) => Effect.Effect<Response, E, R>) =>
    operator(session => Effect.gen(function*() {
      const { params } = yield* HttpRouter.RouteContext
      const businessId = params["id"] ?? "", id = params[param] ?? ""
      if (decodeRouteId(businessId)._tag === "Left" || decodeRouteId(id)._tag === "Left") return yield* json(422, { _tag: "InvalidRequest" }, PRIVATE_HEADERS)
      return yield* run(session, businessId, id)
    })).pipe(Effect.catchAll(failure))
  const base = "/api/growth/clients/:id"
  return HttpRouter.empty.pipe(
    HttpRouter.get(`${base}/opportunities/:opportunityId/report-preview`, scoped("opportunityId", (session, businessId, opportunityId) => Effect.gen(function*() {
      return yield* json(200, { preview: yield* (yield* GrowthReportRepository).preview(session.accountId, businessId, opportunityId) }, PRIVATE_HEADERS)
    }))),
    HttpRouter.post(`${base}/opportunities/:opportunityId/reports`, scoped("opportunityId", (session, businessId, opportunityId) => Effect.gen(function*() {
      const input = decode(GrowthReportPublishInput, yield* readJson)
      if (!input) return yield* json(422, { _tag: "InvalidRequest" }, PRIVATE_HEADERS)
      return yield* json(200, yield* (yield* GrowthReportRepository).publish(session, businessId, opportunityId, input), PRIVATE_HEADERS)
    }))),
    HttpRouter.get(`${base}/opportunities/:opportunityId/reports`, scoped("opportunityId", (session, businessId, opportunityId) => Effect.gen(function*() {
      return yield* json(200, { reports: yield* (yield* GrowthReportRepository).list(session.accountId, businessId, opportunityId) }, PRIVATE_HEADERS)
    }))),
    HttpRouter.get(`${base}/reports/:reportId`, scoped("reportId", (session, businessId, reportId) => Effect.gen(function*() {
      return yield* json(200, { report: yield* (yield* GrowthReportRepository).get(session.accountId, businessId, reportId) }, PRIVATE_HEADERS)
    }))),
    HttpRouter.post(`${base}/reports/:reportId/share`, scoped("reportId", (session, businessId, reportId) => Effect.gen(function*() {
      return yield* json(200, { share: yield* (yield* GrowthReportRepository).share(session, businessId, reportId) }, PRIVATE_HEADERS)
    }))),
    HttpRouter.post(`${base}/reports/:reportId/share/revoke`, scoped("reportId", (session, businessId, reportId) => Effect.gen(function*() {
      yield* (yield* GrowthReportRepository).revokeShare(session, businessId, reportId)
      return yield* json(200, { revoked: true }, PRIVATE_HEADERS)
    }))),
    HttpRouter.get("/api/public/growth-reports/:publicId", Effect.gen(function*() {
      const { params } = yield* HttpRouter.RouteContext
      const report = yield* (yield* GrowthReportRepository).publicReport(params["publicId"] ?? "")
      return yield* report === null ? json(404, { _tag: "ReportNotFound" }, PUBLIC_HEADERS) : json(200, { report }, PUBLIC_HEADERS)
    }).pipe(Effect.catchAll(() => json(500, { _tag: "ReportUnavailable" }, PUBLIC_HEADERS)))),
  )
}
