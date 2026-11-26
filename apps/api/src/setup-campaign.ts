// When setup finishes, the agent starts the work itself: it researches the
// website and saves the first campaign toward the owner's goal, with finished
// deliverables. Nothing is published, sent or spent; what needs a decision
// waits for the owner. Queued in the transaction that finishes setup, once
// per setup, so a retried or replayed setup never starts a second campaign.
import { randomUUID } from "node:crypto"
import { SqlClient } from "@effect/sql"
import { Cause, Effect, Either } from "effect"
import { enqueueAgentWork, AgentWorkRetry } from "./agent-work-queue.js"
import { openArchivedWorkChat } from "./agent-work-chat.js"
import { retryableTurnFailure, sendUnattendedTurn, type UnattendedSender } from "./unattended-agent.js"

type Scope = { readonly accountId: string; readonly userId: string; readonly businessId: string }

export type SetupCampaignPayload = {
  readonly scope: Scope
  readonly setupId: string
  readonly conversationId: string
  readonly message: string
}

const cut = (s: string, n: number) => s.replace(/\s+/g, " ").trim().slice(0, n)

/** What the agent is asked once setup is done. The business's words are data, quoted. */
export const setupCampaignMessage = (input: { readonly businessName: string; readonly websiteUrl: string; readonly goal: string | null }) =>
  `OpenRecord setup is finished for «${cut(input.businessName, 200)}» (${cut(input.websiteUrl, 300)}). ` +
  (input.goal ? `The owner's goal: «${cut(input.goal, 600)}». ` : "") +
  "Start the work now, without waiting to be asked. Read the approved business facts and the website, then the closest competitors. " +
  "Save one concrete first campaign toward the goal with record_campaign_draft, make each of its deliverables with create_artifact, and bind each to the campaign. " +
  "Prefer one cheap, measurable first move over a list of channels. Nothing is published, sent or spent: anything that needs the owner's decision waits for their approval. " +
  "End with a short receipt: what you saved, what waits for their approval, and the next step."

/** Queues the first campaign. Call inside the transaction that finishes setup; a second call for the same setup does nothing. */
export const enqueueSetupCampaign = (scope: Scope, setupId: string, input: Parameters<typeof setupCampaignMessage>[0]) => Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  if ((yield* sql`SELECT 1 FROM agent_work_jobs WHERE kind='SETUP_CAMPAIGN_WRITE' AND ref_id=${setupId}`).length) return null
  const conversationId = yield* openArchivedWorkChat(scope, `Starting: ${input.businessName}`)
  return yield* enqueueAgentWork({
    ...scope, kind: "SETUP_CAMPAIGN_WRITE", refId: setupId,
    payload: { scope, setupId, conversationId, message: setupCampaignMessage(input) } satisfies SetupCampaignPayload,
  })
})

/** Runs the turn. A provider outage before anything was saved runs it again later; anything else is final. */
export const writeSetupCampaignJob = <R>(raw: SetupCampaignPayload, sender: UnattendedSender<R>, tries: { readonly finalAttempt: boolean }) => Effect.gen(function*() {
  const since = new Date()
  const result = yield* sendUnattendedTurn(raw.scope, sender, { message: raw.message, requestId: randomUUID(), conversationId: raw.conversationId, revision: 0 }).pipe(Effect.either)
  if (Either.isRight(result)) return
  const retry = tries.finalAttempt ? null : yield* retryableTurnFailure(result.left, raw.conversationId, since)
  if (retry) return yield* Effect.fail(new AgentWorkRetry({ reason: retry }))
  yield* Effect.logWarning("setup campaign turn failed").pipe(Effect.annotateLogs({ business: raw.scope.businessId, cause: Cause.pretty(Cause.fail(result.left)).slice(0, 400) }))
  return yield* Effect.fail("SETUP_CAMPAIGN_FAILED" as const)
})
