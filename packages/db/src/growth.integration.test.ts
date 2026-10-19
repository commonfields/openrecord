import { createHash, randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Context, Effect, Exit, Layer, Redacted, Scope } from "effect"
import { PgClient } from "@effect/sql-pg"
import pg from "pg"
import { canTransitionGrowth, GrowthStatus, type CreateGrowthOpportunity, type GrowthExecutionRecord, type GrowthMetricDefinitionInput, type GrowthObservedRef } from "@openrecord/contracts"
import { GrowthRepository, GrowthRepositoryLive } from "./growth.js"
import { RecordRepository, RecordRepositoryLive } from "./record.js"
import { migrate } from "./migrate.js"
import { AcquisitionRepository, AcquisitionRepositoryLive } from "./acquisition.js"
import { ObservationRepository, ObservationRepositoryLive } from "./repositories.js"
import { hostedMeasurementContext } from "./evidence.js"
import type { Session } from "./auth.js"

const url = process.env["TEST_DATABASE_URL"] ?? ""
const metric: GrowthMetricDefinitionInput = { conversionKind: "SIGNUP", label: "Trial signups", sourceKind: "GA4_AGGREGATE_EXPORT", sourceIdentity: "TEST GA4 property", eventName: "trial_signup", countingSemantics: "EVENT_COUNT", unit: "COUNT", currency: null, reportingTimeZone: "Asia/Makassar", propertyRef: "TEST property" }
const details = { category: "TEST Software", audience: "TEST operators", valueProposition: "TEST fixture positioning", goalStatement: "Increase trial signups", metric }
const suite = url ? describe : describe.skip
suite("growth persistence, guards and concurrency (disposable TEST fixtures)", () => {
  type Repos = GrowthRepository | RecordRepository | AcquisitionRepository | ObservationRepository
  let pool: pg.Pool, scope: Scope.CloseableScope, ctx: Context.Context<Repos>
  const run = async <A, E>(fx: Effect.Effect<A, E, Repos>): Promise<A> => {
    const result = await Effect.runPromise(Effect.either(Effect.provide(fx, ctx)))
    if (result._tag === "Left") throw result.left
    return result.right
  }
  beforeAll(async () => {
    await migrate(url); pool = new pg.Pool({ connectionString: url }); scope = await Effect.runPromise(Scope.make())
    ctx = await Effect.runPromise(Layer.buildWithScope(Layer.mergeAll(GrowthRepositoryLive, RecordRepositoryLive, AcquisitionRepositoryLive, ObservationRepositoryLive).pipe(Layer.provide(PgClient.layer({ url: Redacted.make(url) }))), scope))
  })
  afterAll(async () => { await Effect.runPromise(Scope.close(scope, Exit.void)); await pool.end() })
  const fixture = async () => {
    const accountId = String((await pool.query("INSERT INTO accounts(name) VALUES('TEST growth') RETURNING id")).rows[0].id)
    const userId = String((await pool.query("INSERT INTO users(email,password_hash) VALUES($1,'TEST-only') RETURNING id", [`growth-${randomUUID()}@example.test`])).rows[0].id)
    await pool.query("INSERT INTO account_users(account_id,user_id) VALUES($1,$2)", [accountId, userId])
    const session: Session = { accountId, userId }
    const profile = await run(Effect.flatMap(GrowthRepository, r => r.registerProduct(session, { name: "TEST Product", websiteUrl: "https://product.test", engagement: "DOGFOOD", ...details, idempotencyKey: randomUUID() })))
    return { session, businessId: profile.businessId, profile }
  }
  const input = (f: Awaited<ReturnType<typeof fixture>>): CreateGrowthOpportunity => ({
    goalId: f.profile.primaryGoal.id, title: "TEST clarify trial eligibility", problemStatement: "TEST trial requirements are unclear", audience: "TEST operators", buyerIntent: "Evaluate a trial",
    targetUrl: "https://product.test/pricing", source: "TEST operator", proposedChange: "Explain trial requirements", expectedMechanism: "Reduce uncertainty before trying",
    assumptions: "Readers may need more detail", uncertainty: "Impact is not measured", baselineAvailability: "UNKNOWN", ownerUserId: f.session.userId,
    initialStatus: "PROPOSED", idempotencyKey: randomUUID(), evidence: [{ type: "OPERATOR_HYPOTHESIS", note: "TEST hypothesis" }],
  })
  const create = (f: Awaited<ReturnType<typeof fixture>>, body = input(f)) => run(Effect.flatMap(GrowthRepository, r => r.create(f.session, f.businessId, "OPERATOR", body)))
  const decision = () => ({ expectedStatus: "PROPOSED" as const, expectedRevision: 1, idempotencyKey: randomUUID(), reason: "TEST reviewed" })
  it("registers one existing Business/Record product on concurrent retry and versions goals without rewriting history", async () => {
    const f = await fixture(); const key = randomUUID()
    const register = () => run(Effect.flatMap(GrowthRepository, r => r.registerProduct(f.session, { name: "TEST retry", websiteUrl: "https://retry.test", engagement: "CLIENT", ...details, idempotencyKey: key })))
    const [a, b] = await Promise.all([register(), register()]); expect(a.businessId).toBe(b.businessId)
    const opportunity = await create(f)
    const changed = await run(Effect.flatMap(GrowthRepository, r => r.saveProfile(f.session, f.businessId, { ...details, goalStatement: "Increase trial signups", metric: { ...metric, eventName: "trial_started" }, idempotencyKey: randomUUID() })))
    expect(changed.primaryGoal.version).toBe(2)
    const replay = await run(Effect.flatMap(GrowthRepository, r => r.saveProfile(f.session, f.businessId, { ...details, goalStatement: "Increase trial signups", metric: { ...metric, eventName: "trial_started" }, idempotencyKey: randomUUID() })))
    expect(replay.primaryGoal.id).toBe(changed.primaryGoal.id)
    const old = await run(Effect.flatMap(GrowthRepository, r => r.get(f.session.accountId, f.businessId, opportunity.id)))
    expect(old.goalId).toBe(f.profile.primaryGoal.id)
    await expect(create(f)).rejects.toMatchObject({ reason: "PrimaryGoalChanged" })
    await expect(pool.query("UPDATE growth_goals SET statement='rewrite' WHERE id=$1", [f.profile.primaryGoal.id])).rejects.toThrow("append-only")
  })
  it("refuses cross-account and cross-business reads/writes without disclosure", async () => {
    const f = await fixture(), other = await fixture(), o = await create(f)
    const effects: Array<Effect.Effect<unknown, unknown, GrowthRepository>> = [
      Effect.flatMap(GrowthRepository, r => r.get(other.session.accountId, f.businessId, o.id)),
      Effect.flatMap(GrowthRepository, r => r.list(other.session.accountId, f.businessId)),
      Effect.flatMap(GrowthRepository, r => r.profile(other.session.accountId, f.businessId)),
      Effect.flatMap(GrowthRepository, r => r.saveProfile(other.session, f.businessId, { ...details, idempotencyKey: randomUUID() })),
      Effect.flatMap(GrowthRepository, r => r.create(other.session, f.businessId, "OPERATOR", input(f))),
      Effect.flatMap(GrowthRepository, r => r.decide(other.session, f.businessId, o.id, "APPROVED", decision())),
    ]
    for (const effect of effects) expect(await run(Effect.either(effect))).toMatchObject({ _tag: "Left", left: { reason: "GrowthNotFound" } })
    await expect(run(Effect.flatMap(GrowthRepository, r => r.get(f.session.accountId, other.businessId, o.id)))).rejects.toMatchObject({ reason: "GrowthNotFound" })
    await expect(create(f, { ...input(f), ownerUserId: other.session.userId })).rejects.toMatchObject({ reason: "OwnerNotFound" })
  })
  it("returns one opportunity for concurrent creates and one event for replayed decisions; rejects stale decisions", async () => {
    const f = await fixture(), body = input(f)
    const [a, b] = await Promise.all([create(f, body), create(f, body)])
    expect(a.id).toBe(b.id); expect(a.events).toHaveLength(1)
    const d = decision()
    const approve = () => run(Effect.flatMap(GrowthRepository, r => r.decide(f.session, f.businessId, a.id, "APPROVED", d)))
    const [x, y] = await Promise.all([approve(), approve()]); expect(x).toEqual(y); expect(x.events).toHaveLength(2)
    await expect(run(Effect.flatMap(GrowthRepository, r => r.decide(f.session, f.businessId, a.id, "CANCELLED", { ...d, idempotencyKey: randomUUID() })))).rejects.toMatchObject({ reason: "StaleDecision" })
    await expect(run(Effect.flatMap(GrowthRepository, r => r.decide(f.session, f.businessId, a.id, "CANCELLED", d)))).rejects.toMatchObject({ reason: "IdempotencyConflict" })
    const cancelled = await run(Effect.flatMap(GrowthRepository, r => r.decide(f.session, f.businessId, a.id, "CANCELLED", { ...decision(), expectedStatus: "APPROVED", expectedRevision: 2 })))
    expect(cancelled.status).toBe("CANCELLED"); expect(cancelled.events).toHaveLength(3)
    await expect(run(Effect.flatMap(GrowthRepository, r => r.decide(f.session, f.businessId, a.id, "APPROVED", { ...decision(), expectedStatus: "CANCELLED", expectedRevision: 3 })))).rejects.toMatchObject({ reason: "TransitionRefused" })
  })
  it("promotes discovered opportunities for review and refuses conflicting decision identities", async () => {
    const f = await fixture()
    const o = await create(f, { ...input(f), initialStatus: "DISCOVERED" })
    const d = { ...decision(), expectedStatus: "DISCOVERED" as const }
    const proposed = await run(Effect.flatMap(GrowthRepository, r => r.propose(f.session, f.businessId, o.id, d)))
    expect(proposed.status).toBe("PROPOSED"); expect(proposed.revision).toBe(2)
    expect(await run(Effect.flatMap(GrowthRepository, r => r.propose(f.session, f.businessId, o.id, d)))).toEqual(proposed)
    for (const wrong of [{ ...d, expectedRevision: 2 }, { ...d, expectedStatus: "PROPOSED" as const }]) {
      await expect(run(Effect.flatMap(GrowthRepository, r => r.propose(f.session, f.businessId, o.id, wrong)))).rejects.toMatchObject({ reason: "IdempotencyConflict" })
    }
    const body = input(f)
    await create(f, body)
    await expect(run(Effect.flatMap(GrowthRepository, r => r.create(f.session, f.businessId, "ASSISTANT", { ...body, evidence: [{ type: "MODEL_SUGGESTION", note: "TEST assistant" }] })))).rejects.toMatchObject({ reason: "IdempotencyConflict" })
  })
  it("serializes opposing human decisions and leaves only the winner in history", async () => {
    const f = await fixture(), o = await create(f)
    const decide = (to: "APPROVED" | "CANCELLED") => run(Effect.flatMap(GrowthRepository, r => r.decide(f.session, f.businessId, o.id, to, decision())))
    const results = await Promise.allSettled([decide("APPROVED"), decide("CANCELLED")])
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1)
    const loser = results.find(r => r.status === "rejected")
    expect(loser).toMatchObject({ status: "rejected", reason: { reason: "StaleDecision" } })
    const loaded = await run(Effect.flatMap(GrowthRepository, r => r.get(f.session.accountId, f.businessId, o.id)))
    expect(loaded.events).toHaveLength(2); expect(loaded.revision).toBe(2)
  })
  it("validates observed references server-side and rejects reserved/misattributed evidence in repo and DB", async () => {
    const f = await fixture(), other = await fixture()
    const action = await run(Effect.flatMap(RecordRepository, r => r.recordAction(f.session, f.businessId, { type: "OTHER", slot: null, note: "TEST fixture action", links: [], performedAt: new Date().toISOString() })))
    const refs = [{ kind: "RECORD_ACTION" as const, id: action.id }]
    const valid = await create(f, { ...input(f), evidence: [...input(f).evidence, { type: "OBSERVED", reference: refs[0]!, note: "TEST stored action" }] })
    expect(valid.evidence.some(e => e.type === "OBSERVED")).toBe(true)
    const validation = await run(Effect.flatMap(GrowthRepository, r => r.validateObserved(other.session.accountId, other.businessId, refs)))
    expect(validation).toEqual({ valid: [], dropped: 1 })
    for (const reference of [...refs, { kind: "RECORD_ACTION" as const, id: randomUUID() }]) await expect(create(other, { ...input(other), evidence: [...input(other).evidence, { type: "OBSERVED", reference, note: "foreign/missing" }] })).rejects.toMatchObject({ reason: "EvidenceNotFound" })
    for (const type of ["VERIFIED_ACTION", "MEASURED_OUTCOME"]) {
      await expect(pool.query("INSERT INTO growth_opportunity_evidence(opportunity_id,business_id,type,note) VALUES($1,$2,$3,'TEST forged')", [valid.id, f.businessId, type])).rejects.toThrow()
    }
    await expect(pool.query("INSERT INTO growth_opportunity_evidence(opportunity_id,business_id,type,reference_kind,reference_id,note) VALUES($1,$2,'OBSERVED','RECORD_ACTION',$3,'TEST forged')", [valid.id, f.businessId, randomUUID()])).rejects.toThrow("outside scope")
    await expect(create(f, { ...input(f), evidence: [{ type: "MODEL_SUGGESTION", note: "TEST wrong author" }] })).rejects.toMatchObject({ reason: "AuthorshipRequired" })
    for (const table of ["growth_opportunities", "growth_opportunity_events", "growth_opportunity_evidence"]) await expect(pool.query(`DELETE FROM ${table} WHERE business_id=$1`, [f.businessId])).rejects.toThrow("append-only")
  })
  it("checks every observed source kind and excludes synthetic, empty and foreign evidence", async () => {
    const f = await fixture(), other = await fixture()
    const observe = async (check: { id: string; question_id: string; prompt: string }, synthetic = false) => {
      await pool.query("UPDATE check_runs SET status='RUNNING', started_at=now(),heartbeat_at=now() WHERE id=$1", [check.id])
      const raw = JSON.stringify({ text: "TEST stored answer", nonce: randomUUID() }), at = new Date().toISOString(), model = "gemini-fixture-model"
      return run(Effect.flatMap(ObservationRepository, r => r.create({ businessId: f.businessId, checkRunId: check.id,
        provider: "gemini", requestedModel: model, observedModel: model, collectedAt: at, answerText: "TEST stored answer",
        retrievalMode: "PROVIDER_GROUNDING", modelVersion: model, retrievalTool: "google_search", requestParameters: { tools: ["google_search"] }, rawResponse: JSON.parse(raw),
        rawDigest: createHash("sha256").update(raw).digest("hex"), rawBytesHex: Buffer.from(raw).toString("hex"), rawContentType: "application/json", providerMetadata: null,
        synthetic, completeRun: true, citations: [], measurementContext: hostedMeasurementContext({ businessId: f.businessId, questionId: check.question_id,
          checkRunId: check.id, prompt: check.prompt, provider: "gemini", requestedModel: model, observedModel: model, observedAt: at }),
      })))
    }
    for (const slot of [1, 2, 3] as const) {
      const item = await run(Effect.flatMap(RecordRepository, r => r.saveSlot(f.session, f.businessId, { slot, subject: "TEST Product", predicate: `TEST fact ${slot}`,
        valueText: "TEST value", valueType: "TEXT", sourceUrl: "https://product.test/facts", question: `TEST question ${slot}?` })))
      await run(Effect.flatMap(RecordRepository, r => r.approveItem(f.session, f.businessId, item.id)))
    }
    const recordRun = await run(Effect.flatMap(RecordRepository, r => r.startRun(f.session, f.businessId, { kind: "INITIAL", provider: "gemini", requestedModel: "gemini-fixture-model", samples: 1 })))
    const recordCheck = (await pool.query("SELECT c.id,c.question_id,q.prompt FROM check_runs c JOIN buyer_questions q ON q.id=c.question_id WHERE c.record_run_id=$1 LIMIT 1", [recordRun.id])).rows[0]
    const observation = await observe(recordCheck)
    const judgment = await run(Effect.flatMap(RecordRepository, r => r.judge(f.session, f.businessId, { observationId: observation.id, decision: "UNKNOWN", note: "TEST reviewed" })))
    const set = await run(Effect.flatMap(AcquisitionRepository, r => r.createQuestionSet(f.session, f.businessId, { basis: "FIXTURE", category: "TEST Software",
      target: { name: "TEST Product", aliases: [], domains: ["product.test"], matchCase: false, ambiguity: null }, competitors: [],
      questions: [{ group: "CATEGORY_DISCOVERY", prompt: "TEST which software should operators evaluate?" }] })))
    const batch = await run(Effect.flatMap(AcquisitionRepository, r => r.startBatch(f.session, f.businessId, { setId: set.id, scope: "FULL", questionKeys: null,
      samples: 1, provider: "gemini", requestedModel: "gemini-fixture-model", acknowledgedMaxProviderCalls: 4 })))
    const validate = (refs: ReadonlyArray<GrowthObservedRef>, target = f) => run(Effect.flatMap(GrowthRepository, r => r.validateObserved(target.session.accountId, target.businessId, refs)))
    expect(await validate([{ kind: "ACQUISITION_BATCH", id: batch.id }])).toEqual({ valid: [], dropped: 1 })
    const acqCheck = (await pool.query("SELECT c.id,c.question_id,q.prompt FROM check_runs c JOIN buyer_questions q ON q.id=c.question_id WHERE c.acq_batch_id=$1", [batch.id])).rows[0]
    const acqObservation = await observe(acqCheck)
    const result = await run(Effect.flatMap(AcquisitionRepository, r => r.judge(f.session, f.businessId, { observationId: acqObservation.id, mention: "UNCLEAR", recommendation: null, note: "TEST reviewed" })))
    const meta = { dataOrigin: "GA4_EXPORT" as const, propertyRef: "TEST property", dateStart: "2026-10-01", dateEnd: "2026-10-07", timeZone: "UTC", attributionBasis: "SESSION_SOURCE_MEDIUM" as const, conversionEvent: null }
    const imported = await run(Effect.flatMap(AcquisitionRepository, r => r.importReferrals(f.session, f.businessId, meta, "date,session source,session medium,sessions\n20261001,chatgpt.com,referral,2\n")))
    const synthetic = await run(Effect.flatMap(AcquisitionRepository, r => r.importReferrals(f.session, f.businessId, { ...meta, dataOrigin: "SYNTHETIC_FIXTURE" }, "date,session source,session medium,sessions\n20261002,chatgpt.com,referral,3\n")))
    const action = await run(Effect.flatMap(RecordRepository, r => r.recordAction(f.session, f.businessId, { type: "OTHER", slot: null, note: "TEST recorded", links: [], performedAt: new Date().toISOString() })))
    const refs: GrowthObservedRef[] = [{ kind: "OBSERVATION", id: observation.id }, { kind: "RECORD_CHECK", id: recordCheck.id }, { kind: "RECORD_JUDGMENT", id: judgment.id },
      { kind: "ACQUISITION_BATCH", id: batch.id }, { kind: "ACQUISITION_RESULT", id: result.id }, { kind: "REFERRAL_IMPORT", id: imported.importId }, { kind: "RECORD_ACTION", id: action.id }]
    expect(await validate(refs)).toEqual({ valid: refs, dropped: 0 })
    expect(await validate(refs, other)).toEqual({ valid: [], dropped: 7 })
    expect(await validate(refs.map(r => ({ ...r, id: randomUUID() })))).toEqual({ valid: [], dropped: 7 })
    expect(await validate([{ kind: "REFERRAL_IMPORT", id: synthetic.importId }])).toEqual({ valid: [], dropped: 1 })
    const created = await create(f, { ...input(f), evidence: [...input(f).evidence, ...refs.map(reference => ({ type: "OBSERVED" as const, reference, note: "TEST stored source; fixture only" }))] })
    expect(created.evidence.filter(e => e.type === "OBSERVED")).toHaveLength(7)
    const syntheticCheck = (await pool.query("SELECT c.id,c.question_id,q.prompt FROM check_runs c JOIN buyer_questions q ON q.id=c.question_id WHERE c.record_run_id=$1 AND c.id<>$2 LIMIT 1", [recordRun.id, recordCheck.id])).rows[0]
    const syntheticObservation = await observe(syntheticCheck, true)
    expect(await validate([{ kind: "OBSERVATION", id: syntheticObservation.id }, { kind: "RECORD_CHECK", id: syntheticCheck.id }])).toEqual({ valid: [], dropped: 2 })
    await run(Effect.flatMap(RecordRepository, r => r.cancelRun(f.session, f.businessId, recordRun.id)))
  })
  it("DB transitions match the pure authority table, including assistant and future-system refusals", async () => {
    const f = await fixture()
    for (const from of ["DISCOVERED", "PROPOSED", "APPROVED", "CANCELLED"] as const) {
      const o = await create(f, { ...input(f), initialStatus: from === "DISCOVERED" ? "DISCOVERED" : "PROPOSED" })
      if (from === "APPROVED" || from === "CANCELLED") await run(Effect.flatMap(GrowthRepository, r => r.decide(f.session, f.businessId, o.id, from, decision())))
      const revision = from === "APPROVED" || from === "CANCELLED" ? 3 : 2
      for (const to of GrowthStatus.literals) for (const actor of ["OPERATOR", "ASSISTANT", "DELIVERY_SYSTEM", "MEASUREMENT_SYSTEM"] satisfies string[]) {
        const client = await pool.connect(); let accepted = false
        try {
          await client.query("BEGIN")
          await client.query("INSERT INTO growth_opportunity_events(opportunity_id,business_id,revision,status,actor,user_id,reason,request_key,conclusion) VALUES($1,$2,$3,$4,$5,$6,'TEST policy probe',$7,$8)", [o.id, f.businessId, revision, to, actor, f.session.userId, randomUUID(), to === "REVIEWED" ? "INCONCLUSIVE" : null])
          accepted = true
        } catch { /* Every rejected combination is asserted below. */ }
        finally { await client.query("ROLLBACK"); client.release() }
        expect(accepted, `${from} -> ${to} by ${actor}`).toBe(canTransitionGrowth(from, to, actor))
      }
    }
  })
  it("does not commit incomplete opportunities or cross-account registration identities", async () => {
    const f = await fixture(), other = await fixture(), o = await create(f)
    await expect(pool.query(`INSERT INTO growth_opportunities
      SELECT (jsonb_populate_record(NULL::growth_opportunities, to_jsonb(o) || jsonb_build_object('id',gen_random_uuid(),'request_key',gen_random_uuid()))).*
      FROM growth_opportunities o WHERE id=$1`, [o.id])).rejects.toThrow("requires initial event and authorship evidence")
    await expect(pool.query("INSERT INTO growth_registrations(account_id,request_key,business_id) VALUES($1,$2,$3)", [other.session.accountId, randomUUID(), f.businessId])).rejects.toThrow("registration outside account")
  })
  it("replays migrations over populated immutable growth history", async () => {
    const f = await fixture(), o = await create(f)
    await migrate(url)
    const loaded = await run(Effect.flatMap(GrowthRepository, r => r.get(f.session.accountId, f.businessId, o.id)))
    expect(loaded).toEqual(o)
  })
  it("versions goal statements independently and preserves exact source, unit and currency definitions", async () => {
    const f = await fixture(), old = await create(f)
    const statement = await run(Effect.flatMap(GrowthRepository, r => r.saveProfile(f.session, f.businessId, { ...details, goalStatement: "Increase trials for agencies", idempotencyKey: randomUUID() })))
    expect(statement.primaryGoal.version).toBe(2)
    expect(statement.primaryGoal.metricDefinition.id).toBe(f.profile.primaryGoal.metricDefinition.id)
    const changed = await run(Effect.flatMap(GrowthRepository, r => r.saveProfile(f.session, f.businessId, { ...details, goalStatement: statement.primaryGoal.statement, idempotencyKey: randomUUID(),
      metric: { conversionKind: "PURCHASE", label: "Gross order value", sourceKind: "OPERATOR_AGGREGATE_EXPORT", sourceIdentity: "TEST shop sales export", eventName: null,
        propertyRef: "TEST shop", countingSemantics: "SUM", unit: "CURRENCY_MINOR", currency: "EUR", reportingTimeZone: "Europe/Berlin" } })))
    expect(changed.primaryGoal.version).toBe(3)
    expect(changed.primaryGoal.metricDefinition).toMatchObject({ version: 2, unit: "CURRENCY_MINOR", currency: "EUR", sourceIdentity: "TEST shop sales export" })
    const historical = await run(Effect.flatMap(GrowthRepository, r => r.goals(f.session.accountId, f.businessId)))
    expect(historical.map(g => g.statement)).toEqual([statement.primaryGoal.statement, statement.primaryGoal.statement, details.goalStatement])
    expect((await run(Effect.flatMap(GrowthRepository, r => r.get(f.session.accountId, f.businessId, old.id)))).goalId).toBe(f.profile.primaryGoal.id)
    await expect(pool.query("UPDATE growth_metric_definitions SET currency='USD' WHERE id=$1", [changed.primaryGoal.metricDefinition.id])).rejects.toThrow("append-only")
  })
  it("identifies profile updates: replay returns the original result and newer content is never rolled back", async () => {
    const f = await fixture()
    const key = randomUUID()
    const body = { category: "TEST identified updates", audience: "TEST operators", valueProposition: "TEST positioning", goalStatement: "TEST increase trial starts", metric: { ...metric, eventName: "trial_started" }, idempotencyKey: key }
    const first = await run(Effect.flatMap(GrowthRepository, r => r.saveProfile(f.session, f.businessId, body)))
    expect(first.primaryGoal.version).toBe(2)
    expect(await run(Effect.flatMap(GrowthRepository, r => r.saveProfile(f.session, f.businessId, body)))).toEqual(first)
    await expect(run(Effect.flatMap(GrowthRepository, r => r.saveProfile(f.session, f.businessId, { ...body, goalStatement: "TEST different content" })))).rejects.toMatchObject({ reason: "IdempotencyConflict" })
    const newer = await run(Effect.flatMap(GrowthRepository, r => r.saveProfile(f.session, f.businessId, { ...body, idempotencyKey: randomUUID(), goalStatement: "TEST newer statement" })))
    expect(newer.primaryGoal.version).toBe(3)
    // The replay still returns its original document, but the stored profile
    // remains the newer update: a retry cannot restore older content.
    expect(await run(Effect.flatMap(GrowthRepository, r => r.saveProfile(f.session, f.businessId, body)))).toEqual(first)
    expect(await run(Effect.flatMap(GrowthRepository, r => r.profile(f.session.accountId, f.businessId)))).toEqual(newer)
    const goals = await run(Effect.flatMap(GrowthRepository, r => r.goals(f.session.accountId, f.businessId)))
    expect(goals.filter(g => g.statement === first.primaryGoal.statement)).toHaveLength(1)
    expect(goals).toHaveLength(3)
    expect(newer.primaryGoal.metricDefinition.id).toBe(first.primaryGoal.metricDefinition.id)
    await expect(pool.query("UPDATE growth_profile_updates SET fingerprint=repeat('0',64) WHERE business_id=$1", [f.businessId])).rejects.toThrow("append-only")
    await expect(pool.query("DELETE FROM growth_profile_updates WHERE business_id=$1", [f.businessId])).rejects.toThrow("append-only")
  })
  it("serializes concurrent identical profile updates without duplicate versions", async () => {
    const f = await fixture()
    const before = await run(Effect.flatMap(GrowthRepository, r => r.goals(f.session.accountId, f.businessId)))
    const body = { category: "TEST concurrent updates", audience: "TEST operators", valueProposition: "TEST positioning", goalStatement: "TEST concurrent goal", metric: { ...metric, eventName: "trial_concurrent" }, idempotencyKey: randomUUID() }
    const update = () => run(Effect.flatMap(GrowthRepository, r => r.saveProfile(f.session, f.businessId, body)))
    const [a, b] = await Promise.all([update(), update()])
    expect(a).toEqual(b)
    const after = await run(Effect.flatMap(GrowthRepository, r => r.goals(f.session.accountId, f.businessId)))
    expect(after).toHaveLength(before.length + 1)
    // An independent identical request reuses the same goal version instead of
    // appending a duplicate history entry.
    const again = await run(Effect.flatMap(GrowthRepository, r => r.saveProfile(f.session, f.businessId, { ...body, idempotencyKey: randomUUID() })))
    expect(again.primaryGoal.id).toBe(a.primaryGoal.id)
    expect(await run(Effect.flatMap(GrowthRepository, r => r.goals(f.session.accountId, f.businessId)))).toHaveLength(after.length)
  })
  const appendExecution = async (f: Awaited<ReturnType<typeof fixture>>, opportunityId: string, channel: string, key = randomUUID()) => {
    const client = await pool.connect()
    try {
      await client.query("BEGIN")
      const row = (await client.query("INSERT INTO interventions(business_id,type,target,performed_at,actor,actor_id,channel,assurance,notes) VALUES($1,$2,'TEST target',now(),'HUMAN',$3,$4,'OPERATOR_ATTESTED','TEST human assertion, not independently verified') RETURNING id",
        [f.businessId, channel === "EMAIL" ? "CAMPAIGN_SENT" : "SOURCE_UPDATED", f.session.userId, channel])).rows[0]
      await client.query("INSERT INTO growth_initiative_actions(intervention_id,opportunity_id,business_id,request_key,created_by_user_id) VALUES($1,$2,$3,$4,$5)", [row.id, opportunityId, f.businessId, key, f.session.userId])
      await client.query("COMMIT"); return String(row.id)
    } catch (e) { await client.query("ROLLBACK"); throw e } finally { client.release() }
  }
  const insertIntervention = async (f: Awaited<ReturnType<typeof fixture>>, supersedesId?: string) => {
    const row = (await pool.query(`INSERT INTO interventions(business_id,type,target,performed_at,actor,actor_id,channel,assurance,supersedes_id,correction_reason,notes)
      VALUES($1,'SOURCE_UPDATED','TEST target',now(),'HUMAN',$2,'WEBSITE','OPERATOR_ATTESTED',$3,$4,'TEST human assertion, not independently verified') RETURNING id`,
      [f.businessId, f.session.userId, supersedesId ?? null, supersedesId ? "TEST correction" : null])).rows[0]
    return String(row.id)
  }
  const linkExecution = async (f: Awaited<ReturnType<typeof fixture>>, interventionId: string, opportunityId: string, key = randomUUID()) => {
    await pool.query("INSERT INTO growth_initiative_actions(intervention_id,opportunity_id,business_id,request_key,created_by_user_id) VALUES($1,$2,$3,$4,$5)",
      [interventionId, opportunityId, f.businessId, key, f.session.userId])
  }
  it.each(["SIGNUP", "BOOKING"] as const)("uses the same initiative model for %s with multiple attested interventions", async kind => {
    const f = await fixture()
    const saved = await run(Effect.flatMap(GrowthRepository, r => r.saveProfile(f.session, f.businessId, { ...details, category: kind === "BOOKING" ? "TEST local appointment service" : details.category, goalStatement: `Improve TEST ${kind}`, idempotencyKey: randomUUID(),
      metric: kind === "SIGNUP" ? metric : { conversionKind: "BOOKING", label: "Confirmed bookings", sourceKind: "OPERATOR_AGGREGATE_EXPORT", sourceIdentity: "TEST booking system",
        eventName: null, propertyRef: null, countingSemantics: "EVENT_COUNT", unit: "COUNT", currency: null, reportingTimeZone: "Europe/London" } })))
    expect(saved.category).toBe(kind === "BOOKING" ? "TEST local appointment service" : "TEST Software")
    const scoped = { ...f, profile: saved }
    const o = await create(scoped, { ...input(scoped), targetUrl: null })
    expect(o.targetUrl).toBeNull(); expect(o.progress).toBe("NOT_STARTED")
    await run(Effect.flatMap(GrowthRepository, r => r.decide(f.session, f.businessId, o.id, "APPROVED", decision())))
    const key = randomUUID()
    await appendExecution(f, o.id, "WEBSITE", key); await appendExecution(f, o.id, "EMAIL")
    await expect(appendExecution(f, o.id, "EMAIL", key)).rejects.toThrow()
    const loaded = await run(Effect.flatMap(GrowthRepository, r => r.get(f.session.accountId, f.businessId, o.id)))
    expect(loaded).toMatchObject({ status: "APPROVED", progress: "EXECUTED", executionCount: 2, revision: 2 })
    expect(loaded.events).toHaveLength(2)
    const review = { expectedStatus: "APPROVED" as const, expectedRevision: 2, idempotencyKey: randomUUID(), reason: "TEST no causal conclusion", conclusion: "INCONCLUSIVE" as const }
    const reviewed = await run(Effect.flatMap(GrowthRepository, r => r.review(f.session, f.businessId, o.id, review)))
    expect(reviewed.status).toBe("REVIEWED"); expect(reviewed.events[2]?.conclusion).toBe("INCONCLUSIVE")
    expect(await run(Effect.flatMap(GrowthRepository, r => r.review(f.session, f.businessId, o.id, review)))).toEqual(reviewed)
    await expect(run(Effect.flatMap(GrowthRepository, r => r.review(f.session, f.businessId, o.id, { ...review, conclusion: "KEEP" })))).rejects.toMatchObject({ reason: "IdempotencyConflict" })
    await expect(appendExecution(f, o.id, "WEBSITE")).rejects.toThrow("not approved")
  })
  it("records operator-attested software and commerce executions through the repository, idempotently", async () => {
    const f = await fixture(), other = await fixture()
    const o = await create(f), pending = await create(f)
    const record = (session: typeof f.session, businessId: string, opportunityId: string, body: GrowthExecutionRecord) =>
      run(Effect.flatMap(GrowthRepository, r => r.recordExecution(session, businessId, opportunityId, body)))
    const forged = (body: Record<string, unknown>) => body as unknown as GrowthExecutionRecord
    const software = { type: "SOURCE_PUBLISHED" as const, channel: "WEBSITE" as const, target: "TEST pricing page",
      description: "TEST published the revised pricing explainer", performedAt: new Date(Date.now() - 7_200_000).toISOString(), idempotencyKey: randomUUID() }
    // Recording attaches to an approved initiative only; the pending row stays untouched.
    await expect(record(f.session, f.businessId, pending.id, software)).rejects.toMatchObject({ reason: "InitiativeNotApproved" })
    await expect(record(f.session, f.businessId, o.id, forged({ ...software, assurance: "SYSTEM_VERIFIED" }))).rejects.toMatchObject({ reason: "InvalidRequest" })
    await run(Effect.flatMap(GrowthRepository, r => r.decide(f.session, f.businessId, o.id, "APPROVED", decision())))
    const first = await record(f.session, f.businessId, o.id, software)
    expect(first.executions).toHaveLength(1)
    expect(first.executions[0]).toMatchObject({ opportunityId: o.id, businessId: f.businessId, type: "SOURCE_PUBLISHED", channel: "WEBSITE",
      target: "TEST pricing page", description: "TEST published the revised pricing explainer", assurance: "OPERATOR_ATTESTED", actor: "HUMAN",
      actorId: f.session.userId, verification: null })
    expect(first.executions).toHaveLength(first.executionCount)
    // A replay returns the original ledger entry; different content under the same
    // request identity is refused instead of appending or silently rewriting.
    const replay = await record(f.session, f.businessId, o.id, software)
    expect(replay.executions).toEqual(first.executions)
    for (const changed of [{ target: "TEST other page" }, { description: "TEST other description" }, { channel: "EMAIL" as const }])
      await expect(record(f.session, f.businessId, o.id, { ...software, ...changed })).rejects.toMatchObject({ reason: "IdempotencyConflict" })
    // Boundary whitespace is normalised, so a retry of the same content is a
    // replay rather than a conflict.
    const spaced = await record(f.session, f.businessId, o.id, { ...software, target: `  ${software.target}  `, description: `  ${software.description}  ` })
    expect(spaced.executions).toEqual(first.executions)
    // An incompatible channel/type pair never reaches the ledger.
    await expect(record(f.session, f.businessId, o.id, forged({ ...software, idempotencyKey: randomUUID(), type: "CAMPAIGN_SENT", channel: "WEBSITE" }))).rejects.toMatchObject({ reason: "InvalidRequest" })
    // The request identity is bound to its author: another member of the same
    // account cannot reuse the key to claim or replace the first operator's row.
    const secondUserId = String((await pool.query("INSERT INTO users(email,password_hash) VALUES($1,'TEST-only') RETURNING id", [`growth-w1-${randomUUID()}@example.test`])).rows[0]["id"])
    await pool.query("INSERT INTO account_users(account_id,user_id) VALUES($1,$2)", [f.session.accountId, secondUserId])
    await expect(record({ accountId: f.session.accountId, userId: secondUserId }, f.businessId, o.id, software)).rejects.toMatchObject({ reason: "IdempotencyConflict" })
    // A service/commerce action uses the same channel-neutral ledger.
    const commerce = { type: "LISTING_UPDATED" as const, channel: "THIRD_PARTY_PROFILE" as const, target: "TEST third-party listing",
      description: "TEST corrected the opening hours", performedAt: new Date(Date.now() - 3_600_000).toISOString(), idempotencyKey: randomUUID() }
    const updated = await record(f.session, f.businessId, o.id, commerce)
    expect(updated).toMatchObject({ progress: "EXECUTED", executionCount: 2 })
    expect(updated.executions.map(e => e.type)).toEqual(["SOURCE_PUBLISHED", "LISTING_UPDATED"])
    const listed = await run(Effect.flatMap(GrowthRepository, r => r.list(f.session.accountId, f.businessId)))
    expect(listed.find(item => item.id === o.id)?.executions).toEqual(updated.executions)
    // Concurrent identical recordings serialize on the opportunity and leave one row.
    const concurrent = { ...commerce, performedAt: new Date(Date.now() - 1_800_000).toISOString(), idempotencyKey: randomUUID() }
    const [left, right] = await Promise.all([record(f.session, f.businessId, o.id, concurrent), record(f.session, f.businessId, o.id, concurrent)])
    expect(left.executions).toHaveLength(3); expect(right.executions).toEqual(left.executions)
    expect(String((await pool.query("SELECT count(*)::int AS n FROM growth_initiative_actions WHERE opportunity_id=$1 AND request_key=$2", [o.id, concurrent.idempotencyKey])).rows[0]["n"])).toBe("1")
    // The performed time asserts the past, checked against the database clock.
    await expect(record(f.session, f.businessId, o.id, { ...concurrent, idempotencyKey: randomUUID(), performedAt: new Date(Date.now() + 3_600_000).toISOString() })).rejects.toMatchObject({ reason: "ExecutionTimeRefused" })
    // Foreign operators, businesses and opportunities are never disclosed.
    await expect(record(other.session, f.businessId, o.id, { ...commerce, idempotencyKey: randomUUID() })).rejects.toMatchObject({ reason: "GrowthNotFound" })
    const foreignOpportunity = await create(other)
    await expect(record(f.session, other.businessId, foreignOpportunity.id, { ...commerce, idempotencyKey: randomUUID() })).rejects.toMatchObject({ reason: "GrowthNotFound" })
    // A replay after the initiative closed returns the original record; a new
    // recording is refused while the history stays authoritative.
    const review = { expectedStatus: "APPROVED" as const, expectedRevision: 2, idempotencyKey: randomUUID(), reason: "TEST closed after execution", conclusion: "INCONCLUSIVE" as const }
    await run(Effect.flatMap(GrowthRepository, r => r.review(f.session, f.businessId, o.id, review)))
    const afterReview = await record(f.session, f.businessId, o.id, software)
    expect(afterReview.status).toBe("REVIEWED")
    expect(afterReview.executions[0]).toEqual(first.executions[0])
    expect(afterReview.executions).toHaveLength(3)
    await expect(record(f.session, f.businessId, o.id, { ...commerce, idempotencyKey: randomUUID() })).rejects.toMatchObject({ reason: "InitiativeNotApproved" })
    await expect(pool.query("DELETE FROM interventions WHERE business_id=$1", [f.businessId])).rejects.toThrow("append-only")
  })
  it("rolls back the intervention when the initiative link fails inside the same transaction", async () => {
    const f = await fixture()
    const o = await create(f)
    await run(Effect.flatMap(GrowthRepository, r => r.decide(f.session, f.businessId, o.id, "APPROVED", decision())))
    const description = `TEST atomicity ${randomUUID()}`
    const body = { type: "SOURCE_UPDATED" as const, channel: "WEBSITE" as const, target: "TEST atomicity page", description,
      performedAt: new Date(Date.now() - 60_000).toISOString(), idempotencyKey: randomUUID() }
    // A test-only trigger forces the second half of the write to fail after the
    // intervention insert succeeded. Both rows must disappear together.
    await pool.query(`CREATE OR REPLACE FUNCTION w1_forced_link_failure() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'forced link failure'; END $$ LANGUAGE plpgsql`)
    await pool.query("CREATE TRIGGER w1_forced_link_failure BEFORE INSERT ON growth_initiative_actions FOR EACH ROW EXECUTE FUNCTION w1_forced_link_failure()")
    try {
      // Effect SQL reports the driver failure generically; the rollback and the
      // successful retry below prove the transaction boundary.
      await expect(run(Effect.flatMap(GrowthRepository, r => r.recordExecution(f.session, f.businessId, o.id, body)))).rejects.toThrow()
    } finally {
      await pool.query("DROP TRIGGER IF EXISTS w1_forced_link_failure ON growth_initiative_actions")
      await pool.query("DROP FUNCTION IF EXISTS w1_forced_link_failure()")
    }
    expect((await pool.query("SELECT count(*)::int AS n FROM interventions WHERE business_id=$1 AND notes=$2", [f.businessId, description])).rows[0]["n"]).toBe(0)
    expect((await pool.query("SELECT count(*)::int AS n FROM growth_initiative_actions WHERE opportunity_id=$1 AND request_key=$2", [o.id, body.idempotencyKey])).rows[0]["n"]).toBe(0)
    // The retry after the failed transaction succeeds exactly once.
    const recorded = await run(Effect.flatMap(GrowthRepository, r => r.recordExecution(f.session, f.businessId, o.id, body)))
    expect(recorded.executions).toHaveLength(1)
    expect(recorded.executions[0]).toMatchObject({ description, assurance: "OPERATOR_ATTESTED" })
  })
  it("binds an entire intervention correction chain to one initiative regardless of link order", async () => {
    const f = await fixture(), other = await fixture()
    const o1 = await create(f), o2 = await create(f)
    for (const o of [o1, o2]) await run(Effect.flatMap(GrowthRepository, r => r.decide(f.session, f.businessId, o.id, "APPROVED", decision())))
    // Original linked first: the correction may only join the same initiative.
    const original = await insertIntervention(f)
    const correction = await insertIntervention(f, original)
    await linkExecution(f, original, o1.id)
    await expect(linkExecution(f, correction, o2.id)).rejects.toThrow("cannot change initiative")
    await linkExecution(f, correction, o1.id)
    // Correction linked first: the original cannot move elsewhere afterwards.
    const root2 = await insertIntervention(f)
    const fix2 = await insertIntervention(f, root2)
    await linkExecution(f, fix2, o2.id)
    await expect(linkExecution(f, root2, o1.id)).rejects.toThrow("cannot change initiative")
    await linkExecution(f, root2, o2.id)
    // Multiple corrections: every member constrains the whole chain.
    const root3 = await insertIntervention(f)
    const mid3 = await insertIntervention(f, root3)
    const tip3 = await insertIntervention(f, mid3)
    await linkExecution(f, tip3, o2.id)
    await expect(linkExecution(f, root3, o1.id)).rejects.toThrow("cannot change initiative")
    await expect(linkExecution(f, mid3, o1.id)).rejects.toThrow("cannot change initiative")
    await linkExecution(f, root3, o2.id)
    await linkExecution(f, mid3, o2.id)
    // Concurrent links on one chain serialize on its root: exactly one wins.
    const root4 = await insertIntervention(f)
    const fix4 = await insertIntervention(f, root4)
    const results = await Promise.allSettled([linkExecution(f, root4, o1.id), linkExecution(f, fix4, o2.id)])
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1)
    expect(String((results.find(r => r.status === "rejected") as PromiseRejectedResult).reason)).toContain("cannot change initiative")
    // Cross-business members and history rewrites stay refused.
    const foreign = await insertIntervention(other)
    await expect(linkExecution(f, foreign, o1.id)).rejects.toThrow("outside scope")
    await expect(pool.query("UPDATE growth_initiative_actions SET opportunity_id=$1 WHERE intervention_id=$2", [o2.id, original])).rejects.toThrow("append-only")
    await expect(pool.query("DELETE FROM growth_initiative_actions WHERE intervention_id=$1", [original])).rejects.toThrow("append-only")
  })
  it("fails closed on forged system claims, attestations, foreign links and non-members", async () => {
    const f = await fixture(), other = await fixture(), o = await create(f)
    await run(Effect.flatMap(GrowthRepository, r => r.decide(f.session, f.businessId, o.id, "APPROVED", decision())))
    const insert = (actor: string, actorId: string | null, assurance: string, kind: string | null, claim: string | null, type = "SOURCE_UPDATED") => pool.query(
      "INSERT INTO interventions(business_id,type,target,performed_at,actor,actor_id,channel,assurance,verification_kind,verification_id,verification_claim) VALUES($1,$2,'TEST',now(),$3,$4,'WEBSITE',$5,$6,$7,$8)",
      [f.businessId,type,actor,actorId,assurance,kind,kind ? randomUUID() : null,claim])
    await expect(insert("SYSTEM", null, "SYSTEM_VERIFIED", "GROWTH_DELIVERY", "PR_MERGED")).rejects.toThrow("unverified")
    await expect(insert("SYSTEM", null, "SYSTEM_VERIFIED", "GROWTH_DELIVERY", "DEPLOYED", "SOURCE_PUBLISHED")).rejects.toThrow("unverified")
    await expect(insert("AGENT", f.session.userId, "OPERATOR_ATTESTED", null, null)).rejects.toThrow("requires a human")
    await expect(insert("HUMAN", other.session.userId, "OPERATOR_ATTESTED", null, null)).rejects.toThrow("outside scope")
    await expect(insert("HUMAN", f.session.userId, "OPERATOR_ATTESTED", "GROWTH_DELIVERY", "PR_MERGED")).rejects.toThrow("not system verification")
    await expect(appendExecution(other, o.id, "EMAIL")).rejects.toThrow("outside scope")
    await expect(run(Effect.flatMap(GrowthRepository, r => r.saveProfile({ ...f.session, userId: other.session.userId }, f.businessId, { ...details, idempotencyKey: randomUUID() })))).rejects.toMatchObject({ reason: "GrowthNotFound" })
    await expect(pool.query("DELETE FROM growth_initiative_actions")).rejects.toThrow("append-only")
  })

})
