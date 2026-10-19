import { HttpRouter } from "@effect/platform"
import { Effect } from "effect"
import { BusinessRepository, GrowthRefused, GrowthRepository, type Session } from "@openrecord/db"
import { CreateGrowthOpportunity, GrowthDecision, GrowthExecutionRecord, GrowthReview, GrowthProductInput, GrowthProfileUpdate, decodeRouteId } from "@openrecord/contracts"
import { decode, json, operatorSessionFor, readJson, type WithSession } from "./record-routes.js"

const failure = (e: unknown) => {
  if (e instanceof GrowthRefused) return json(e.reason.endsWith("NotFound") ? 404 : e.reason === "InvalidRequest" || e.reason === "ExecutionTimeRefused" ? 422 : 409, { _tag: "GrowthRefused", reason: e.reason })
  if (typeof e === "object" && e !== null && "_tag" in e && e._tag === "NotAuthenticated") return json(401, { _tag: "NotAuthenticated" })
  return json(500, { _tag: "GrowthRequestFailed" })
}
export const growthApi = (withSession: WithSession) => {
  const operator = operatorSessionFor(withSession)
  const client = <E, R>(run: (session: Session, businessId: string, opportunityId: string | undefined) => Effect.Effect<import("@effect/platform/HttpServerResponse").HttpServerResponse, E, R>) =>
    operator(session => Effect.gen(function*() {
      const { params } = yield* HttpRouter.RouteContext
      const businessId = params["id"] ?? ""
      const opportunityId = params["opportunityId"]
      if (decodeRouteId(businessId)._tag === "Left" || (opportunityId !== undefined && decodeRouteId(opportunityId)._tag === "Left")) return yield* json(422, { _tag: "InvalidRequest" })
      if (!(yield* (yield* BusinessRepository).getScoped(session.accountId, businessId))) return yield* json(404, { _tag: "GrowthNotFound" })
      return yield* run(session, businessId, opportunityId)
    })).pipe(Effect.catchAll(failure))
  const decision = (to: "APPROVED" | "CANCELLED") => client((session, businessId, id) => Effect.gen(function*() {
    const input = decode(GrowthDecision, yield* readJson)
    if (!input || !id) return yield* json(422, { _tag: "InvalidRequest" })
    return yield* json(200, { opportunity: yield* (yield* GrowthRepository).decide(session, businessId, id, to, input) })
  }))
  return HttpRouter.empty.pipe(
    HttpRouter.post("/api/growth/products", operator(session => Effect.gen(function*() {
      const input = decode(GrowthProductInput, yield* readJson)
      if (!input) return yield* json(422, { _tag: "InvalidRequest" })
      return yield* json(200, { profile: yield* (yield* GrowthRepository).registerProduct(session, input) })
    })).pipe(Effect.catchAll(failure))),
    HttpRouter.get("/api/growth/clients/:id", client((session, id) => Effect.gen(function*() {
      const repo = yield* GrowthRepository
      return yield* json(200, { profile: yield* repo.profile(session.accountId, id), goals: yield* repo.goals(session.accountId, id) })
    }))),
    HttpRouter.put("/api/growth/clients/:id", client((session, id) => Effect.gen(function*() {
      const input = decode(GrowthProfileUpdate, yield* readJson)
      if (!input) return yield* json(422, { _tag: "InvalidRequest" })
      return yield* json(200, { profile: yield* (yield* GrowthRepository).saveProfile(session, id, input) })
    }))),
    HttpRouter.get("/api/growth/clients/:id/opportunities", client((session, id) => Effect.gen(function*() {
      return yield* json(200, { opportunities: yield* (yield* GrowthRepository).list(session.accountId, id) })
    }))),
    HttpRouter.get("/api/growth/clients/:id/opportunities/:opportunityId", client((session, id, opportunityId) => Effect.gen(function*() {
      if (!opportunityId) return yield* json(404, { _tag: "GrowthNotFound" })
      return yield* json(200, { opportunity: yield* (yield* GrowthRepository).get(session.accountId, id, opportunityId) })
    }))),
    HttpRouter.post("/api/growth/clients/:id/opportunities", client((session, id) => Effect.gen(function*() {
      const input = decode(CreateGrowthOpportunity, yield* readJson)
      if (!input || input.evidence.some(e => e.type === "MODEL_SUGGESTION")) return yield* json(422, { _tag: "InvalidRequest" })
      return yield* json(200, { opportunity: yield* (yield* GrowthRepository).create(session, id, "OPERATOR", input) })
    }))),
    HttpRouter.post("/api/growth/clients/:id/opportunities/:opportunityId/propose", client((session, businessId, id) => Effect.gen(function*() {
      const input = decode(GrowthDecision, yield* readJson)
      if (!input || !id) return yield* json(422, { _tag: "InvalidRequest" })
      return yield* json(200, { opportunity: yield* (yield* GrowthRepository).propose(session, businessId, id, input) })
    }))),
    HttpRouter.post("/api/growth/clients/:id/opportunities/:opportunityId/executions", client((session, businessId, id) => Effect.gen(function*() {
      const input = decode(GrowthExecutionRecord, yield* readJson)
      if (!input || !id) return yield* json(422, { _tag: "InvalidRequest" })
      return yield* json(200, { opportunity: yield* (yield* GrowthRepository).recordExecution(session, businessId, id, input) })
    }))),
    HttpRouter.post("/api/growth/clients/:id/opportunities/:opportunityId/review", client((session, businessId, id) => Effect.gen(function*() {
      const input = decode(GrowthReview, yield* readJson)
      if (!input || !id) return yield* json(422, { _tag: "InvalidRequest" })
      return yield* json(200, { opportunity: yield* (yield* GrowthRepository).review(session, businessId, id, input) })
    }))),
    HttpRouter.post("/api/growth/clients/:id/opportunities/:opportunityId/approve", decision("APPROVED")),
    HttpRouter.post("/api/growth/clients/:id/opportunities/:opportunityId/cancel", decision("CANCELLED")),
    HttpRouter.post("/api/growth/clients/:id/opportunities/:opportunityId/reject", decision("CANCELLED")),
  )
}
