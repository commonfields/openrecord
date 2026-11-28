import { randomUUID } from "node:crypto"
import { MAX_CONTINUATIONS, TurnContinuation } from "./turn-continuation.js"
import { SqlClient } from "@effect/sql"
import { Cause, Data, Effect, Option, Schedule, Schema } from "effect"
import { AgentWorkKind, runAgentWorkJob } from "./agent-work-handlers.js"

type WorkJob = {
  job_id: string
  account_id: string
  user_id: string
  business_id: string
  kind: AgentWorkKind
  ref_id: string
  payload: unknown
  claim_id: string
  /** Times a restart cut this job's turn short and it was queued again. */
  continuations?: number
}

/**
 * A handler fails with this only when the attempt saved nothing: no tool
 * that writes ran, and the record it works on was left as it was. The job
 * then runs again after a growing delay, up to MAX_WORK_ATTEMPTS. Any other
 * failure after execution starts is final, so ambiguous work is never replayed.
 */
export class AgentWorkRetry extends Data.TaggedError("AgentWorkRetry")<{ readonly reason: string }> {}
export const MAX_WORK_ATTEMPTS = 4
/** Kinds whose handler reads the outside state before writing, so one interrupted mid-run may run again. */
const RESUMABLE_KINDS: ReadonlySet<string> = new Set(["CHANGE_PUBLISH_WRITE"])
/**
 * Kinds whose work is one agent turn sent through sendUnattendedTurn. One cut
 * short by a restart runs again as a continuation (TurnContinuation): told the
 * original request and to check before repeating, at most MAX_CONTINUATIONS
 * times, as an interrupted chat turn is. Follow-ups, visibility reviews and
 * helpers are read-only or have their own recovery, and are not continued.
 */
const CONTINUABLE_KINDS: ReadonlySet<string> = new Set(["GROWTH_BRIEF_WRITE", "SETUP_DRAFT_WRITE", "APPROVED_INITIATIVE_WRITE", "DECLINED_INITIATIVE_WRITE",
  "SETUP_CAMPAIGN_WRITE", "DECISION_RESUME_WRITE"])
/** One, three, then nine minutes. */
export const retryDelaySeconds = (attempt: number) => Math.min(1800, 60 * 3 ** Math.max(0, attempt - 1))
/** Which attempt this is, for handlers that settle their record only on the last one. */
export interface WorkAttempt { readonly attempt: number; readonly finalAttempt: boolean }
const isRetry = (e: unknown): e is AgentWorkRetry => typeof e === "object" && e !== null && (e as { _tag?: unknown })._tag === "AgentWorkRetry"
/** True when a handler's failure asks for another attempt; handlers that catch everything let it through. */
export const isWorkRetry = (cause: Cause.Cause<unknown>) => Option.exists(Cause.failureOption(cause), isRetry)

export const reconcileAgentWork = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql`UPDATE agent_work_jobs SET status='QUEUED', claim_id=NULL, lease_until=NULL, started_at=NULL
    WHERE status='RUNNING' AND lease_until<=now() AND execution_started_at IS NULL`
  // A publish reads the site before it writes, so one cut off mid-run is safe to run again (up to its attempts).
  yield* sql`UPDATE agent_work_jobs SET status='QUEUED', claim_id=NULL, lease_until=NULL, started_at=NULL, execution_started_at=NULL, failure_reason='INTERRUPTED'
    WHERE status='RUNNING' AND lease_until<=now() AND execution_started_at IS NOT NULL AND kind IN ${sql.in([...RESUMABLE_KINDS])} AND attempt_count < ${MAX_WORK_ATTEMPTS}`
  yield* sql`UPDATE agent_work_jobs SET status='QUEUED', claim_id=NULL, lease_until=NULL, started_at=NULL, execution_started_at=NULL,
      failure_reason='INTERRUPTED', continuations=continuations+1
    WHERE status='RUNNING' AND lease_until<=now() AND execution_started_at IS NOT NULL AND kind IN ${sql.in([...CONTINUABLE_KINDS])}
      AND continuations < ${MAX_CONTINUATIONS}`
  yield* sql`UPDATE agent_work_jobs SET status='INTERRUPTED', failure_reason='INTERRUPTED', finished_at=now(), claim_id=NULL, lease_until=NULL
    WHERE status='RUNNING' AND lease_until<=now() AND execution_started_at IS NOT NULL`
})

export const enqueueAgentWork = (input: {
  readonly accountId: string
  readonly userId: string
  readonly businessId: string
  readonly kind: AgentWorkKind
  readonly refId: string
  readonly payload: unknown
}) => Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const inserted = yield* sql`INSERT INTO agent_work_jobs(account_id,user_id,business_id,kind,ref_id,payload)
    VALUES (${input.accountId},${input.userId},${input.businessId},${input.kind},${input.refId},${JSON.stringify(input.payload)}::jsonb)
    ON CONFLICT DO NOTHING RETURNING job_id`
  return inserted[0] ? String(inserted[0]["job_id"]) : null
})

const claimWork = (helperOnly: boolean, waitedSeconds = 0) => Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* reconcileAgentWork
  return yield* sql.withTransaction(Effect.gen(function*() {
    yield* sql`SELECT pg_advisory_xact_lock(703941220)`
    const running = (yield* sql`SELECT count(*)::int AS n FROM agent_work_jobs WHERE status='RUNNING'`)[0]
    if (Number(running?.["n"] ?? 0) >= 4) return null
    const row = (yield* sql<WorkJob>`SELECT j.* FROM agent_work_jobs j
      WHERE j.status='QUEUED' AND j.available_at <= now() - make_interval(secs => ${waitedSeconds}) AND (${!helperOnly} OR j.kind='HELPER_TASK_RUN')
        -- One chat's work runs in order: a job waits while an older one for the same chat is queued
        -- (waiting to retry included) or running, so a later step never overtakes an earlier one.
        AND NOT EXISTS (SELECT 1 FROM agent_work_jobs older WHERE older.status IN ('QUEUED','RUNNING') AND older.job_id<>j.job_id
          AND (older.created_at, older.job_id) < (j.created_at, j.job_id)
          AND coalesce(older.payload->>'conversationId', older.payload->'wake'->>'conversation_id') = coalesce(j.payload->>'conversationId', j.payload->'wake'->>'conversation_id'))
      ORDER BY j.created_at FOR UPDATE SKIP LOCKED LIMIT 1`)[0]
    if (!row) return null
    const claimId = randomUUID()
    yield* sql`UPDATE agent_work_jobs SET status='RUNNING', claim_id=${claimId}, lease_until=now()+interval '15 minutes', started_at=now()
      WHERE job_id=${row.job_id}`
    return { ...row, claim_id: claimId }
  }))
})
export const claimAgentWork = claimWork(false)

/**
 * Claims one queued job by id, outside the shared cap: an approval the person
 * is waiting on runs at once, through the same lease and recording as any job.
 * Null when it is not queued (a worker took it, or it already ran).
 */
export const claimAgentWorkById = (jobId: string) => Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const claimId = randomUUID()
  const row = (yield* sql<WorkJob>`UPDATE agent_work_jobs SET status='RUNNING', claim_id=${claimId}, lease_until=now()+interval '15 minutes', started_at=now()
    WHERE job_id=${jobId} AND status='QUEUED' AND available_at<=now() RETURNING *`)[0]
  return row ? { ...row, claim_id: claimId } : null
})

type JobRunner<E, R> = (kind: AgentWorkKind, payload: unknown, job: WorkJob & WorkAttempt) => Effect.Effect<unknown, E, R>
/** Runs a claimed job with the registered handlers. */
export const executeAgentWork = (job: WorkJob) => executeAgentWorkWith(job, runAgentWorkJob)
/** Runs a claimed job with a given handler: tests, and a publish run inline by its own route. */
export const executeAgentWorkWith = <E, R>(job: WorkJob, run: JobRunner<E, R>) => Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  // A claim that never starts is not an attempt; only starting execution counts.
  const started = yield* sql`UPDATE agent_work_jobs SET execution_started_at=now(), attempt_count=attempt_count+1
    WHERE job_id=${job.job_id} AND claim_id=${job.claim_id} AND status='RUNNING' AND lease_until>now() AND execution_started_at IS NULL
    RETURNING attempt_count`
  if (!started[0]) return
  const attempt = Number(started[0]["attempt_count"])
  const tries: WorkAttempt = { attempt, finalAttempt: attempt >= MAX_WORK_ATTEMPTS }
  const active = Effect.gen(function*() {
    const rows = yield* sql`SELECT job_id FROM agent_work_jobs WHERE job_id=${job.job_id} AND claim_id=${job.claim_id}
      AND status='RUNNING' AND lease_until>now() FOR SHARE`
    if (!rows[0]) return yield* Effect.fail("CANCELLED" as const)
  })
  const heartbeat = Effect.forever(Effect.gen(function*() {
    yield* Effect.sleep("30 seconds")
    const rows = yield* sql`UPDATE agent_work_jobs SET lease_until=now()+interval '15 minutes'
      WHERE job_id=${job.job_id} AND claim_id=${job.claim_id} AND status='RUNNING' AND lease_until>now() RETURNING job_id`
    if (!rows[0]) return yield* Effect.fail("CANCELLED" as const)
  }))
  const work = Effect.gen(function*() {
    yield* active
    const kind = yield* Schema.decodeUnknown(AgentWorkKind)(job.kind)
    const handled = run(kind, job.payload, { ...job, ...tries })
    // A job continuing after a restart has its turn worded as a continuation.
    return yield* (job.continuations ? Effect.provideService(handled, TurnContinuation, { continuations: job.continuations }) : handled)
  })
  const outcome = yield* Effect.raceFirst(work, heartbeat).pipe(Effect.exit)
  if (outcome._tag === "Success") {
    yield* sql`UPDATE agent_work_jobs SET status='COMPLETED', finished_at=now(), lease_until=NULL, claim_id=NULL
      WHERE job_id=${job.job_id} AND claim_id=${job.claim_id} AND status='RUNNING'`
  } else if (outcome.cause._tag === "Fail" && isRetry(outcome.cause.error) && !tries.finalAttempt) {
    const delay = retryDelaySeconds(attempt)
    yield* sql`UPDATE agent_work_jobs SET status='QUEUED', failure_reason=${outcome.cause.error.reason.slice(0, 80)},
        available_at=now()+make_interval(secs => ${delay}), claim_id=NULL, lease_until=NULL, started_at=NULL, execution_started_at=NULL
      WHERE job_id=${job.job_id} AND claim_id=${job.claim_id} AND status='RUNNING'`
  } else {
    const reason = outcome.cause._tag === "Fail" && isRetry(outcome.cause.error) ? outcome.cause.error.reason.slice(0, 80) : outcome.cause._tag === "Fail" && typeof outcome.cause.error === "string" && /^[A-Z_]{1,80}$/.test(outcome.cause.error)
      ? outcome.cause.error : "FAILED"
    yield* sql`UPDATE agent_work_jobs SET status='FAILED', failure_reason=${reason}, finished_at=now(), lease_until=NULL, claim_id=NULL
      WHERE job_id=${job.job_id} AND claim_id=${job.claim_id} AND status='RUNNING'`
  }
})

/** One pass for tests and manual drains. */
export const runOneAgentWork = () =>
  Effect.gen(function*() {
    const job = yield* claimAgentWork
    if (job) yield* executeAgentWork(job)
    return job !== null
  })

const workLane = (helperOnly: boolean, waitedSeconds = 0) => Effect.gen(function*() {
  const job = yield* claimWork(helperOnly, waitedSeconds)
  if (job) yield* executeAgentWork(job)
  else if (!helperOnly) {
    const sessions = yield* Effect.promise(() => import("./agent-sessions.js"))
    yield* sessions.recoverQueuedHelperParent
  }
}).pipe(
  Effect.catchAllCause(() => Effect.logWarning("agent work worker unavailable")),
  Effect.repeat(Schedule.spaced("1 second")),
)

// Keep the existing lane for scheduled work and let async helpers run in
// parallel. The database enforces the shared four-job cap across replicas.
export const agentWorkWorker = Effect.all([workLane(false), workLane(true), workLane(true)], { concurrency: 3 }).pipe(Effect.asVoid)
/** The API's standby: work due this long with no worker taking it (`agentRequestStandby`). */
export const agentWorkStandby = Effect.all([workLane(false, 20), workLane(true, 20)], { concurrency: 2 }).pipe(Effect.asVoid)
