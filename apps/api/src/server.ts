import { HttpServer } from "@effect/platform"
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node"
import { Config, Effect, Layer } from "effect"
import { PgClient } from "@effect/sql-pg"
import { createServer } from "node:http"
import {
  GrowthRepositoriesLive,
  SetupRepositoryLive,
  AgentProposalRepositoryLive,
  AuthRepositoryLive,
  AssayRepositoryLive,
  AssayReviewRepositoryLive,
  BusinessRepositoryLive,
  CheckRunRepositoryLive,
  ClaimRepositoryLive,
  DiscoveryFrontierRepositoryLive,
  DiscoveryMatchRepositoryLive,
  DiscoveryObservationRepositoryLive,
  DiscoveryRunRepositoryLive,
  DiscoveryScopeRepositoryLive,
  EvidenceLineageRepositoryLive,
  FactRepositoryLive,
  InterventionBindingRepositoryLive,
  InterventionRepositoryLive,
  JudgmentRepositoryLive,
  ObservationRepositoryLive,
  ProductReadRepositoryLive,
  QuestionRepositoryLive,
  SiteFindingEventRepositoryLive,
  SiteFindingRepositoryLive,
  SiteFixProposalRepositoryLive,
  SiteGscRepositoryLive,
  SiteMutationRepositoryLive,
  SiteOperatorEventRepositoryLive,
  SitePageObservationRepositoryLive,
  SiteRunRepositoryLive,
  SiteTargetRepositoryLive,
  SiteVerificationRepositoryLive,
  SourceTargetRepositoryLive,
  ReobservationIntentRepositoryLive,
  ReobservationRepositoryLive,
  RecordRepositoryLive,
  AcquisitionRepositoryLive,
  GrowthMeasurementRepositoryLive,
} from "@openrecord/db"
import { GitHubExecutionLive } from "@openrecord/site-operator"
import { Ga4ProviderLive } from "@openrecord/ga4"
import { AdsProviderLive } from "@openrecord/ads"
import { makeRouter } from "./router.js"
import { resumeLocalBridges } from "./local-bridge.js"
import { briefScheduler } from "./growth-brief.js"

const Repos = Layer.mergeAll(
  GitHubExecutionLive,
  // W8: GA4 OAuth client, redirect URI and token encryption keys from server configuration only.
  Ga4ProviderLive,
  // Meta and Google Ads app credentials and redirect URI, from server configuration only.
  AdsProviderLive,
  GrowthRepositoriesLive,
  SetupRepositoryLive,
  GrowthMeasurementRepositoryLive,
  AgentProposalRepositoryLive,
  RecordRepositoryLive,
  AcquisitionRepositoryLive,
  AssayRepositoryLive,
  AssayReviewRepositoryLive,
  AuthRepositoryLive,
  BusinessRepositoryLive,
  FactRepositoryLive,
  QuestionRepositoryLive,
  SourceTargetRepositoryLive,
  CheckRunRepositoryLive,
  ObservationRepositoryLive,
  ClaimRepositoryLive,
  InterventionBindingRepositoryLive,
  InterventionRepositoryLive,
  JudgmentRepositoryLive,
  ProductReadRepositoryLive,
  QuestionRepositoryLive,
  SourceTargetRepositoryLive,
  ReobservationIntentRepositoryLive,
  ReobservationRepositoryLive,
  DiscoveryScopeRepositoryLive,
  DiscoveryRunRepositoryLive,
  EvidenceLineageRepositoryLive,
  DiscoveryFrontierRepositoryLive,
  DiscoveryObservationRepositoryLive,
  DiscoveryMatchRepositoryLive,
  SiteTargetRepositoryLive,
  SiteRunRepositoryLive,
  SitePageObservationRepositoryLive,
  SiteFindingRepositoryLive,
  SiteFindingEventRepositoryLive,
  SiteFixProposalRepositoryLive,
  SiteMutationRepositoryLive,
  SiteVerificationRepositoryLive,
  SiteOperatorEventRepositoryLive,
  SiteGscRepositoryLive,
)

// Only what the API consumes: requiring unused keys (session secret,
// worker path) at boot would be a regression for dev and deploy.
const ApiConfig = Config.all({
  databaseUrl: Config.redacted("DATABASE_URL"),
  port: Config.integer("PORT").pipe(Config.withDefault(3001)),
  appBaseUrl: Config.string("APP_BASE_URL").pipe(Config.withDefault("http://localhost:3000")),
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
    const ServerLive = Layer.mergeAll(HttpServer.serve(makeRouter()), LocalBridges, Briefs).pipe(
      Layer.provide(ReposProvided),
      Layer.provide(NodeHttpServer.layer(() => createServer(), { port: config.port })),
    )
    yield* Layer.launch(ServerLive)
  }),
)

NodeRuntime.runMain(main)
