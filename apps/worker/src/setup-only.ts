// Local development setup worker. It only reads queued setup homepages;
// measurement, execution and other queues are handled by the full worker.
import { Config, Effect, Layer } from "effect"
import { NodeRuntime } from "@effect/platform-node"
import { PgClient } from "@effect/sql-pg"
import { SetupRepositoryLive } from "@openrecord/db"
import { SetupRunner, SetupRunnerLive } from "./setup-runner.js"

const main = Effect.flatMap(Config.redacted("DATABASE_URL"), url => {
  const pg = PgClient.layer({ url })
  const setup = SetupRunnerLive.pipe(Layer.provide(SetupRepositoryLive), Layer.provide(pg))
  return Effect.gen(function*() {
    const runner = yield* SetupRunner
    while (true) {
      const worked = yield* runner.runOnce().pipe(Effect.catchAll(error => Effect.logError("setup worker failed").pipe(
        Effect.annotateLogs({ error: error._tag }), Effect.as(false))))
      if (!worked) yield* Effect.sleep("1 second")
    }
  }).pipe(Effect.provide(setup), Effect.scoped)
})

NodeRuntime.runMain(main)
