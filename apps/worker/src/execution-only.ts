// Explicit local worker for approved connected changes. It never claims the
// measurement, setup, or other worker queues.
import { Config, Effect, Layer } from "effect"
import { NodeRuntime } from "@effect/platform-node"
import { PgClient } from "@effect/sql-pg"
import { GrowthExecutionRepositoryLive } from "@openrecord/db"
import { GitHubExecution, GitHubExecutionLive, parseRepositoryAllowlist } from "@openrecord/site-operator"
import { ExecutionRunner, ExecutionRunnerLive } from "./execution-runner.js"

const main = Effect.gen(function*() {
  const github = yield* GitHubExecution
  if (!github.transport || parseRepositoryAllowlist(process.env["GITHUB_EXECUTION_REPOSITORIES"]).size === 0) {
    return yield* Effect.fail(new Error("Execution worker requires a valid GitHub execution token, endpoint, and repository allowlist; no jobs were claimed."))
  }
  const runner = yield* ExecutionRunner
  yield* Effect.logInfo("connected execution worker started")
  while (true) {
    const worked = yield* runner.runOnce().pipe(Effect.catchAll(error => Effect.logError("execution worker failed").pipe(
      Effect.annotateLogs({ error: error._tag }), Effect.as(false))))
    if (!worked) yield* Effect.sleep("1 second")
  }
})

const program = Effect.flatMap(Config.redacted("DATABASE_URL"), url => {
  const pg = PgClient.layer({ url })
  const github = GitHubExecutionLive
  const runner = ExecutionRunnerLive.pipe(Layer.provide(Layer.mergeAll(GrowthExecutionRepositoryLive, github)), Layer.provide(pg))
  return main.pipe(Effect.provide(Layer.mergeAll(runner, github)), Effect.scoped)
})

NodeRuntime.runMain(program)
