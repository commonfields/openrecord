import { randomUUID } from "node:crypto"
import { Cause, Effect, Either } from "effect"
import { AgentWorkRetry } from "./agent-work-queue.js"
import { sendSessionTurn } from "./agent-sessions.js"
import { retryableTurnFailure, sendUnattendedTurn, type UnattendedSender } from "./unattended-agent.js"

type Scope = { readonly accountId: string; readonly userId: string; readonly businessId: string }

export type ApprovedInitiativeWritePayload = {
  readonly scope: Scope
  readonly conversationId: string
  readonly opportunityId: string
  readonly message: string
}

const sessionSender: UnattendedSender<Effect.Effect.Context<ReturnType<typeof sendSessionTurn>>> = (scope, body) =>
  sendSessionTurn(scope, body)

type Tries = { readonly finalAttempt: boolean }
/** A provider outage before anything was saved runs the work again later; any other failure is logged and final. */
const runInitiativeTurn = <R>(scope: Scope, conversationId: string, message: string, sender: UnattendedSender<R>, tries: Tries = { finalAttempt: true }) =>
  Effect.gen(function*() {
    const since = new Date()
    const result = yield* sendUnattendedTurn(scope, sender, { message, requestId: randomUUID(), conversationId, revision: 0 }).pipe(Effect.either)
    if (Either.isRight(result)) return
    const retry = tries.finalAttempt ? null : yield* retryableTurnFailure(result.left, conversationId, since).pipe(Effect.orElseSucceed(() => null))
    if (retry) return yield* Effect.fail(new AgentWorkRetry({ reason: retry }))
    yield* Effect.logWarning("initiative work turn failed").pipe(
      Effect.annotateLogs({ business: scope.businessId, conversationId, cause: Cause.pretty(Cause.fail(result.left)).slice(0, 400) }))
  })

export const writeApprovedInitiativeJob = (raw: ApprovedInitiativeWritePayload, tries?: Tries) =>
  runInitiativeTurn(raw.scope, raw.conversationId, raw.message, sessionSender, tries)

export const writeDeclinedInitiativeJob = (raw: ApprovedInitiativeWritePayload, tries?: Tries) =>
  runInitiativeTurn(raw.scope, raw.conversationId, raw.message, sessionSender, tries)