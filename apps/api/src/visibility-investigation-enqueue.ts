import { randomUUID } from "node:crypto"
import { SqlClient } from "@effect/sql"
import { Effect } from "effect"
import { enqueueAgentWork } from "./agent-work-queue.js"
import { openArchivedWorkChat } from "./agent-work-chat.js"
import { visibilityInvestigationMessage } from "./visibility-investigation-messages.js"

type Scope = { readonly accountId: string; readonly userId: string; readonly businessId: string }

export type VisibilityInvestigationPayload = {
  readonly scope: Scope
  readonly investigationId: string
  readonly conversationId: string
  readonly requestId: string
  readonly message: string
}

export const enqueueVisibilityInvestigationWork = (scope: Scope, investigationId: string, context: string) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const exists = (yield* sql`SELECT 1 FROM growth_investigations WHERE id = ${investigationId} AND business_id = ${scope.businessId}`)[0]
    if (!exists) return null
    const conversationId = yield* openArchivedWorkChat(scope, "Visibility alert")
    const message = visibilityInvestigationMessage(investigationId, context)
    const requestId = randomUUID()
    return yield* enqueueAgentWork({
      accountId: scope.accountId,
      userId: scope.userId,
      businessId: scope.businessId,
      kind: "VISIBILITY_INVESTIGATION_WRITE",
      refId: investigationId,
      payload: { scope, investigationId, conversationId, requestId, message } satisfies VisibilityInvestigationPayload,
    })
  })