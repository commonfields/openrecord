import { randomUUID } from "node:crypto"
import { Cause, Effect } from "effect"
import { sendSessionTurn } from "./agent-sessions.js"
import { sendUnattendedTurn, type UnattendedSender } from "./unattended-agent.js"

type Scope = { readonly accountId: string; readonly userId: string; readonly businessId: string }

export type ApprovedInitiativeWritePayload = {
  readonly scope: Scope
  readonly conversationId: string
  readonly opportunityId: string
  readonly message: string
}

const sessionSender: UnattendedSender<Effect.Effect.Context<ReturnType<typeof sendSessionTurn>>> = (scope, body) =>
  sendSessionTurn(scope, body)

const runInitiativeTurn = <R>(scope: Scope, conversationId: string, message: string, sender: UnattendedSender<R>) =>
  sendUnattendedTurn(scope, sender, { message, requestId: randomUUID(), conversationId, revision: 0 }).pipe(
    Effect.catchAllCause(cause => Effect.logWarning("initiative work turn failed").pipe(
      Effect.annotateLogs({ business: scope.businessId, conversationId, cause: Cause.pretty(cause).slice(0, 400) }),
    )),
  )

export const writeApprovedInitiativeJob = (raw: ApprovedInitiativeWritePayload) =>
  runInitiativeTurn(raw.scope, raw.conversationId, raw.message, sessionSender)

export const writeDeclinedInitiativeJob = (raw: ApprovedInitiativeWritePayload) =>
  runInitiativeTurn(raw.scope, raw.conversationId, raw.message, sessionSender)