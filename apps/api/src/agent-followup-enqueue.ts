import { Effect } from "effect"
import { enqueueAgentWork } from "./agent-work-queue.js"
import type { CampaignWake } from "./campaign-followups.js"
import type { FollowupWake } from "./agent-followups.js"

export type InvestigationFollowupPayload = { readonly wake: FollowupWake }
export type CampaignFollowupPayload = { readonly wake: CampaignWake }

export const enqueueInvestigationFollowup = (wake: FollowupWake) =>
  enqueueAgentWork({
    accountId: wake.account_id,
    userId: wake.user_id,
    businessId: wake.business_id,
    kind: "INVESTIGATION_FOLLOWUP_WRITE",
    refId: wake.id,
    payload: { wake } satisfies InvestigationFollowupPayload,
  }).pipe(Effect.asVoid)

export const enqueueCampaignFollowup = (wake: CampaignWake) =>
  enqueueAgentWork({
    accountId: wake.account_id,
    userId: wake.user_id,
    businessId: wake.business_id,
    kind: "CAMPAIGN_FOLLOWUP_WRITE",
    refId: wake.id,
    payload: { wake } satisfies CampaignFollowupPayload,
  }).pipe(Effect.asVoid)