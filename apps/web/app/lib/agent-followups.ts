import { decodeFollowupResponse, type FollowupConfigure, type FollowupPolicy, type FollowupWakeReceipt, HARNESS_NAMES, type HarnessReasoningEffort } from "@openrecord/contracts"
import { api, ApiError } from "./api"
import type { AgentSelection } from "./harness"

export const Followups = {
  read: async (businessId: string) => decodeFollowupResponse(await api<unknown>(`/api/businesses/${encodeURIComponent(businessId)}/agent/follow-ups`)),
  configure: async (businessId: string, request: FollowupConfigure) => decodeFollowupResponse(await api<unknown>(`/api/businesses/${encodeURIComponent(businessId)}/agent/follow-ups`, {
    method: "PUT", body: JSON.stringify(request),
  })),
}

export function followupModel(selection: AgentSelection, reasoningEffort?: HarnessReasoningEffort) {
  if (selection.status === "hosted") return { selection: null, provider: selection.provider, model: selection.model, label: `${selection.provider} · ${selection.model}` }
  if (selection.status === "instance") return {
    selection: { instanceId: selection.instance.id, model: selection.model.id, ...(reasoningEffort ? { reasoningEffort } : {}) },
    provider: selection.instance.driver, model: selection.model.id, label: `${HARNESS_NAMES[selection.instance.driver]} · ${selection.model.name}`,
  }
  // A loading or missing selection must never silently authorize hosted usage.
  return null
}
export type FollowupModel = NonNullable<ReturnType<typeof followupModel>>
export function followupLocation(policy: FollowupPolicy, conversationId: string): "off" | "here" | "elsewhere" {
  return policy.kind === "unconfigured" || !policy.enabled ? "off" : policy.conversationId === conversationId ? "here" : "elsewhere"
}
export function followupModelMatches(policy: FollowupPolicy, model: FollowupModel): boolean {
  if (policy.kind !== "configured" || policy.provider !== model.provider || policy.model !== model.model) return false
  if (policy.selection === null || model.selection === null) return policy.selection === model.selection
  return policy.selection.instanceId === model.selection.instanceId && policy.selection.model === model.selection.model && policy.selection.reasoningEffort === model.selection.reasoningEffort
}
export const followupStatus: Readonly<Record<FollowupWakeReceipt["status"], string>> = {
  RUNNING: "Reviewing", COMPLETED: "Update saved", FAILED: "Review failed", CANCELLED: "Stopped", INTERRUPTED: "Interrupted — not retried",
}
export function followupError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 409) return "The settings or model changed. Refresh status before confirming again."
    if (error.status === 401 || error.status === 403) return "You don't have permission to change these follow-ups. Sign in again or contact your workspace owner."
    if (error.status === 404) return "This business or chat is no longer available."
  }
  return "Follow-ups are unavailable. The change could not be confirmed. Refresh status before trying again."
}
export const followupChatEvent = (businessId: string, conversationId: string) => `openrecord:follow-up:${businessId}:${conversationId}`
