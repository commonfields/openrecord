// Local development AI-check worker. It only runs queued AI-answer checks
// (re-checks after a fix, checks a person approved); setup, execution, GA4 and
// discovery queues are handled elsewhere. Each check asks a real assistant
// and is billed by that provider, so scripts/dev-up.sh starts it only when
// OPENRECORD_CHECKS=1.
import { Config, Effect } from "effect"
import { NodeRuntime } from "@effect/platform-node"
import { CheckRunner } from "./check-runner.js"
import { buildCheckLive } from "./runner.js"

const main = Effect.flatMap(Config.redacted("DATABASE_URL"), url => Effect.gen(function*() {
  const runner = yield* CheckRunner
  yield* Effect.logInfo("AI-check worker started")
  while (true) {
    const worked = yield* runner.runOnce().pipe(Effect.catchAll(error => Effect.logError("check worker failed").pipe(
      Effect.annotateLogs({ error: error._tag }), Effect.as(false))))
    if (!worked) yield* Effect.sleep("2 seconds")
  }
}).pipe(Effect.provide(buildCheckLive(url)), Effect.scoped))

NodeRuntime.runMain(main)
