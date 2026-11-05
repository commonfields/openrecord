import { HttpRouter } from "@effect/platform"
import { SqlClient } from "@effect/sql"
import { decodeRouteId } from "@openrecord/contracts"
import { Effect } from "effect"
import { HttpServerRequest } from "@effect/platform"
import { cancelAgentRequest, enqueueAgentRequest } from "./agent-request-queue.js"
import { json, operatorSessionFor, readJson, type WithSession } from "./record-routes.js"

const PRIVATE = { "cache-control": "no-store" }
const failure = (e: unknown) => {
  const tag = (e as { _tag?: string })?._tag
  const reason = (e as { reason?: string })?.reason
  return json(tag === "NotAuthenticated" ? 401 : tag === "ParseError" ? 422 : tag === "AgentRequestRefused" ? reason === "NOT_FOUND" ? 404 : reason === "QUEUE_FULL" ? 429 : 409 : 500,
    { _tag: "AgentRequestUnavailable", ...(tag === "AgentRequestRefused" ? { reason } : {}) })
}
export const agentRequestApi = (withSession: WithSession) => {
  const operator = operatorSessionFor(withSession)
  const enqueue = (business: boolean) => operator(session => Effect.gen(function*() {
    const { params } = yield* HttpRouter.RouteContext
    const businessId = business ? params["id"] ?? "" : null
    if (businessId !== null && decodeRouteId(businessId)._tag === "Left") return yield* json(422,{ _tag: "InvalidRequest" })
    const result = yield* enqueueAgentRequest({ accountId:session.accountId,userId:session.userId,businessId },yield* readJson)
    return yield* json(202,result,PRIVATE)
  })).pipe(Effect.catchAll(failure))
  return HttpRouter.empty.pipe(
    HttpRouter.post("/api/businesses/:id/agent/requests",enqueue(true)),
    HttpRouter.post("/api/agent/requests",enqueue(false)),
    HttpRouter.get("/api/agent/requests",operator(session => Effect.gen(function*() {
      const request = yield* HttpServerRequest.HttpServerRequest
      const conversationId = new URL(request.url,"http://localhost").searchParams.get("conversationId") ?? ""
      if (decodeRouteId(conversationId)._tag === "Left") return yield* json(422,{ _tag: "InvalidRequest" })
      const sql = yield* SqlClient.SqlClient
      const rows = yield* sql`SELECT j.request_id,j.status,j.payload->>'message' AS message,j.payload->'attachments' AS attachments FROM agent_request_jobs j
        JOIN agent_conversations c ON c.id=j.conversation_id
        WHERE j.account_id=${session.accountId} AND j.user_id=${session.userId} AND j.conversation_id=${conversationId}
        AND (j.status IN ('QUEUED','RUNNING') OR (j.status IN ('FAILED','INTERRUPTED') AND j.created_at>=c.updated_at)) ORDER BY j.created_at DESC LIMIT 1`
      return yield* json(200,{ request: rows[0] ?? null },PRIVATE)
    })).pipe(Effect.catchAll(failure))),
    HttpRouter.get("/api/agent/requests/:requestId",operator(session => Effect.gen(function*() {
      const { params } = yield* HttpRouter.RouteContext
      const id=params["requestId"] ?? ""
      if (decodeRouteId(id)._tag === "Left") return yield* json(422,{ _tag:"InvalidRequest" })
      const sql=yield* SqlClient.SqlClient
      const rows=yield* sql`SELECT request_id,status,result,failure_reason,conversation_id FROM agent_request_jobs WHERE request_id=${id} AND account_id=${session.accountId} AND user_id=${session.userId}`
      return rows[0] ? yield* json(200,rows[0],PRIVATE) : yield* json(404,{ _tag:"NotFound" })
    })).pipe(Effect.catchAll(failure))),
    HttpRouter.post("/api/agent/requests/:requestId/cancel",operator(session => Effect.gen(function*() {
      const { params }=yield* HttpRouter.RouteContext
      const id=params["requestId"] ?? ""
      if (decodeRouteId(id)._tag === "Left") return yield* json(422,{ _tag:"InvalidRequest" })
      return yield* json(200,yield* cancelAgentRequest(session.accountId,session.userId,id),PRIVATE)
    })).pipe(Effect.catchAll(failure))),
  )
}
