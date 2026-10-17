// OPENRECORD_AI_ACQUISITION_PILOT_V1 persistence against Postgres 16:
// frozen question sets, batch/check identity, spend acknowledgment, tenant
// isolation, append-only recommendation review, raw evidence identity and
// GA4 import validation. Every agency, brand, reviewer and export is a
// labelled TEST fixture; the worker is simulated by persisting Gemini-shaped
// observations through the real ObservationRepository.
// Requires TEST_DATABASE_URL (CI provides postgres; skipped otherwise).
import { createHash, randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Context, Effect, Exit, Layer, Redacted, Scope } from "effect"
import { PgClient } from "@effect/sql-pg"
import pg from "pg"
import {
  ACQ_MAX_ATTEMPTS_PER_CHECK, AcquisitionRepository, AcquisitionRepositoryLive, ObservationRepository, ObservationRepositoryLive,
  RecordRepository, RecordRepositoryLive, acquisitionView, hostedMeasurementContext, type CreateSetInput, type Session,
} from "./index.js"
import { migrate } from "./migrate.js"

const url = process.env["TEST_DATABASE_URL"] ?? ""
const suite = url ? describe : describe.skip
const MODEL = "gemini-3.5-flash-lite"
type Repos = AcquisitionRepository | RecordRepository | ObservationRepository

const SPEC: CreateSetInput = {
  basis: "FIXTURE", category: "TEST customer support agents",
  target: { name: "Supportly", aliases: ["Supportly AI"], domains: ["supportly.test"], matchCase: false, ambiguity: null },
  competitors: [{ name: "HelpHub", aliases: [], domains: ["helphub.test"], matchCase: false, ambiguity: null }],
  questions: [
    { group: "PROBLEM_SOLVING", prompt: "Which TEST tool answers support email automatically?" },
    { group: "CATEGORY_DISCOVERY", prompt: "What are the best TEST AI support agents?" },
    { group: "CATEGORY_DISCOVERY", prompt: "Which TEST support agents suit a small shop?" },
  ],
}

suite("AI acquisition persistence (TEST agency, TEST brands, TEST reviewer)", () => {
  let pool: pg.Pool
  let scope: Scope.CloseableScope
  let ctx: Context.Context<Repos>
  const run = <A, E>(fx: Effect.Effect<A, E, Repos>) => Effect.runPromise(Effect.provide(fx, ctx))
  const fails = async <A, E>(fx: Effect.Effect<A, E, Repos>) => {
    const exit = await Effect.runPromiseExit(Effect.provide(fx, ctx))
    if (exit._tag === "Success") throw new Error("expected failure")
    return JSON.stringify(exit.cause)
  }
  const acq = <A, E>(fn: (r: AcquisitionRepository["Type"]) => Effect.Effect<A, E>) => run(Effect.flatMap(AcquisitionRepository, fn))

  beforeAll(async () => {
    await migrate(url)
    pool = new pg.Pool({ connectionString: url })
    scope = await Effect.runPromise(Scope.make())
    ctx = await Effect.runPromise(Layer.buildWithScope(
      Layer.mergeAll(AcquisitionRepositoryLive, RecordRepositoryLive, ObservationRepositoryLive).pipe(Layer.provide(PgClient.layer({ url: Redacted.make(url) }))),
      scope,
    ))
  })
  afterAll(async () => {
    await Effect.runPromise(Scope.close(scope, Exit.succeed(undefined)))
    await pool.end()
  })

  const agency = async (): Promise<Session> => {
    const accountId = (await pool.query(`INSERT INTO accounts (name) VALUES ('TEST Agency') RETURNING id`)).rows[0].id as string
    const userId = (await pool.query(`INSERT INTO users (email, password_hash) VALUES ($1,'TEST-only') RETURNING id`, [`acq-${randomUUID()}@example.test`])).rows[0].id as string
    await pool.query(`INSERT INTO account_users (account_id, user_id) VALUES ($1,$2)`, [accountId, userId])
    return { accountId, userId }
  }
  const client = async (session: Session) =>
    (await run(Effect.flatMap(RecordRepository, r => r.createClient(session, { name: "TEST Supportly", websiteUrl: "https://supportly.test/", engagement: "FIXTURE" })))).businessId
  const setup = async () => {
    const session = await agency()
    const businessId = await client(session)
    const set = await acq(r => r.createQuestionSet(session, businessId, SPEC))
    return { session, businessId, set }
  }
  const batch = (session: Session, businessId: string, setId: string, samples = 2, keys: string[] | null = null) => acq(r => r.startBatch(session, businessId, {
    setId, scope: keys ? "SMOKE" : "FULL", questionKeys: keys, samples, provider: "gemini", requestedModel: MODEL,
    acknowledgedMaxProviderCalls: (keys?.length ?? 3) * samples * ACQ_MAX_ATTEMPTS_PER_CHECK,
  }))
  const checksOf = async (batchId: string) => (await pool.query(`SELECT id, question_id FROM check_runs WHERE acq_batch_id = $1 ORDER BY queued_at, id`, [batchId])).rows as Array<{ id: string; question_id: string }>
  /** Simulates the worker answering one acquisition check through Gemini. */
  const answer = async (businessId: string, checkRunId: string, text: string, synthetic = false) => {
    await pool.query(`UPDATE check_runs SET status='RUNNING', started_at=now(), heartbeat_at=now() WHERE id=$1 AND status='QUEUED'`, [checkRunId])
    const q = (await pool.query(`SELECT c.question_id, q.prompt FROM check_runs c JOIN buyer_questions q ON q.id = c.question_id WHERE c.id = $1`, [checkRunId])).rows[0]
    const raw = JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }], modelVersion: MODEL, nonce: randomUUID() })
    const collectedAt = new Date().toISOString()
    await run(Effect.flatMap(ObservationRepository, o => o.create({
      businessId, checkRunId, provider: "gemini", requestedModel: MODEL, observedModel: MODEL, collectedAt, answerText: text,
      retrievalMode: "PROVIDER_GROUNDING", modelVersion: MODEL, retrievalTool: "google_search", requestParameters: { model: MODEL, tools: ["google_search"] },
      rawResponse: JSON.parse(raw), rawDigest: createHash("sha256").update(raw).digest("hex"), rawBytesHex: Buffer.from(raw).toString("hex"),
      rawContentType: "application/json", providerMetadata: { webSearchQueries: ["TEST query"] }, synthetic, completeRun: true,
      measurementContext: hostedMeasurementContext({ businessId, questionId: q.question_id, checkRunId, prompt: q.prompt, provider: "gemini",
        requestedModel: MODEL, observedModel: MODEL, observedAt: collectedAt }),
      citations: [{ uri: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/TEST", title: "supportly.test", position: 1, attributed: true }],
    })))
    return createHash("sha256").update(raw).digest("hex")
  }

  describe("frozen question sets", () => {
    it("freezes exact prompts with keys, groups, positions and a spec digest", async () => {
      const { set } = await setup()
      expect(set.version).toBe(1)
      expect(set.questions.map(q => [q.key, q.group, q.position])).toEqual([["CD-01", "CATEGORY_DISCOVERY", 1], ["CD-02", "CATEGORY_DISCOVERY", 2], ["PS-01", "PROBLEM_SOLVING", 3]])
      expect(set.questions[0]!.prompt).toBe("What are the best TEST AI support agents?")
      expect(set.specDigest).toMatch(/^[0-9a-f]{64}$/)
    })
    it("refuses edits, deletion, late questions and prompt changes", async () => {
      const { set, businessId } = await setup()
      await expect(pool.query(`UPDATE acq_question_sets SET category = 'x' WHERE id = $1`, [set.id])).rejects.toThrow(/append-only/)
      await expect(pool.query(`DELETE FROM acq_questions WHERE set_id = $1`, [set.id])).rejects.toThrow(/append-only/)
      await expect(pool.query(`UPDATE buyer_questions SET prompt = 'Why is Supportly the best?' WHERE id = $1`, [set.questions[0]!.buyerQuestionId])).rejects.toThrow(/immutable/)
      await expect(pool.query(`UPDATE buyer_questions SET active = false WHERE id = $1`, [set.questions[0]!.buyerQuestionId])).rejects.toThrow(/immutable/)
      const bq = (await pool.query(`INSERT INTO buyer_questions (business_id, prompt) VALUES ($1, 'TEST late question') RETURNING id`, [businessId])).rows[0].id
      await expect(pool.query(`INSERT INTO acq_questions (business_id, set_id, question_key, intent_group, position, buyer_question_id) VALUES ($1,$2,'CD-09','CATEGORY_DISCOVERY',9,$3)`,
        [businessId, set.id, bq])).rejects.toThrow(/frozen/)
    })
    it("versions a changed set instead of editing it", async () => {
      const { session, businessId, set } = await setup()
      const v2 = await acq(r => r.createQuestionSet(session, businessId, { ...SPEC, questions: [...SPEC.questions, { group: "ALTERNATIVES", prompt: "What are TEST alternatives to HelpHub?" }] }))
      expect(v2.version).toBe(2)
      expect(v2.specDigest).not.toBe(set.specDigest)
      const view = acquisitionView((await acq(r => r.snapshot(businessId)))!)
      expect(view.sets.map(s => s.questions.length)).toEqual([3, 4])
    })
    it("refuses alias collisions, duplicate questions and invalid domains", async () => {
      const session = await agency()
      const businessId = await client(session)
      expect(await fails(Effect.flatMap(AcquisitionRepository, r => r.createQuestionSet(session, businessId, { ...SPEC,
        competitors: [{ name: "HelpHub", aliases: ["supportly ai"], domains: ["helphub.test"], matchCase: false, ambiguity: null }] })))).toContain("AliasCollision")
      expect(await fails(Effect.flatMap(AcquisitionRepository, r => r.createQuestionSet(session, businessId, { ...SPEC,
        questions: [SPEC.questions[0]!, { ...SPEC.questions[0]!, prompt: SPEC.questions[0]!.prompt.toUpperCase() }] })))).toContain("DuplicateQuestion")
      expect(await fails(Effect.flatMap(AcquisitionRepository, r => r.createQuestionSet(session, businessId, { ...SPEC,
        target: { ...SPEC.target, domains: ["not a domain"] } })))).toContain("InvalidBrand")
    })
  })

  describe("batches and checks", () => {
    it("queues one ordinary worker check per question and sample after the spend ceiling is acknowledged", async () => {
      const { session, businessId, set } = await setup()
      expect(await fails(Effect.flatMap(AcquisitionRepository, r => r.startBatch(session, businessId, { setId: set.id, scope: "FULL", questionKeys: null, samples: 2,
        provider: "gemini", requestedModel: MODEL, acknowledgedMaxProviderCalls: 6 })))).toContain("SpendPlanNotAcknowledged")
      const b = await batch(session, businessId, set.id)
      expect(b).toMatchObject({ scope: "FULL", questionCount: 3, sampleCount: 2, maxProviderCalls: 24, provider: "gemini", requestedModel: MODEL, retrievalRequested: true })
      const rows = (await pool.query(`SELECT status, provider, requested_model, record_run_id FROM check_runs WHERE acq_batch_id = $1`, [b.id])).rows
      expect(rows).toHaveLength(6)
      expect(rows.every(r => r.status === "QUEUED" && r.provider === "gemini" && r.requested_model === MODEL && r.record_run_id === null)).toBe(true)
      // The worker claims by queued_at: frozen position order, then sample.
      const order = (await pool.query(`SELECT q.question_key, c.acq_sample FROM check_runs c JOIN acq_questions q ON q.id = c.acq_question_id
        WHERE c.acq_batch_id = $1 ORDER BY c.queued_at`, [b.id])).rows.map(r => `${r.question_key}#${r.acq_sample}`)
      expect(order).toEqual(["CD-01#1", "CD-01#2", "CD-02#1", "CD-02#2", "PS-01#1", "PS-01#2"])
      expect(await fails(Effect.flatMap(AcquisitionRepository, r => r.startBatch(session, businessId, { setId: set.id, scope: "FULL", questionKeys: null, samples: 1,
        provider: "gemini", requestedModel: MODEL, acknowledgedMaxProviderCalls: 12 })))).toContain("BatchInProgress")
    })
    it("runs a smoke batch over named questions only", async () => {
      const { session, businessId, set } = await setup()
      const b = await batch(session, businessId, set.id, 1, ["PS-01"])
      expect(b).toMatchObject({ scope: "SMOKE", questionCount: 1, maxProviderCalls: 4 })
      expect(await checksOf(b.id)).toHaveLength(1)
    })
    it("binds each check to its batch provider, model, question and sampling policy for good", async () => {
      const { session, businessId, set } = await setup()
      const b = await batch(session, businessId, set.id, 1)
      const [c] = await checksOf(b.id)
      await expect(pool.query(`UPDATE check_runs SET requested_model = 'gemini-other' WHERE id = $1`, [c!.id])).rejects.toThrow(/immutable/)
      await expect(pool.query(`UPDATE check_runs SET acq_sample = 2 WHERE id = $1`, [c!.id])).rejects.toThrow(/immutable/)
      const q = set.questions[0]!
      await expect(pool.query(`INSERT INTO check_runs (business_id, question_id, provider, requested_model, acq_batch_id, acq_question_id, acq_sample) VALUES ($1,$2,'gemini','gemini-other',$3,$4,1)`,
        [businessId, q.buyerQuestionId, b.id, q.id])).rejects.toThrow(/does not match/)
      await expect(pool.query(`INSERT INTO check_runs (business_id, question_id, provider, requested_model, acq_batch_id, acq_question_id, acq_sample) VALUES ($1,$2,'gemini',$3,$4,$5,2)`,
        [businessId, q.buyerQuestionId, MODEL, b.id, q.id])).rejects.toThrow(/does not match/)
      await expect(pool.query(`INSERT INTO check_runs (business_id, question_id, provider, requested_model, acq_batch_id, acq_question_id, acq_sample) VALUES ($1,$2,'gemini',$3,$4,$5,1)`,
        [businessId, set.questions[1]!.buyerQuestionId, MODEL, b.id, q.id])).rejects.toThrow(/does not match/)
    })
  })

  describe("tenant isolation", () => {
    it("never reads or writes another agency's acquisition rows", async () => {
      const a = await setup()
      const b = await setup()
      const ab = await batch(a.session, a.businessId, a.set.id, 1, ["CD-01"])
      const [c] = await checksOf(ab.id)
      await answer(a.businessId, c!.id, "Supportly is a good fit.")
      const observationId = (await pool.query(`SELECT id FROM observations WHERE check_run_id = $1`, [c!.id])).rows[0].id
      expect(await fails(Effect.flatMap(AcquisitionRepository, r => r.judge(b.session, b.businessId, { observationId, mention: "MENTIONED", recommendation: "RECOMMENDED", note: null })))).toContain("ObservationNotFound")
      expect(await fails(Effect.flatMap(AcquisitionRepository, r => r.startBatch(b.session, b.businessId, { setId: a.set.id, scope: "SMOKE", questionKeys: ["CD-01"], samples: 1,
        provider: "gemini", requestedModel: MODEL, acknowledgedMaxProviderCalls: 4 })))).toContain("QuestionSetNotFound")
      await expect(pool.query(`INSERT INTO acq_batches (business_id, set_id, scope, question_count, sample_count, provider, max_provider_calls, requested_by_user_id) VALUES ($1,$2,'FULL',1,1,'gemini',4,$3)`,
        [b.businessId, a.set.id, b.session.userId])).rejects.toThrow(/foreign key/)
      await expect(pool.query(`INSERT INTO acq_judgments (business_id, observation_id, batch_id, mention, detector_version, candidate_count, reviewed_by_user_id) VALUES ($1,$2,$3,'NOT_MENTIONED','v',0,$4)`,
        [a.businessId, observationId, ab.id, b.session.userId])).rejects.toThrow(/account user/)
      const other = (await acq(r => r.snapshot(b.businessId)))!
      expect(other.checks).toHaveLength(0)
      expect(other.sets.map(s => s.id)).toEqual([b.set.id])
    })
  })

  describe("recommendation review", () => {
    it("attributes reviews to the session user, pins detector output, and keeps corrections append-only", async () => {
      const { session, businessId, set } = await setup()
      const b = await batch(session, businessId, set.id, 1, ["CD-01"])
      const [c] = await checksOf(b.id)
      const digest = await answer(businessId, c!.id, "You can consider HelpHub or Supportly AI.")
      const observationId = (await pool.query(`SELECT id FROM observations WHERE check_run_id = $1`, [c!.id])).rows[0].id as string
      expect(await fails(Effect.flatMap(AcquisitionRepository, r => r.judge(session, businessId, { observationId, mention: "NOT_MENTIONED", recommendation: "RECOMMENDED", note: null })))).toContain("InvalidJudgment")
      const first = await acq(r => r.judge(session, businessId, { observationId, mention: "MENTIONED", recommendation: "UNCLEAR", note: "TEST listed only" }))
      expect(first).toMatchObject({ reviewedByUserId: session.userId, detectorVersion: "acq-exact-alias-v1", candidateCount: 1, supersedesId: null })
      const second = await acq(r => r.judge(session, businessId, { observationId, mention: "MENTIONED", recommendation: "RECOMMENDED", note: null }))
      expect(second.supersedesId).toBe(first.id)
      await expect(pool.query(`UPDATE acq_judgments SET recommendation = 'ADVISED_AGAINST' WHERE id = $1`, [first.id])).rejects.toThrow(/append-only/)
      await expect(pool.query(`DELETE FROM acq_judgments WHERE id = $1`, [first.id])).rejects.toThrow(/append-only/)
      const view = acquisitionView((await acq(r => r.snapshot(businessId)))!)
      const check = view.checks.find(x => x.id === c!.id)!
      expect(check.judgments).toHaveLength(2)
      expect(check.judgment!.recommendation).toBe("RECOMMENDED")
      // Raw evidence identity: the observation keeps the exact provider bytes and digest.
      expect(check.observation!.rawDigest).toBe(digest)
      const stored = (await pool.query(`SELECT re.digest, o.raw_digest FROM observations o JOIN raw_evidence re ON re.id = o.raw_evidence_id WHERE o.id = $1`, [observationId])).rows[0]
      expect(stored).toEqual({ digest, raw_digest: digest })
      await expect(pool.query(`UPDATE observations SET answer_text = 'Supportly is the best' WHERE id = $1`, [observationId])).rejects.toThrow(/append-only/)
      const m = view.batches[0]!.metrics
      expect(m.recommendationRate).toEqual({ n: 1, d: 1 })
      expect(m.ownedCitationRate).toEqual({ n: 1, d: 1 })
    })
    it("refuses a review of a record observation", async () => {
      const { session, businessId } = await setup()
      const recordQuestion = (await pool.query(`INSERT INTO buyer_questions (business_id, prompt) VALUES ($1,'TEST plain') RETURNING id`, [businessId])).rows[0].id
      const plain = (await pool.query(`INSERT INTO check_runs (business_id, question_id, provider, requested_model) VALUES ($1,$2,'gemini',$3) RETURNING id`, [businessId, recordQuestion, MODEL])).rows[0].id
      await answer(businessId, plain, "TEST unrelated answer")
      const observationId = (await pool.query(`SELECT id FROM observations WHERE check_run_id = $1`, [plain])).rows[0].id
      expect(await fails(Effect.flatMap(AcquisitionRepository, r => r.judge(session, businessId, { observationId, mention: "NOT_MENTIONED", recommendation: null, note: null })))).toContain("ObservationNotFound")
    })
  })

  describe("GA4 referral imports", () => {
    const meta = { dataOrigin: "SYNTHETIC_FIXTURE" as const, propertyRef: "TEST-property", dateStart: "2026-09-01", dateEnd: "2026-09-30", timeZone: "UTC",
      attributionBasis: "SESSION_SOURCE_MEDIUM" as const, conversionEvent: null }
    const csv = "date,sessionSource,sessionMedium,sessions\n20260901,chatgpt.com,referral,3\n20260902,google,organic,10\n"
    it("stores the original export and digest, and re-imports idempotently", async () => {
      const { session, businessId } = await setup()
      const first = await acq(r => r.importReferrals(session, businessId, meta, csv))
      expect(first.duplicate).toBe(false)
      const again = await acq(r => r.importReferrals(session, businessId, meta, csv))
      expect(again).toEqual({ importId: first.importId, duplicate: true })
      expect(await fails(Effect.flatMap(AcquisitionRepository, r => r.importReferrals(session, businessId, { ...meta, timeZone: "America/Chicago" }, csv)))).toContain("DuplicateExportDifferentMetadata")
      const stored = (await pool.query(`SELECT raw_text, raw_digest, row_count FROM acq_referral_imports WHERE id = $1`, [first.importId])).rows[0]
      expect(stored).toEqual({ raw_text: csv, raw_digest: createHash("sha256").update(csv).digest("hex"), row_count: 2 })
      const view = acquisitionView((await acq(r => r.snapshot(businessId)))!)
      expect(view.referrals[0]).toMatchObject({ synthetic: true, aiSessions: 3, totalSessions: 13, signups: "SIGNUPS_NOT_MEASURED" })
    })
    it("refuses malformed exports with the line, and rows outside the stated range at the database", async () => {
      const { session, businessId } = await setup()
      expect(await fails(Effect.flatMap(AcquisitionRepository, r => r.importReferrals(session, businessId, meta, "date,sessionSource,sessionMedium,sessions\n20261005,a,b,1\n")))).toMatch(/DateOutsideRange.*2|line":2/)
      const imp = (await acq(r => r.importReferrals(session, businessId, meta, csv))).importId
      await expect(pool.query(`INSERT INTO acq_referral_rows (import_id, business_id, row_number, day, session_source, session_medium, sessions) VALUES ($1,$2,9,'2026-09-03','x','y',1)`,
        [imp, businessId])).rejects.toThrow(/only with their import/)
      await expect(pool.query(`UPDATE acq_referral_imports SET row_count = 99 WHERE id = $1`, [imp])).rejects.toThrow(/append-only/)
    })
  })
})
