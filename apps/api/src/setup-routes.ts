import { HttpRouter } from "@effect/platform"
import { PgClient } from "@effect/sql-pg"
import { Effect, Option } from "effect"
import { BusinessRepository, GrowthGa4Repository, GrowthRefused, GrowthRepository, RecordRefused, SetupRefused, SetupRepository, setupKey, type Session, type SetupRow } from "@openrecord/db"
import { SetupConfirmInput, SetupRevisionInput, SetupStartInput, decodeRouteId, type SetupView } from "@openrecord/contracts"
import { Ga4Provider } from "@openrecord/ga4"
import { GitHubExecution } from "@openrecord/site-operator"
import { decode, json, operatorSessionFor, readJson, type WithSession } from "./record-routes.js"
import { deriveChannelInventory } from "./channels.js"
import { loadProviderCatalog } from "./provider-catalog.js"
import { assessSetup, firstInitiative, setupStep } from "./setup-plan.js"

const STATUS: Record<SetupRefused["reason"], number> = {
  SetupNotFound: 404, SetupStale: 409, WebsiteInUse: 409, DiscoveryPending: 409, BriefRequired: 409, ChannelsRequired: 409, NotRetryable: 409, FactsManagedByRepository: 409,
}
const failure = (e: unknown) => {
  if (e instanceof SetupRefused) return json(STATUS[e.reason], { _tag: "SetupRefused", reason: e.reason, ...(e.businessId ? { businessId: e.businessId } : {}) })
  if (e instanceof GrowthRefused) return json(e.reason.endsWith("NotFound") ? 404 : e.reason === "InvalidRequest" ? 422 : 409, { _tag: "GrowthRefused", reason: e.reason })
  if (e instanceof RecordRefused) return json(e.reason.endsWith("NotFound") ? 404 : 409, { _tag: "RecordRefused", reason: e.reason })
  if (typeof e === "object" && e !== null && "_tag" in e && e._tag === "NotAuthenticated") return json(401, { _tag: "NotAuthenticated" })
  return json(500, { _tag: "SetupRequestFailed" })
}

/** Gathers what the inventory needs. Every read is scoped to the account. */
const channelsFor = (accountId: string, businessId: string, setup: SetupRow | null) => Effect.gen(function*() {
  const sql = yield* PgClient.PgClient
  const counts = yield* sql`SELECT
      (SELECT count(*) FROM site_targets WHERE business_id = ${businessId} AND enabled) AS site_targets,
      (SELECT count(*) FROM growth_execution_targets WHERE business_id = ${businessId}) AS execution_targets,
      (SELECT website_url FROM record_profiles WHERE business_id = ${businessId}) AS website_url`
  const ga4Config = yield* Effect.serviceOption(Ga4Provider)
  const ga4Configured = Option.isSome(ga4Config) && ga4Config.value.configured
  const ga4Repo = yield* GrowthGa4Repository
  const connections = ga4Configured ? yield* ga4Repo.connections(accountId) : []
  const bindings = ga4Configured ? yield* ga4Repo.bindings(accountId, businessId) : []
  const github = yield* Effect.serviceOption(GitHubExecution)
  const catalog = yield* loadProviderCatalog(false, false)
  return deriveChannelInventory({
    businessId,
    websiteUrl: setup?.websiteUrl ?? (counts[0]?.["website_url"] ? String(counts[0]["website_url"]) : null),
    discovery: setup?.discovery ?? null,
    siteTargets: Number(counts[0]?.["site_targets"] ?? 0),
    ga4: { configured: ga4Configured, connections: connections.map(c => ({ status: c.status, statusReason: c.statusReason, googleEmail: c.googleEmail })), boundToBusiness: bindings.some(b => b.active) },
    github: { configured: Option.isSome(github) && github.value.transport !== null, targets: Number(counts[0]?.["execution_targets"] ?? 0) },
    answerProviders: catalog.providers.filter(p => p.id !== "mock" && p.enabled).map(p => p.id),
  })
})

const viewOf = (session: Session, row: SetupRow) => Effect.gen(function*() {
  const growth = yield* GrowthRepository
  const inventory = yield* channelsFor(session.accountId, row.businessId, row)
  const profile = yield* growth.profile(session.accountId, row.businessId)
  const opportunity = row.opportunityId ? yield* growth.get(session.accountId, row.businessId, row.opportunityId) : null
  const discovery: SetupView["discovery"] = row.discoveryStatus === "DONE" && row.discovery ? { status: "DONE", signals: row.discovery }
    : row.discoveryStatus === "FAILED" ? { status: "FAILED", failure: row.discoveryFailure ?? "UNKNOWN" }
      : { status: row.discoveryStatus === "FETCHING" ? "FETCHING" : "QUEUED" }
  const settled = row.discoveryStatus === "DONE" || row.discoveryStatus === "FAILED"
  return {
    id: row.id, businessId: row.businessId, businessName: row.businessName, websiteUrl: row.websiteUrl, goalStatement: row.goalStatement,
    step: setupStep(row), revision: row.revision, discovery, brief: row.brief, channelsReviewedAt: row.channelsReviewedAt, inventory,
    assessment: settled ? assessSetup(row.discovery, row.discoveryFailure, inventory, profile !== null) : null,
    opportunity,
  } satisfies SetupView
})

export const setupApi = (withSession: WithSession) => {
  const operator = operatorSessionFor(withSession)
  const business = <E, R>(run: (session: Session, businessId: string) => Effect.Effect<import("@effect/platform/HttpServerResponse").HttpServerResponse, E, R>) =>
    operator(session => Effect.gen(function*() {
      const { params } = yield* HttpRouter.RouteContext
      const businessId = params["id"] ?? ""
      if (decodeRouteId(businessId)._tag === "Left") return yield* json(422, { _tag: "InvalidRequest" })
      if (!(yield* (yield* BusinessRepository).getScoped(session.accountId, businessId))) return yield* json(404, { _tag: "SetupRefused", reason: "SetupNotFound" })
      return yield* run(session, businessId)
    })).pipe(Effect.catchAll(failure))
  const withRevision = (act: (session: Session, businessId: string, revision: number) => Effect.Effect<SetupRow, unknown, SetupRepository | GrowthRepository>) =>
    business((session, businessId) => Effect.gen(function*() {
      const input = decode(SetupRevisionInput, yield* readJson)
      if (!input) return yield* json(422, { _tag: "InvalidRequest" })
      const row = yield* act(session, businessId, input.expectedRevision)
      return yield* json(200, { setup: yield* viewOf(session, row) })
    }))

  return HttpRouter.empty.pipe(
    HttpRouter.post("/api/setup", operator(session => Effect.gen(function*() {
      const input = decode(SetupStartInput, yield* readJson)
      if (!input) return yield* json(422, { _tag: "InvalidRequest" })
      const { setup, created } = yield* (yield* SetupRepository).start(session, input)
      return yield* json(200, { setup: yield* viewOf(session, setup), created })
    })).pipe(Effect.catchAll(failure))),

    HttpRouter.get("/api/businesses/:id/setup", business((session, businessId) => Effect.gen(function*() {
      const row = yield* (yield* SetupRepository).get(session.accountId, businessId)
      return yield* json(200, { setup: row ? yield* viewOf(session, row) : null })
    }))),

    HttpRouter.get("/api/businesses/:id/channels", business((session, businessId) => Effect.gen(function*() {
      const row = yield* (yield* SetupRepository).get(session.accountId, businessId)
      return yield* json(200, { inventory: yield* channelsFor(session.accountId, businessId, row) })
    }))),

    HttpRouter.post("/api/businesses/:id/setup/confirm", business((session, businessId) => Effect.gen(function*() {
      const input = decode(SetupConfirmInput, yield* readJson)
      if (!input) return yield* json(422, { _tag: "InvalidRequest" })
      const row = yield* (yield* SetupRepository).confirm(session, businessId, input)
      return yield* json(200, { setup: yield* viewOf(session, row) })
    }))),

    HttpRouter.post("/api/businesses/:id/setup/channels", withRevision((session, businessId, revision) => Effect.flatMap(SetupRepository, r => r.reviewChannels(session, businessId, revision)))),
    HttpRouter.post("/api/businesses/:id/setup/retry", withRevision((session, businessId, revision) => Effect.flatMap(SetupRepository, r => r.retry(session, businessId, revision)))),

    HttpRouter.post("/api/businesses/:id/setup/propose", withRevision((session, businessId, revision) => Effect.gen(function*() {
      const setups = yield* SetupRepository
      return yield* setups.withTransaction(Effect.gen(function*() {
        const row = yield* setups.lockForPropose(session, businessId, revision)
        if (row.opportunityId) return row
        const growth = yield* GrowthRepository
        const profile = yield* growth.profile(session.accountId, businessId)
        if (!profile || !row.brief) return yield* Effect.fail(new SetupRefused({ reason: "BriefRequired" }))
        const fields = firstInitiative({ goalId: profile.primaryGoal.id, brief: row.brief, websiteUrl: row.websiteUrl, signals: row.discovery, readOn: new Date().toISOString().slice(0, 10) })
        const opportunity = yield* growth.create(session, businessId, "ASSISTANT", {
          ...fields, ownerUserId: session.userId, initialStatus: "PROPOSED", idempotencyKey: setupKey(row.id, "propose"),
          evidence: [{ type: "MODEL_SUGGESTION", note: "Suggested by OpenRecord setup from your confirmed brief and a public read of your homepage, using fixed rules. A hypothesis for your review: no impact is claimed." }],
        })
        yield* setups.linkOpportunity(row.id, opportunity.id)
        return { ...row, opportunityId: opportunity.id, revision: row.revision + 1 }
      }))
    }))),
  )
}
