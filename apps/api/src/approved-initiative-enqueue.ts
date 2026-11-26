// Enqueue only: no agent loop imports (avoids decision-feedback → agent-registry cycle).
import { Effect } from "effect"
import type { GrowthOpportunity } from "@openrecord/contracts"
import type { Session } from "@openrecord/db"
import { enqueueAgentWork } from "./agent-work-queue.js"
import { openArchivedWorkChat } from "./agent-work-chat.js"
import { approvedInitiativeMessage, declinedInitiativeMessage } from "./approved-initiative-messages.js"
import type { ApprovedInitiativeWritePayload } from "./approved-initiative-turn.js"

export const enqueueApprovedInitiativeWork = (session: Session, businessId: string, opportunity: GrowthOpportunity) =>
  Effect.gen(function*() {
    const scope = { accountId: session.accountId, userId: session.userId, businessId }
    const conversationId = yield* openArchivedWorkChat(scope, `Making: ${opportunity.title}`)
    const message = approvedInitiativeMessage(opportunity.title, opportunity.proposedChange)
    return yield* enqueueAgentWork({
      accountId: scope.accountId, userId: scope.userId, businessId,
      kind: "APPROVED_INITIATIVE_WRITE", refId: opportunity.id,
      payload: { scope, conversationId, opportunityId: opportunity.id, message } satisfies ApprovedInitiativeWritePayload,
    })
  })

export const enqueueDeclinedInitiativeWork = (
  session: Session,
  businessId: string,
  opportunityId: string,
  title: string,
  reason: string | null,
) => Effect.gen(function*() {
  const scope = { accountId: session.accountId, userId: session.userId, businessId }
  const conversationId = yield* openArchivedWorkChat(scope, `Revising: ${title}`)
  const message = declinedInitiativeMessage(title, reason)
  return yield* enqueueAgentWork({
    accountId: scope.accountId, userId: scope.userId, businessId,
    kind: "DECLINED_INITIATIVE_WRITE", refId: opportunityId,
    payload: { scope, conversationId, opportunityId, message } satisfies ApprovedInitiativeWritePayload,
  })
})