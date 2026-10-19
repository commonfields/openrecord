import { Schema } from "effect"

// Marketing delivery V1: one channel, a GitHub pull request that changes one
// first-party Markdown/MDX content file. Everything here is pure so the API,
// the database guard tests and the web diff view share one definition.

const Text = (max: number) => Schema.String.pipe(Schema.maxLength(max), Schema.filter(s => s.trim().length > 0))

// ---- which files may be delivered ----

export const DELIVERY_EXTENSIONS = [".md", ".mdx"] as const
export const DELIVERY_MAX_FILE_BYTES = 256_000

/**
 * A repository-relative content path a delivery may change. Deliberately
 * narrow: Markdown/MDX only, plain segments, no dot-files or dot-directories
 * (so no .github workflows, .env or tool config), no traversal, no absolute
 * paths. Symlinks are irrelevant because GitHub's contents API addresses blobs
 * by path; a symlink entry is refused when read (see the API's file type check).
 */
export const deliverablePathProblem = (path: string): string | null => {
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
  if (!DELIVERY_EXTENSIONS.some(ext => lower.endsWith(ext))) return "PATH_EXTENSION"
  return null
}

/**
 * Allowed path entries on a connected repository: an exact file, or a
 * directory prefix ending in "/". Entries obey the same segment rules.
 */
export const allowedPathEntryProblem = (entry: string): string | null => {
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
  return deliverablePathProblem(entry)
}

export const pathAllowed = (path: string, allowed: ReadonlyArray<string>): boolean =>
  deliverablePathProblem(path) === null && allowed.some(entry => entry.endsWith("/") ? path.startsWith(entry) : path === entry)

// ---- the exact change ----

export const DeliveryEdit = Schema.Struct({ find: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(5000)), replace: Schema.String.pipe(Schema.maxLength(5000)) })
export type DeliveryEdit = typeof DeliveryEdit.Type
export const DeliveryEdits = Schema.Array(DeliveryEdit).pipe(Schema.minItems(1), Schema.maxItems(20))

export type EditFailure =
  | { readonly code: "NOT_FOUND"; readonly index: number }
  | { readonly code: "AMBIGUOUS"; readonly index: number }
  | { readonly code: "OVERLAP"; readonly index: number }
  | { readonly code: "NO_CHANGE" }

/**
 * Applies find/replace edits to the reviewed source. Each `find` must occur
 * exactly once and edits may not overlap, so the result never depends on edit
 * order or on guessing which occurrence was meant.
 */
export const applyDeliveryEdits = (source: string, edits: ReadonlyArray<DeliveryEdit>): { ok: true; content: string } | { ok: false; failure: EditFailure } => {
  const spans: Array<{ start: number; end: number; replace: string; index: number }> = []
  for (const [index, edit] of edits.entries()) {
    const start = source.indexOf(edit.find)
    if (start < 0) return { ok: false, failure: { code: "NOT_FOUND", index } }
    if (source.indexOf(edit.find, start + 1) >= 0) return { ok: false, failure: { code: "AMBIGUOUS", index } }
    spans.push({ start, end: start + edit.find.length, replace: edit.replace, index })
  }
  spans.sort((a, b) => a.start - b.start)
  for (let i = 1; i < spans.length; i++) {
    if (spans[i]!.start < spans[i - 1]!.end) return { ok: false, failure: { code: "OVERLAP", index: spans[i]!.index } }
  }
  let content = ""
  let at = 0
  for (const s of spans) {
    content += source.slice(at, s.start) + s.replace
    at = s.end
  }
  content += source.slice(at)
  return content === source ? { ok: false, failure: { code: "NO_CHANGE" } } : { ok: true, content }
}

// ---- reviewable diff ----

export type DiffLine = { readonly kind: "context" | "add" | "remove"; readonly text: string; readonly before: number | null; readonly after: number | null }
export type DiffHunk = { readonly beforeStart: number; readonly afterStart: number; readonly lines: ReadonlyArray<DiffLine> }

const MAX_DIFF_CELLS = 4_000_000

/**
 * Line diff (longest common subsequence) grouped into hunks with `context`
 * unchanged lines around each change. Common prefix and suffix are trimmed
 * first, so typical copy edits stay far below the size cap; beyond it the
 * whole changed region is shown as removed then added, never misaligned.
 */
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
      // Removals before additions within a change, as unified diffs read.
      else if (i < n && (j === m || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) { ops.push({ kind: "remove", text: midA[i]!, before: head + i + 1, after: null }); i++ }
      else { ops.push({ kind: "add", text: midB[j]!, before: null, after: head + j + 1 }); j++ }
    }
  } else {
    midA.forEach((text, i) => ops.push({ kind: "remove", text, before: head + i + 1, after: null }))
    midB.forEach((text, j) => ops.push({ kind: "add", text, before: null, after: head + j + 1 }))
  }
  for (let k = 0; k < tail; k++) ops.push({ kind: "context", text: a[a.length - tail + k]!, before: a.length - tail + k + 1, after: b.length - tail + k + 1 })

  // Each change keeps `context` lines either side; windows that touch merge.
  const ranges: Array<[number, number]> = []
  ops.forEach((op, index) => {
    if (op.kind === "context") return
    const start = Math.max(0, index - context)
    const end = Math.min(ops.length - 1, index + context)
    const last = ranges.at(-1)
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end)
    else ranges.push([start, end])
  })
  return ranges.map(([start, end]) => toHunk(ops.slice(start, end + 1)))
}

const toHunk = (lines: DiffLine[]): DiffHunk => ({
  beforeStart: lines.find(l => l.before !== null)?.before ?? 0,
  afterStart: lines.find(l => l.after !== null)?.after ?? 0,
  lines,
})

/** Unified diff text for the stored record and the pull request body. */
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

// ---- lifecycle ----

export const DeliveryState = Schema.Literal(
  "DRAFTED", "APPROVED_FOR_PR", "REJECTED", "STALE", "PR_OPENED", "PR_MERGED", "CLOSED_WITHOUT_DELIVERY", "DEPLOYMENT_VERIFIED",
)
export type DeliveryState = typeof DeliveryState.Type
export type DeliveryActor = "OPERATOR" | "ASSISTANT" | "DELIVERY_SYSTEM"

/**
 * Who may move a delivery where. The database guard mirrors this table and
 * the integration tests compare the two.
 * - Only a person approves a draft for a pull request, rejects it, or
 *   attests a deployment.
 * - Only the delivery system records what GitHub confirmed: a pull request
 *   that exists, a merge, a close without merge, or a base file that changed
 *   after review (STALE). Nothing here can be reached by the assistant saying so.
 */
export const DELIVERY_TRANSITIONS: ReadonlyArray<{ from: DeliveryState | null; to: DeliveryState; actors: ReadonlyArray<DeliveryActor> }> = [
  { from: null, to: "DRAFTED", actors: ["OPERATOR", "ASSISTANT"] },
  { from: "DRAFTED", to: "APPROVED_FOR_PR", actors: ["OPERATOR"] },
  { from: "DRAFTED", to: "REJECTED", actors: ["OPERATOR"] },
  { from: "APPROVED_FOR_PR", to: "REJECTED", actors: ["OPERATOR"] },
  { from: "APPROVED_FOR_PR", to: "STALE", actors: ["DELIVERY_SYSTEM"] },
  { from: "APPROVED_FOR_PR", to: "PR_OPENED", actors: ["DELIVERY_SYSTEM"] },
  { from: "PR_OPENED", to: "PR_MERGED", actors: ["DELIVERY_SYSTEM"] },
  { from: "PR_OPENED", to: "CLOSED_WITHOUT_DELIVERY", actors: ["DELIVERY_SYSTEM"] },
  { from: "PR_MERGED", to: "DEPLOYMENT_VERIFIED", actors: ["OPERATOR"] },
]
export const canTransitionDelivery = (from: DeliveryState | null, to: DeliveryState, actor: DeliveryActor): boolean =>
  DELIVERY_TRANSITIONS.some(t => t.from === from && t.to === to && t.actors.includes(actor))

// ---- requests ----

export const GitHubOwner = Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/))
export const GitHubRepoSlug = Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9._-]{1,100}$/), Schema.filter(s => s !== "." && s !== ".."))
export const GitBranchName = Schema.String.pipe(Schema.maxLength(200), Schema.pattern(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/),
  Schema.filter(s => !s.includes("..") && !s.endsWith("/") && !s.endsWith(".lock") && !s.includes("//")))

export const ConnectDeliveryTarget = Schema.Struct({
  owner: GitHubOwner,
  repository: GitHubRepoSlug,
  baseBranch: GitBranchName,
  allowedPaths: Schema.Array(Schema.String.pipe(Schema.maxLength(300), Schema.filter(p => allowedPathEntryProblem(p) === null)))
    .pipe(Schema.minItems(1), Schema.maxItems(20)),
  idempotencyKey: Schema.UUID,
})
export type ConnectDeliveryTarget = typeof ConnectDeliveryTarget.Type

export const PrepareDelivery = Schema.Struct({
  targetId: Schema.UUID,
  filePath: Schema.String.pipe(Schema.filter(p => deliverablePathProblem(p) === null)),
  edits: DeliveryEdits,
  rationale: Text(2000),
  assumptions: Text(2000),
  idempotencyKey: Schema.UUID,
})
export type PrepareDelivery = typeof PrepareDelivery.Type

export const DeliveryDecision = Schema.Struct({
  approve: Schema.Boolean,
  /** The patch the person reviewed; approval binds to exactly this hash. */
  reviewedPatchSha256: Schema.String.pipe(Schema.pattern(/^[a-f0-9]{64}$/)),
  expectedRevision: Schema.Int.pipe(Schema.greaterThanOrEqualTo(1)),
  reason: Text(1000),
  idempotencyKey: Schema.UUID,
})
export type DeliveryDecision = typeof DeliveryDecision.Type

export const OpenDeliveryPullRequest = Schema.Struct({ idempotencyKey: Schema.UUID })

export const AttestDeployment = Schema.Struct({
  /** Where the operator saw the change live. Not fetched or verified by OpenRecord. */
  url: Schema.String.pipe(Schema.maxLength(2000), Schema.filter(s => { try { const u = new URL(s); return u.protocol === "https:" || u.protocol === "http:" } catch { return false } })),
  observedAt: Schema.String.pipe(Schema.filter(s => !Number.isNaN(Date.parse(s)))),
  note: Text(1000),
  expectedRevision: Schema.Int.pipe(Schema.greaterThanOrEqualTo(1)),
  idempotencyKey: Schema.UUID,
})
export type AttestDeployment = typeof AttestDeployment.Type

// ---- read model ----

export interface DeliveryTarget {
  readonly id: string; readonly businessId: string; readonly provider: "GITHUB"; readonly owner: string; readonly repository: string
  readonly baseBranch: string; readonly allowedPaths: ReadonlyArray<string>; readonly createdByUserId: string; readonly createdAt: string
}
export interface DeliveryEvent {
  readonly id: string; readonly state: DeliveryState; readonly revision: number; readonly actor: DeliveryActor
  readonly userId: string | null; readonly reason: string; readonly detail: Record<string, unknown>; readonly createdAt: string
}
export interface DeliveryAttempt {
  readonly id: string; readonly state: "CLAIMED" | "SUCCEEDED" | "FAILED" | "UNKNOWN"; readonly headBranch: string
  readonly commitSha: string | null; readonly prNumber: number | null; readonly prUrl: string | null
  readonly failureCode: string | null; readonly failureDetail: string | null; readonly createdAt: string; readonly updatedAt: string
}
export interface GrowthDelivery {
  readonly id: string; readonly businessId: string; readonly opportunityId: string; readonly targetId: string
  readonly owner: string; readonly repository: string; readonly filePath: string; readonly baseBranch: string
  readonly baseCommitSha: string; readonly baseBlobSha: string; readonly beforeSha256: string; readonly afterSha256: string
  readonly afterBlobSha: string; readonly patchSha256: string; readonly edits: ReadonlyArray<DeliveryEdit>; readonly diff: string
  readonly rationale: string; readonly assumptions: string; readonly proposedBy: "OPERATOR" | "ASSISTANT"
  readonly createdByUserId: string; readonly createdAt: string
  readonly state: DeliveryState; readonly revision: number; readonly events: ReadonlyArray<DeliveryEvent>
  readonly attempts: ReadonlyArray<DeliveryAttempt>
}
