import { Effect, Schema } from "effect"
import type { ApprovedInitiativeWritePayload } from "./approved-initiative-turn.js"
import type { CampaignFollowupPayload, InvestigationFollowupPayload } from "./agent-followup-enqueue.js"
import type { GrowthBriefWritePayload } from "./growth-brief.js"
import type { SetupDraftWritePayload } from "./setup-draft.js"

export const AgentWorkKind = Schema.Literal(
  "GROWTH_BRIEF_WRITE",
  "SETUP_DRAFT_WRITE",
  "APPROVED_INITIATIVE_WRITE",
  "DECLINED_INITIATIVE_WRITE",
  "INVESTIGATION_FOLLOWUP_WRITE",
  "CAMPAIGN_FOLLOWUP_WRITE",
  "VISIBILITY_INVESTIGATION_WRITE",
  "HELPER_TASK_RUN",
)
export type AgentWorkKind = typeof AgentWorkKind.Type

/** Dynamic imports avoid a load-time cycle through growth-brief → agent-sessions → agent-registry. */
export const runAgentWorkJob = (kind: AgentWorkKind, payload: unknown, job: {
  readonly account_id: string; readonly user_id: string; readonly business_id: string; readonly ref_id: string
  /** Absent in direct calls, which then count as the last attempt. */
  readonly attempt?: number; readonly finalAttempt?: boolean
}) =>
  Effect.gen(function*() {
    switch (kind) {
      case "GROWTH_BRIEF_WRITE": {
        const m = yield* Effect.promise(() => import("./growth-brief.js"))
        return yield* m.writeGrowthBriefJob(payload as GrowthBriefWritePayload, { finalAttempt: job.finalAttempt ?? true })
      }
      case "SETUP_DRAFT_WRITE": {
        const m = yield* Effect.promise(() => import("./setup-draft.js"))
        return yield* m.writeSetupDraftJob(payload as SetupDraftWritePayload, { finalAttempt: job.finalAttempt ?? true })
      }
      case "APPROVED_INITIATIVE_WRITE": {
        const m = yield* Effect.promise(() => import("./approved-initiative-turn.js"))
        return yield* m.writeApprovedInitiativeJob(payload as ApprovedInitiativeWritePayload)
      }
      case "DECLINED_INITIATIVE_WRITE": {
        const m = yield* Effect.promise(() => import("./approved-initiative-turn.js"))
        return yield* m.writeDeclinedInitiativeJob(payload as ApprovedInitiativeWritePayload)
      }
      case "INVESTIGATION_FOLLOWUP_WRITE": {
        const m = yield* Effect.promise(() => import("./agent-followup-turn.js"))
        return yield* m.writeInvestigationFollowupJob(payload as InvestigationFollowupPayload)
      }
      case "CAMPAIGN_FOLLOWUP_WRITE": {
        const m = yield* Effect.promise(() => import("./agent-followup-turn.js"))
        return yield* m.writeCampaignFollowupJob(payload as CampaignFollowupPayload)
      }
      case "VISIBILITY_INVESTIGATION_WRITE": {
        const m = yield* Effect.promise(() => import("./visibility-investigation-turn.js"))
        return yield* m.writeVisibilityInvestigationJob(payload, job)
      }
      case "HELPER_TASK_RUN": {
        const m = yield* Effect.promise(() => import("./agent-sessions.js"))
        return yield* m.runQueuedHelper(job, payload)
      }
      default:
        return yield* Effect.die(`unknown agent work kind: ${kind}`)
    }
  })
