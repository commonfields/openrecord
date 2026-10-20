// W7 connected execution client: operator API calls and the plain-language
// words for what happened. Three facts are always shown apart:
//   the request, the repository merge, and the live website.
// "Marketing work completed" is never derived from a provider response, and a
// merge is never described as the website being live.
import type { ExecutionFacts, ExecutionOperation, ExecutionState, ExecutionTarget } from "@openrecord/contracts"
import { api, ApiError } from "./api"

const base = (id: string) => `/api/growth/clients/${encodeURIComponent(id)}`
const op = (id: string, operationId: string) => `${base(id)}/connected-executions/${encodeURIComponent(operationId)}`
export type SiteChoice = { id: string; rootUrl: string; canonicalOrigin: string }
export const GrowthExecutions = {
  sites: (id: string) => api<{ sites: SiteChoice[] }>(`/api/businesses/${encodeURIComponent(id)}/search/sites`),
  targets: (id: string) => api<{ targets: ExecutionTarget[] }>(`${base(id)}/execution-targets`),
  connect: (id: string, input: { owner: string; repository: string; baseBranch: string; siteTargetId: string; allowedPaths: string[]; idempotencyKey: string }) =>
    api<{ target: ExecutionTarget }>(`${base(id)}/execution-targets`, { method: "POST", body: JSON.stringify(input) }),
  list: (id: string, opportunityId: string) => api<{ operations: ExecutionOperation[] }>(`${base(id)}/opportunities/${encodeURIComponent(opportunityId)}/connected-executions`),
  prepare: (id: string, opportunityId: string, input: { targetId: string; actionKind: "REMOVE_NOINDEX_META"; filePath: string; liveUrl: string; rationale: string; siteFindingId: string | null; idempotencyKey: string }) =>
    api<{ operation: ExecutionOperation }>(`${base(id)}/opportunities/${encodeURIComponent(opportunityId)}/connected-executions`, { method: "POST", body: JSON.stringify(input) }),
  authorize: (id: string, operationId: string, input: { reviewedPatchSha256: string; expectedRevision: number; reason: string; idempotencyKey: string }) =>
    api<{ operation: ExecutionOperation }>(`${op(id, operationId)}/authorize`, { method: "POST", body: JSON.stringify(input) }),
  dispatch: (id: string, operationId: string, input: { expectedRevision: number; idempotencyKey: string }) =>
    api<{ operation: ExecutionOperation }>(`${op(id, operationId)}/dispatch`, { method: "POST", body: JSON.stringify(input) }),
  cancel: (id: string, operationId: string, input: { expectedRevision: number; reason: string; idempotencyKey: string }) =>
    api<{ operation: ExecutionOperation }>(`${op(id, operationId)}/cancel`, { method: "POST", body: JSON.stringify(input) }),
  check: (id: string, operationId: string) => api<{ operation: ExecutionOperation }>(`${op(id, operationId)}/check`, { method: "POST", body: JSON.stringify({ idempotencyKey: crypto.randomUUID() }) }),
  liveCheck: (id: string, operationId: string) => api<{ operation: ExecutionOperation }>(`${op(id, operationId)}/live-check`, { method: "POST", body: JSON.stringify({ idempotencyKey: crypto.randomUUID() }) }),
}

export const EXECUTION_STATE_COPY: Record<ExecutionState, { title: string; detail: string }> = {
  PREPARED: { title: "Change prepared", detail: "Review the exact change below. Nothing has been sent to the repository." },
  AUTHORIZED: { title: "Change approved", detail: "You approved this exact change. It has not been sent yet." },
  DISPATCHING: { title: "Opening the pull request", detail: "OpenRecord is sending the approved change to the repository." },
  AWAITING_MERGE: { title: "Waiting for repository merge", detail: "A pull request is open. The repository maintainer decides whether to merge it. OpenRecord does not merge or deploy." },
  RECONCILING: { title: "Verifying the merge", detail: "GitHub reports a merge. OpenRecord is checking that it is exactly the approved change." },
  VERIFIED: { title: "GitHub merge confirmed", detail: "The approved change was merged into the repository. This does not show the website is live." },
  FAILED: { title: "Stopped", detail: "The change was not completed." },
  BLOCKED: { title: "Stopped for safety", detail: "OpenRecord stopped before anything unapproved could happen. A new approval is needed to try again." },
  UNKNOWN: { title: "Checking with GitHub", detail: "GitHub did not confirm the request. OpenRecord is checking what happened before doing anything else." },
  CANCELLED: { title: "Cancelled", detail: "You cancelled this change before it was sent." },
}
const STOP_COPY: Record<string, string> = {
  SOURCE_CHANGED: "The page changed after you reviewed it. Prepare the change again.",
  AUTHORIZATION_EXPIRED: "The approval expired before the change was sent. Prepare and approve it again.",
  INITIATIVE_NOT_APPROVED: "The initiative is no longer approved.",
  REPOSITORY_NOT_PERMITTED: "This repository is not permitted for your account.",
  PATH_NOT_PERMITTED: "The page is outside the paths connected for this repository.",
  NOT_APPLICABLE: "OpenRecord could not make this change safely.",
  BRANCH_CONFLICT: "The working branch holds something other than the approved change.",
  PROVIDER_AUTH: "GitHub refused OpenRecord's access. Ask your administrator to check the repository connection.",
  PROVIDER_NOT_FOUND: "GitHub could not find the repository, branch or page.",
  PROVIDER_REJECTED: "GitHub rejected the request.",
  RETRIES_EXHAUSTED: "OpenRecord could not confirm the outcome. Check the repository before approving again.",
  PR_CLOSED_WITHOUT_MERGE: "The pull request was closed without being merged.",
  PR_CONTENT_CHANGED: "The pull request was changed after it was opened, so it is no longer the approved change.",
  PR_WRONG_TARGET: "The pull request no longer points at the approved repository and branch.",
  MERGED_CONTENT_DIFFERS: "What was merged is not the approved change, so no verification was recorded.",
  NOT_CONFIGURED: "Repository access is not configured on this server.",
}
export const executionStopCopy = (o: Pick<ExecutionOperation, "state" | "events">): string | null => {
  if (o.state !== "FAILED" && o.state !== "BLOCKED") return null
  const code = String(o.events.at(-1)?.detail["code"] ?? "")
  return STOP_COPY[code] ?? EXECUTION_STATE_COPY[o.state].detail
}

/** The three facts as client-safe sentences. Never merged into one "done". */
export const executionFactLines = (f: ExecutionFacts): ReadonlyArray<{ label: string; text: string; tone: "ok" | "wait" | "no" }> => [
  { label: "Request", tone: f.request === "ACCEPTED_BY_PROVIDER" ? "ok" : "wait",
    text: f.request === "NOT_SENT" ? "Not sent to the repository" : f.request === "ACCEPTED_BY_OPENRECORD" ? "OpenRecord is sending the approved change" : "Pull request opened" },
  { label: "Repository merge", tone: f.providerAction === "VERIFIED" ? "ok" : "wait",
    text: f.providerAction === "VERIFIED" ? "GitHub merge confirmed" : "Not confirmed" },
  { label: "Live website", tone: f.liveChange === "OBSERVED" ? "ok" : f.liveChange === "NOT_OBSERVED" ? "no" : "wait",
    text: f.liveChange === "OBSERVED" ? "Website change observed" : f.liveChange === "NOT_OBSERVED" ? "Website change not observed" : f.liveChange === "INCONCLUSIVE" ? "Website verification unavailable"
      : f.liveChange === "PENDING" ? "Website change not yet observed" : "Not checked until the merge is confirmed" },
]

export const executionError = (e: unknown): string => {
  const reason = e instanceof ApiError && typeof e.body["reason"] === "string" ? e.body["reason"] : ""
  const reasons: Record<string, string> = {
    RepositoryNotPermitted: "This repository is not permitted for your account. Ask your administrator to allow it.",
    ExecutionNotConfigured: "Repository access is not configured on this server.",
    NotApplicable: "This page has no robots noindex directive that OpenRecord can remove safely.",
    PageNotFound: "The page was not found on the base branch.", PageNotSupported: "That page is not a plain HTML file OpenRecord can change.",
    PathNotPermitted: "That page is outside the paths connected for this repository.", LivePageOutsideSite: "The live address is outside the registered website.",
    PatchMismatch: "The change you reviewed is not the change on record. Reload and review again.", StaleExecution: "This changed since you opened it. Reload and review again.",
    InitiativeNotApproved: "The initiative must be approved first.", ExecutionAlreadyOpen: "Another change for this page is still in progress.",
    ExecutionUnresolved: "A connected change is still in progress. Wait until it settles before the final decision.",
    AuthorizationExpired: "The approval expired. Prepare and approve the change again.", IdempotencyConflict: "This request no longer matches. Reload and try again.",
    ProviderAuth: "GitHub refused OpenRecord's access.", ProviderUnavailable: "GitHub is unavailable. Try again shortly.", ProviderRateLimited: "GitHub is rate limiting requests. Try again shortly.",
    RepositoryNotFound: "GitHub could not find that repository.", BaseBranchNotFound: "GitHub could not find the base branch.", TargetAlreadyConnected: "That repository is already connected.",
    ExecutionTargetNotFound: "Connect a repository first.", FindingMismatch: "That finding does not describe this page.", TransitionRefused: "That step is not available in the current state.",
  }
  if (reason) return reasons[reason] ?? `The request was refused (${reason}).`
  return e instanceof Error ? e.message : "The request failed. Try again."
}
