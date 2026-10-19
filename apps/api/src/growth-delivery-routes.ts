import { HttpRouter } from "@effect/platform"
import { Effect } from "effect"
import { BusinessRepository, DeliveryRefused, GrowthDeliveryRepository, GrowthRefused, type Session } from "@openrecord/db"
import { AttestDeployment, ConnectDeliveryTarget, DeliveryDecision, OpenDeliveryPullRequest, PrepareDelivery, decodeRouteId } from "@openrecord/contracts"
import { decode, json, operatorSessionFor, readJson, type WithSession } from "./record-routes.js"
import { GitHubError } from "./github-delivery.js"
import { attestDeployment, connectTarget, decideDelivery, openPullRequest, prepareDelivery, refreshDelivery } from "./growth-delivery.js"

// 404 only for OpenRecord resources outside the caller's scope; something the
// request names that GitHub does not have is an invalid request (422).
const NOT_FOUND = new Set(["GrowthNotFound", "OpportunityNotFound", "DeliveryNotFound", "TargetNotFound", "GoalNotFound", "OwnerNotFound"])
const status = (reason: string) =>
  NOT_FOUND.has(reason) ? 404
  : reason === "InvalidRequest" || reason.startsWith("Edit") || reason.startsWith("Path") || reason.startsWith("Source")
    || reason === "ResultTooLarge" || reason === "RepositoryNotFound" || reason === "BaseBranchNotFound" ? 422
  : reason === "DeliveryNotConfigured" ? 503
  : reason === "RepositoryNotAuthorized" || reason === "RepositoryInAnotherAccount" ? 403
  : 409
const failure = (e: unknown) => {
  if (e instanceof DeliveryRefused || e instanceof GrowthRefused) return json(status(e.reason), { _tag: "DeliveryRefused", reason: e.reason })
  // GitHub's own message is not shown: it can echo repository internals.
  if (e instanceof GitHubError) return json(502, { _tag: "GitHubUnavailable", kind: e.kind })
  if (typeof e === "object" && e !== null && "_tag" in e && e._tag === "NotAuthenticated") return json(401, { _tag: "NotAuthenticated" })
  return json(500, { _tag: "DeliveryRequestFailed" })
}

export const growthDeliveryApi = (withSession: WithSession) => {
  const operator = operatorSessionFor(withSession)
  const scoped = <E, R>(run: (session: Session, businessId: string, params: Readonly<Record<string, string | undefined>>) => Effect.Effect<import("@effect/platform/HttpServerResponse").HttpServerResponse, E, R>) =>
    operator(session => Effect.gen(function*() {
      const { params } = yield* HttpRouter.RouteContext
      const businessId = params["id"] ?? ""
      for (const key of ["id", "opportunityId", "deliveryId"]) {
        const value = params[key]
        if (value !== undefined && decodeRouteId(value)._tag === "Left") return yield* json(422, { _tag: "InvalidRequest" })
      }
      if (!(yield* (yield* BusinessRepository).getScoped(session.accountId, businessId))) return yield* json(404, { _tag: "DeliveryRefused", reason: "GrowthNotFound" })
      return yield* run(session, businessId, params)
    })).pipe(Effect.catchAll(failure))
  const base = "/api/growth/clients/:id"
  return HttpRouter.empty.pipe(
    HttpRouter.get(`${base}/delivery-targets`, scoped((session, id) => Effect.gen(function*() {
      return yield* json(200, { targets: yield* (yield* GrowthDeliveryRepository).targets(session.accountId, id) })
    }))),
    HttpRouter.post(`${base}/delivery-targets`, scoped((session, id) => Effect.gen(function*() {
      const input = decode(ConnectDeliveryTarget, yield* readJson)
      if (!input) return yield* json(422, { _tag: "InvalidRequest" })
      return yield* json(200, { target: yield* connectTarget(session, id, input) })
    }))),
    HttpRouter.get(`${base}/deliveries`, scoped((session, id) => Effect.gen(function*() {
      return yield* json(200, { deliveries: yield* (yield* GrowthDeliveryRepository).list(session.accountId, id, null) })
    }))),
    HttpRouter.post(`${base}/opportunities/:opportunityId/deliveries`, scoped((session, id, params) => Effect.gen(function*() {
      const input = decode(PrepareDelivery, yield* readJson)
      if (!input || !params["opportunityId"]) return yield* json(422, { _tag: "InvalidRequest" })
      return yield* json(200, { delivery: yield* prepareDelivery(session, id, params["opportunityId"], "OPERATOR", input) })
    }))),
    HttpRouter.get(`${base}/deliveries/:deliveryId`, scoped((session, id, params) => Effect.gen(function*() {
      return yield* json(200, { delivery: yield* (yield* GrowthDeliveryRepository).get(session.accountId, id, params["deliveryId"]!) })
    }))),
    HttpRouter.post(`${base}/deliveries/:deliveryId/decision`, scoped((session, id, params) => Effect.gen(function*() {
      const input = decode(DeliveryDecision, yield* readJson)
      if (!input) return yield* json(422, { _tag: "InvalidRequest" })
      return yield* json(200, { delivery: yield* decideDelivery(session, id, params["deliveryId"]!, input) })
    }))),
    // The one route that writes outside OpenRecord: a person's request opens the pull request.
    HttpRouter.post(`${base}/deliveries/:deliveryId/pull-request`, scoped((session, id, params) => Effect.gen(function*() {
      const input = decode(OpenDeliveryPullRequest, yield* readJson)
      if (!input) return yield* json(422, { _tag: "InvalidRequest" })
      const { delivery, outcome } = yield* openPullRequest(session, id, params["deliveryId"]!, input.idempotencyKey)
      const code = outcome === "OPENED" || outcome === "REPLAYED" ? 200 : outcome === "UNKNOWN" ? 502 : 409
      return yield* json(code, { delivery, outcome })
    }))),
    HttpRouter.post(`${base}/deliveries/:deliveryId/refresh`, scoped((session, id, params) => Effect.gen(function*() {
      return yield* json(200, { delivery: yield* refreshDelivery(session, id, params["deliveryId"]!) })
    }))),
    HttpRouter.post(`${base}/deliveries/:deliveryId/deployment`, scoped((session, id, params) => Effect.gen(function*() {
      const input = decode(AttestDeployment, yield* readJson)
      if (!input) return yield* json(422, { _tag: "InvalidRequest" })
      return yield* json(200, { delivery: yield* attestDeployment(session, id, params["deliveryId"]!, input) })
    }))),
  )
}
