import { HttpIncomingMessage, HttpRouter, HttpServerRequest } from "@effect/platform"
import { Effect, Option } from "effect"
import { BusinessRepository } from "@openrecord/db"
import {
  HarnessActivation,
  HarnessPairRequest,
  HarnessPoll,
  HarnessRegister,
  HarnessJobResult,
  decodeRouteId
} from "@openrecord/contracts"
import { configuredAgentModel } from "./agent-model.js"
import { decode, json, operatorSessionFor, readJson as readRequestJson, type WithSession } from "./record-routes.js"
import {
  HarnessRefused,
  activateHarness,
  authenticateBridge,
  cancelHarnessConversation,
  completeHarnessJob,
  createPair,
  harnessCatalog,
  pollHarnessJobs,
  registerBridge,
  requestHarnessRefresh,
  revokeBridge,
  type BridgeIdentity
} from "./harness-store.js"

const readJson = readRequestJson.pipe(HttpIncomingMessage.withMaxBodySize(Option.some(200000)))

const failure = (e: unknown) => {
  if (e instanceof HarnessRefused)
    return json(
      e.reason === "UNAUTHENTICATED" ? 401 : e.reason === "NOT_FOUND" ? 404 : 409,
      { _tag: "HarnessUnavailable", reason: e.reason },
      { "cache-control": "no-store" }
    )
  if (typeof e === "object" && e !== null && "_tag" in e && e._tag === "NotAuthenticated")
    return json(401, { _tag: "NotAuthenticated" })
  return json(500, { _tag: "HarnessRequestFailed" })
}
const invalid = () => json(422, { _tag: "InvalidRequest" })
const routeId = Effect.gen(function* () {
  const { params } = yield* HttpRouter.RouteContext
  const id = params["id"] ?? ""
  return decodeRouteId(id)._tag === "Right" ? id : null
})

export const harnessApi = (withSession: WithSession) => {
  const operator = operatorSessionFor(withSession)
  const bridge = <E, R>(
    act: (
      identity: BridgeIdentity
    ) => Effect.Effect<import("@effect/platform/HttpServerResponse").HttpServerResponse, E, R>
  ) =>
    Effect.gen(function* () {
      const req = yield* HttpServerRequest.HttpServerRequest
      // Bridge routes accept bearer capabilities only, never ambient cookies.
      if (req.headers["origin"] !== undefined) return yield* json(403, { _tag: "OriginRefused" })
      const token = req.headers["authorization"]?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1] ?? ""
      return yield* act(yield* authenticateBridge(token))
    }).pipe(Effect.catchAll(failure))
  return HttpRouter.empty.pipe(
    HttpRouter.get(
      "/api/agent/providers",
      operator((session) =>
        Effect.gen(function* () {
          const catalog = yield* harnessCatalog(session)
          const hosted = yield* configuredAgentModel.pipe(
            Effect.map((m) => ({ provider: m.provider, model: m.requestedModel })),
            Effect.orElseSucceed(() => null)
          )
          return yield* json(200, { ...catalog, hosted }, { "cache-control": "no-store" })
        })
      ).pipe(Effect.catchAll(failure))
    ),
    HttpRouter.post(
      "/api/agent/bridges/pairs",
      operator((session) =>
        Effect.gen(function* () {
          const body = decode(HarnessPairRequest, yield* readJson)
          if (!body) return yield* invalid()
          return yield* json(200, yield* createPair(session, body.name), {
            "cache-control": "no-store",
            "referrer-policy": "no-referrer"
          })
        })
      ).pipe(Effect.catchAll(failure))
    ),
    HttpRouter.del(
      "/api/agent/bridges/:id",
      operator((session) =>
        Effect.gen(function* () {
          const id = yield* routeId
          if (!id) return yield* invalid()
          yield* revokeBridge(session, id)
          return yield* json(200, { revoked: true })
        })
      ).pipe(Effect.catchAll(failure))
    ),
    HttpRouter.patch(
      "/api/agent/providers/:id",
      operator((session) =>
        Effect.gen(function* () {
          const id = yield* routeId,
            body = decode(HarnessActivation, yield* readJson)
          if (!id || !body) return yield* invalid()
          yield* activateHarness(session, id, body.enabled)
          return yield* json(200, { updated: true })
        })
      ).pipe(Effect.catchAll(failure))
    ),
    HttpRouter.post(
      "/api/agent/providers/:id/refresh",
      operator((session) =>
        Effect.gen(function* () {
          const id = yield* routeId
          if (!id) return yield* invalid()
          yield* requestHarnessRefresh(session, id)
          return yield* json(200, { requested: true, refreshWithinSeconds: 30 })
        })
      ).pipe(Effect.catchAll(failure))
    ),
    HttpRouter.post(
      "/api/businesses/:id/agent/cancel",
      operator((session) =>
        Effect.gen(function* () {
          const id = yield* routeId
          if (!id) return yield* invalid()
          if (!(yield* (yield* BusinessRepository).getScoped(session.accountId, id)))
            return yield* json(404, { _tag: "BusinessNotFound" })
          yield* cancelHarnessConversation({ ...session, businessId: id })
          return yield* json(200, { cancelled: true })
        })
      ).pipe(Effect.catchAll(failure))
    ),
    HttpRouter.post(
      "/api/bridge/register",
      Effect.gen(function* () {
        const req = yield* HttpServerRequest.HttpServerRequest
        if (req.headers["origin"] !== undefined) return yield* json(403, { _tag: "OriginRefused" })
        const input = decode(HarnessRegister, yield* readJson)
        if (!input) return yield* invalid()
        return yield* json(200, yield* registerBridge(input.code), { "cache-control": "no-store" })
      }).pipe(Effect.catchAll(failure))
    ),
    HttpRouter.post(
      "/api/bridge/poll",
      bridge((identity) =>
        Effect.gen(function* () {
          const body = decode(HarnessPoll, yield* readJson)
          if (!body || JSON.stringify(body).length > 200000) return yield* invalid()
          return yield* json(200, yield* pollHarnessJobs(identity, body.reports, body.acceptJob), {
            "cache-control": "no-store"
          })
        })
      )
    ),
    HttpRouter.post(
      "/api/bridge/jobs/:id/result",
      bridge((identity) =>
        Effect.gen(function* () {
          const id = yield* routeId
          const body = decode(HarnessJobResult, yield* readJson)
          if (!id || !body || JSON.stringify(body).length > 100000) return yield* invalid()
          yield* completeHarnessJob(identity, id, body)
          return yield* json(200, { accepted: true })
        })
      )
    )
  )
}
