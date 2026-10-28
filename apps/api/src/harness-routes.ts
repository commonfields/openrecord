import { HttpIncomingMessage, HttpRouter, HttpServerRequest } from "@effect/platform"
import { Effect, Option, Schema } from "effect"
import { BusinessRepository } from "@openrecord/db"
import {
  HarnessActivation,
  HarnessPairRequest,
  HarnessPoll,
  HarnessRegister,
  HarnessJobResult,
  HarnessJobProgress,
  AgentMessageRequest,
  decodeRouteId
} from "@openrecord/contracts"
import { configuredAgentModel } from "./agent-model.js"
import { ensureLocalBridge, localBridgeEnabled } from "./local-bridge.js"
import { AgentConversationRefused, createConversation, deleteConversation, loadConversation, sendConversation } from "./agent-conversations.js"
import { AgentModelError } from "./agent-model.js"
import { readRunProgress } from "./agent-run.js"
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
  longPollHarnessJobs,
  recordHarnessProgress,
  registerBridge,
  requestHarnessRefresh,
  revokeBridge,
  type BridgeIdentity
} from "./harness-store.js"

const readJson = readRequestJson.pipe(HttpIncomingMessage.withMaxBodySize(Option.some(200000)))

const failure = (e: unknown) => {
  if (e instanceof AgentModelError) return json(503, { _tag: "AgentUnavailable", reason: e.reason })
  if (e instanceof AgentConversationRefused)
    return json(e.reason === "NOT_FOUND" ? 404 : 409, { _tag: "ConversationUnavailable", reason: e.reason })
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
    HttpRouter.get("/api/agent/conversation", operator(session => Effect.gen(function*() {
      const req = yield* HttpServerRequest.HttpServerRequest
      const id = new URL(req.url, "http://localhost").searchParams.get("conversationId") ?? undefined
      if (id !== undefined && decodeRouteId(id)._tag !== "Right") return yield* invalid()
      return yield* json(200, { conversation: yield* loadConversation({ ...session, businessId: null }, id) }, { "cache-control": "no-store" })
    })).pipe(Effect.catchAll(failure))),
    HttpRouter.post("/api/agent/conversation", operator(session => Effect.gen(function*() {
      const body = decode(Schema.Struct({ conversationId: Schema.UUID }), yield* readJson)
      if (!body) return yield* invalid()
      return yield* json(200, { conversation: yield* createConversation({ ...session, businessId: null }, body.conversationId) }, { "cache-control": "no-store" })
    })).pipe(Effect.catchAll(failure))),
    HttpRouter.del("/api/agent/conversation", operator(session => Effect.gen(function*() {
      const req = yield* HttpServerRequest.HttpServerRequest
      const id = new URL(req.url, "http://localhost").searchParams.get("conversationId") ?? undefined
      if (id !== undefined && decodeRouteId(id)._tag !== "Right") return yield* invalid()
      yield* deleteConversation({ ...session, businessId: null }, id)
      return yield* json(200, { deleted: true })
    })).pipe(Effect.catchAll(failure))),
    HttpRouter.post("/api/agent/messages", operator(session => Effect.gen(function*() {
      const body = decode(AgentMessageRequest, yield* readJson)
      if (!body) return yield* invalid()
      return yield* json(200, yield* sendConversation({ ...session, businessId: null }, body), { "cache-control": "no-store" })
    })).pipe(Effect.catchAll(failure))),
    // Live run progress for a request the signed-in user sent: the run's state
    // and its journal after a sequence number. Reconnecting clients resume
    // from the last sequence they saw; unknown or foreign requests read as null.
    HttpRouter.get("/api/agent/runs/progress", operator(session => Effect.gen(function*() {
      const req = yield* HttpServerRequest.HttpServerRequest
      const params = new URL(req.url, "http://localhost").searchParams
      const requestId = params.get("requestId") ?? "", after = Number(params.get("after") ?? "-1")
      if (decodeRouteId(requestId)._tag !== "Right" || !Number.isInteger(after) || after < -1) return yield* invalid()
      return yield* json(200, yield* readRunProgress(session, requestId, after), { "cache-control": "no-store" })
    })).pipe(Effect.catchAll(failure))),
    HttpRouter.post("/api/agent/cancel", operator(session => Effect.gen(function*() {
      const body = decode(Schema.Struct({ conversationId: Schema.UUID }), yield* readJson)
      if (!body) return yield* invalid()
      yield* cancelHarnessConversation({ ...session, businessId: null, conversationId: body.conversationId })
      return yield* json(200, { cancelled: true })
    })).pipe(Effect.catchAll(failure))),
    HttpRouter.post("/api/businesses/:id/agent/conversation", operator(session => Effect.gen(function*() {
      const id = yield* routeId
      const body = decode(Schema.Struct({ conversationId: Schema.UUID }), yield* readJson)
      if (!id || !body) return yield* invalid()
      if (!(yield* (yield* BusinessRepository).getScoped(session.accountId, id))) return yield* json(404, { _tag: "BusinessNotFound" })
      return yield* json(200, { conversation: yield* createConversation({ ...session, businessId: id }, body.conversationId) }, { "cache-control": "no-store" })
    })).pipe(Effect.catchAll(failure))),
    HttpRouter.get(
      "/api/agent/providers",
      operator((session) =>
        Effect.gen(function* () {
          const catalog = yield* harnessCatalog(session)
          const hosted = yield* configuredAgentModel.pipe(
            Effect.map((m) => ({ provider: m.provider, model: m.requestedModel })),
            Effect.orElseSucceed(() => null)
          )
          return yield* json(200, { ...catalog, hosted, local: localBridgeEnabled() }, { "cache-control": "no-store" })
        })
      ).pipe(Effect.catchAll(failure))
    ),
    // This computer's bridge: started and paired by the server itself when it
    // runs on the person's own machine. connect: true turns it back on after
    // the person disconnected it.
    HttpRouter.post(
      "/api/agent/bridges/local",
      operator((session) =>
        Effect.gen(function* () {
          const body = decode(Schema.Struct({ connect: Schema.optional(Schema.Boolean) }), yield* readJson)
          if (!body) return yield* invalid()
          const port = Number(process.env["PORT"] ?? 3001)
          return yield* json(200, { status: yield* ensureLocalBridge(session, port, body.connect === true) }, { "cache-control": "no-store" })
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
          const body = decode(Schema.Struct({ conversationId: Schema.optional(Schema.UUID) }), yield* readJson)
          if (!body) return yield* invalid()
          yield* cancelHarnessConversation({ ...session, businessId: id, ...(body.conversationId ? { conversationId: body.conversationId } : {}) })
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
          const accept = body.acceptJob ?? true
          return yield* json(200, body.wait ? yield* longPollHarnessJobs(identity, body.reports, accept) : yield* pollHarnessJobs(identity, body.reports, body.acceptJob), {
            "cache-control": "no-store"
          })
        })
      )
    ),
    HttpRouter.post(
      "/api/bridge/jobs/:id/progress",
      bridge((identity) =>
        Effect.gen(function* () {
          const id = yield* routeId
          const body = decode(HarnessJobProgress, yield* readJson)
          if (!id || !body) return yield* invalid()
          yield* recordHarnessProgress(identity, id, body)
          return yield* json(200, { accepted: true })
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
