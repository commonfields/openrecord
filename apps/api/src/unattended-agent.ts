// Shared turn dispatch for scheduled and setup work: resolve a working
// subscription model, then fall back to the hosted model when configured.
import type { HarnessSelection } from "@openrecord/contracts"
import { SqlClient } from "@effect/sql"
import { Effect, Either } from "effect"
import { resolveUnattendedSelection } from "./harness-selection.js"
import { TurnContinuation, continuationMessage } from "./turn-continuation.js"

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
  /** Marks the turn as OpenRecord's in the chat, not the person's. */
  readonly origin?: { readonly kind: "wake"; readonly title: string } | undefined
  /** Continue a paused turn's own conversation (agent-pause.ts). */
  readonly resume?: { readonly runId: string; readonly contents: ReadonlyArray<import("./agent-model.js").ModelContent> } | undefined
}

export type UnattendedSender<R> = (scope: Scope, body: UnattendedBody) => Effect.Effect<unknown, unknown, R>

const modelFailure = (e: unknown) =>
  typeof e === "object" && e !== null && (e as { _tag?: string })._tag === "AgentModelError"

/** Runs one turn, matching desktop model fallbacks before trying the hosted model. */
export const sendUnattendedTurn = <R>(scope: Scope, sender: UnattendedSender<R>, given: Omit<UnattendedBody, "selection">) =>
  Effect.gen(function*() {
    // A job continuing after a restart says so, and to check before repeating what its last turn may have done.
    const continued = yield* Effect.serviceOption(TurnContinuation)
    const body = continued._tag === "Some"
      ? { ...given, message: continuationMessage(given.message), origin: { kind: "wake" as const, title: "Continued after a restart" } }
      : given
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
/** Model failures a later attempt can clear: the provider was down, slow or busy, or no model was ready. */
const RETRYABLE_MODEL_FAILURES = new Set(["UNAVAILABLE", "RATE_LIMITED", "TIMEOUT", "UNCONFIGURED"])

/**
 * The retry reason for a failed unattended turn, or null when it must not run
 * again. Only a passing model failure qualifies, and only when no run in the
 * turn's own conversation since `since` completed a tool that saves, prepares
 * or delegates: running again then cannot repeat work.
 */
export const retryableTurnFailure = (error: unknown, conversationId: string, since: Date) => Effect.gen(function*() {
  if (!modelFailure(error)) return null
  const reason = String((error as { reason?: unknown }).reason ?? "")
  if (!RETRYABLE_MODEL_FAILURES.has(reason)) return null
  const sql = yield* SqlClient.SqlClient
  const wrote = yield* sql`SELECT 1 FROM agent_run_events e JOIN agent_runs r ON r.id=e.run_id
    WHERE r.conversation_id=${conversationId} AND r.started_at>=${since} AND e.type='TOOL_COMPLETED'
      AND coalesce(e.payload->>'effect','') <> 'read' LIMIT 1`
  return wrote.length ? null : `MODEL_${reason}`
})
