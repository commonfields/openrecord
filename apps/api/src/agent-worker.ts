import { NodeRuntime } from "@effect/platform-node"
import { PgClient } from "@effect/sql-pg"
import { Config, Effect, Layer } from "effect"
import { Repos } from "./services.js"
import { agentRequestWorker } from "./agent-request-queue.js"
import { withAgentWorkerRuntime } from "./agent-worker-runtime.js"

// No HTTP listener, local bridge launcher, publishing queues or other schedulers.
NodeRuntime.runMain(Effect.gen(function*() {
  const databaseUrl = yield* Config.redacted("DATABASE_URL")
  const services = Repos.pipe(Layer.provideMerge(PgClient.layer({ url: databaseUrl })))
  yield* withAgentWorkerRuntime("standalone", agentRequestWorker).pipe(Effect.provide(services))
}))
