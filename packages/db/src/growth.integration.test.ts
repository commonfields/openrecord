import { createHash, randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Context, Effect, Exit, Layer, Redacted, Scope } from "effect"
import { PgClient } from "@effect/sql-pg"
import pg from "pg"
import { canTransitionGrowth, GrowthStatus, type CreateGrowthOpportunity, type GrowthActor, type GrowthMetric, type GrowthObservedRef } from "@openrecord/contracts"
import { GrowthRepository, GrowthRepositoryLive } from "./growth.js"
import { RecordRepository, RecordRepositoryLive } from "./record.js"
import { migrate } from "./migrate.js"
import { AcquisitionRepository, AcquisitionRepositoryLive } from "./acquisition.js"
import { ObservationRepository, ObservationRepositoryLive } from "./repositories.js"
import { hostedMeasurementContext } from "./evidence.js"
import type { Session } from "./auth.js"

const url = process.env["TEST_DATABASE_URL"] ?? ""
const metric: GrowthMetric = { kind: "TRIAL_SIGNUPS", analyticsSource: "GA4_AGGREGATE_EXPORT", eventName: "trial_signup", countingSemantics: "EVENT_COUNT", reportingTimeZone: "Asia/Makassar", propertyRef: null }
const details = { category: "TEST Software", audience: "TEST operators", valueProposition: "TEST fixture positioning", primaryGoal: metric }
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
    const changed = await run(Effect.flatMap(GrowthRepository, r => r.saveProfile(f.session, f.businessId, { ...details, primaryGoal: { ...metric, eventName: "trial_started" } })))
    expect(changed.primaryGoal.version).toBe(2)
    const replay = await run(Effect.flatMap(GrowthRepository, r => r.saveProfile(f.session, f.businessId, { ...details, primaryGoal: { ...metric, eventName: "trial_started" } })))
    expect(replay.primaryGoal.id).toBe(changed.primaryGoal.id)
    const old = await run(Effect.flatMap(GrowthRepository, r => r.get(f.session.accountId, f.businessId, opportunity.id)))
    expect(old.goalId).toBe(f.profile.primaryGoal.id)
    await expect(create(f)).rejects.toMatchObject({ reason: "PrimaryGoalChanged" })
    await expect(pool.query("UPDATE growth_goals SET event_name='rewrite' WHERE id=$1", [f.profile.primaryGoal.id])).rejects.toThrow("append-only")
  })
  it("refuses cross-account and cross-business reads/writes without disclosure", async () => {
    const f = await fixture(), other = await fixture(), o = await create(f)
    const effects: Array<Effect.Effect<unknown, unknown, GrowthRepository>> = [
      Effect.flatMap(GrowthRepository, r => r.get(other.session.accountId, f.businessId, o.id)),
      Effect.flatMap(GrowthRepository, r => r.list(other.session.accountId, f.businessId)),
      Effect.flatMap(GrowthRepository, r => r.profile(other.session.accountId, f.businessId)),
      Effect.flatMap(GrowthRepository, r => r.saveProfile(other.session, f.businessId, details)),
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
      await expect(pool.query("INSERT INTO growth_opportunity_evidence(opportunity_id,business_id,type,note) VALUES($1,$2,$3,'TEST forged')", [valid.id, f.businessId, type])).rejects.toThrow("authoritative attachment required")
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
      for (const to of GrowthStatus.literals) for (const actor of ["OPERATOR", "ASSISTANT", "DELIVERY_SYSTEM", "MEASUREMENT_SYSTEM"] satisfies GrowthActor[]) {
        const client = await pool.connect(); let accepted = false
        try {
          await client.query("BEGIN")
          await client.query("INSERT INTO growth_opportunity_events(opportunity_id,business_id,revision,status,actor,user_id,reason,request_key) VALUES($1,$2,$3,$4,$5,$6,'TEST policy probe',$7)", [o.id, f.businessId, revision, to, actor, f.session.userId, randomUUID()])
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
})
