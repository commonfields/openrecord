// Shared turn dispatch for scheduled and setup work: resolve a working
// subscription model, then fall back to the hosted model when configured.
import type { HarnessSelection } from "@openrecord/contracts"
import { SqlClient } from "@effect/sql"
import { Effect, Either } from "effect"
import { AgentModelError } from "./agent-model.js"
import { resolveUnattendedSelection } from "./harness-selection.js"

type Scope = { readonly accountId: string; readonly userId: string; readonly businessId: string }

export const lastChatSelection = (scope: Scope) => Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql`SELECT m->'inference' AS inference FROM agent_conversations c, jsonb_array_elements(c.messages) WITH ORDINALITY AS e(m, i)
    WHERE c.account_id = ${scope.accountId} AND c.user_id = ${scope.userId} AND c.business_id = ${scope.businessId}
      AND m->>'role' = 'agent' AND m->'inference' ? 'instanceId' ORDER BY c.updated_at DESC, i DESC LIMIT 1`
  const inf = rows[0]?.["inference"] as { instanceId?: string; requestedModel?: string; reasoningEffort?: HarnessSelection["reasoningEffort"] } | undefined
  return inf?.instanceId && inf.requestedModel
    ? { instanceId: inf.instanceId, model: inf.requestedModel, ...(inf.reasoningEffort ? { reasoningEffort: inf.reasoningEffort } : {}) } as HarnessSelection
    : undefined
})

export type UnattendedBody = {
  readonly message: string
  readonly requestId: string
  readonly conversationId: string
  readonly revision: number
  readonly selection?: HarnessSelection | undefined
}

export type UnattendedSender<R> = (scope: Scope, body: UnattendedBody) => Effect.Effect<unknown, unknown, R>

const modelFailure = (e: unknown) =>
  typeof e === "object" && e !== null && (e as { _tag?: string })._tag === "AgentModelError"

/** Runs one turn, matching desktop model fallbacks before trying the hosted model. */
export const sendUnattendedTurn = <R>(scope: Scope, sender: UnattendedSender<R>, body: Omit<UnattendedBody, "selection">) =>
  Effect.gen(function*() {
    const preferred = yield* lastChatSelection(scope)
    const resolved = yield* resolveUnattendedSelection(scope, preferred)
    const send = (selection: HarnessSelection | undefined) =>
      sender(scope, { ...body, selection })
    if (resolved) {
      const first = yield* send(resolved).pipe(Effect.either)
      if (Either.isRight(first)) return first.right
      if (!modelFailure(first.left)) return yield* Effect.fail(first.left)
    }
    if (preferred && resolved && resolved.instanceId !== preferred.instanceId) {
      // Resolved a stand-in; skip repeating the broken pick.
    } else if (preferred) {
      const retry = yield* send(preferred).pipe(Effect.either)
      if (Either.isRight(retry)) return retry.right
      if (!modelFailure(retry.left)) return yield* Effect.fail(retry.left)
    }
    return yield* send(undefined)
  })