import { randomUUID } from "node:crypto"
import { SqlClient } from "@effect/sql"
import { Effect } from "effect"

/** Process liveness, independent of any single job lease. Never contains secrets. */
export const withAgentWorkerRuntime = <A, E, R>(mode: "api" | "standalone", work: Effect.Effect<A, E, R>) =>
  Effect.scoped(Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const id = randomUUID()
    const raw = process.env["OPENRECORD_BUILD_FINGERPRINT"] ?? ""
    const fingerprint = /^[a-f0-9]{64}$/.test(raw) ? raw : null
    yield* Effect.acquireRelease(
      sql`INSERT INTO agent_worker_instances(id,mode,source_fingerprint) VALUES(${id},${mode},${fingerprint})`,
      () => sql`UPDATE agent_worker_instances SET stopped_at=now() WHERE id=${id}`.pipe(
        Effect.timeout("3 seconds"), Effect.catchAllCause(() => Effect.void)),
    )
    yield* Effect.logInfo(`agent request worker started (${mode}, ${id})`)
    const heartbeat = Effect.forever(Effect.sleep("10 seconds").pipe(Effect.andThen(
      sql`UPDATE agent_worker_instances SET heartbeat_at=now() WHERE id=${id}`,
    )))
    return yield* Effect.raceFirst(work, heartbeat)
  }))
