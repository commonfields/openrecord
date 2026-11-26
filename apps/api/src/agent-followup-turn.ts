import { Effect } from "effect"
import type { CampaignFollowupPayload, InvestigationFollowupPayload } from "./agent-followup-enqueue.js"

export const writeInvestigationFollowupJob = (raw: InvestigationFollowupPayload) =>
  Effect.gen(function*() {
    const m = yield* Effect.promise(() => import("./agent-followups.js"))
    if ((yield* m.deliverFollowup(raw.wake)) === "Failure") return yield* Effect.fail("INVESTIGATION_FOLLOWUP_FAILED" as const)
  })

export const writeCampaignFollowupJob = (raw: CampaignFollowupPayload) =>
  Effect.gen(function*() {
    const m = yield* Effect.promise(() => import("./campaign-followups.js"))
    if ((yield* m.deliverCampaignFollowup(raw.wake)) === "Failure") return yield* Effect.fail("CAMPAIGN_FOLLOWUP_FAILED" as const)
  })
