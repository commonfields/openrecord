// Closes the loop for a website change made to fix a wrong AI answer: once
// the change is live, the fix is recorded on that issue (as if the person had
// written it down) and a re-check is queued, so the before/after comparison
// on the issue follows without another step. Best effort: a publish never
// fails because this bookkeeping could not run, and what did not happen is
// reported instead of claimed.
import { Effect } from "effect"
import { recordIntervention } from "./interventions.js"
import { requestRecheck } from "./reobservations.js"

export type FixFollowUp =
  | { readonly recorded: false; readonly reason: "NO_ISSUE" | "ISSUE_NOT_FOUND" | "NOT_RECORDED" }
  | { readonly recorded: true; readonly interventionId: string; readonly recheck: "QUEUED" | "ALREADY_ACTIVE" | "NOT_QUEUED" }

/** The kind of fix a website change is, in the evidence protocol's words. */
export const fixType = (kind: string) =>
  kind === "CREATE_POST" || kind === "CREATE_CMS_ITEM" ? "SOURCE_PUBLISHED" as const : kind === "ADD_FAQ" ? "STRUCTURED_DATA_UPDATED" as const : "SOURCE_UPDATED" as const

export const followUpFix = (input: {
  readonly businessId: string
  readonly claimId: string | null
  readonly userId: string
  readonly kind: string
  readonly link: string | null
  readonly title: string
  readonly rationale: string
  readonly publishedAt: string | null
}) => Effect.gen(function*() {
  if (!input.claimId) return { recorded: false, reason: "NO_ISSUE" } as FixFollowUp
  const intervention = yield* recordIntervention(input.businessId, input.claimId, input.userId, {
    type: fixType(input.kind),
    target: (input.link ?? input.title).slice(0, 2000),
    performedAt: input.publishedAt ?? new Date().toISOString(),
    notes: `Published from OpenRecord: ${input.rationale}`.slice(0, 2000),
    sourceBindingId: null,
  }).pipe(Effect.catchAll(() => Effect.succeed(undefined)))
  if (intervention === null) return { recorded: false, reason: "ISSUE_NOT_FOUND" } as FixFollowUp
  if (intervention === undefined) return { recorded: false, reason: "NOT_RECORDED" } as FixFollowUp
  const recheck = yield* requestRecheck(input.businessId, input.claimId, input.userId, { interventionId: intervention.id }).pipe(
    Effect.map(r => r ? "QUEUED" as const : "NOT_QUEUED" as const),
    Effect.catchTag("ReobservationAlreadyActive", () => Effect.succeed("ALREADY_ACTIVE" as const)),
    Effect.catchAll(() => Effect.succeed("NOT_QUEUED" as const)),
  )
  return { recorded: true, interventionId: intervention.id, recheck } as FixFollowUp
})
