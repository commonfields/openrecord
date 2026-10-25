import { createHash } from "node:crypto"
import { Context, Data, Effect, Layer, Schema } from "effect"
import { PgClient } from "@effect/sql-pg"
import type { SqlError } from "@effect/sql/SqlError"
import type { Fragment } from "@effect/sql/Statement"
import type { DiscoverySignals, SetupBrief, SetupConfirmInput, SetupStartInput } from "@openrecord/contracts"
import { decodeRow, iso, IntField, NullableJsonField, NullableTextField, NullableTimestampField, NullableUuidField, TextField, UuidField, type RowDecodeError } from "./row-codecs.js"
import { RecordRepository, type RecordRefused } from "./record.js"
import { FactRepository } from "./repositories.js"
import { GrowthRepository, type GrowthRefused } from "./growth.js"
import type { Session } from "./auth.js"

export class SetupRefused extends Data.TaggedError("SetupRefused")<{ readonly reason: "SetupNotFound" | "SetupStale" | "WebsiteInUse" | "DiscoveryPending" | "BriefRequired" | "ChannelsRequired" | "NotRetryable" | "FactsManagedByRepository"; readonly businessId?: string }> {}
type SetupError = SqlError | RowDecodeError | SetupRefused | GrowthRefused | RecordRefused
export type SetupEffect<A, R = never> = Effect.Effect<A, SetupError, R>

const Row = Schema.Struct({
  id: UuidField, account_id: UuidField, business_id: UuidField, business_name: TextField, website_url: TextField, website_host: TextField,
  goal_statement: NullableTextField, started_by_user_id: UuidField, discovery_status: Schema.Literal("QUEUED", "FETCHING", "DONE", "FAILED"),
  discovery_attempts: IntField, claim_token: NullableUuidField, discovery: NullableJsonField, discovery_failure: NullableTextField,
  brief: NullableJsonField, brief_confirmed_at: NullableTimestampField, channels_reviewed_at: NullableTimestampField,
  opportunity_id: NullableUuidField, revision: IntField,
})
export interface SetupRow {
  readonly id: string
  readonly accountId: string
  readonly businessId: string
  readonly businessName: string
  readonly websiteUrl: string
  readonly websiteHost: string
  readonly goalStatement: string | null
  readonly discoveryStatus: "QUEUED" | "FETCHING" | "DONE" | "FAILED"
  readonly claimToken: string | null
  readonly discovery: DiscoverySignals | null
  readonly discoveryFailure: string | null
  readonly brief: (SetupBrief & { readonly confirmedAt: string }) | null
  readonly channelsReviewedAt: string | null
  readonly opportunityId: string | null
  readonly revision: number
}
const toRow = (r: typeof Row.Type): SetupRow => ({
  id: r.id, accountId: r.account_id, businessId: r.business_id, businessName: r.business_name, websiteUrl: r.website_url, websiteHost: r.website_host,
  goalStatement: r.goal_statement, discoveryStatus: r.discovery_status, claimToken: r.claim_token,
  // Written only by this module from typed values; the database keeps it immutable once recorded.
  discovery: r.discovery as DiscoverySignals | null,
  discoveryFailure: r.discovery_failure,
  brief: r.brief && r.brief_confirmed_at ? { ...(r.brief as unknown as SetupBrief), confirmedAt: iso(r.brief_confirmed_at) } : null,
  channelsReviewedAt: r.channels_reviewed_at ? iso(r.channels_reviewed_at) : null,
  opportunityId: r.opportunity_id, revision: Number(r.revision),
})

/** The host a setup is keyed on: one setup per website per account. */
export const setupHost = (url: string): string => new URL(url).hostname.toLowerCase().replace(/^www\./, "")

/** A stable UUID for an idempotency key derived from a setup and a purpose,
 * so a retried request replays instead of writing twice. */
export const setupKey = (setupId: string, purpose: string): string => {
  const h = createHash("sha256").update(`${setupId}:${purpose}`).digest("hex")
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`
}

export type DiscoveryResult = { readonly signals: DiscoverySignals } | { readonly failure: string }

export class SetupRepository extends Context.Tag("SetupRepository")<SetupRepository, {
  /** Starts setup, or returns the setup that already exists for the business
   * or website. Never creates a second business for the same website. */
  readonly start: (session: Session, input: SetupStartInput) => SetupEffect<{ readonly setup: SetupRow; readonly created: boolean }, RecordRepository>
  readonly get: (accountId: string, businessId: string) => SetupEffect<SetupRow | null>
  readonly claim: (scope?: { readonly businessId?: string }) => SetupEffect<SetupRow | null>
  readonly complete: (claimed: SetupRow, result: DiscoveryResult) => SetupEffect<void>
  readonly retry: (session: Session, businessId: string, expectedRevision: number) => SetupEffect<SetupRow>
  readonly confirm: (session: Session, businessId: string, input: SetupConfirmInput) => SetupEffect<SetupRow, FactRepository | GrowthRepository>
  readonly reviewChannels: (session: Session, businessId: string, expectedRevision: number) => SetupEffect<SetupRow>
  /** Locks the setup for the propose step; the caller creates the initiative
   * inside the same transaction and links it with `linkOpportunity`. */
  readonly lockForPropose: (session: Session, businessId: string, expectedRevision: number) => SetupEffect<SetupRow>
  readonly linkOpportunity: (setupId: string, opportunityId: string) => SetupEffect<void>
  readonly withTransaction: <A, E, R>(fx: Effect.Effect<A, E, R>) => Effect.Effect<A, E | SqlError, R>
}>() {}

export const SetupRepositoryLive = Layer.effect(SetupRepository, Effect.map(PgClient.PgClient, sql => {
  const select = (where: Fragment) => sql`SELECT s.*, b.name AS business_name FROM business_setups s JOIN businesses b ON b.id = s.business_id WHERE ${where}`
  const one = (rows: ReadonlyArray<unknown>) => rows[0] ? decodeRow(Row, "business_setups", rows[0]).pipe(Effect.map(toRow)) : Effect.succeed(null)
  const byBusiness = (accountId: string, businessId: string, lock = false) =>
    (lock
      ? sql`SELECT s.*, b.name AS business_name FROM business_setups s JOIN businesses b ON b.id = s.business_id WHERE s.account_id = ${accountId} AND s.business_id = ${businessId} FOR UPDATE OF s`
      : select(sql`s.account_id = ${accountId} AND s.business_id = ${businessId}`)).pipe(Effect.flatMap(one))
  const locked = (session: Session, businessId: string, expectedRevision: number) => Effect.gen(function*() {
    const row = yield* byBusiness(session.accountId, businessId, true)
    if (!row) return yield* Effect.fail(new SetupRefused({ reason: "SetupNotFound" }))
    if (row.revision !== expectedRevision) return yield* Effect.fail(new SetupRefused({ reason: "SetupStale" }))
    return row
  })
  const reread = (accountId: string, businessId: string) => byBusiness(accountId, businessId).pipe(
    Effect.flatMap(r => (r ? Effect.succeed(r) : Effect.fail(new SetupRefused({ reason: "SetupNotFound" })))))

  return {
    withTransaction: fx => sql.withTransaction(fx),

    start: (session, input) => sql.withTransaction(Effect.gen(function*() {
      // One writer per account at a time, so two tabs cannot race a duplicate.
      yield* sql`SELECT id FROM accounts WHERE id = ${session.accountId} FOR UPDATE`
      const host = setupHost(input.websiteUrl)
      const existingForHost = yield* select(sql`s.account_id = ${session.accountId} AND s.website_host = ${host}`).pipe(Effect.flatMap(one))

      let businessId = input.businessId
      if (businessId) {
        const owned = yield* sql`SELECT id FROM businesses WHERE id = ${businessId} AND account_id = ${session.accountId}`
        if (owned.length === 0) return yield* Effect.fail(new SetupRefused({ reason: "SetupNotFound" }))
        const current = yield* byBusiness(session.accountId, businessId)
        if (current) return { setup: current, created: false }
        if (existingForHost) return yield* Effect.fail(new SetupRefused({ reason: "WebsiteInUse", businessId: existingForHost.businessId }))
        const profile = yield* sql`SELECT 1 FROM record_profiles WHERE business_id = ${businessId}`
        if (profile.length === 0) yield* sql`INSERT INTO record_profiles (business_id, website_url, engagement) VALUES (${businessId}, ${input.websiteUrl}, 'CLIENT')`
      } else {
        if (existingForHost) return { setup: existingForHost, created: false }
        // An existing client on the same website is the same business: adopt it.
        const clients = yield* sql`SELECT p.business_id, p.website_url FROM record_profiles p JOIN businesses b ON b.id = p.business_id
          WHERE b.account_id = ${session.accountId} ORDER BY p.created_at, p.business_id`
        const match = clients.find(c => { try { return setupHost(String(c["website_url"])) === host } catch { return false } })
        businessId = match ? String(match["business_id"]) : (yield* (yield* RecordRepository).createClient(session, { name: host, websiteUrl: input.websiteUrl, engagement: "CLIENT" })).businessId
      }
      yield* sql`INSERT INTO business_setups (account_id, business_id, website_url, website_host, goal_statement, started_by_user_id)
        VALUES (${session.accountId}, ${businessId}, ${input.websiteUrl}, ${host}, ${input.goalStatement}, ${session.userId})`
      return { setup: yield* reread(session.accountId, businessId), created: true }
    })),

    get: (accountId, businessId) => byBusiness(accountId, businessId),

    claim: scope => sql`WITH candidate AS (
        SELECT id FROM business_setups
        WHERE (discovery_status = 'QUEUED' OR (discovery_status = 'FETCHING' AND claimed_at < now() - interval '5 minutes'))
          AND discovery_attempts < 3
          AND (${scope?.businessId ?? null}::uuid IS NULL OR business_id = ${scope?.businessId ?? null}::uuid)
        ORDER BY created_at, id LIMIT 1 FOR UPDATE SKIP LOCKED
      ) UPDATE business_setups s SET discovery_status = 'FETCHING', claimed_at = now(), claim_token = gen_random_uuid(), discovery_attempts = discovery_attempts + 1
      FROM candidate c WHERE s.id = c.id RETURNING s.id`.pipe(
      Effect.flatMap(rows => rows[0] ? select(sql`s.id = ${String(rows[0]["id"])}`).pipe(Effect.flatMap(one)) : Effect.succeed(null))),

    complete: (claimed, result) => sql.withTransaction(Effect.gen(function*() {
      const current = yield* sql`SELECT discovery_status, claim_token FROM business_setups WHERE id = ${claimed.id} FOR UPDATE`
      // A run that lost its claim (timed out, re-queued) must not overwrite a newer one.
      if (current[0]?.["discovery_status"] !== "FETCHING" || current[0]?.["claim_token"] !== claimed.claimToken) return
      if ("signals" in result)
        yield* sql`UPDATE business_setups SET discovery_status = 'DONE', discovery = ${JSON.stringify(result.signals)}::jsonb, discovered_at = now(),
          discovery_failure = NULL, claim_token = NULL, revision = revision + 1, updated_at = now() WHERE id = ${claimed.id}`
      else
        yield* sql`UPDATE business_setups SET discovery_status = 'FAILED', discovery_failure = ${result.failure.slice(0, 200)}, claim_token = NULL,
          revision = revision + 1, updated_at = now() WHERE id = ${claimed.id}`
    })),

    retry: (session, businessId, expectedRevision) => sql.withTransaction(Effect.gen(function*() {
      const row = yield* locked(session, businessId, expectedRevision)
      if (row.discoveryStatus !== "FAILED") return yield* Effect.fail(new SetupRefused({ reason: "NotRetryable" }))
      yield* sql`UPDATE business_setups SET discovery_status = 'QUEUED', discovery_attempts = 0, discovery_failure = NULL, revision = revision + 1, updated_at = now() WHERE id = ${row.id}`
      return yield* reread(session.accountId, businessId)
    })),

    confirm: (session, businessId, input) => sql.withTransaction(Effect.gen(function*() {
      const row = yield* locked(session, businessId, input.expectedRevision)
      // A failed discovery never blocks setup: the operator can describe the business by hand.
      if (row.discoveryStatus === "QUEUED" || row.discoveryStatus === "FETCHING") return yield* Effect.fail(new SetupRefused({ reason: "DiscoveryPending" }))
      const mode = yield* sql`SELECT writer FROM business_authority_mode WHERE business_id = ${businessId}`
      if (input.facts.length > 0 && mode[0] && mode[0]["writer"] === "REPOSITORY_MANIFEST") return yield* Effect.fail(new SetupRefused({ reason: "FactsManagedByRepository" }))

      yield* sql`UPDATE businesses SET name = ${input.businessName} WHERE id = ${businessId} AND account_id = ${session.accountId}`
      const facts = yield* FactRepository
      const now = new Date().toISOString()
      const factIds: string[] = []
      for (const fact of input.facts) {
        const active = (yield* facts.listByBusiness(businessId)).find(f => f.status === "ACTIVE" && f.subject === input.businessName && f.predicate === fact.predicate)
        if (active && active.valueText === fact.valueText) { factIds.push(active.id); continue }
        const saved = active
          ? yield* facts.supersede({ businessId, factId: active.id, valueText: fact.valueText, valueType: "TEXT", validFrom: now, validUntil: null, sourceKind: "WEBSITE" })
          : yield* facts.create({ businessId, subject: input.businessName, predicate: fact.predicate, valueText: fact.valueText, valueType: "TEXT", validFrom: now, validUntil: null, sourceKind: "WEBSITE" })
        factIds.push(saved.id)
      }
      yield* (yield* GrowthRepository).saveProfile(session, businessId, {
        category: input.category, audience: input.audience, valueProposition: input.valueProposition, goalStatement: input.goalStatement,
        // Measured by manual daily exports until an operator binds an analytics source.
        metric: { conversionKind: input.conversionKind, label: input.metricLabel, sourceKind: "OPERATOR_AGGREGATE_EXPORT", sourceIdentity: "Manual daily export",
          reportingTimeZone: input.reportingTimeZone, propertyRef: null, eventName: null, countingSemantics: "EVENT_COUNT", unit: "COUNT", currency: null },
        idempotencyKey: setupKey(row.id, `confirm:${row.revision}`),
      })
      const brief: SetupBrief = { businessName: input.businessName, category: input.category, audience: input.audience, valueProposition: input.valueProposition,
        goalStatement: input.goalStatement, conversionKind: input.conversionKind, metricLabel: input.metricLabel, reportingTimeZone: input.reportingTimeZone, factIds }
      yield* sql`UPDATE business_setups SET brief = ${JSON.stringify(brief)}::jsonb, brief_confirmed_by_user_id = ${session.userId}, brief_confirmed_at = now(),
        goal_statement = ${input.goalStatement}, revision = revision + 1, updated_at = now() WHERE id = ${row.id}`
      return yield* reread(session.accountId, businessId)
    })),

    reviewChannels: (session, businessId, expectedRevision) => sql.withTransaction(Effect.gen(function*() {
      const row = yield* locked(session, businessId, expectedRevision)
      if (!row.brief) return yield* Effect.fail(new SetupRefused({ reason: "BriefRequired" }))
      if (!row.channelsReviewedAt)
        yield* sql`UPDATE business_setups SET channels_reviewed_by_user_id = ${session.userId}, channels_reviewed_at = now(), revision = revision + 1, updated_at = now() WHERE id = ${row.id}`
      return yield* reread(session.accountId, businessId)
    })),

    lockForPropose: (session, businessId, expectedRevision) => Effect.gen(function*() {
      const row = yield* byBusiness(session.accountId, businessId, true)
      if (!row) return yield* Effect.fail(new SetupRefused({ reason: "SetupNotFound" }))
      // A replay after success returns the linked initiative regardless of revision.
      if (row.opportunityId) return row
      if (row.revision !== expectedRevision) return yield* Effect.fail(new SetupRefused({ reason: "SetupStale" }))
      if (!row.brief) return yield* Effect.fail(new SetupRefused({ reason: "BriefRequired" }))
      if (!row.channelsReviewedAt) return yield* Effect.fail(new SetupRefused({ reason: "ChannelsRequired" }))
      return row
    }),

    linkOpportunity: (setupId, opportunityId) =>
      sql`UPDATE business_setups SET opportunity_id = ${opportunityId}, revision = revision + 1, updated_at = now() WHERE id = ${setupId} AND opportunity_id IS NULL`.pipe(Effect.asVoid),
  }
}))
