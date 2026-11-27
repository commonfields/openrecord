// Approved website changes publish through a durable job. The approval moves
// the change to PUBLISHING and queues the job in one transaction, then runs it
// at once so the person sees the result. If the process stops part way, the
// job is claimed again after its lease and finishes from what the site holds:
// each publish reads the site before it writes (wordpress.ts carryOutChange,
// webflow.ts carryOutWebflowChange), so running it again never writes twice.
import { Effect } from "effect"
import { claimAgentWorkById, enqueueAgentWork, executeAgentWorkWith } from "./agent-work-queue.js"

export type ChangePublishPayload = {
  readonly system: "WORDPRESS" | "WEBFLOW"
  readonly accountId: string
  readonly businessId: string
  readonly changeId: string
}

/** Queues the publish. Call inside the transaction that moved the change to PUBLISHING. */
export const enqueueChangePublish = (input: ChangePublishPayload & { readonly userId: string }) =>
  enqueueAgentWork({ accountId: input.accountId, userId: input.userId, businessId: input.businessId, kind: "CHANGE_PUBLISH_WRITE", refId: input.changeId,
    payload: { system: input.system, accountId: input.accountId, businessId: input.businessId, changeId: input.changeId } satisfies ChangePublishPayload })

/**
 * Runs a queued publish now, in this request, under the job's lease. The caller
 * passes its own publish (the same one the worker runs), so this module never
 * imports the sites. Its result comes back; null when a worker already has it or it failed.
 */
export const runChangePublishNow = <A, E, R>(jobId: string, publish: Effect.Effect<A, E, R>) => Effect.gen(function*() {
  const job = yield* claimAgentWorkById(jobId)
  if (!job) return null
  let result: A | null = null
  yield* executeAgentWorkWith(job, () => Effect.tap(publish, r => Effect.sync(() => { result = r })))
  return result as A | null
})

export const writeChangePublishJob = (raw: ChangePublishPayload) => Effect.gen(function*() {
  if (raw.system === "WORDPRESS") {
    const m = yield* Effect.promise(() => import("./wordpress.js"))
    return yield* Effect.asVoid(m.carryOutChange(raw.accountId, raw.businessId, raw.changeId))
  }
  const m = yield* Effect.promise(() => import("./webflow.js"))
  return yield* Effect.asVoid(m.carryOutWebflowChange(raw.accountId, raw.businessId, raw.changeId))
})
