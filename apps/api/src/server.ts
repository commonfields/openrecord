import { HttpServer } from "@effect/platform"
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { Config, Effect, Layer } from "effect"
import { PgClient } from "@effect/sql-pg"
import { createServer } from "node:http"
import { Repos } from "./services.js"
import { makeRouter } from "./router.js"
import { resumeLocalBridges } from "./local-bridge.js"
import { briefScheduler } from "./growth-brief.js"
import { trackingScheduler } from "./acquisition-schedule.js"
import { answerScheduler } from "./research/answer-schedule.js"
import { followupScheduler } from "./agent-followups.js"
import { setupScheduler } from "./setup-scheduler.js"
import { agentRequestWorker } from "./agent-request-queue.js"
import { withAgentWorkerRuntime } from "./agent-worker-runtime.js"

// Only what the API consumes: requiring unused keys (session secret,
// worker path) at boot would be a regression for dev and deploy.
const ApiConfig = Config.all({
  databaseUrl: Config.redacted("DATABASE_URL"),
  port: Config.integer("PORT").pipe(Config.withDefault(3001)),
  appBaseUrl: Config.string("APP_BASE_URL").pipe(Config.withDefault("http://localhost:3000")),
  agentRequestWorkerEnabled: Config.boolean("AGENT_REQUEST_WORKER_ENABLED").pipe(Config.withDefault(true)),
})

const main = Effect.flatMap(ApiConfig, (config) =>
  Effect.gen(function*() {
    yield* Effect.logInfo(`API listening on port ${config.port}`)
    const PgLive = PgClient.layer({ url: config.databaseUrl })
    // Wire Postgres into the repositories (sequential), then serve.
    const ReposProvided = Layer.provideMerge(Repos, PgLive)
    // This computer's bridges start with the server (local mode only).
    const LocalBridges = Layer.effectDiscard(Effect.forkDaemon(resumeLocalBridges.pipe(Effect.delay("1 second"), Effect.catchAllCause(Effect.logWarning))))
    // Weekly growth briefs that are due, checked every five minutes once the server is up.
    const Briefs = Layer.effectDiscard(Effect.forkDaemon(briefScheduler.pipe(Effect.delay("30 seconds"))))
    const Followups = Layer.scopedDiscard(Effect.forkScoped(followupScheduler.pipe(Effect.delay("30 seconds"))))
    // Scheduled AI-answer tracking runs that are due, and comparisons of finished runs.
    const Tracking = Layer.effectDiscard(Effect.forkDaemon(trackingScheduler.pipe(Effect.delay("45 seconds"))))
    // Approved AI answer tracking on the team's own subscriptions.
    const AnswerTracking = Layer.effectDiscard(Effect.forkDaemon(answerScheduler.pipe(Effect.delay("60 seconds"))))
    const Setup = Layer.scopedDiscard(Effect.forkScoped(setupScheduler))
    const AgentRequests = config.agentRequestWorkerEnabled
      ? Layer.scopedDiscard(Effect.forkScoped(withAgentWorkerRuntime("api", agentRequestWorker)))
      : Layer.empty
    const ServerLive = Layer.mergeAll(HttpServer.serve(makeRouter()), LocalBridges, Briefs, Followups, Tracking, AnswerTracking, Setup, AgentRequests).pipe(
      Layer.provide(ReposProvided),
      Layer.provide(NodeHttpServer.layer(() => createServer(), { port: config.port })),
    )
    yield* Layer.launch(ServerLive)
  }),
)

NodeRuntime.runMain(main)
