import { randomUUID } from "node:crypto"
import { SqlClient } from "@effect/sql"
import { Effect, Schedule, Schema } from "effect"
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
}

export const reconcileAgentWork = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql`UPDATE agent_work_jobs SET status='QUEUED', claim_id=NULL, lease_until=NULL, started_at=NULL
    WHERE status='RUNNING' AND lease_until<=now() AND execution_started_at IS NULL`
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

const claimWork = (helperOnly: boolean) => Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* reconcileAgentWork
  return yield* sql.withTransaction(Effect.gen(function*() {
    yield* sql`SELECT pg_advisory_xact_lock(703941220)`
    const running = (yield* sql`SELECT count(*)::int AS n FROM agent_work_jobs WHERE status='RUNNING'`)[0]
    if (Number(running?.["n"] ?? 0) >= 4) return null
    const row = (yield* sql<WorkJob>`SELECT j.* FROM agent_work_jobs j
      WHERE j.status='QUEUED' AND (${!helperOnly} OR j.kind='HELPER_TASK_RUN')
      ORDER BY j.created_at FOR UPDATE SKIP LOCKED LIMIT 1`)[0]
    if (!row) return null
    const claimId = randomUUID()
    yield* sql`UPDATE agent_work_jobs SET status='RUNNING', claim_id=${claimId}, lease_until=now()+interval '15 minutes', started_at=now()
      WHERE job_id=${row.job_id}`
    return { ...row, claim_id: claimId }
  }))
})
export const claimAgentWork = claimWork(false)

export const executeAgentWork = (job: WorkJob, run = runAgentWorkJob) => Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const started = yield* sql`UPDATE agent_work_jobs SET execution_started_at=now()
    WHERE job_id=${job.job_id} AND claim_id=${job.claim_id} AND status='RUNNING' AND lease_until>now() AND execution_started_at IS NULL
    RETURNING job_id`
  if (!started[0]) return
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
    return yield* run(kind, job.payload, job)
  })
  const outcome = yield* Effect.raceFirst(work, heartbeat).pipe(Effect.exit)
  if (outcome._tag === "Success") {
    yield* sql`UPDATE agent_work_jobs SET status='COMPLETED', finished_at=now(), lease_until=NULL, claim_id=NULL
      WHERE job_id=${job.job_id} AND claim_id=${job.claim_id} AND status='RUNNING'`
  } else {
    const reason = outcome.cause._tag === "Fail" && typeof outcome.cause.error === "string" && /^[A-Z_]{1,80}$/.test(outcome.cause.error)
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

const workLane = (helperOnly: boolean) => Effect.gen(function*() {
  const job = yield* claimWork(helperOnly)
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
