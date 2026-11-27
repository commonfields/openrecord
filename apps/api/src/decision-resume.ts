// A chat waiting on the owner picks its work back up once they decide. When
// the owner approves or declines something the agent saved in a chat (a page
// change, a publication, a campaign review, a strategy, an account action, a
// draft), that chat gets the next turn by itself: confirm what happened and take
// the next step, or revise from the reason given. It runs on the server, so it
// does not depend on the app staying open. Growth initiatives have their own
// make-and-revise work (approved-initiative-enqueue.ts) and are not resumed here.
//
// The turn is OpenRecord's, marked as such in the chat, and has the same tools
// as any chat turn: it can prepare and propose, never approve, publish or spend.
// A chat that is busy when the job runs is tried again later.
import { randomUUID } from "node:crypto"
import { SqlClient } from "@effect/sql"
import { Cause, Effect, Either } from "effect"
import { AgentWorkRetry, enqueueAgentWork } from "./agent-work-queue.js"
import { retryableTurnFailure, sendUnattendedTurn, type UnattendedSender } from "./unattended-agent.js"

type Scope = { readonly accountId: string; readonly userId: string; readonly businessId: string }

export type DecisionResumePayload = {
  readonly scope: Scope
  readonly conversationId: string
  readonly kind: string
  readonly itemId: string
  readonly message: string
}

/** Kinds a chat card can carry, other than growth initiatives. */
export const RESUMED_KINDS = new Set(["CAMPAIGN_PUBLICATION", "CAMPAIGN_REVIEW", "MARKETING_STRATEGY", "AGENT_PROPOSAL", "AGENT_DRAFT", "WORDPRESS_CHANGE", "WEBFLOW_CHANGE", "GITHUB_CHANGE", "ACCOUNT_ACTION"])

const cut = (s: string, n: number) => s.replace(/\s+/g, " ").trim().slice(0, n)

/** What the chat is told. The owner's words are quoted as data. */
export const decisionResumeMessage = (input: { readonly approved: boolean; readonly title: string; readonly reason: string | null }) =>
  `OpenRecord notice: the owner ${input.approved ? "approved" : "declined"} «${cut(input.title, 300)}»` +
  (input.reason ? ` and said: «${cut(input.reason, 500)}»` : "") + ". " +
  (input.approved
    ? "Read its current state with the matching read (read_proposals, read_wordpress_content, read_campaign_delivery and so on) and say plainly what happened: done, verified, still pending or failed. Then take the next step this was waiting for, in this turn."
    : "Do not offer the same thing again. Using their reason, revise it or prepare a better option in this turn, and say what changed.") +
  " Do not ask the owner to decide this same item again."

/**
 * The chat whose agent reply carried this item as a decision card, newest
 * first, in the business and account where it was decided. Null when none
 * does (an item made outside a chat) or the chat's person left the account.
 */
const originatingChat = (accountId: string, businessId: string, itemId: string) => Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql`SELECT c.id, c.user_id FROM agent_conversations c
    JOIN account_users u ON u.account_id=c.account_id AND u.user_id=c.user_id
    WHERE c.account_id=${accountId} AND c.business_id=${businessId} AND c.expires_at>now()
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(c.messages) m WHERE m->>'role'='agent'
        AND m->'decisions' @> ${JSON.stringify([{ id: itemId }])}::jsonb)
    ORDER BY c.updated_at DESC LIMIT 1`
  return rows[0] ? { conversationId: String(rows[0]["id"]), userId: String(rows[0]["user_id"]) } : null
})

/** Queues the chat's next turn after a decision. Nothing happens for kinds it does not cover or items no chat carried. */
export const enqueueDecisionResume = (input: {
  readonly accountId: string; readonly businessId: string; readonly kind: string; readonly itemId: string
  readonly approved: boolean; readonly title: string; readonly reason: string | null
}) => Effect.gen(function*() {
  if (!RESUMED_KINDS.has(input.kind)) return null
  const chat = yield* originatingChat(input.accountId, input.businessId, input.itemId)
  if (!chat) return null
  const scope = { accountId: input.accountId, userId: chat.userId, businessId: input.businessId }
  return yield* enqueueAgentWork({
    ...scope, kind: "DECISION_RESUME_WRITE", refId: input.itemId,
    payload: { scope, conversationId: chat.conversationId, kind: input.kind, itemId: input.itemId,
      message: decisionResumeMessage(input) } satisfies DecisionResumePayload,
  })
})

const conversationBusy = (e: unknown) => typeof e === "object" && e !== null && (e as { _tag?: string })._tag === "AgentConversationRefused"
  && ["BUSY", "STALE"].includes(String((e as { reason?: unknown }).reason))

/** Runs the turn. A busy chat or a passing model failure with nothing saved runs again later; anything else is final. */
export const writeDecisionResumeJob = <R>(raw: DecisionResumePayload, sender: UnattendedSender<R>, tries: { readonly finalAttempt: boolean }) => Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const since = new Date()
  const revision = Number((yield* sql`SELECT revision FROM agent_conversations WHERE id=${raw.conversationId} AND expires_at>now()`)[0]?.["revision"] ?? -1)
  if (revision < 0) return yield* Effect.fail("DECISION_RESUME_CHAT_GONE" as const)
  const result = yield* sendUnattendedTurn(raw.scope, sender, { message: raw.message, requestId: randomUUID(), conversationId: raw.conversationId,
    revision, origin: { kind: "wake", title: "After your decision" } }).pipe(Effect.either)
  if (Either.isRight(result)) return
  if (!tries.finalAttempt && conversationBusy(result.left)) return yield* Effect.fail(new AgentWorkRetry({ reason: "CHAT_BUSY" }))
  const retry = tries.finalAttempt ? null : yield* retryableTurnFailure(result.left, raw.conversationId, since)
  if (retry) return yield* Effect.fail(new AgentWorkRetry({ reason: retry }))
  yield* Effect.logWarning("decision resume turn failed").pipe(Effect.annotateLogs({ business: raw.scope.businessId, cause: Cause.pretty(Cause.fail(result.left)).slice(0, 400) }))
  return yield* Effect.fail("DECISION_RESUME_FAILED" as const)
})
