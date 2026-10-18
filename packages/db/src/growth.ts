import { Context, Data, Effect, Layer, Schema } from "effect"
import { PgClient } from "@effect/sql-pg"
import type { SqlError } from "@effect/sql/SqlError"
import {
  canTransitionGrowth, CreateGrowthOpportunity, GrowthDecision, GrowthEvidenceInput, GrowthMetric,
  GrowthOpportunityFields, GrowthProductInput, GrowthProfileInput, GrowthStatus,
  type GrowthGoal, type GrowthObservedRef, type GrowthOpportunity, type GrowthProfile,
} from "@openrecord/contracts"
import { decodeRow, type RowDecodeError } from "./row-codecs.js"
import { RecordRepository } from "./record.js"
import type { Session } from "./auth.js"

export class GrowthRefused extends Data.TaggedError("GrowthRefused")<{ readonly reason: string }> {}
export type GrowthEffect<A> = Effect.Effect<A, SqlError | RowDecodeError | GrowthRefused>
const Goal = Schema.Struct({ ...GrowthMetric.fields, id: Schema.UUID, businessId: Schema.UUID, version: Schema.Int, createdByUserId: Schema.UUID, createdAt: Schema.String })
const Profile = Schema.Struct({ businessId: Schema.UUID, category: Schema.String, audience: Schema.String, valueProposition: Schema.String,
  primaryGoal: Goal, updatedByUserId: Schema.UUID, updatedAt: Schema.String })
const EvidenceMeta = Schema.Struct({ id: Schema.UUID, createdAt: Schema.String })
const Evidence = Schema.Union(
  Schema.extend(GrowthEvidenceInput.members[0], EvidenceMeta),
  Schema.extend(GrowthEvidenceInput.members[1], EvidenceMeta),
  Schema.extend(GrowthEvidenceInput.members[2], EvidenceMeta),
)
const Event = Schema.Struct({ id: Schema.UUID, status: GrowthStatus, revision: Schema.Int,
  actor: Schema.Literal("OPERATOR", "ASSISTANT", "DELIVERY_SYSTEM", "MEASUREMENT_SYSTEM"), userId: Schema.UUID, reason: Schema.String, createdAt: Schema.String })
const Opportunity = Schema.Struct({ ...GrowthOpportunityFields.fields, id: Schema.UUID, businessId: Schema.UUID, ownerUserId: Schema.UUID,
  createdByUserId: Schema.UUID, createdByActor: Schema.Literal("OPERATOR", "ASSISTANT"), createdAt: Schema.String, updatedAt: Schema.String,
  updatedByUserId: Schema.UUID, status: GrowthStatus, revision: Schema.Int, evidence: Schema.Array(Evidence), events: Schema.Array(Event) })
export class GrowthRepository extends Context.Tag("GrowthRepository")<GrowthRepository, {
  readonly profile: (accountId: string, businessId: string) => GrowthEffect<GrowthProfile | null>
  readonly goals: (accountId: string, businessId: string) => GrowthEffect<ReadonlyArray<GrowthGoal>>
  readonly saveProfile: (session: Session, businessId: string, input: GrowthProfileInput) => GrowthEffect<GrowthProfile>
  readonly registerProduct: (session: Session, input: typeof GrowthProductInput.Type) => Effect.Effect<GrowthProfile, SqlError | RowDecodeError | GrowthRefused | import("./record.js").RecordRefused, RecordRepository>
  readonly list: (accountId: string, businessId: string, limit?: number) => GrowthEffect<ReadonlyArray<GrowthOpportunity>>
  readonly get: (accountId: string, businessId: string, opportunityId: string) => GrowthEffect<GrowthOpportunity>
  readonly create: (session: Session, businessId: string, actor: "OPERATOR" | "ASSISTANT", input: CreateGrowthOpportunity) => GrowthEffect<GrowthOpportunity>
  readonly validateObserved: (accountId: string, businessId: string, references: ReadonlyArray<GrowthObservedRef>) => GrowthEffect<{ valid: ReadonlyArray<GrowthObservedRef>; dropped: number }>
  readonly propose: (session: Session, businessId: string, opportunityId: string, input: GrowthDecision) => GrowthEffect<GrowthOpportunity>
  /** Human decisions only. No assistant or future-system actor argument. */
  readonly decide: (session: Session, businessId: string, opportunityId: string, decision: "APPROVED" | "CANCELLED", input: GrowthDecision) => GrowthEffect<GrowthOpportunity>
}>() {}

export const GrowthRepositoryLive = Layer.effect(GrowthRepository, Effect.map(PgClient.PgClient, sql => {
  const refuse = (reason: string) => Effect.fail(new GrowthRefused({ reason }))
  const parse = <A, I>(schema: Schema.Schema<A, I>, input: unknown) => Schema.decodeUnknown(schema, { onExcessProperty: "error" })(input).pipe(
    Effect.mapError(() => new GrowthRefused({ reason: "InvalidRequest" })))
  const scope = (accountId: string, businessId: string) => Effect.gen(function*() {
    const rows = yield* sql`SELECT b.id FROM businesses b JOIN record_profiles r ON r.business_id=b.id WHERE b.id=${businessId} AND b.account_id=${accountId}`
    if (!rows.length) return yield* refuse("GrowthNotFound")
  })
  const member = (session: Session, businessId: string) => Effect.gen(function*() {
    yield* scope(session.accountId, businessId)
    const rows = yield* sql`SELECT 1 FROM account_users WHERE account_id=${session.accountId} AND user_id=${session.userId}`
    if (!rows.length) return yield* refuse("GrowthNotFound")
  })
  const profile = (accountId: string, businessId: string): GrowthEffect<GrowthProfile | null> => Effect.gen(function*() {
    yield* scope(accountId, businessId)
    const rows = yield* sql`SELECT jsonb_build_object('businessId',p.business_id,'category',p.category,'audience',p.audience,
      'valueProposition',p.value_proposition,'primaryGoal',g.document,'updatedByUserId',p.updated_by_user_id,'updatedAt',p.updated_at) AS document
      FROM growth_profiles p JOIN growth_goal_documents g ON g.id=p.primary_goal_id AND g.business_id=p.business_id WHERE p.business_id=${businessId}`
    return rows[0] ? yield* decodeRow(Profile, "growth_profiles", rows[0]["document"]) : null
  })
  const get = (accountId: string, businessId: string, opportunityId: string): GrowthEffect<GrowthOpportunity> => Effect.gen(function*() {
    yield* scope(accountId, businessId)
    const rows = yield* sql`SELECT document FROM growth_opportunity_documents WHERE id=${opportunityId} AND business_id=${businessId}`
    if (!rows[0]) return yield* refuse("OpportunityNotFound")
    return yield* decodeRow(Opportunity, "growth_opportunities", rows[0]["document"])
  })
  const saveProfile = (session: Session, businessId: string, raw: GrowthProfileInput): GrowthEffect<GrowthProfile> => sql.withTransaction(Effect.gen(function*() {
    yield* member(session, businessId)
    const input = yield* parse(GrowthProfileInput, raw)
    yield* sql`SELECT business_id FROM record_profiles WHERE business_id=${businessId} FOR UPDATE`
    const current = yield* profile(session.accountId, businessId)
    // Repeat the same definition without manufacturing a new metric version.
    const metric = input.primaryGoal
    const metricKeys: ReadonlyArray<keyof GrowthMetric> = ["kind", "analyticsSource", "eventName", "countingSemantics", "reportingTimeZone", "propertyRef"]
    const same = current !== null && metricKeys.every(key => current.primaryGoal[key] === metric[key])
    let goalId = current?.primaryGoal.id
    if (!same) {
      const rows = yield* sql`INSERT INTO growth_goals(business_id,version,kind,analytics_source,event_name,counting_semantics,reporting_time_zone,property_ref,created_by_user_id)
        SELECT ${businessId},COALESCE(MAX(version),0)+1,${metric.kind},${metric.analyticsSource},${metric.eventName},${metric.countingSemantics},${metric.reportingTimeZone},${metric.propertyRef},${session.userId}
        FROM growth_goals WHERE business_id=${businessId} RETURNING id`
      goalId = String(rows[0]!["id"])
    }
    if (!goalId) return yield* refuse("GoalRequired")
    yield* sql`INSERT INTO growth_profiles(business_id,category,audience,value_proposition,primary_goal_id,updated_by_user_id)
      VALUES(${businessId},${input.category},${input.audience},${input.valueProposition},${goalId},${session.userId})
      ON CONFLICT(business_id) DO UPDATE SET category=excluded.category,audience=excluded.audience,value_proposition=excluded.value_proposition,
        primary_goal_id=excluded.primary_goal_id,updated_by_user_id=excluded.updated_by_user_id,updated_at=now()`
    const saved = yield* profile(session.accountId, businessId)
    if (!saved) return yield* refuse("GrowthNotFound")
    return saved
  }))
  const validateObserved = (accountId: string, businessId: string, references: ReadonlyArray<GrowthObservedRef>) => Effect.gen(function*() {
    yield* scope(accountId, businessId)
    const valid: GrowthObservedRef[] = []
    for (const reference of references) {
      const rows = yield* sql`SELECT growth_observed_exists(${businessId}::uuid,${reference.kind},${reference.id}::uuid) AS valid`
      if (rows[0]?.["valid"] === true) valid.push(reference)
    }
    return { valid, dropped: references.length - valid.length }
  })
  const transition = (session: Session, businessId: string, opportunityId: string, decision: "PROPOSED" | "APPROVED" | "CANCELLED", raw: GrowthDecision): GrowthEffect<GrowthOpportunity> => sql.withTransaction(Effect.gen(function*() {
      yield* member(session, businessId)
      const input = yield* parse(GrowthDecision, raw)
      if (decision !== "PROPOSED" && decision !== "APPROVED" && decision !== "CANCELLED") return yield* refuse("TransitionRefused")
      const locked = yield* sql`SELECT id FROM growth_opportunities WHERE id=${opportunityId} AND business_id=${businessId} FOR UPDATE`
      if (!locked.length) return yield* refuse("OpportunityNotFound")
      const existing = yield* sql`SELECT e.status,e.reason,e.revision,prior.status AS expected_status FROM growth_opportunity_events e
        LEFT JOIN growth_opportunity_events prior ON prior.opportunity_id=e.opportunity_id AND prior.revision=e.revision-1
        WHERE e.opportunity_id=${opportunityId} AND e.request_key=${input.idempotencyKey}`
      if (existing[0]) {
        if (existing[0]["status"] !== decision || existing[0]["reason"] !== input.reason || existing[0]["revision"] !== input.expectedRevision + 1 || existing[0]["expected_status"] !== input.expectedStatus) return yield* refuse("IdempotencyConflict")
        return yield* get(session.accountId, businessId, opportunityId)
      }
      const current = yield* get(session.accountId, businessId, opportunityId)
      if (current.status !== input.expectedStatus || current.revision !== input.expectedRevision) return yield* refuse("StaleDecision")
      if (!canTransitionGrowth(current.status, decision, "OPERATOR")) return yield* refuse("TransitionRefused")
      yield* sql`INSERT INTO growth_opportunity_events(opportunity_id,business_id,revision,status,actor,user_id,reason,request_key)
        VALUES(${opportunityId},${businessId},${current.revision + 1},${decision},'OPERATOR',${session.userId},${input.reason},${input.idempotencyKey})`
      return yield* get(session.accountId, businessId, opportunityId)
    }))
  return {
    profile, get, saveProfile, validateObserved,
    goals: (accountId, businessId) => Effect.gen(function*() {
      yield* scope(accountId, businessId)
      const rows = yield* sql`SELECT document FROM growth_goal_documents WHERE business_id=${businessId} ORDER BY (document->>'version')::int DESC LIMIT 100`
      return yield* Effect.forEach(rows, row => decodeRow(Goal, "growth_goals", row["document"]))
    }),
    registerProduct: (session, raw) => sql.withTransaction(Effect.gen(function*() {
      const input = yield* parse(GrowthProductInput, raw)
      // Lock account, not global state: concurrent registration replays one
      // existing Business + Record profile without leaving orphan clients.
      const accounts = yield* sql`SELECT a.id FROM accounts a JOIN account_users u ON u.account_id=a.id
        WHERE a.id=${session.accountId} AND u.user_id=${session.userId} FOR UPDATE OF a`
      if (!accounts.length) return yield* refuse("GrowthNotFound")
      const existing = yield* sql`SELECT business_id FROM growth_registrations WHERE account_id=${session.accountId} AND request_key=${input.idempotencyKey}`
      if (existing[0]) {
        const saved = yield* profile(session.accountId, String(existing[0]["business_id"]))
        if (!saved) return yield* refuse("GrowthNotFound")
        return saved
      }
      const record = yield* (yield* RecordRepository).createClient(session, { name: input.name, websiteUrl: input.websiteUrl, engagement: input.engagement })
      const saved = yield* saveProfile(session, record.businessId, { category: input.category, audience: input.audience, valueProposition: input.valueProposition, primaryGoal: input.primaryGoal })
      yield* sql`INSERT INTO growth_registrations(account_id,request_key,business_id) VALUES(${session.accountId},${input.idempotencyKey},${record.businessId})`
      return saved
    })),
    list: (accountId, businessId, limit = 50) => Effect.gen(function*() {
      yield* scope(accountId, businessId)
      const rows = yield* sql`SELECT document FROM growth_opportunity_documents WHERE business_id=${businessId} ORDER BY created_at DESC,id LIMIT ${Math.min(100, Math.max(1, limit))}`
      return yield* Effect.forEach(rows, row => decodeRow(Opportunity, "growth_opportunities", row["document"]))
    }),
    create: (session, businessId, actor, raw) => sql.withTransaction(Effect.gen(function*() {
      yield* member(session, businessId)
      const input = yield* parse(CreateGrowthOpportunity, raw)
      if (actor !== "OPERATOR" && actor !== "ASSISTANT") return yield* refuse("ActorRefused")
      // Same business lock also fences concurrent primary-goal edits.
      yield* sql`SELECT business_id FROM record_profiles WHERE business_id=${businessId} FOR UPDATE`
      const existing = yield* sql`SELECT id,created_by_actor FROM growth_opportunities WHERE business_id=${businessId} AND request_key=${input.idempotencyKey}`
      if (existing[0]) {
        if (existing[0]["created_by_actor"] !== actor) return yield* refuse("IdempotencyConflict")
        return yield* get(session.accountId, businessId, String(existing[0]["id"]))
      }
      const goals = yield* sql`SELECT id FROM growth_goals WHERE id=${input.goalId} AND business_id=${businessId}`
      if (!goals.length) return yield* refuse("GoalNotFound")
      const current = yield* profile(session.accountId, businessId)
      if (!current || current.primaryGoal.id !== input.goalId) return yield* refuse("PrimaryGoalChanged")
      const owner = yield* sql`SELECT 1 FROM account_users WHERE account_id=${session.accountId} AND user_id=${input.ownerUserId}`
      if (!owner.length) return yield* refuse("OwnerNotFound")
      if (!canTransitionGrowth(null, input.initialStatus, actor)) return yield* refuse("TransitionRefused")
      const evidence: ReadonlyArray<GrowthEvidenceInput> = input.evidence
      if (!evidence.some(e => e.type === (actor === "ASSISTANT" ? "MODEL_SUGGESTION" : "OPERATOR_HYPOTHESIS"))) return yield* refuse("AuthorshipRequired")
      if (evidence.some(e => (e.type === "MODEL_SUGGESTION" && actor !== "ASSISTANT") || (e.type === "OPERATOR_HYPOTHESIS" && actor !== "OPERATOR"))) return yield* refuse("EvidenceAuthorityRefused")
      const refs = evidence.flatMap(e => e.type === "OBSERVED" ? [e.reference] : [])
      if ((yield* validateObserved(session.accountId, businessId, refs)).dropped > 0) return yield* refuse("EvidenceNotFound")
      const rows = yield* sql`INSERT INTO growth_opportunities(business_id,goal_id,title,problem_statement,audience,buyer_intent,target_url,source,proposed_change,
        expected_mechanism,assumptions,uncertainty,baseline_availability,owner_user_id,created_by_user_id,created_by_actor,request_key)
        VALUES(${businessId},${input.goalId},${input.title},${input.problemStatement},${input.audience},${input.buyerIntent},${input.targetUrl},${input.source},${input.proposedChange},
        ${input.expectedMechanism},${input.assumptions},${input.uncertainty},${input.baselineAvailability},${input.ownerUserId},${session.userId},${actor},${input.idempotencyKey}) RETURNING id`
      const id = String(rows[0]!["id"])
      for (const e of evidence) yield* sql`INSERT INTO growth_opportunity_evidence(opportunity_id,business_id,type,reference_kind,reference_id,note)
        VALUES(${id},${businessId},${e.type},${e.type === "OBSERVED" ? e.reference.kind : null},${e.type === "OBSERVED" ? e.reference.id : null},${e.note})`
      yield* sql`INSERT INTO growth_opportunity_events(opportunity_id,business_id,revision,status,actor,user_id,reason,request_key)
        VALUES(${id},${businessId},1,${input.initialStatus},${actor},${session.userId},'Opportunity created',${input.idempotencyKey})`
      return yield* get(session.accountId, businessId, id)
    })),
    propose: (session, businessId, opportunityId, input) => transition(session, businessId, opportunityId, "PROPOSED", input),
    decide: (session, businessId, opportunityId, decision, input) => {
      if (decision !== "APPROVED" && decision !== "CANCELLED") return refuse("TransitionRefused")
      return transition(session, businessId, opportunityId, decision, input)
    },
  } satisfies Context.Tag.Service<GrowthRepository>
}))
