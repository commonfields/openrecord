import { randomUUID } from "node:crypto"
import { SqlClient } from "@effect/sql"
import { Effect } from "effect"

type Scope = { readonly accountId: string; readonly userId: string; readonly businessId: string }

/** A dedicated archived chat for background agent work on this business. */
export const openArchivedWorkChat = (scope: Scope, title: string) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const conversationId = randomUUID()
    yield* sql`INSERT INTO agent_conversations(id, account_id, business_id, user_id, archived_at, last_reply)
      VALUES (${conversationId}, ${scope.accountId}, ${scope.businessId}, ${scope.userId}, now(), ${JSON.stringify({ title: title.slice(0, 120) })}::jsonb)`
    return conversationId
  })