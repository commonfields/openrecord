import { randomUUID } from "node:crypto"
import { SqlClient } from "@effect/sql"
import { Effect, Schema } from "effect"
import { enqueueAgentWork } from "./agent-work-queue.js"
import { openArchivedWorkChat } from "./agent-work-chat.js"
import { visibilityInvestigationMessage } from "./visibility-investigation-messages.js"

const Scope = Schema.Struct({ accountId: Schema.UUID, userId: Schema.UUID, businessId: Schema.UUID })
export const VisibilityInvestigationPayload = Schema.Struct({
  scope: Scope, investigationId: Schema.UUID, conversationId: Schema.UUID, requestId: Schema.UUID, message: Schema.String,
})
export type VisibilityInvestigationPayload = typeof VisibilityInvestigationPayload.Type

export const enqueueVisibilityInvestigationWork = (scope: typeof Scope.Type, investigationId: string, context: string) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    return yield* sql.withTransaction(Effect.gen(function*() {
      const scoped = yield* sql`SELECT i.id FROM growth_investigations i
        JOIN businesses b ON b.id=i.business_id
        JOIN account_users u ON u.account_id=b.account_id AND u.user_id=${scope.userId}
        WHERE i.id=${investigationId} AND b.id=${scope.businessId} AND b.account_id=${scope.accountId}
        FOR UPDATE OF i`
      if (!scoped.length) return yield* Effect.fail("VISIBILITY_INVESTIGATION_OUT_OF_SCOPE" as const)
      const previous = yield* sql<{ job_id: string }>`SELECT job_id FROM agent_work_jobs
        WHERE kind='VISIBILITY_INVESTIGATION_WRITE' AND ref_id=${investigationId}`
      if (previous[0]) return previous[0].job_id
      const conversationId = yield* openArchivedWorkChat(scope, "Visibility alert")
      const message = visibilityInvestigationMessage(investigationId, context)
      const requestId = randomUUID()
      const jobId = yield* enqueueAgentWork({
        ...scope, kind: "VISIBILITY_INVESTIGATION_WRITE", refId: investigationId,
        payload: { scope, investigationId, conversationId, requestId, message } satisfies VisibilityInvestigationPayload,
      })
      if (!jobId) return yield* Effect.fail("VISIBILITY_INVESTIGATION_QUEUE_CONFLICT" as const)
      return jobId
    }))
  })
