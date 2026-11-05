import { Layer } from "effect"
import {
  GrowthRepositoriesLive, SetupRepositoryLive, AgentProposalRepositoryLive,
  AuthRepositoryLive, AssayRepositoryLive, AssayReviewRepositoryLive,
  BusinessRepositoryLive, CheckRunRepositoryLive, ClaimRepositoryLive,
  DiscoveryFrontierRepositoryLive, DiscoveryMatchRepositoryLive,
  DiscoveryObservationRepositoryLive, DiscoveryRunRepositoryLive,
  DiscoveryScopeRepositoryLive, EvidenceLineageRepositoryLive, FactRepositoryLive,
  InterventionBindingRepositoryLive, InterventionRepositoryLive, JudgmentRepositoryLive,
  ObservationRepositoryLive, ProductReadRepositoryLive, QuestionRepositoryLive,
  SiteFindingEventRepositoryLive, SiteFindingRepositoryLive, SiteFixProposalRepositoryLive,
  SiteGscRepositoryLive, SiteMutationRepositoryLive, SiteOperatorEventRepositoryLive,
  SitePageObservationRepositoryLive, SiteRunRepositoryLive, SiteTargetRepositoryLive,
  SiteVerificationRepositoryLive, SourceTargetRepositoryLive,
  ReobservationIntentRepositoryLive, ReobservationRepositoryLive, RecordRepositoryLive,
  AcquisitionRepositoryLive, GrowthMeasurementRepositoryLive,
} from "@openrecord/db"
import { GitHubExecutionLive } from "@openrecord/site-operator"
import { Ga4ProviderLive } from "@openrecord/ga4"
import { AdsProviderLive } from "@openrecord/ads"

/** Shared dependencies only: importing this module starts no HTTP server or queues. */
export const Repos = Layer.mergeAll(
  GitHubExecutionLive, Ga4ProviderLive, AdsProviderLive,
  GrowthRepositoriesLive, SetupRepositoryLive, GrowthMeasurementRepositoryLive,
  AgentProposalRepositoryLive, RecordRepositoryLive, AcquisitionRepositoryLive,
  AssayRepositoryLive, AssayReviewRepositoryLive, AuthRepositoryLive,
  BusinessRepositoryLive, FactRepositoryLive, QuestionRepositoryLive,
  SourceTargetRepositoryLive, CheckRunRepositoryLive, ObservationRepositoryLive,
  ClaimRepositoryLive, InterventionBindingRepositoryLive, InterventionRepositoryLive,
  JudgmentRepositoryLive, ProductReadRepositoryLive, ReobservationIntentRepositoryLive,
  ReobservationRepositoryLive, DiscoveryScopeRepositoryLive, DiscoveryRunRepositoryLive,
  EvidenceLineageRepositoryLive, DiscoveryFrontierRepositoryLive,
  DiscoveryObservationRepositoryLive, DiscoveryMatchRepositoryLive,
  SiteTargetRepositoryLive, SiteRunRepositoryLive, SitePageObservationRepositoryLive,
  SiteFindingRepositoryLive, SiteFindingEventRepositoryLive, SiteFixProposalRepositoryLive,
  SiteMutationRepositoryLive, SiteVerificationRepositoryLive,
  SiteOperatorEventRepositoryLive, SiteGscRepositoryLive,
)
