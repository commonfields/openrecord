import { HttpRouter } from "@effect/platform"
import { SqlClient } from "@effect/sql"
import { BusinessRepository } from "@openrecord/db"
import { decodeRouteId, FollowupConfigure, FollowupResponse, FOLLOWUP_LIMITS } from "@openrecord/contracts"
import { Effect, Schema } from "effect"
import { randomUUID } from "node:crypto"
import { configuredAgentModel } from "./agent-model.js"
import { harnessModel } from "./harness-model.js"
import { decode, json, operatorSessionFor, readJson, type WithSession } from "./record-routes.js"

const PRIVATE = { "cache-control": "no-store" }
export { FOLLOWUP_LIMITS } from "@openrecord/contracts"

/** Only an authenticated operator route can grant authority; not an agent tool. */
export const followupPolicyApi = (withSession: WithSession) => {
  const operator = operatorSessionFor(withSession)
  const route = (write: boolean) => operator(session => Effect.gen(function*() {
    const { params } = yield* HttpRouter.RouteContext
    const businessId = params["id"] ?? ""
    if (decodeRouteId(businessId)._tag === "Left") return yield* json(422, { _tag: "InvalidRequest" }, PRIVATE)
    if (!(yield* (yield* BusinessRepository).getScoped(session.accountId, businessId))) return yield* json(404, { _tag: "NotFound" }, PRIVATE)
    const sql = yield* SqlClient.SqlClient
    if (write) {
      const input = decode(FollowupConfigure, yield* readJson)
      if (!input) return yield* json(422, { _tag: "InvalidRequest" }, PRIVATE)
      if (!input.enabled) {
        yield* sql.withTransaction(Effect.gen(function*() {
          const policies = yield* sql`UPDATE growth_investigation_wake_policies SET enabled = false, grant_id = ${randomUUID()}, updated_at = now()
            WHERE account_id = ${session.accountId} AND user_id = ${session.userId} AND business_id = ${businessId} RETURNING id`
          for (const p of policies) yield* sql`UPDATE growth_investigation_wakes SET status = 'CANCELLED', finished_at = now()
            WHERE policy_id = ${p["id"]} AND status = 'RUNNING'`
        }))
      } else {
        const conversations = yield* sql`SELECT id FROM agent_conversations WHERE id = ${input.conversationId}
          AND account_id = ${session.accountId} AND user_id = ${session.userId} AND business_id = ${businessId} AND depth = 0 AND expires_at > now()`
        if (!conversations[0]) return yield* json(404, { _tag: "NotFound" }, PRIVATE)
        // Resolve configuration now without making a model call. Never fall back.
        const model = yield* (input.selection ? harnessModel({ accountId: session.accountId, userId: session.userId, businessId }, input.selection) : configuredAgentModel)
        if (model.provider !== input.expectedProvider || model.requestedModel !== input.expectedModel) return yield* json(409, { _tag: "FollowupModelChanged" }, PRIVATE)
        const rows = yield* sql`INSERT INTO growth_investigation_wake_policies(account_id,user_id,business_id,conversation_id,grant_id,enabled,selection,provider,model)
          SELECT ${session.accountId},${session.userId},${businessId},${input.conversationId},${input.requestId},true,
            ${input.selection === null ? null : JSON.stringify(input.selection)}::jsonb,${model.provider},${model.requestedModel}
          WHERE ${input.expectedGrantId}::uuid IS NULL OR EXISTS (SELECT 1 FROM growth_investigation_wake_policies
            WHERE account_id=${session.accountId} AND user_id=${session.userId} AND business_id=${businessId}
              AND grant_id IN (${input.expectedGrantId}::uuid, ${input.requestId}::uuid))
          ON CONFLICT(account_id,user_id,business_id) DO UPDATE SET enabled=true, conversation_id=EXCLUDED.conversation_id,
            grant_id=EXCLUDED.grant_id, selection=EXCLUDED.selection, provider=EXCLUDED.provider, model=EXCLUDED.model, updated_at=now()
          WHERE (growth_investigation_wake_policies.grant_id = ${input.expectedGrantId}::uuid AND EXCLUDED.grant_id <> ${input.expectedGrantId}::uuid) OR
            (growth_investigation_wake_policies.grant_id = EXCLUDED.grant_id AND growth_investigation_wake_policies.enabled AND growth_investigation_wake_policies.conversation_id=EXCLUDED.conversation_id
             AND growth_investigation_wake_policies.selection IS NOT DISTINCT FROM EXCLUDED.selection
             AND growth_investigation_wake_policies.provider=EXCLUDED.provider AND growth_investigation_wake_policies.model=EXCLUDED.model)
          RETURNING id`
        if (!rows[0]) return yield* json(409, { _tag: "GrantRequestConflict" }, PRIVATE)
      }
    }
    const policies = yield* sql`SELECT jsonb_build_object('kind','configured','enabled',enabled,'grantId',grant_id,
      'conversationId',conversation_id,'selection',selection,'provider',provider,'model',model,'updatedAt',updated_at) AS item FROM growth_investigation_wake_policies
      WHERE account_id=${session.accountId} AND user_id=${session.userId} AND business_id=${businessId}`
    const wakes = yield* sql`SELECT jsonb_build_object('id',w.id,'noteId',w.note_id,'conversationId',w.conversation_id,
      'status',w.status,'startedAt',w.started_at,'finishedAt',w.finished_at) AS item FROM growth_investigation_wakes w
      JOIN growth_investigation_wake_policies p ON p.id=w.policy_id
      WHERE p.account_id=${session.accountId} AND p.user_id=${session.userId} AND p.business_id=${businessId}
      ORDER BY w.started_at DESC LIMIT 10`
    const response = yield* Schema.decodeUnknown(FollowupResponse)({ policy: policies[0]?.["item"] ?? { kind: "unconfigured" }, limits: FOLLOWUP_LIMITS, wakes: wakes.map(row => row["item"]) })
    return yield* json(200, response, PRIVATE)
  })).pipe(Effect.catchAll(e => json(typeof e === "object" && e !== null && "_tag" in e && e._tag === "NotAuthenticated" ? 401 : 503, { _tag: "FollowupPolicyUnavailable" }, PRIVATE)))
  return HttpRouter.empty.pipe(
    HttpRouter.get("/api/businesses/:id/agent/follow-ups", route(false)),
    HttpRouter.put("/api/businesses/:id/agent/follow-ups", route(true)),
  )
}
