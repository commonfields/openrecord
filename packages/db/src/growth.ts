import { createHash } from "node:crypto"
import { Context, Data, Effect, Layer, Schema } from "effect"
import { PgClient } from "@effect/sql-pg"
import type { SqlError } from "@effect/sql/SqlError"
import {
  canTransitionGrowth, CreateGrowthOpportunity, GrowthChannel, GrowthDecision, GrowthEvidenceInput, GrowthExecutionRecord, GrowthExecutionType,
  GrowthMetricDefinitionInput, GrowthProgress, GrowthReview, GrowthReviewConclusion, GrowthOpportunityFields, GrowthProductInput, GrowthProfileUpdate, GrowthStatus,
  type GrowthExecution, type GrowthGoal, type GrowthObservedRef, type GrowthOpportunity, type GrowthProfile,
} from "@openrecord/contracts"
import { decodeRow, iso, type RowDecodeError } from "./row-codecs.js"
import { RecordRepository } from "./record.js"
import type { Session } from "./auth.js"

export class GrowthRefused extends Data.TaggedError("GrowthRefused")<{ readonly reason: string }> {}
export type GrowthEffect<A> = Effect.Effect<A, SqlError | RowDecodeError | GrowthRefused>
const MetricMeta = Schema.Struct({ id: Schema.UUID, businessId: Schema.UUID, version: Schema.Int, createdByUserId: Schema.UUID, createdAt: Schema.String })
const Metric = Schema.Union(
  Schema.extend(GrowthMetricDefinitionInput.members[0], MetricMeta), Schema.extend(GrowthMetricDefinitionInput.members[1], MetricMeta), Schema.extend(GrowthMetricDefinitionInput.members[2], MetricMeta),
)
export const GrowthGoalDocument = Schema.Struct({ id: Schema.UUID, businessId: Schema.UUID, version: Schema.Int, statement: Schema.String,
  metricDefinition: Metric, createdByUserId: Schema.UUID, createdAt: Schema.String })
const Profile = Schema.Struct({ businessId: Schema.UUID, category: Schema.String, audience: Schema.String, valueProposition: Schema.String,
  primaryGoal: GrowthGoalDocument, updatedByUserId: Schema.UUID, updatedAt: Schema.String })
const EvidenceMeta = Schema.Struct({ id: Schema.UUID, createdAt: Schema.String })
const Evidence = Schema.Union(
  Schema.extend(GrowthEvidenceInput.members[0], EvidenceMeta),
  Schema.extend(GrowthEvidenceInput.members[1], EvidenceMeta),
  Schema.extend(GrowthEvidenceInput.members[2], EvidenceMeta),
)
const Event = Schema.Struct({ id: Schema.UUID, status: GrowthStatus, revision: Schema.Int,
  actor: Schema.Literal("OPERATOR", "ASSISTANT"), userId: Schema.UUID, reason: Schema.String, conclusion: Schema.NullOr(GrowthReviewConclusion), createdAt: Schema.String })
const ExecutionFields = { id: Schema.UUID, opportunityId: Schema.UUID, businessId: Schema.UUID, type: GrowthExecutionType, channel: GrowthChannel,
  target: Schema.String, description: Schema.NullOr(Schema.String), performedAt: Schema.String, recordedAt: Schema.String }
const Execution = Schema.Union(
  Schema.Struct({ ...ExecutionFields, assurance: Schema.Literal("OPERATOR_ATTESTED"), actor: Schema.Literal("HUMAN"), actorId: Schema.UUID, verification: Schema.Null }),
  Schema.Struct({ ...ExecutionFields, assurance: Schema.Literal("SYSTEM_VERIFIED"), actor: Schema.Literal("SYSTEM"), actorId: Schema.Null,
    verification: Schema.Struct({ kind: Schema.Literal("GROWTH_DELIVERY"), id: Schema.UUID, claim: Schema.Literal("PR_MERGED") }) }),
)
const Opportunity = Schema.Struct({ ...GrowthOpportunityFields.fields, id: Schema.UUID, businessId: Schema.UUID, ownerUserId: Schema.UUID,
  createdByUserId: Schema.UUID, createdByActor: Schema.Literal("OPERATOR", "ASSISTANT"), createdAt: Schema.String, updatedAt: Schema.String,
  updatedByUserId: Schema.UUID, status: GrowthStatus, revision: Schema.Int, progress: GrowthProgress, executionCount: Schema.Int, evidence: Schema.Array(Evidence), events: Schema.Array(Event) })
export class GrowthRepository extends Context.Tag("GrowthRepository")<GrowthRepository, {
  readonly profile: (accountId: string, businessId: string) => GrowthEffect<GrowthProfile | null>
  readonly goals: (accountId: string, businessId: string) => GrowthEffect<ReadonlyArray<GrowthGoal>>
  readonly saveProfile: (session: Session, businessId: string, input: GrowthProfileUpdate) => GrowthEffect<GrowthProfile>
  readonly registerProduct: (session: Session, input: typeof GrowthProductInput.Type) => Effect.Effect<GrowthProfile, SqlError | RowDecodeError | GrowthRefused | import("./record.js").RecordRefused, RecordRepository>
  readonly list: (accountId: string, businessId: string, limit?: number) => GrowthEffect<ReadonlyArray<GrowthOpportunity>>
  readonly get: (accountId: string, businessId: string, opportunityId: string) => GrowthEffect<GrowthOpportunity>
  readonly create: (session: Session, businessId: string, actor: "OPERATOR" | "ASSISTANT", input: CreateGrowthOpportunity) => GrowthEffect<GrowthOpportunity>
  readonly validateObserved: (accountId: string, businessId: string, references: ReadonlyArray<GrowthObservedRef>) => GrowthEffect<{ valid: ReadonlyArray<GrowthObservedRef>; dropped: number }>
  readonly propose: (session: Session, businessId: string, opportunityId: string, input: GrowthDecision) => GrowthEffect<GrowthOpportunity>
  readonly review: (session: Session, businessId: string, opportunityId: string, input: GrowthReview) => GrowthEffect<GrowthOpportunity>
  /** Human decisions only. No assistant or future-system actor argument. */
  readonly decide: (session: Session, businessId: string, opportunityId: string, decision: "APPROVED" | "CANCELLED", input: GrowthDecision) => GrowthEffect<GrowthOpportunity>
  /** Operator-only. Records one HUMAN / OPERATOR_ATTESTED execution on the
   * channel-neutral ledger and links it to the approved initiative. */
  readonly recordExecution: (session: Session, businessId: string, opportunityId: string, input: GrowthExecutionRecord) => GrowthEffect<GrowthOpportunity>
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
  /** Mirrors growth_opportunity_documents: an execution replaced by a
   * correction is not double-counted, so the history length equals
   * `executionCount` and each row carries its exact assurance. */
  const executionDocument = (businessId: string, row: Record<string, unknown>) => ({
    id: row["id"], opportunityId: row["opportunity_id"], businessId, type: row["type"], channel: row["channel"], target: row["target"],
    description: row["notes"], performedAt: iso(row["performed_at"] as Date | string), recordedAt: iso(row["created_at"] as Date | string),
    assurance: row["assurance"], actor: row["actor"], actorId: row["actor_id"],
    verification: row["verification_kind"] === null ? null : { kind: row["verification_kind"], id: row["verification_id"], claim: row["verification_claim"] },
  })
  const executionsOf = (businessId: string, opportunityId: string): GrowthEffect<ReadonlyArray<GrowthExecution>> => Effect.gen(function*() {
    const rows = yield* sql`SELECT a.opportunity_id,i.id,i.type,i.channel,i.target,i.notes,i.performed_at,i.assurance,i.actor,i.actor_id,
      i.verification_kind,i.verification_id,i.verification_claim,i.created_at
      FROM growth_initiative_actions a JOIN interventions i ON i.id=a.intervention_id AND i.business_id=a.business_id
      WHERE a.business_id=${businessId} AND a.opportunity_id=${opportunityId}
      AND NOT EXISTS(SELECT 1 FROM interventions correction WHERE correction.supersedes_id=i.id)
      ORDER BY i.performed_at,i.created_at,i.id`
    return yield* Effect.forEach(rows, row => decodeRow(Execution, "growth_initiative_actions", executionDocument(businessId, row)))
  })
  const executionsByOpportunity = (businessId: string): GrowthEffect<ReadonlyMap<string, ReadonlyArray<GrowthExecution>>> => Effect.gen(function*() {
    const rows = yield* sql`SELECT a.opportunity_id,i.id,i.type,i.channel,i.target,i.notes,i.performed_at,i.assurance,i.actor,i.actor_id,
      i.verification_kind,i.verification_id,i.verification_claim,i.created_at
      FROM growth_initiative_actions a JOIN interventions i ON i.id=a.intervention_id AND i.business_id=a.business_id
      WHERE a.business_id=${businessId} AND NOT EXISTS(SELECT 1 FROM interventions correction WHERE correction.supersedes_id=i.id)
      ORDER BY i.performed_at,i.created_at,i.id`
    const all = yield* Effect.forEach(rows, row => decodeRow(Execution, "growth_initiative_actions", executionDocument(businessId, row)))
    const grouped = new Map<string, Array<GrowthExecution>>()
    for (const execution of all) {
      const bucket = grouped.get(execution.opportunityId)
      if (bucket) bucket.push(execution); else grouped.set(execution.opportunityId, [execution])
    }
    return grouped
  })
  const get = (accountId: string, businessId: string, opportunityId: string): GrowthEffect<GrowthOpportunity> => Effect.gen(function*() {
    yield* scope(accountId, businessId)
    const rows = yield* sql`SELECT document FROM growth_opportunity_documents WHERE id=${opportunityId} AND business_id=${businessId}`
    if (!rows[0]) return yield* refuse("OpportunityNotFound")
    const opportunity = yield* decodeRow(Opportunity, "growth_opportunities", rows[0]["document"])
    return { ...opportunity, executions: yield* executionsOf(businessId, opportunityId) }
  })
  // Deterministic JSON for the operation fingerprint: key order must not let
  // two identical payloads hash differently.
  const canonical = (value: unknown): string => {
    const order = (v: unknown): unknown => Array.isArray(v) ? v.map(order)
      : v !== null && typeof v === "object" ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : 1).map(([k, x]) => [k, order(x)]))
      : v
    return JSON.stringify(order(value))
  }
  const saveProfile = (session: Session, businessId: string, raw: GrowthProfileUpdate): GrowthEffect<GrowthProfile> => sql.withTransaction(Effect.gen(function*() {
    yield* member(session, businessId)
    const input = yield* parse(GrowthProfileUpdate, raw)
    yield* sql`SELECT business_id FROM record_profiles WHERE business_id=${businessId} FOR UPDATE`
    // The request identity is read only after the business lock: concurrent
    // identical updates observe the first committed result instead of creating
    // duplicate versions, and a replay never re-applies older content.
    const fingerprint = createHash("sha256").update(canonical({
      category: input.category, audience: input.audience, valueProposition: input.valueProposition, goalStatement: input.goalStatement, metric: input.metric,
    })).digest("hex")
    const seen = yield* sql`SELECT fingerprint,result FROM growth_profile_updates WHERE business_id=${businessId} AND request_key=${input.idempotencyKey}`
    if (seen[0]) {
      if (seen[0]["fingerprint"] !== fingerprint) return yield* refuse("IdempotencyConflict")
      return yield* decodeRow(Profile, "growth_profile_updates", seen[0]["result"])
    }
    const current = yield* profile(session.accountId, businessId)
    // Locking the business serializes independent definition and goal versions.
    const metric = input.metric
    const matches = yield* sql`SELECT id FROM growth_metric_definitions WHERE business_id=${businessId}
      AND conversion_kind=${metric.conversionKind} AND label=${metric.label} AND source_kind=${metric.sourceKind}
      AND source_identity=${metric.sourceIdentity} AND event_name IS NOT DISTINCT FROM ${metric.eventName}
      AND counting_semantics=${metric.countingSemantics} AND unit=${metric.unit} AND currency IS NOT DISTINCT FROM ${metric.currency}
      AND reporting_time_zone=${metric.reportingTimeZone} AND property_ref IS NOT DISTINCT FROM ${metric.propertyRef} ORDER BY version DESC LIMIT 1`
    let metricId = matches[0] ? String(matches[0]["id"]) : undefined
    if (!metricId) {
      const rows = yield* sql`INSERT INTO growth_metric_definitions(business_id,version,conversion_kind,label,source_kind,source_identity,event_name,counting_semantics,unit,currency,reporting_time_zone,property_ref,created_by_user_id)
        SELECT ${businessId},COALESCE(MAX(version),0)+1,${metric.conversionKind},${metric.label},${metric.sourceKind},${metric.sourceIdentity},${metric.eventName},${metric.countingSemantics},${metric.unit},${metric.currency},${metric.reportingTimeZone},${metric.propertyRef},${session.userId}
        FROM growth_metric_definitions WHERE business_id=${businessId} RETURNING id`
      metricId = String(rows[0]!["id"])
    }
    let goalId = current?.primaryGoal.id
    if (!current || current.primaryGoal.statement !== input.goalStatement || current.primaryGoal.metricDefinition.id !== metricId) {
      const rows = yield* sql`INSERT INTO growth_goals(business_id,version,statement,metric_definition_id,created_by_user_id)
        SELECT ${businessId},COALESCE(MAX(version),0)+1,${input.goalStatement},${metricId},${session.userId}
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
    yield* sql`INSERT INTO growth_profile_updates(business_id,request_key,fingerprint,result,created_by_user_id)
      VALUES(${businessId},${input.idempotencyKey},${fingerprint},${JSON.stringify(saved)}::jsonb,${session.userId})`
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
  const transition = (session: Session, businessId: string, opportunityId: string, decision: "PROPOSED" | "APPROVED" | "CANCELLED" | "REVIEWED", raw: GrowthDecision | GrowthReview): GrowthEffect<GrowthOpportunity> => sql.withTransaction(Effect.gen(function*() {
      yield* member(session, businessId)
      const input = decision === "REVIEWED" ? yield* parse(GrowthReview, raw) : yield* parse(GrowthDecision, raw)
      const conclusion = "conclusion" in input ? input.conclusion : null
      if (decision !== "PROPOSED" && decision !== "APPROVED" && decision !== "CANCELLED" && decision !== "REVIEWED") return yield* refuse("TransitionRefused")
      const locked = yield* sql`SELECT id FROM growth_opportunities WHERE id=${opportunityId} AND business_id=${businessId} FOR UPDATE`
      if (!locked.length) return yield* refuse("OpportunityNotFound")
      const existing = yield* sql`SELECT e.status,e.reason,e.revision,e.conclusion,prior.status AS expected_status FROM growth_opportunity_events e
        LEFT JOIN growth_opportunity_events prior ON prior.opportunity_id=e.opportunity_id AND prior.revision=e.revision-1
        WHERE e.opportunity_id=${opportunityId} AND e.request_key=${input.idempotencyKey}`
      if (existing[0]) {
        if (existing[0]["conclusion"] !== conclusion || existing[0]["status"] !== decision || existing[0]["reason"] !== input.reason || existing[0]["revision"] !== input.expectedRevision + 1 || existing[0]["expected_status"] !== input.expectedStatus) return yield* refuse("IdempotencyConflict")
        return yield* get(session.accountId, businessId, opportunityId)
      }
      const current = yield* get(session.accountId, businessId, opportunityId)
      if (current.status !== input.expectedStatus || current.revision !== input.expectedRevision) return yield* refuse("StaleDecision")
      if (!canTransitionGrowth(current.status, decision, "OPERATOR")) return yield* refuse("TransitionRefused")
      // W7: a final decision cannot pretend it prevented an external action that may be in progress.
      if (decision === "REVIEWED" || decision === "CANCELLED") {
        const open = yield* sql`SELECT 1 FROM growth_execution_operations o WHERE o.opportunity_id=${opportunityId} AND o.business_id=${businessId}
          AND growth_execution_state(o.id) IN ('DISPATCHING','AWAITING_MERGE','RECONCILING','UNKNOWN') LIMIT 1`
        if (open.length) return yield* refuse("ExecutionUnresolved")
      }
      yield* sql`INSERT INTO growth_opportunity_events(opportunity_id,business_id,revision,status,actor,user_id,reason,request_key,conclusion)
        VALUES(${opportunityId},${businessId},${current.revision + 1},${decision},'OPERATOR',${session.userId},${input.reason},${input.idempotencyKey},${conclusion})`
      return yield* get(session.accountId, businessId, opportunityId)
    }))
  return {
    profile, get, saveProfile, validateObserved,
    goals: (accountId, businessId) => Effect.gen(function*() {
      yield* scope(accountId, businessId)
      const rows = yield* sql`SELECT document FROM growth_goal_documents WHERE business_id=${businessId} ORDER BY (document->>'version')::int DESC LIMIT 100`
      return yield* Effect.forEach(rows, row => decodeRow(GrowthGoalDocument, "growth_goals", row["document"]))
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
      const saved = yield* saveProfile(session, record.businessId, { category: input.category, audience: input.audience, valueProposition: input.valueProposition, goalStatement: input.goalStatement, metric: input.metric, idempotencyKey: input.idempotencyKey })
      yield* sql`INSERT INTO growth_registrations(account_id,request_key,business_id) VALUES(${session.accountId},${input.idempotencyKey},${record.businessId})`
      return saved
    })),
    list: (accountId, businessId, limit = 50) => Effect.gen(function*() {
      yield* scope(accountId, businessId)
      const rows = yield* sql`SELECT document FROM growth_opportunity_documents WHERE business_id=${businessId} ORDER BY created_at DESC,id LIMIT ${Math.min(100, Math.max(1, limit))}`
      const executions = yield* executionsByOpportunity(businessId)
      return yield* Effect.forEach(rows, row => Effect.gen(function*() {
        const opportunity = yield* decodeRow(Opportunity, "growth_opportunities", row["document"])
        return { ...opportunity, executions: executions.get(opportunity.id) ?? [] }
      }))
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
    review: (session, businessId, opportunityId, input) => transition(session, businessId, opportunityId, "REVIEWED", input),
    propose: (session, businessId, opportunityId, input) => transition(session, businessId, opportunityId, "PROPOSED", input),
    decide: (session, businessId, opportunityId, decision, input) => {
      if (decision !== "APPROVED" && decision !== "CANCELLED") return refuse("TransitionRefused")
      return transition(session, businessId, opportunityId, decision, input)
    },
    recordExecution: (session, businessId, opportunityId, raw) => sql.withTransaction(Effect.gen(function*() {
      yield* member(session, businessId)
      const input = yield* parse(GrowthExecutionRecord, raw)
      const content = { ...input, target: input.target.trim(), description: input.description.trim() }
      // An execution asserts what already happened. The bound is checked
      // against the database clock with a small skew window, not the caller's.
      const timing = yield* sql`SELECT (${content.performedAt}::timestamptz <= now() + interval '5 minutes') AS accepted`
      if (timing[0]?.["accepted"] !== true) return yield* refuse("ExecutionTimeRefused")
      // The opportunity lock serializes sibling executions, decisions and reviews.
      const locked = yield* sql`SELECT id FROM growth_opportunities WHERE id=${opportunityId} AND business_id=${businessId} FOR UPDATE`
      if (!locked.length) return yield* refuse("OpportunityNotFound")
      // The request identity is read only after the lock: concurrent identical
      // recordings observe the first committed row, and a replay never appends
      // a second ledger entry or re-relinks an existing one.
      const seen = yield* sql`SELECT i.type,i.channel,i.target,i.notes,i.performed_at,a.created_by_user_id FROM growth_initiative_actions a
        JOIN interventions i ON i.id=a.intervention_id AND i.business_id=a.business_id
        WHERE a.opportunity_id=${opportunityId} AND a.business_id=${businessId} AND a.request_key=${content.idempotencyKey}`
      if (seen[0]) {
        // Instant comparison, not string formatting: a JS date string is not
        // guaranteed to preserve milliseconds across runtimes.
        const recorded = seen[0]["performed_at"]
        const recordedMs = recorded instanceof Date ? recorded.getTime() : Date.parse(String(recorded))
        const identical = seen[0]["created_by_user_id"] === session.userId && seen[0]["type"] === content.type
          && seen[0]["channel"] === content.channel && seen[0]["target"] === content.target
          && (seen[0]["notes"] ?? null) === content.description && recordedMs === Date.parse(content.performedAt)
        if (!identical) return yield* refuse("IdempotencyConflict")
        return yield* get(session.accountId, businessId, opportunityId)
      }
      const current = yield* get(session.accountId, businessId, opportunityId)
      if (current.status !== "APPROVED") return yield* refuse("InitiativeNotApproved")
      // Assurance, actor and verification are fixed here: no request field can
      // manufacture a system-verified execution.
      const rows = yield* sql`INSERT INTO interventions(business_id,type,target,performed_at,actor,actor_id,notes,channel,assurance)
        VALUES(${businessId},${content.type},${content.target},${content.performedAt}::timestamptz,'HUMAN',${session.userId},${content.description},${content.channel},'OPERATOR_ATTESTED') RETURNING id`
      yield* sql`INSERT INTO growth_initiative_actions(intervention_id,opportunity_id,business_id,request_key,created_by_user_id)
        VALUES(${rows[0]!["id"]},${opportunityId},${businessId},${content.idempotencyKey},${session.userId})`
      return yield* get(session.accountId, businessId, opportunityId)
    })),
  } satisfies Context.Tag.Service<GrowthRepository>
}))
