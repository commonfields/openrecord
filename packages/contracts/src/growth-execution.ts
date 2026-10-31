import { Schema } from "effect"

// W7 connected execution. One exact, human-authorized website change is
// carried out through a provider (GitHub first) and reconciled. Everything in
// this file is pure so the API, the worker, the database guard tests and the
// web view share one definition. Nothing here is a growth-initiative state:
// the initiative's human decision lifecycle (W0) is not touched.
//
// Three different facts are kept apart, and a fourth is never derived:
//   REQUEST ACCEPTED          OpenRecord or the provider accepted a request
//   PROVIDER ACTION VERIFIED  OpenRecord confirmed the exact authorized change
//                             was merged at the provider
//   LIVE CHANGE OBSERVED      OpenRecord re-observed the change on the live site
//   (business impact)         only the measurement and evaluation system speaks
//                             to it; nothing here implies it.

const Text = (max: number) => Schema.String.pipe(Schema.maxLength(max), Schema.filter(s => s.trim().length > 0))

// ---- what may be changed ----

/**
 * What one connected change may do to one HTML page. Each is a deterministic
 * edit (site-operator page-edits): take out an accidental noindex, or set the
 * page's title, meta description or canonical address, add schema.org JSON-LD,
 * or set one image's alt text. The words are proposed by the agent or a person
 * and reach the site only through the reviewed, authorized pull request.
 */
export const ExecutionActionKind = Schema.Literal("REMOVE_NOINDEX_META", "SET_TITLE", "SET_META_DESCRIPTION", "SET_CANONICAL", "ADD_JSON_LD", "SET_IMAGE_ALT")
export type ExecutionActionKind = typeof ExecutionActionKind.Type

const OneLine = (max: number) => Schema.String.pipe(Schema.maxLength(max), Schema.filter(s => s.trim().length > 0 && !/[\r\n]/.test(s)))
/** The content an edit writes; which fields it needs depends on the kind. */
export const ExecutionActionValue = Schema.Struct({
  title: Schema.optional(OneLine(120)),
  description: Schema.optional(OneLine(320)),
  canonicalUrl: Schema.optional(Schema.String.pipe(Schema.maxLength(2000))),
  jsonLd: Schema.optional(Schema.String.pipe(Schema.maxLength(8000))),
  imageSrc: Schema.optional(OneLine(2000)),
  alt: Schema.optional(OneLine(250)),
})
export type ExecutionActionValue = typeof ExecutionActionValue.Type

export type ExecutionEdit =
  | { readonly kind: "REMOVE_NOINDEX_META" }
  | { readonly kind: "SET_TITLE"; readonly title: string }
  | { readonly kind: "SET_META_DESCRIPTION"; readonly description: string }
  | { readonly kind: "SET_CANONICAL"; readonly url: string }
  | { readonly kind: "ADD_JSON_LD"; readonly json: string }
  | { readonly kind: "SET_IMAGE_ALT"; readonly src: string; readonly alt: string }

/**
 * The edit a request asks for, or null when its value does not fit the kind:
 * a missing field, a field another kind uses, or a canonical address on a
 * different site than the page.
 */
export const executionEdit = (kind: ExecutionActionKind, value: ExecutionActionValue | null | undefined, liveUrl: string): ExecutionEdit | null => {
  const v = value ?? {}
  const used = Object.entries(v).filter(([, x]) => x !== undefined).map(([k]) => k).sort().join(",")
  const only = (fields: string) => used === fields
  switch (kind) {
    case "REMOVE_NOINDEX_META": return only("") ? { kind } : null
    case "SET_TITLE": return only("title") ? { kind, title: v.title!.trim() } : null
    case "SET_META_DESCRIPTION": return only("description") ? { kind, description: v.description!.trim() } : null
    case "ADD_JSON_LD": return only("jsonLd") ? { kind, json: v.jsonLd! } : null
    case "SET_IMAGE_ALT": return only("alt,imageSrc") ? { kind, src: v.imageSrc!, alt: v.alt!.trim() } : null
    case "SET_CANONICAL": {
      if (!only("canonicalUrl")) return null
      try {
        const url = new URL(v.canonicalUrl!), page = new URL(liveUrl)
        return (url.protocol === "https:" || url.protocol === "http:") && url.origin === page.origin && !url.username && !url.password ? { kind, url: url.toString() } : null
      } catch { return null }
    }
  }
}

export const EXECUTION_EXTENSIONS = [".html", ".htm"] as const
export const EXECUTION_MAX_FILE_BYTES = 256_000
export const EXECUTION_AUTHORIZATION_HOURS = 24
/** How long OpenRecord keeps following an unmerged pull request. After that the operation stops, so an abandoned pull request cannot hold the initiative's final decision forever. */
export const EXECUTION_MERGE_WINDOW_DAYS = 30

/**
 * A repository-relative HTML page an execution may change. Deliberately
 * narrow: plain segments, no dot-files or dot-directories (so no .github
 * workflows, .env or tool config), no traversal, no absolute paths.
 */
export const executionPathProblem = (path: string): string | null => {
  if (path.length === 0 || path.length > 300) return "PATH_LENGTH"
  if (path !== path.normalize("NFC")) return "PATH_NOT_NORMALIZED"
  if (!/^[A-Za-z0-9_\-./]+$/.test(path)) return "PATH_CHARACTERS"
  if (path.startsWith("/") || path.endsWith("/")) return "PATH_NOT_RELATIVE_FILE"
  const segments = path.split("/")
  if (segments.length > 12) return "PATH_DEPTH"
  for (const s of segments) {
    if (s === "" || s === "." || s === "..") return "PATH_TRAVERSAL"
    if (s.startsWith(".")) return "PATH_HIDDEN_SEGMENT"
  }
  const lower = path.toLowerCase()
  if (!EXECUTION_EXTENSIONS.some(ext => lower.endsWith(ext))) return "PATH_EXTENSION"
  return null
}

/** Allowed path entries on a target: an exact page, or a directory prefix ending in "/". */
export const allowedExecutionPathProblem = (entry: string): string | null => {
  if (entry.endsWith("/")) {
    const dir = entry.slice(0, -1)
    if (dir.length === 0) return "PATH_ROOT_NOT_ALLOWED"
    if (!/^[A-Za-z0-9_\-./]+$/.test(dir) || dir.startsWith("/")) return "PATH_CHARACTERS"
    for (const s of dir.split("/")) {
      if (s === "" || s === "." || s === "..") return "PATH_TRAVERSAL"
      if (s.startsWith(".")) return "PATH_HIDDEN_SEGMENT"
    }
    return null
  }
  return executionPathProblem(entry)
}
export const executionPathAllowed = (path: string, allowed: ReadonlyArray<string>): boolean =>
  executionPathProblem(path) === null && allowed.some(entry => entry.endsWith("/") ? path.startsWith(entry) : path === entry)

/**
 * Repositories OpenRecord may never write to as an execution target,
 * whatever an operator or a server allowlist says. Lower-case owner/name.
 */
export const EXECUTION_DENIED_REPOSITORIES: ReadonlyArray<string> = ["commonfields/openrecord"]
export const executionRepositoryDenied = (owner: string, repository: string, extra: ReadonlyArray<string> = []): boolean => {
  const key = `${owner}/${repository}`.toLowerCase()
  return [...EXECUTION_DENIED_REPOSITORIES, ...extra.map(s => s.toLowerCase())].includes(key)
}

// ---- reviewable diff (same line diff the pull request body carries) ----

export type DiffLine = { readonly kind: "context" | "add" | "remove"; readonly text: string; readonly before: number | null; readonly after: number | null }
export type DiffHunk = { readonly beforeStart: number; readonly afterStart: number; readonly lines: ReadonlyArray<DiffLine> }
const MAX_DIFF_CELLS = 4_000_000

/** Line diff grouped into hunks with `context` unchanged lines around each change. */
export const diffLines = (before: string, after: string, context = 3): ReadonlyArray<DiffHunk> => {
  const a = before.split("\n")
  const b = after.split("\n")
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++
  const midA = a.slice(head, a.length - tail)
  const midB = b.slice(head, b.length - tail)
  const ops: DiffLine[] = []
  for (let i = 0; i < head; i++) ops.push({ kind: "context", text: a[i]!, before: i + 1, after: i + 1 })
  if (midA.length * midB.length <= MAX_DIFF_CELLS) {
    const n = midA.length, m = midB.length
    const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = midA[i] === midB[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!)
    }
    let i = 0, j = 0
    while (i < n || j < m) {
      if (i < n && j < m && midA[i] === midB[j]) { ops.push({ kind: "context", text: midA[i]!, before: head + i + 1, after: head + j + 1 }); i++; j++ }
      else if (i < n && (j === m || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) { ops.push({ kind: "remove", text: midA[i]!, before: head + i + 1, after: null }); i++ }
      else { ops.push({ kind: "add", text: midB[j]!, before: null, after: head + j + 1 }); j++ }
    }
  } else {
    midA.forEach((text, i) => ops.push({ kind: "remove", text, before: head + i + 1, after: null }))
    midB.forEach((text, j) => ops.push({ kind: "add", text, before: null, after: head + j + 1 }))
  }
  for (let k = 0; k < tail; k++) ops.push({ kind: "context", text: a[a.length - tail + k]!, before: a.length - tail + k + 1, after: b.length - tail + k + 1 })
  const ranges: Array<[number, number]> = []
  ops.forEach((op, index) => {
    if (op.kind === "context") return
    const start = Math.max(0, index - context)
    const end = Math.min(ops.length - 1, index + context)
    const last = ranges.at(-1)
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end)
    else ranges.push([start, end])
  })
  return ranges.map(([start, end]) => {
    const lines = ops.slice(start, end + 1)
    return { beforeStart: lines.find(l => l.before !== null)?.before ?? 0, afterStart: lines.find(l => l.after !== null)?.after ?? 0, lines }
  })
}

export const unifiedDiff = (path: string, hunks: ReadonlyArray<DiffHunk>): string => {
  const out = [`--- a/${path}`, `+++ b/${path}`]
  for (const h of hunks) {
    const beforeCount = h.lines.filter(l => l.kind !== "add").length
    const afterCount = h.lines.filter(l => l.kind !== "remove").length
    out.push(`@@ -${h.beforeStart},${beforeCount} +${h.afterStart},${afterCount} @@`)
    for (const l of h.lines) out.push(`${l.kind === "add" ? "+" : l.kind === "remove" ? "-" : " "}${l.text}`)
  }
  return out.join("\n")
}

// ---- execution-operation lifecycle ----

export const ExecutionState = Schema.Literal(
  "PREPARED", "AUTHORIZED", "DISPATCHING", "AWAITING_MERGE", "RECONCILING", "VERIFIED", "FAILED", "BLOCKED", "UNKNOWN", "CANCELLED",
)
export type ExecutionState = typeof ExecutionState.Type
export type ExecutionActor = "OPERATOR" | "ASSISTANT" | "EXECUTION_SYSTEM"

/** The external action may be, or may have been, performed: the initiative's final decision waits for these to settle. */
export const EXECUTION_IN_FLIGHT: ReadonlyArray<ExecutionState> = ["DISPATCHING", "AWAITING_MERGE", "RECONCILING", "UNKNOWN"]
export const EXECUTION_TERMINAL: ReadonlyArray<ExecutionState> = ["VERIFIED", "FAILED", "BLOCKED", "CANCELLED"]

/**
 * Who may move an operation where. The database guard mirrors this table and
 * the integration tests compare the two. Only a person authorizes, dispatches
 * or cancels. Only the execution system records what the provider confirmed.
 * The assistant can propose (PREPARED) and nothing else.
 */
export const EXECUTION_TRANSITIONS: ReadonlyArray<{ from: ExecutionState | null; to: ExecutionState; actors: ReadonlyArray<ExecutionActor> }> = [
  { from: null, to: "PREPARED", actors: ["OPERATOR", "ASSISTANT"] },
  { from: "PREPARED", to: "AUTHORIZED", actors: ["OPERATOR"] },
  { from: "PREPARED", to: "CANCELLED", actors: ["OPERATOR"] },
  { from: "AUTHORIZED", to: "CANCELLED", actors: ["OPERATOR"] },
  { from: "AUTHORIZED", to: "DISPATCHING", actors: ["OPERATOR"] },
  { from: "AUTHORIZED", to: "BLOCKED", actors: ["EXECUTION_SYSTEM"] },
  { from: "DISPATCHING", to: "AWAITING_MERGE", actors: ["EXECUTION_SYSTEM"] },
  { from: "DISPATCHING", to: "UNKNOWN", actors: ["EXECUTION_SYSTEM"] },
  { from: "DISPATCHING", to: "FAILED", actors: ["EXECUTION_SYSTEM"] },
  { from: "DISPATCHING", to: "BLOCKED", actors: ["EXECUTION_SYSTEM"] },
  { from: "UNKNOWN", to: "DISPATCHING", actors: ["EXECUTION_SYSTEM"] },
  { from: "UNKNOWN", to: "AWAITING_MERGE", actors: ["EXECUTION_SYSTEM"] },
  { from: "UNKNOWN", to: "FAILED", actors: ["EXECUTION_SYSTEM"] },
  { from: "UNKNOWN", to: "BLOCKED", actors: ["EXECUTION_SYSTEM"] },
  { from: "AWAITING_MERGE", to: "RECONCILING", actors: ["EXECUTION_SYSTEM"] },
  { from: "AWAITING_MERGE", to: "FAILED", actors: ["EXECUTION_SYSTEM"] },
  { from: "AWAITING_MERGE", to: "BLOCKED", actors: ["EXECUTION_SYSTEM"] },
  { from: "RECONCILING", to: "AWAITING_MERGE", actors: ["EXECUTION_SYSTEM"] },
  { from: "RECONCILING", to: "VERIFIED", actors: ["EXECUTION_SYSTEM"] },
  { from: "RECONCILING", to: "BLOCKED", actors: ["EXECUTION_SYSTEM"] },
  { from: "RECONCILING", to: "FAILED", actors: ["EXECUTION_SYSTEM"] },
]
export const canTransitionExecution = (from: ExecutionState | null, to: ExecutionState, actor: ExecutionActor): boolean =>
  EXECUTION_TRANSITIONS.some(t => t.from === from && t.to === to && t.actors.includes(actor))

/** Why an operation stopped. Stored in the event detail; shown in plain words. */
export type ExecutionStopCode =
  | "SOURCE_CHANGED" | "AUTHORIZATION_EXPIRED" | "INITIATIVE_NOT_APPROVED" | "REPOSITORY_NOT_PERMITTED" | "PATH_NOT_PERMITTED"
  | "NOT_APPLICABLE" | "BRANCH_CONFLICT" | "PROVIDER_AUTH" | "PROVIDER_NOT_FOUND" | "PROVIDER_REJECTED" | "RETRIES_EXHAUSTED"
  | "PR_CLOSED_WITHOUT_MERGE" | "MERGE_WINDOW_EXPIRED" | "PR_CONTENT_CHANGED" | "PR_WRONG_TARGET" | "MERGED_CONTENT_DIFFERS" | "NOT_CONFIGURED"

// ---- provider evidence and live observation ----

export const ExecutionEvidenceKind = Schema.Literal(
  "BRANCH_READY", "COMMIT_CREATED", "PR_OPENED", "PR_OBSERVED_OPEN", "PR_CLOSED_UNMERGED", "PR_CONTENT_CHANGED", "PR_MERGE_CONFIRMED", "DISPATCH_UNCERTAIN",
)
export type ExecutionEvidenceKind = typeof ExecutionEvidenceKind.Type

/** Separate from provider verification: a re-observation of the configured live page. */
export const ExecutionLiveResult = Schema.Literal("CHANGE_OBSERVED", "CHANGE_NOT_OBSERVED", "INCONCLUSIVE")
export type ExecutionLiveResult = typeof ExecutionLiveResult.Type

// ---- requests ----

export const GitHubOwner = Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/))
export const GitHubRepoSlug = Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9._-]{1,100}$/), Schema.filter(s => s !== "." && s !== ".."))
export const GitBranchName = Schema.String.pipe(Schema.maxLength(200), Schema.pattern(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/),
  Schema.filter(s => !s.includes("..") && !s.endsWith("/") && !s.endsWith(".lock") && !s.includes("//")))

export const ConnectExecutionTarget = Schema.Struct({
  owner: GitHubOwner,
  repository: GitHubRepoSlug,
  baseBranch: GitBranchName,
  /** The registered website this repository publishes; live checks stay inside its scope. */
  siteTargetId: Schema.UUID,
  allowedPaths: Schema.Array(Schema.String.pipe(Schema.maxLength(300), Schema.filter(p => allowedExecutionPathProblem(p) === null)))
    .pipe(Schema.minItems(1), Schema.maxItems(20)),
  idempotencyKey: Schema.UUID,
})
export type ConnectExecutionTarget = typeof ConnectExecutionTarget.Type

export const PrepareExecution = Schema.Struct({
  targetId: Schema.UUID,
  actionKind: ExecutionActionKind,
  /** What the edit writes; absent for REMOVE_NOINDEX_META. Checked by executionEdit. */
  value: Schema.optional(ExecutionActionValue),
  filePath: Schema.String.pipe(Schema.filter(p => executionPathProblem(p) === null)),
  /** The public page this file serves. Re-observed after the merge; fetched only inside the registered site. */
  liveUrl: Schema.String.pipe(Schema.maxLength(2000), Schema.filter(s => { try { const u = new URL(s); return u.protocol === "https:" || u.protocol === "http:" } catch { return false } })),
  rationale: Text(2000),
  siteFindingId: Schema.NullOr(Schema.UUID),
  idempotencyKey: Schema.UUID,
})
export type PrepareExecution = typeof PrepareExecution.Type

export const AuthorizeExecution = Schema.Struct({
  /** The change the person reviewed. Authorization binds to exactly this hash. */
  reviewedPatchSha256: Schema.String.pipe(Schema.pattern(/^[a-f0-9]{64}$/)),
  expectedRevision: Schema.Int.pipe(Schema.greaterThanOrEqualTo(1)),
  reason: Text(1000),
  idempotencyKey: Schema.UUID,
})
export type AuthorizeExecution = typeof AuthorizeExecution.Type

export const DispatchExecution = Schema.Struct({
  expectedRevision: Schema.Int.pipe(Schema.greaterThanOrEqualTo(1)),
  idempotencyKey: Schema.UUID,
})
export type DispatchExecution = typeof DispatchExecution.Type

export const CancelExecution = Schema.Struct({
  expectedRevision: Schema.Int.pipe(Schema.greaterThanOrEqualTo(1)),
  reason: Text(1000),
  idempotencyKey: Schema.UUID,
})
export type CancelExecution = typeof CancelExecution.Type

export const RequestExecutionCheck = Schema.Struct({ idempotencyKey: Schema.UUID })
export type RequestExecutionCheck = typeof RequestExecutionCheck.Type

// ---- read model ----

export interface ExecutionTarget {
  readonly id: string; readonly businessId: string; readonly provider: "GITHUB"; readonly owner: string; readonly repository: string
  readonly baseBranch: string; readonly siteTargetId: string; readonly allowedPaths: ReadonlyArray<string>
  readonly createdByUserId: string; readonly createdAt: string
}
export interface ExecutionEvent {
  readonly id: string; readonly state: ExecutionState; readonly revision: number; readonly actor: ExecutionActor
  readonly userId: string | null; readonly reason: string; readonly detail: Record<string, unknown>; readonly createdAt: string
}
export interface ExecutionEvidence {
  readonly id: string; readonly kind: ExecutionEvidenceKind; readonly detail: Record<string, unknown>; readonly observedAt: string
}
export interface ExecutionLiveCheck {
  readonly id: string; readonly result: ExecutionLiveResult; readonly url: string; readonly httpStatus: number | null
  readonly detail: string; readonly bodyDigest: string | null; readonly checkedAt: string
}
export interface ExecutionReceipt {
  readonly interventionId: string; readonly claim: "PR_MERGED"; readonly mergedAt: string; readonly mergeCommitSha: string; readonly pullRequestUrl: string
}
export interface ExecutionOperation {
  readonly id: string; readonly businessId: string; readonly opportunityId: string; readonly targetId: string
  readonly owner: string; readonly repository: string; readonly baseBranch: string; readonly actionKind: ExecutionActionKind
  /** What the edit writes; null for REMOVE_NOINDEX_META. */
  readonly actionValue: ExecutionActionValue | null
  readonly filePath: string; readonly liveUrl: string; readonly siteFindingId: string | null
  readonly baseCommitSha: string; readonly baseBlobSha: string; readonly beforeSha256: string; readonly afterSha256: string
  readonly patchSha256: string; readonly diff: string; readonly rationale: string
  readonly proposedBy: "OPERATOR" | "ASSISTANT"; readonly createdByUserId: string; readonly createdAt: string
  readonly state: ExecutionState; readonly revision: number
  readonly events: ReadonlyArray<ExecutionEvent>; readonly evidence: ReadonlyArray<ExecutionEvidence>
  readonly liveChecks: ReadonlyArray<ExecutionLiveCheck>; readonly receipt: ExecutionReceipt | null
}

export type RequestFact = "NOT_SENT" | "ACCEPTED_BY_OPENRECORD" | "ACCEPTED_BY_PROVIDER"
/** Only a confirmed merge of the authorized change is VERIFIED. A stopped operation is NOT_VERIFIED, never "not performed": OpenRecord cannot prove a negative at the provider. */
export type ProviderFact = "NOT_VERIFIED" | "VERIFIED"
export type LiveFact = "NOT_CHECKED" | "PENDING" | "OBSERVED" | "NOT_OBSERVED" | "INCONCLUSIVE"
export interface ExecutionFacts { readonly request: RequestFact; readonly providerAction: ProviderFact; readonly liveChange: LiveFact }

/**
 * The three facts, derived and never merged. A live check without a verified
 * merge is not shown: a page that changed for another reason says nothing
 * about this authorization.
 */
export const executionFacts = (e: Pick<ExecutionOperation, "state" | "evidence" | "liveChecks">): ExecutionFacts => {
  const accepted = e.evidence.some(x => x.kind === "PR_OPENED")
  const request: RequestFact = accepted ? "ACCEPTED_BY_PROVIDER"
    : e.state === "PREPARED" ? "NOT_SENT" : e.state === "CANCELLED" ? "NOT_SENT" : "ACCEPTED_BY_OPENRECORD"
  const providerAction: ProviderFact = e.state === "VERIFIED" ? "VERIFIED" : "NOT_VERIFIED"
  const latest = e.liveChecks[0]
  const liveChange: LiveFact = e.state !== "VERIFIED" ? "NOT_CHECKED"
    : !latest ? "PENDING" : latest.result === "CHANGE_OBSERVED" ? "OBSERVED" : latest.result === "CHANGE_NOT_OBSERVED" ? "NOT_OBSERVED" : "INCONCLUSIVE"
  return { request, providerAction, liveChange }
}
