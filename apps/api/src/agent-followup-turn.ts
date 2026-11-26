import { Effect } from "effect"
import type { CampaignFollowupPayload, InvestigationFollowupPayload } from "./agent-followup-enqueue.js"

export const writeInvestigationFollowupJob = (raw: InvestigationFollowupPayload) =>
  Effect.gen(function*() {
    const m = yield* Effect.promise(() => import("./agent-followups.js"))
    return yield* m.deliverFollowup(raw.wake)
  })

export const writeCampaignFollowupJob = (raw: CampaignFollowupPayload) =>
  Effect.gen(function*() {
    const m = yield* Effect.promise(() => import("./campaign-followups.js"))
    return yield* m.deliverCampaignFollowup(raw.wake)
  })