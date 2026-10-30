import { Schema } from "effect"
import { HarnessSelection } from "./harness.js"

const Name = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(200))
export const FollowupConfigure = Schema.Union(
  Schema.Struct({ enabled: Schema.Literal(false) }),
  Schema.Struct({ enabled: Schema.Literal(true), requestId: Schema.UUID, expectedGrantId: Schema.NullOr(Schema.UUID),
    conversationId: Schema.UUID, selection: Schema.NullOr(HarnessSelection), expectedProvider: Name, expectedModel: Name }),
)
export type FollowupConfigure = typeof FollowupConfigure.Type
export const FollowupPolicy = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("unconfigured") }),
  Schema.Struct({ kind: Schema.Literal("configured"), enabled: Schema.Boolean, grantId: Schema.UUID,
    conversationId: Schema.UUID, selection: Schema.NullOr(HarnessSelection), provider: Name, model: Name, updatedAt: Schema.String }),
)
export type FollowupPolicy = typeof FollowupPolicy.Type
export const FollowupWakeReceipt = Schema.Struct({ id: Schema.UUID, noteId: Schema.UUID, conversationId: Schema.UUID,
  status: Schema.Literal("RUNNING", "COMPLETED", "FAILED", "CANCELLED", "INTERRUPTED"), startedAt: Schema.String, finishedAt: Schema.NullOr(Schema.String) })
export type FollowupWakeReceipt = typeof FollowupWakeReceipt.Type
export const FOLLOWUP_LIMITS = { wakeUpsPer24Hours: 1, modelSteps: 3, toolCalls: 4, timeoutSeconds: 120, readOnly: true } as const
export const FollowupResponse = Schema.Struct({ policy: FollowupPolicy,
  limits: Schema.Struct({ wakeUpsPer24Hours: Schema.Literal(1), modelSteps: Schema.Literal(3), toolCalls: Schema.Literal(4), timeoutSeconds: Schema.Literal(120), readOnly: Schema.Literal(true) }),
  wakes: Schema.Array(FollowupWakeReceipt).pipe(Schema.maxItems(10)),
})
export type FollowupResponse = typeof FollowupResponse.Type
export const decodeFollowupResponse = Schema.decodeUnknownSync(FollowupResponse)
