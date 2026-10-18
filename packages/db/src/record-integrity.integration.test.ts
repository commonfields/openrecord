// OPENRECORD_RECORD_INTEGRITY_V1 acceptance (cases A–H), required invariants
// and adversarial review, end to end against Postgres 16. Every agency,
// client, fact and reviewer is a labelled TEST fixture. The worker is
// simulated by persisting grounded Gemini-shaped observations with explicit
// collection times; every human act (approval, claim, judgment, action)
// goes through the session-attributed repository, never raw SQL.
// Requires TEST_DATABASE_URL (CI provides postgres; skipped otherwise).
import { createHash, randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Context, Effect, Exit, Layer, Redacted, Scope } from "effect"
import { PgClient } from "@effect/sql-pg"
import pg from "pg"
import {
  CAUSALITY_DISCLOSURE, hostedMeasurementContext, ObservationRepository, ObservationRepositoryLive,
  operatorView, publicRecord, RecordRepository, RecordRepositoryLive,
  type RecordDecision, type RecordSlot, type Session,
} from "./index.js"
import { migrate } from "./migrate.js"

const url = process.env["TEST_DATABASE_URL"] ?? process.env["DATABASE_URL"] ?? ""
const suite = url ? describe : describe.skip
const MODEL = "gemini-2.5-flash"
const unique = (prefix: string) => `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`

type Repos = RecordRepository | ObservationRepository

suite("record integrity v1 (TEST Northstar agency, TEST clients, TEST reviewer)", () => {
  let pool: pg.Pool
  let scope: Scope.CloseableScope
  let ctx: Context.Context<Repos>
  const runFx = <A, E>(fx: Effect.Effect<A, E, Repos>) => Effect.runPromise(Effect.provide(fx, ctx))

  beforeAll(async () => {
    await migrate(url)
    pool = new pg.Pool({ connectionString: url })
    scope = await Effect.runPromise(Scope.make())
    ctx = await Effect.runPromise(Layer.buildWithScope(
      Layer.mergeAll(RecordRepositoryLive, ObservationRepositoryLive).pipe(Layer.provide(PgClient.layer({ url: Redacted.make(url) }))),
      scope,
    ))
  })
  afterAll(async () => {
    await Effect.runPromise(Scope.close(scope, Exit.succeed(undefined)))
    await pool.end()
  })

  const agency = async (): Promise<Session> => {
    const accountId = (await pool.query(`INSERT INTO accounts (name) VALUES ($1) RETURNING id`, [unique("Northstar")])).rows[0].id as string
    const userId = (await pool.query(`INSERT INTO users (email, password_hash) VALUES ($1,'TEST-only') RETURNING id`, [`integrity-${randomUUID()}@example.test`])).rows[0].id as string
    await pool.query(`INSERT INTO account_users (account_id, user_id) VALUES ($1,$2)`, [accountId, userId])
    return { accountId, userId }
  }
  interface SlotSpec {
    readonly slot: RecordSlot; readonly predicate: string; readonly value: string; readonly valueType?: "TEXT" | "CURRENCY"
    readonly validFrom: string; readonly validUntil?: string | null; readonly question: string
  }
  const client = async (session: Session, name: string, slots: ReadonlyArray<SlotSpec>, website = "https://client.test/") => {
    const c = await runFx(Effect.flatMap(RecordRepository, r => r.createClient(session, { name, websiteUrl: website, engagement: "FIXTURE" })))
    for (const s of slots) {
      const item = await runFx(Effect.flatMap(RecordRepository, r => r.saveSlot(session, c.businessId, {
        slot: s.slot, subject: name, predicate: s.predicate, valueText: s.value, valueType: s.valueType ?? "TEXT",
        validFrom: s.validFrom, validUntil: s.validUntil ?? null, sourceUrl: `${website}facts`, question: s.question,
      })))
      await runFx(Effect.flatMap(RecordRepository, r => r.approveItem(session, c.businessId, item.id)))
    }
    return c.businessId
  }
  /** Simulates the worker answering one record check on a grounded AI surface. */
  const answer = async (businessId: string, checkId: string, text: string, collectedAt: string, citations: ReadonlyArray<{ uri: string; title: string }> = [], model = MODEL) => {
    await pool.query(`UPDATE check_runs SET status='RUNNING', started_at=now(), heartbeat_at=now() WHERE id=$1 AND status='QUEUED'`, [checkId])
    const run = (await pool.query(`SELECT c.question_id, q.prompt FROM check_runs c JOIN buyer_questions q ON q.id=c.question_id WHERE c.id=$1`, [checkId])).rows[0]
    const raw = JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }], modelVersion: model, nonce: randomUUID() })
    return runFx(Effect.flatMap(ObservationRepository, o => o.create({
      businessId, checkRunId: checkId, provider: "gemini", requestedModel: model, observedModel: model, collectedAt, answerText: text,
      retrievalMode: "PROVIDER_GROUNDING", modelVersion: model, retrievalTool: "google_search",
      requestParameters: { model, tools: ["google_search"] }, rawResponse: JSON.parse(raw),
      rawDigest: createHash("sha256").update(raw).digest("hex"), rawBytesHex: Buffer.from(raw).toString("hex"), rawContentType: "application/json",
      providerMetadata: { responseId: "TEST-internal-response" }, synthetic: false, completeRun: true,
      measurementContext: hostedMeasurementContext({ businessId, questionId: run.question_id, checkRunId: checkId, prompt: run.prompt,
        provider: "gemini", requestedModel: model, observedModel: model, observedAt: collectedAt }),
      citations: citations.map((c, i) => ({ uri: c.uri, title: c.title, position: i + 1, attributed: true })),
    })))
  }
  const snapshot = async (businessId: string) => (await runFx(Effect.flatMap(RecordRepository, r => r.snapshot(businessId))))!
  const judge = (session: Session, businessId: string, observationId: string, decision: RecordDecision, claim?: { text: string; span?: string | null }) =>
    runFx(Effect.flatMap(RecordRepository, r => r.judge(session, businessId, { observationId, decision, note: "TEST reviewer internal note", claim: claim ?? null })))
  const slotOf = async (businessId: string, runId: string) => {
    const s = await snapshot(businessId)
    return s.checks.filter(c => c.runId === runId).map(c => ({ check: c, slot: s.items.find(i => i.id === c.itemId)!.slot }))
  }
  const fail = async (checkId: string) => {
    await pool.query(`UPDATE check_runs SET status='FAILED', failure_class='PROVIDER_UNAVAILABLE', failure_detail_safe='provider unavailable', completed_at=now() WHERE id=$1`, [checkId])
  }

  const refusal = (fx: (r: Context.Tag.Service<typeof RecordRepository>) => Effect.Effect<unknown, unknown>) =>
    runFx(Effect.flip(Effect.flatMap(RecordRepository, fx)).pipe(Effect.map(e => String((e as { reason?: unknown }).reason ?? (e as { _tag?: unknown })._tag))))

  const PRICE_Q = "How much does Example Pro cost?"
  const HOURS_Q = "Is Example Clinic open on Saturday?"
  const APPT_Q = "Does Example Studio offer same-day appointments?"

  it("case A — contradiction: approved $79, 4 of 5 observed samples say $49", async () => {
    const session = await agency()
    const businessId = await client(session, "TEST Example Pro", [
      { slot: 1, predicate: "Monthly price", value: "$79", valueType: "CURRENCY", validFrom: "2026-07-01T00:00:00.000Z", question: PRICE_Q },
      { slot: 2, predicate: "Support hours", value: "09:00-17:00", validFrom: "2026-01-01T00:00:00.000Z", question: "When is Example Pro support open?" },
      { slot: 3, predicate: "Free trial", value: "14 days", validFrom: "2026-01-01T00:00:00.000Z", question: "Does Example Pro offer a free trial?" },
    ])
    const run = await runFx(Effect.flatMap(RecordRepository, r => r.startRun(session, businessId, { kind: null, provider: "gemini", requestedModel: MODEL, samples: 5 })))
    expect(run.sampleCount).toBe(5)
    for (const { check, slot } of await slotOf(businessId, run.id)) {
      const contradicts = slot === 1 && check.sample <= 4
      const text = slot === 1
        ? contradicts ? "Example Pro costs $49 per month — see our 2024 pricing." : "Example Pro costs $79 per month."
        : slot === 2 ? "Example Pro support is open 09:00-17:00." : "Example Pro offers a 14-day free trial."
      const obs = await answer(businessId, check.id, text, "2026-10-01T10:00:00.000Z",
        slot === 1 && contradicts ? [{ uri: "https://example.com/blog/pricing-2024", title: "2024 pricing" }] : [{ uri: "https://client.test/facts", title: "client.test" }])
      await judge(session, businessId, obs.id, slot === 1 ? (contradicts ? "CONTRADICTS" : "MATCHES") : "MATCHES",
        slot === 1 && contradicts ? { text: "$49 per month", span: "$49 per month" } : undefined)
    }
    const view = operatorView(await snapshot(businessId))
    const slot1 = view.slots.find(s => s.slot === 1)!
    // The record view shows the approved truth, the observed claim, the
    // sample count, the source and the review — no score.
    expect(slot1.item.fact.valueText).toBe("$79")
    expect(slot1.finding).toMatchObject({ kind: "CONTRADICTION", state: "OPEN" })
    expect(slot1.finding.samples).toMatchObject({ total: 5, reviewed: 5, contradict: 4, matches: 1 })
    expect(slot1.finding.samples.statement).toBe("4 of 5 reviewed observations contradicted this fact; 1 matched.")
    const reviewed = (await snapshot(businessId)).checks.filter(c => c.runId === run.id && c.itemId === slot1.item.id && c.observation)
    expect(reviewed).toHaveLength(5)
    const claims = reviewed.flatMap(c => c.claims)
    expect(claims).toHaveLength(4)
    expect(claims.every(k => k.supportingSpan === "$49 per month" && k.extractionMethod === "MANUAL_EXACT_SPAN")).toBe(true)
    expect(reviewed.every(c => c.judgments.length === 1 && c.judgments[0]!.factVersion === 1)).toBe(true)
    expect(JSON.stringify(view)).not.toMatch(/score|percent/i)
  })

  it("cancel: stopping a re-check cancels only unsent questions, keeps history and frees the next run", async () => {
    const session = await agency()
    const businessId = await client(session, "TEST Example Stop", [
      { slot: 1, predicate: "Monthly price", value: "$79", valueType: "CURRENCY", validFrom: "2026-01-01T00:00:00.000Z", question: PRICE_Q },
    ])
    const first = await runFx(Effect.flatMap(RecordRepository, r => r.startRun(session, businessId, { kind: null, provider: "gemini", requestedModel: MODEL, samples: 3 })))
    for (const { check } of await slotOf(businessId, first.id)) {
      const obs = await answer(businessId, check.id, "Example Pro costs $79 per month.", "2026-10-01T10:00:00.000Z")
      await judge(session, businessId, obs.id, "MATCHES")
    }
    // An accidental re-check: one question is already in flight, two wait.
    const accidental = await runFx(Effect.flatMap(RecordRepository, r => r.startRun(session, businessId, { kind: "FOLLOW_UP", provider: "gemini", requestedModel: MODEL, samples: 3 })))
    const queued = await slotOf(businessId, accidental.id)
    await pool.query(`UPDATE check_runs SET status='RUNNING', started_at=now(), heartbeat_at=now() WHERE id=$1`, [queued[0]!.check.id])
    // Another agency cannot stop it.
    const stranger = await agency()
    expect(await refusal(r => r.cancelRun(stranger, randomUUID(), accidental.id))).toBe("RecordNotFound")
    const result = await runFx(Effect.flatMap(RecordRepository, r => r.cancelRun(session, businessId, accidental.id)))
    expect(result).toEqual({ cancelled: 2, stillRunning: 1 })
    const rows = (await pool.query(`SELECT status, failure_class, completed_at FROM check_runs WHERE record_run_id=$1 ORDER BY record_sample`, [accidental.id])).rows
    expect(rows.map(r => [r.status, r.failure_class])).toEqual([["RUNNING", null], ["FAILED", "CANCELLED"], ["FAILED", "CANCELLED"]])
    // A worker cannot claim a cancelled check.
    const claimable = (await pool.query(`SELECT count(*)::int AS n FROM check_runs WHERE record_run_id=$1 AND status='QUEUED'`, [accidental.id])).rows[0].n
    expect(claimable).toBe(0)
    // The in-flight question finishes and is kept; the run is partial, not cancelled.
    await answer(businessId, queued[0]!.check.id, "Example Pro costs $79 per month.", "2026-10-08T10:00:00.000Z")
    let view = operatorView(await snapshot(businessId))
    expect(view.runs.find(r => r.id === accidental.id)!.status).toBe("PARTIALLY_SUCCEEDED")
    expect(view.activeRun).toBe(false)

    // A re-check stopped before anything started is CANCELLED: it is kept in
    // history, is not compared, and does not lock the first check.
    const second = await runFx(Effect.flatMap(RecordRepository, r => r.startRun(session, businessId, { kind: "FOLLOW_UP", provider: "gemini", requestedModel: MODEL, samples: 3 })))
    expect(await runFx(Effect.flatMap(RecordRepository, r => r.cancelRun(session, businessId, second.id)))).toEqual({ cancelled: 3, stillRunning: 0 })
    view = operatorView(await snapshot(businessId))
    expect(view.runs.find(r => r.id === second.id)!.status).toBe("CANCELLED")
    expect(view.slots[0]!.latestFollowUpCheckIds).toEqual(queued.map(q => q.check.id))
    expect(await refusal(r => r.cancelRun(session, businessId, second.id))).toBe("RunNotActive")
    expect(await refusal(r => r.cancelRun(session, businessId, randomUUID()))).toBe("RunNotFound")
  })

  it("cancel: a first re-check cancelled before it started does not lock the first check", async () => {
    const session = await agency()
    const businessId = await client(session, "TEST Example Undo", [
      { slot: 1, predicate: "Monthly price", value: "$79", valueType: "CURRENCY", validFrom: "2026-01-01T00:00:00.000Z", question: PRICE_Q },
    ])
    const first = await runFx(Effect.flatMap(RecordRepository, r => r.startRun(session, businessId, { kind: null, provider: "gemini", requestedModel: MODEL, samples: 1 })))
    for (const { check } of await slotOf(businessId, first.id)) await answer(businessId, check.id, "Example Pro costs $79 per month.", "2026-10-01T10:00:00.000Z")
    const accidental = await runFx(Effect.flatMap(RecordRepository, r => r.startRun(session, businessId, { kind: "FOLLOW_UP", provider: "gemini", requestedModel: MODEL, samples: 1 })))
    await runFx(Effect.flatMap(RecordRepository, r => r.cancelRun(session, businessId, accidental.id)))
    const redo = await runFx(Effect.flatMap(RecordRepository, r => r.startRun(session, businessId, { kind: "INITIAL", provider: "gemini", requestedModel: MODEL, samples: 1 })))
    expect(redo.kind).toBe("INITIAL")
  })

  it("case B — agreement: matching evidence is kept, no issue is manufactured", async () => {
    const session = await agency()
    const businessId = await client(session, "TEST Example Clinic", [
      { slot: 1, predicate: "Saturday hours", value: "09:00–14:00", validFrom: "2026-01-01T00:00:00.000Z", question: HOURS_Q },
      { slot: 2, predicate: "New patients", value: "Yes", validFrom: "2026-01-01T00:00:00.000Z", question: "Does Example Clinic accept new patients?" },
      { slot: 3, predicate: "X-ray on site", value: "Yes", validFrom: "2026-01-01T00:00:00.000Z", question: "Does Example Clinic have X-ray on site?" },
    ])
    const run = await runFx(Effect.flatMap(RecordRepository, r => r.startRun(session, businessId, { kind: null, provider: "gemini", requestedModel: MODEL, samples: 2 })))
    for (const { check } of await slotOf(businessId, run.id)) {
      const obs = await answer(businessId, check.id, "TEST agreed answer.", "2026-10-01T10:00:00.000Z", [{ uri: "https://client.test/facts", title: "client.test" }])
      await judge(session, businessId, obs.id, "MATCHES")
    }
    const view = operatorView(await snapshot(businessId))
    for (const s of view.slots) {
      expect(s.finding).toMatchObject({ kind: "AGREEMENT", state: "AGREEMENT" })
      expect(s.finding.state).not.toBe("OPEN")
      expect(s.comparison).toBeNull()
    }
  })

  it("case C — uncertainty: ambiguity stays UNKNOWN, never inferred", async () => {
    const session = await agency()
    const businessId = await client(session, "TEST Example Studio", [
      { slot: 1, predicate: "Same-day appointments", value: "Available", validFrom: "2026-01-01T00:00:00.000Z", question: APPT_Q },
      { slot: 2, predicate: "Wheelchair access", value: "Yes", validFrom: "2026-01-01T00:00:00.000Z", question: "Is Example Studio wheelchair accessible?" },
      { slot: 3, predicate: "Parking", value: "Free on site", validFrom: "2026-01-01T00:00:00.000Z", question: "Does Example Studio offer parking?" },
    ])
    const run = await runFx(Effect.flatMap(RecordRepository, r => r.startRun(session, businessId, { kind: null, provider: "gemini", requestedModel: MODEL, samples: 2 })))
    for (const { check, slot } of await slotOf(businessId, run.id)) {
      const text = slot === 1 ? "Some visitors mention appointments, but availability is unclear." : "TEST agreed answer."
      const obs = await answer(businessId, check.id, text, "2026-10-01T10:00:00.000Z")
      await judge(session, businessId, obs.id, slot === 1 ? "UNKNOWN" : "MATCHES")
    }
    const s = await snapshot(businessId)
    const slot1checks = s.checks.filter(c => c.runId === run.id && s.items.find(i => i.id === c.itemId)!.slot === 1)
    expect(slot1checks.map(c => c.judgments[0]!.decision)).toEqual(["UNKNOWN", "UNKNOWN"])
    const view = operatorView(s)
    expect(view.slots.find(x => x.slot === 1)!.finding).toMatchObject({ kind: "UNDETERMINED" })
    const page = publicRecord(s)
    expect(page.facts[0]!.samples.map(a => a.status === "ANSWERED" ? a.judgment.decision : null)).toEqual(["UNKNOWN", "UNKNOWN"])
  })

  it("case D — temporal truth: the same claim text judges differently across a truth change", async () => {
    const session = await agency()
    // Slot 3 starts at $49. The May run binds that version; the July truth
    // change supersedes it; the October run binds the $79 version. Every
    // step below uses the real saveSlot/startRun/judge path.
    const businessId = await client(session, "TEST Temporal Pro", [
      { slot: 1, predicate: "Monthly price", value: "$79", valueType: "CURRENCY", validFrom: "2026-01-01T00:00:00.000Z", question: PRICE_Q },
      { slot: 2, predicate: "Support hours", value: "09:00-17:00", validFrom: "2026-01-01T00:00:00.000Z", question: "x?" },
      { slot: 3, predicate: "Onboarding fee", value: "$49", valueType: "CURRENCY", validFrom: "2026-01-01T00:00:00.000Z", question: "What is the onboarding fee?" },
    ], "https://temporal.test/")
    const run1 = await runFx(Effect.flatMap(RecordRepository, r => r.startRun(session, businessId, { kind: null, provider: "gemini", requestedModel: MODEL, samples: 1 })))
    for (const { check, slot } of await slotOf(businessId, run1.id)) {
      const text = slot === 3 ? "The onboarding fee is $49 per month." : "TEST agreed answer."
      const o = await answer(businessId, check.id, text, "2026-05-10T10:00:00.000Z")
      if (slot !== 3) await judge(session, businessId, o.id, "MATCHES")
    }
    const mayCheck = (await slotOf(businessId, run1.id)).find(x => x.slot === 3)!.check
    const may = (await snapshot(businessId)).checks.find(c => c.id === mayCheck.id)!.observation!
    const j1 = await judge(session, businessId, may.id, "MATCHES")
    expect(j1.factVersion).toBe(1)
    // July: the business approves $79. History is appended, never rewritten.
    const v2item = await runFx(Effect.flatMap(RecordRepository, r => r.saveSlot(session, businessId, {
      slot: 3, subject: "TEST Temporal Pro", predicate: "Onboarding fee", valueText: "$79", valueType: "CURRENCY",
      validFrom: "2026-07-01T00:00:00.000Z", validUntil: null, sourceUrl: "https://temporal.test/facts", question: "What is the onboarding fee?",
    })))
    expect(v2item.fact.version).toBe(2)
    await runFx(Effect.flatMap(RecordRepository, r => r.approveItem(session, businessId, v2item.id)))
    // October: the same question and the same claim text, bound to the $79
    // version. The claim now contradicts that truth.
    const run2 = await runFx(Effect.flatMap(RecordRepository, r => r.startRun(session, businessId, { kind: "FOLLOW_UP", provider: "gemini", requestedModel: MODEL, samples: 1 })))
    const octCheck = (await slotOf(businessId, run2.id)).find(x => x.slot === 3)!.check
    const oct = await answer(businessId, octCheck.id, "The onboarding fee is $49 per month.", "2026-10-05T10:00:00.000Z")
    const j2 = await judge(session, businessId, oct.id, "CONTRADICTS")
    expect(j2.factVersion).toBe(2)
    // Same text, different collection dates, different correct outcomes: the
    // May observation was never judged against today's $79.
    expect(may.answerText).toBe(oct.answerText)
    expect(j1.decision).toBe("MATCHES")
    expect(j2.decision).toBe("CONTRADICTS")
    expect(j1.factId).not.toBe(j2.factId)
    // Truth changed between the runs, so no before/after outcome is derived.
    const view = operatorView(await snapshot(businessId))
    expect(view.slots.find(x => x.slot === 3)!.comparison).toMatchObject({ state: "DERIVED", outcome: "INDETERMINATE", reason: "FACT_CHANGED" })
  })

  it("case E — weekly before/after: action recorded, contradiction gone, honest correction", async () => {
    const session = await agency()
    const businessId = await client(session, "TEST Before After", [
      { slot: 1, predicate: "Monthly price", value: "$79", valueType: "CURRENCY", validFrom: "2026-07-01T00:00:00.000Z", question: PRICE_Q },
      { slot: 2, predicate: "Support hours", value: "09:00-17:00", validFrom: "2026-01-01T00:00:00.000Z", question: "x?" },
      { slot: 3, predicate: "Free trial", value: "14 days", validFrom: "2026-01-01T00:00:00.000Z", question: "y?" },
    ])
    const before = await runFx(Effect.flatMap(RecordRepository, r => r.startRun(session, businessId, { kind: null, provider: "gemini", requestedModel: MODEL, samples: 5 })))
    for (const { check, slot } of await slotOf(businessId, before.id)) {
      const contradicts = slot === 1 && check.sample <= 4
      const text = slot === 1
        ? contradicts ? "It costs $49 per month." : "It costs $79 per month."
        : "TEST agreed answer."
      const obs = await answer(businessId, check.id, text, "2026-10-01T10:00:00.000Z")
      await judge(session, businessId, obs.id, slot === 1 ? (contradicts ? "CONTRADICTS" : "MATCHES") : "MATCHES")
    }
    await runFx(Effect.flatMap(RecordRepository, r => r.recordAction(session, businessId,
      { slot: 1, type: "SOURCE_UPDATED", note: "Updated controlled pricing page.", links: ["https://client.test/facts"], performedAt: "2026-10-04T12:00:00.000Z" })))
    const afterRun = await runFx(Effect.flatMap(RecordRepository, r => r.startRun(session, businessId, { kind: "FOLLOW_UP", provider: "gemini", requestedModel: MODEL, samples: 5 })))
    for (const { check, slot } of await slotOf(businessId, afterRun.id)) {
      const text = slot === 1 ? "It costs $79 per month." : "TEST agreed answer."
      const obs = await answer(businessId, check.id, text, "2026-10-08T10:00:00.000Z")
      await judge(session, businessId, obs.id, "MATCHES")
    }
    await runFx(Effect.flatMap(RecordRepository, r => r.share(session, businessId)))
    const s = await snapshot(businessId)
    const page = publicRecord(s)
    const fact = page.facts[0]!
    expect(fact.summary).toMatchObject({ total: 5, reviewed: 5, contradict: 0, matches: 5 })
    expect(fact.comparison).toMatchObject({ outcome: "OBSERVED_CORRECTED",
      before: { summary: { contradict: 4, matches: 1 } },
      actions: [{ note: "Updated controlled pricing page." }],
      after: { summary: { contradict: 0, matches: 5 } } })
    expect(fact.comparison!.before.samples).toHaveLength(5)
    expect(fact.comparison!.after.samples).toHaveLength(5)
    expect(page.disclosure).toBe(CAUSALITY_DISCLOSURE)
    expect(JSON.stringify({ ...page, disclosure: null })).not.toMatch(/caused|because of|thanks to|led to|resulted in|fixed the AI|optimization/i)
    expect(operatorView(s).slots.find(x => x.slot === 1)!.finding.state).toBe("OBSERVED_CORRECTED")
  })

  it("case F — no change: contradiction persists, never softened into success", async () => {
    const session = await agency()
    const businessId = await client(session, "TEST No Change", [
      { slot: 1, predicate: "Monthly price", value: "$79", valueType: "CURRENCY", validFrom: "2026-07-01T00:00:00.000Z", question: PRICE_Q },
      { slot: 2, predicate: "Support hours", value: "09:00-17:00", validFrom: "2026-01-01T00:00:00.000Z", question: "x?" },
      { slot: 3, predicate: "Free trial", value: "14 days", validFrom: "2026-01-01T00:00:00.000Z", question: "y?" },
    ])
    for (const [kind, at] of [["INITIAL", "2026-10-01T10:00:00.000Z"], ["FOLLOW_UP", "2026-10-08T10:00:00.000Z"]] as const) {
      const run = await runFx(Effect.flatMap(RecordRepository, r => r.startRun(session, businessId,
        { kind: kind === "INITIAL" ? null : "FOLLOW_UP", provider: "gemini", requestedModel: MODEL, samples: 5 })))
      for (const { check, slot } of await slotOf(businessId, run.id)) {
        const contradicts = slot === 1 && check.sample <= 4
        const text = slot === 1 ? (contradicts ? "It costs $49 per month." : "It costs $79 per month.") : "TEST agreed answer."
        const obs = await answer(businessId, check.id, text, at)
        await judge(session, businessId, obs.id, slot === 1 ? (contradicts ? "CONTRADICTS" : "MATCHES") : "MATCHES")
      }
      if (kind === "INITIAL") {
        await runFx(Effect.flatMap(RecordRepository, r => r.recordAction(session, businessId,
          { slot: 1, type: "SOURCE_UPDATED", note: "Updated controlled pricing page.", links: [], performedAt: "2026-10-04T12:00:00.000Z" })))
      }
    }
    const page = publicRecord(await snapshot(businessId))
    expect(page.facts[0]!.comparison).toMatchObject({ outcome: "NO_OBSERVED_CHANGE" })
    expect(page.facts[0]!.comparison!.explanation).toBe("No observed change. The later answers still contradict the approved fact.")
  })

  it("case G — indeterminate: follow-up evidence unusable, never a correction", async () => {
    const session = await agency()
    const businessId = await client(session, "TEST Indeterminate", [
      { slot: 1, predicate: "Monthly price", value: "$79", valueType: "CURRENCY", validFrom: "2026-07-01T00:00:00.000Z", question: PRICE_Q },
      { slot: 2, predicate: "Support hours", value: "09:00-17:00", validFrom: "2026-01-01T00:00:00.000Z", question: "x?" },
      { slot: 3, predicate: "Free trial", value: "14 days", validFrom: "2026-01-01T00:00:00.000Z", question: "y?" },
    ])
    const before = await runFx(Effect.flatMap(RecordRepository, r => r.startRun(session, businessId, { kind: null, provider: "gemini", requestedModel: MODEL, samples: 2 })))
    for (const { check, slot } of await slotOf(businessId, before.id)) {
      const obs = await answer(businessId, check.id, slot === 1 ? "It costs $49 per month." : "TEST agreed answer.", "2026-10-01T10:00:00.000Z")
      await judge(session, businessId, obs.id, slot === 1 ? "CONTRADICTS" : "MATCHES")
    }
    await runFx(Effect.flatMap(RecordRepository, r => r.recordAction(session, businessId,
      { slot: 1, type: "SOURCE_UPDATED", note: "Updated controlled pricing page.", links: [], performedAt: "2026-10-04T12:00:00.000Z" })))
    const afterRun = await runFx(Effect.flatMap(RecordRepository, r => r.startRun(session, businessId, { kind: "FOLLOW_UP", provider: "gemini", requestedModel: MODEL, samples: 2 })))
    for (const { check, slot } of await slotOf(businessId, afterRun.id)) {
      if (slot === 1 && check.sample === 2) {
        await fail(check.id)
      } else {
        const obs = await answer(businessId, check.id, slot === 1 ? "It costs $79 per month." : "TEST agreed answer.", "2026-10-08T10:00:00.000Z")
        await judge(session, businessId, obs.id, "MATCHES")
      }
    }
    const page = publicRecord(await snapshot(businessId))
    const comparison = page.facts[0]!.comparison!
    expect(comparison.outcome).toBe("INDETERMINATE")
    expect(comparison.outcome).not.toBe("OBSERVED_CORRECTED")
    expect(comparison.explanation).toBe("One of the checks was only partially completed, so this record cannot establish a weekly outcome.")
  })

  it("case H — external resolution: the product takes no credit without a recorded action", async () => {
    const session = await agency()
    const businessId = await client(session, "TEST External", [
      { slot: 1, predicate: "Monthly price", value: "$79", valueType: "CURRENCY", validFrom: "2026-07-01T00:00:00.000Z", question: PRICE_Q },
      { slot: 2, predicate: "Support hours", value: "09:00-17:00", validFrom: "2026-01-01T00:00:00.000Z", question: "x?" },
      { slot: 3, predicate: "Free trial", value: "14 days", validFrom: "2026-01-01T00:00:00.000Z", question: "y?" },
    ])
    for (const [kind, at, text] of [
      ["INITIAL", "2026-10-01T10:00:00.000Z", "It costs $49 per month."],
      ["FOLLOW_UP", "2026-10-08T10:00:00.000Z", "It costs $79 per month."],
    ] as const) {
      const run = await runFx(Effect.flatMap(RecordRepository, r => r.startRun(session, businessId,
        { kind: kind === "INITIAL" ? null : "FOLLOW_UP", provider: "gemini", requestedModel: MODEL, samples: 2 })))
      for (const { check, slot } of await slotOf(businessId, run.id)) {
        const t = slot === 1 ? text : "TEST agreed answer."
        const obs = await answer(businessId, check.id, t, at)
        await judge(session, businessId, obs.id, slot === 1 ? (kind === "INITIAL" ? "CONTRADICTS" : "MATCHES") : "MATCHES")
      }
    }
    // No action was recorded anywhere in this record.
    expect((await snapshot(businessId)).actions).toEqual([])
    const page = publicRecord(await snapshot(businessId))
    const comparison = page.facts[0]!.comparison!
    expect(comparison.outcome).toBe("RESOLVED_EXTERNALLY")
    expect(comparison.actions).toEqual([])
    expect(comparison.explanation).toContain("no action was recorded in OpenRecord, so OpenRecord takes no credit")
  })

  it("attribution: a targeted action corrects its fact only; record-level actions take no credit", async () => {
    const session = await agency()
    const targeted = await client(session, "TEST Attribution", [
      { slot: 1, predicate: "Monthly price", value: "$79", valueType: "CURRENCY", validFrom: "2026-07-01T00:00:00.000Z", question: PRICE_Q },
      { slot: 2, predicate: "Saturday hours", value: "09:00–14:00", validFrom: "2026-01-01T00:00:00.000Z", question: HOURS_Q },
      { slot: 3, predicate: "Free trial", value: "14 days", validFrom: "2026-01-01T00:00:00.000Z", question: "y?" },
    ])
    const runTargeted = async (kind: "INITIAL" | "FOLLOW_UP", at: string, texts: [string, string]) => {
      const run = await runFx(Effect.flatMap(RecordRepository, r => r.startRun(session, targeted,
        { kind: kind === "INITIAL" ? null : "FOLLOW_UP", provider: "gemini", requestedModel: MODEL, samples: 1 })))
      for (const { check, slot } of await slotOf(targeted, run.id)) {
        const text = slot === 1 ? texts[0] : slot === 2 ? texts[1] : "TEST agreed answer."
        const obs = await answer(targeted, check.id, text, at)
        await judge(session, targeted, obs.id, slot === 3 ? "MATCHES" : kind === "INITIAL" ? "CONTRADICTS" : "MATCHES")
      }
    }
    await runTargeted("INITIAL", "2026-10-01T10:00:00.000Z", ["It costs $49 per month.", "Closed on Saturdays."])
    // Only Fact A gets a targeted action. Fact B's contradiction is on its own.
    await runFx(Effect.flatMap(RecordRepository, r => r.recordAction(session, targeted,
      { slot: 1, type: "SOURCE_UPDATED", note: "Updated pricing page.", links: [], performedAt: "2026-10-04T12:00:00.000Z" })))
    await runTargeted("FOLLOW_UP", "2026-10-08T10:00:00.000Z", ["It costs $79 per month.", "Open Saturdays 09:00–14:00."])
    const page = publicRecord(await snapshot(targeted))
    expect(page.facts[0]!.comparison).toMatchObject({ outcome: "OBSERVED_CORRECTED" })
    // Fact B also matches now — independently. The pricing action must not
    // give OpenRecord attribution for Fact B.
    expect(page.facts[1]!.comparison).toMatchObject({ outcome: "RESOLVED_EXTERNALLY" })
    expect(page.facts[1]!.comparison!.actions).toEqual([])

    // Record-level action alone + disappearance = RESOLVED_EXTERNALLY, never corrected.
    const businessId = await client(session, "TEST Record Level", [
      { slot: 1, predicate: "Monthly price", value: "$79", valueType: "CURRENCY", validFrom: "2026-07-01T00:00:00.000Z", question: PRICE_Q },
      { slot: 2, predicate: "Saturday hours", value: "09:00–14:00", validFrom: "2026-01-01T00:00:00.000Z", question: HOURS_Q },
      { slot: 3, predicate: "Free trial", value: "14 days", validFrom: "2026-01-01T00:00:00.000Z", question: "y?" },
    ])
    for (const [kind, at] of [["INITIAL", "2026-10-01T10:00:00.000Z"], ["FOLLOW_UP", "2026-10-08T10:00:00.000Z"]] as const) {
      const run = await runFx(Effect.flatMap(RecordRepository, r => r.startRun(session, businessId,
        { kind: kind === "INITIAL" ? null : "FOLLOW_UP", provider: "gemini", requestedModel: MODEL, samples: 1 })))
      for (const { check, slot } of await slotOf(businessId, run.id)) {
        const text = slot === 1
          ? kind === "INITIAL" ? "It costs $49 per month." : "It costs $79 per month."
          : slot === 2 ? (kind === "INITIAL" ? "Closed on Saturdays." : "Open Saturdays 09:00–14:00.") : "TEST agreed answer."
        const obs = await answer(businessId, check.id, text, at)
        await judge(session, businessId, obs.id, slot === 3 ? "MATCHES" : kind === "INITIAL" ? "CONTRADICTS" : "MATCHES")
      }
      if (kind === "INITIAL") {
        await runFx(Effect.flatMap(RecordRepository, r => r.recordAction(session, businessId,
          { slot: null, type: "SOURCE_UPDATED", note: "General website refresh.", links: [], performedAt: "2026-10-04T12:00:00.000Z" })))
      }
    }
    const general = publicRecord(await snapshot(businessId))
    for (const fact of [general.facts[0]!, general.facts[1]!]) {
      expect(fact.comparison).toMatchObject({ outcome: "RESOLVED_EXTERNALLY" })
      // Still visible in the overall history — just not attributing.
      expect(fact.comparison!.actions).toEqual([{ performedAt: "2026-10-04T12:00:00.000Z", note: "General website refresh.", links: [] }])
    }
  })

  it("invariants: history, immutability, tenancy, sampling policy and evidence-backed counts", async () => {
    const session = await agency()
    const other = await agency()
    const businessId = await client(session, "TEST Invariants", [
      { slot: 1, predicate: "Monthly price", value: "$79", valueType: "CURRENCY", validFrom: "2026-07-01T00:00:00.000Z", question: PRICE_Q },
      { slot: 2, predicate: "Support hours", value: "09:00-17:00", validFrom: "2026-01-01T00:00:00.000Z", question: "x?" },
      { slot: 3, predicate: "Free trial", value: "14 days", validFrom: "2026-01-01T00:00:00.000Z", question: "y?" },
    ])
    // A fact edit creates history: SUPERSEDED v1 plus ACTIVE v2, never a rewrite.
    const heads = (await snapshot(businessId)).items.filter(i => !i.superseded)
    const changed = await runFx(Effect.flatMap(RecordRepository, r => r.saveSlot(session, businessId, {
      slot: 1, subject: "TEST Invariants", predicate: "Monthly price", valueText: "$99", valueType: "CURRENCY",
      validFrom: "2026-07-01T00:00:00.000Z", validUntil: null, sourceUrl: "https://client.test/facts", question: PRICE_Q,
    })))
    expect(changed.fact.version).toBe(2)
    const versions = (await pool.query(`SELECT version, status FROM authoritative_facts WHERE business_id=$1 AND subject='TEST Invariants' AND predicate='Monthly price' ORDER BY version`,
      [businessId])).rows
    expect(versions).toMatchObject([{ version: 1, status: "SUPERSEDED" }, { version: 2, status: "ACTIVE" }])
    expect(heads.find(i => i.slot === 1)!.fact.id).not.toBe(changed.fact.id)
    // Tracked fact content is immutable in place.
    await expect(pool.query(`UPDATE authoritative_facts SET value_text='rewritten' WHERE id=$1`, [changed.fact.id])).rejects.toThrow(/immutable/)
    // Absurd sample counts are refused before any run starts.
    const badRange = await Effect.runPromiseExit(Effect.flatMap(RecordRepository, r => r.startRun(session, businessId,
      { kind: null, provider: "gemini", requestedModel: MODEL, samples: 9 })).pipe(Effect.provide(ctx)))
    expect(badRange._tag).toBe("Failure")
    // Sampling policy: follow-ups reuse the baseline count.
    await runFx(Effect.flatMap(RecordRepository, r => r.approveItem(session, businessId, changed.id)))
    const run1 = await runFx(Effect.flatMap(RecordRepository, r => r.startRun(session, businessId,
      { kind: null, provider: "gemini", requestedModel: MODEL, samples: 3 })))
    expect(run1.sampleCount).toBe(3)
    // Answer and review every check of the run.
    for (const { check, slot } of await slotOf(businessId, run1.id)) {
      const obs = await answer(businessId, check.id, slot === 1 ? "It costs $99 per month." : "TEST agreed answer.", "2026-10-01T10:00:00.000Z")
      await judge(session, businessId, obs.id, "MATCHES")
    }
    const badSamples = await Effect.runPromiseExit(Effect.flatMap(RecordRepository, r => r.startRun(session, businessId,
      { kind: "FOLLOW_UP", provider: "gemini", requestedModel: MODEL, samples: 2 })).pipe(Effect.provide(ctx)))
    expect(badSamples._tag).toBe("Failure")
    // Claims and judgments are append-only; raw observations cannot be mutated.
    const s1 = await snapshot(businessId)
    const checkRow = s1.checks.find(c => c.runId === run1.id && s1.items.find(i => i.id === c.itemId)!.slot === 1)!
    const obsId = checkRow.observation!.id
    await expect(pool.query(`UPDATE observations SET answer_text='rewritten' WHERE id=$1`, [obsId])).rejects.toThrow()
    const withClaim = await judge(session, businessId, obsId, "MATCHES", { text: "$99 per month", span: "$99 per month" })
    expect(withClaim.claimId).not.toBeNull()
    await expect(pool.query(`UPDATE record_claims SET claim_text='rewritten' WHERE id=$1`, [withClaim.claimId])).rejects.toThrow(/append-only/)
    await expect(pool.query(`DELETE FROM record_claims WHERE id=$1`, [withClaim.claimId])).rejects.toThrow(/append-only/)
    await expect(pool.query(`DELETE FROM record_judgments WHERE business_id=$1`, [businessId])).rejects.toThrow(/append-only/)
    // A claim span must occur verbatim in the observed answer — no fake certainty.
    const badSpan = await Effect.runPromiseExit(Effect.flatMap(RecordRepository, r => r.judge(session, businessId,
      { observationId: obsId, decision: "MATCHES", note: null, claim: { text: "invented", span: "invented span" } })).pipe(Effect.provide(ctx)))
    expect(badSpan._tag).toBe("Failure")
    // Cross-tenant review fails closed.
    const crossBusiness = await client(other, "TEST Other", [
      { slot: 1, predicate: "Other fact", value: "x", validFrom: "2026-01-01T00:00:00.000Z", question: "Other?" },
      { slot: 2, predicate: "Other fact 2", value: "x", validFrom: "2026-01-01T00:00:00.000Z", question: "Other 2?" },
      { slot: 3, predicate: "Other fact 3", value: "x", validFrom: "2026-01-01T00:00:00.000Z", question: "Other 3?" },
    ])
    const cross = await Effect.runPromiseExit(Effect.flatMap(RecordRepository, r => r.judge(other, crossBusiness,
      { observationId: obsId, decision: "MATCHES", note: null })).pipe(Effect.provide(ctx)))
    expect(cross._tag).toBe("Failure")
    // Every client-facing count reconstructs from stored rows.
    const stored = (await pool.query(
      `SELECT j.decision, count(*)::int n FROM record_judgments j JOIN observations o ON o.id=j.observation_id
       JOIN check_runs c ON c.id=o.check_run_id WHERE c.record_run_id=$1 AND NOT EXISTS (SELECT 1 FROM record_judgments n WHERE n.supersedes_id=j.id)
       GROUP BY j.decision`, [run1.id])).rows as Array<{ decision: string; n: number }>
    const byDecision = new Map(stored.map(r => [r.decision, r.n]))
    const total = (await pool.query(`SELECT count(*)::int n FROM check_runs WHERE record_run_id=$1`, [run1.id])).rows[0].n as number
    expect(total).toBe(9)
    expect(byDecision.get("MATCHES")).toBe(9)
  })

  it("adversarial: truth drift, fake review, fake correction and provider substitution all fail closed", async () => {
    const session = await agency()
    const businessId = await client(session, "TEST Adversarial", [
      { slot: 1, predicate: "Monthly price", value: "$79", valueType: "CURRENCY", validFrom: "2026-07-01T00:00:00.000Z", question: PRICE_Q },
      { slot: 2, predicate: "Support hours", value: "09:00-17:00", validFrom: "2026-01-01T00:00:00.000Z", question: "x?" },
      { slot: 3, predicate: "Free trial", value: "14 days", validFrom: "2026-01-01T00:00:00.000Z", question: "y?" },
    ])
    const run = await runFx(Effect.flatMap(RecordRepository, r => r.startRun(session, businessId, { kind: null, provider: "gemini", requestedModel: MODEL, samples: 1 })))
    for (const { check, slot } of await slotOf(businessId, run.id)) {
      const o = await answer(businessId, check.id, slot === 1 ? "It costs $49 per month." : "TEST agreed answer.", "2026-10-01T10:00:00.000Z")
      if (slot !== 1) await judge(session, businessId, o.id, "MATCHES")
    }
    const target = (await slotOf(businessId, run.id)).find(x => x.slot === 1)!.check
    const obs = (await snapshot(businessId)).checks.find(c => c.id === target.id)!.observation!
    // Truth drift: a judgment pinned to a fact version that was not valid
    // when observed is refused, even by direct SQL.
    await expect(pool.query(
      `INSERT INTO record_judgments (business_id, observation_id, item_id, decision, fact_id, fact_version, reviewed_by_user_id)
       SELECT $1, $2, record_item_id, 'MATCHES', $3, 99, $4 FROM check_runs WHERE id=$5`,
      [businessId, obs.id, target.itemId, session.userId, target.id])).rejects.toThrow(/slot fact version/)
    // Fake human review: no worker, seed or script identity can review —
    // only an account member, at server time, through the guarded path.
    const outsider = await agency()
    await expect(pool.query(
      `INSERT INTO record_judgments (business_id, observation_id, item_id, decision, fact_id, fact_version, reviewed_by_user_id)
       SELECT c.business_id, $1, c.record_item_id, 'MATCHES', i.fact_id, f.version, $2 FROM check_runs c
       JOIN record_items i ON i.id=c.record_item_id JOIN authoritative_facts f ON f.id=i.fact_id WHERE c.id=$3`,
      [obs.id, outsider.userId, target.id])).rejects.toThrow(/account user/)
    await judge(session, businessId, obs.id, "CONTRADICTS")
    // Fake correction: OBSERVED_CORRECTED needs a reviewed MATCHES follow-up;
    // an unreviewed follow-up stays private and derives nothing.
    const run2 = await runFx(Effect.flatMap(RecordRepository, r => r.startRun(session, businessId, { kind: "FOLLOW_UP", provider: "gemini", requestedModel: MODEL, samples: 1 })))
    for (const { check, slot } of await slotOf(businessId, run2.id)) {
      const o = await answer(businessId, check.id, slot === 1 ? "It costs $79 per month." : "TEST agreed answer.", "2026-10-08T10:00:00.000Z")
      if (slot !== 1) await judge(session, businessId, o.id, "MATCHES")
    }
    const privatePage = publicRecord(await snapshot(businessId))
    expect(privatePage.facts[0]!.comparison).toBeNull()
    expect(operatorView(await snapshot(businessId)).slots.find(x => x.slot === 1)!.comparison).toMatchObject({ state: "AWAITING_REVIEW" })
    const followId = (await slotOf(businessId, run2.id)).find(x => x.slot === 1)!.check.id
    await judge(session, businessId, (await snapshot(businessId)).checks.find(c => c.id === followId)!.observation!.id, "MATCHES")
    // Provider substitution: a follow-up on a different model is not
    // comparable — INDETERMINATE, never a correction.
    const run3 = await runFx(Effect.flatMap(RecordRepository, r => r.startRun(session, businessId, { kind: "FOLLOW_UP", provider: "gemini", requestedModel: "gemini-2.5-pro", samples: 1 })))
    expect(run3.requestedModel).toBe("gemini-2.5-pro")
    const sub = (await slotOf(businessId, run3.id)).find(x => x.slot === 1)!.check
    const subObs = await answer(businessId, sub.id, "It costs $79 per month.", "2026-10-09T10:00:00.000Z", [], "gemini-2.5-pro")
    await judge(session, businessId, subObs.id, "MATCHES")
    expect(operatorView(await snapshot(businessId)).slots.find(x => x.slot === 1)!.comparison).toMatchObject({
      state: "DERIVED", outcome: "INDETERMINATE", reason: "SURFACE_CHANGED",
    })
  })
})
