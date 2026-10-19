import type { AttestDeployment, ConnectDeliveryTarget, DeliveryDecision, DeliveryState, DeliveryTarget, GrowthDelivery, PrepareDelivery } from "@openrecord/contracts"
import { api, ApiError } from "./api"

const base = (id: string) => `/api/growth/clients/${encodeURIComponent(id)}`
const post = <T>(path: string, body: unknown) => api<T>(path, { method: "POST", body: JSON.stringify(body) })

export const Delivery = {
  targets: (id: string) => api<{ targets: DeliveryTarget[] }>(`${base(id)}/delivery-targets`),
  connect: (id: string, input: ConnectDeliveryTarget) => post<{ target: DeliveryTarget }>(`${base(id)}/delivery-targets`, input),
  list: (id: string) => api<{ deliveries: GrowthDelivery[] }>(`${base(id)}/deliveries`),
  prepare: (id: string, opportunityId: string, input: PrepareDelivery) =>
    post<{ delivery: GrowthDelivery }>(`${base(id)}/opportunities/${encodeURIComponent(opportunityId)}/deliveries`, input),
  decide: (id: string, deliveryId: string, input: DeliveryDecision) => post<{ delivery: GrowthDelivery }>(`${base(id)}/deliveries/${encodeURIComponent(deliveryId)}/decision`, input),
  openPullRequest: (id: string, deliveryId: string, idempotencyKey: string) =>
    post<{ delivery: GrowthDelivery; outcome: "OPENED" | "REPLAYED" | "STALE" | "FAILED" | "UNKNOWN" }>(`${base(id)}/deliveries/${encodeURIComponent(deliveryId)}/pull-request`, { idempotencyKey }),
  refresh: (id: string, deliveryId: string) => post<{ delivery: GrowthDelivery }>(`${base(id)}/deliveries/${encodeURIComponent(deliveryId)}/refresh`, {}),
  attest: (id: string, deliveryId: string, input: AttestDeployment) => post<{ delivery: GrowthDelivery }>(`${base(id)}/deliveries/${encodeURIComponent(deliveryId)}/deployment`, input),
}

export const DELIVERY_STATE_LABELS: Record<DeliveryState, string> = {
  DRAFTED: "Draft for review", APPROVED_FOR_PR: "Approved for pull request", REJECTED: "Rejected", STALE: "Stale: file changed",
  PR_OPENED: "Pull request open", PR_MERGED: "Merged, deployment unknown", CLOSED_WITHOUT_DELIVERY: "Closed without delivery",
  DEPLOYMENT_VERIFIED: "Deployment attested",
}

const REASONS: Record<string, string> = {
  DeliveryNotConfigured: "GitHub delivery is not configured on this server (no delivery token).",
  RepositoryNotAuthorized: "This repository is not on the server's delivery allowlist for this account.",
  RepositoryInAnotherAccount: "This repository is connected to another account.",
  RepositoryNotFound: "GitHub does not show this repository to the delivery token.",
  BaseBranchNotFound: "That base branch does not exist in the repository.",
  TargetExists: "This repository is already connected.",
  PathNotAllowed: "That file is outside the paths allowed for this repository.",
  SourceNotFound: "That file does not exist on the base branch.",
  SourceNotAFile: "That path is not a regular file (directories, symlinks and submodules are refused).",
  SourceUnsupported: "That file is too large or not UTF-8 text.",
  EditNotFound: "One of the texts to replace was not found in the current file.",
  EditAmbiguous: "One of the texts to replace appears more than once. Include more surrounding text.",
  EditOverlap: "Two edits overlap. Combine them into one.",
  EditNoChange: "The edits do not change the file.",
  OpportunityNotApproved: "Only an approved opportunity can be delivered.",
  ReviewedPatchMismatch: "The change differs from the one you reviewed. Reload and review it again.",
  StaleDecision: "This change was updated. Reload before deciding.",
  NotApprovedForPullRequest: "Approve the change before opening a pull request.",
  StaleBase: "The file changed on the base branch after review. Prepare the change again.",
  AttemptInFlight: "A pull request is already being opened for this change.",
  NotMerged: "Record a deployment only after GitHub reports the merge.",
  IdempotencyConflict: "This request no longer matches the saved one. Reload and try again.",
}
export const deliveryError = (e: unknown): string => {
  if (e instanceof ApiError) {
    const reason = typeof e.body["reason"] === "string" ? e.body["reason"] : null
    if (reason && REASONS[reason]) return REASONS[reason]
    if (e.body["_tag"] === "GitHubUnavailable") return "GitHub did not respond as expected. Nothing is assumed to have happened; try again."
    if (e.status === 422) return "Check the repository, branch, path and edits."
  }
  return e instanceof Error ? e.message : "The request failed. Try again."
}
