// AI Acquisition persistence (migration 0026). Account = agency, Business =
// client. Writes are human acts attributed to the session user; the database
// re-checks membership, tenancy, frozen question sets and append-only
// history. Provider execution is the existing worker: a batch only queues
// ordinary check_runs bound to (batch, question, sample). Reads return the
// stored evidence; candidates, metrics and the report are derived by
// acquisition-view.ts on every request.
import { Context, Data, Effect, Layer, Schema } from "effect"
import { PgClient } from "@effect/sql-pg"
import type { SqlError } from "@effect/sql/SqlError"
import type { Session } from "./auth.js"
import { decodeRow, iso, type RowDecodeError } from "./row-codecs.js"
import { DETECTOR_VERSION, brandTerms, detectMentions, normalizeDomain, type BrandSpec } from "./acquisition-detect.js"
import { parseGa4Export, sha256Hex, type Ga4ImportMeta } from "./acquisition-ga4.js"

export const ACQ_INTENT_GROUPS = ["CATEGORY_DISCOVERY", "PROBLEM_SOLVING", "ALTERNATIVES", "INTEGRATION_NEEDS", "PURCHASE_EVALUATION"] as const
export type AcqIntentGroup = (typeof ACQ_INTENT_GROUPS)[number]
export const ACQ_GROUP_PREFIX: Record<AcqIntentGroup, string> = {
  CATEGORY_DISCOVERY: "CD", PROBLEM_SOLVING: "PS", ALTERNATIVES: "AL", INTEGRATION_NEEDS: "IN", PURCHASE_EVALUATION: "PE",
}
export type AcqBasis = "AUTHORIZED_CLIENT" | "PUBLIC_RESEARCH" | "FIXTURE"
export type AcqMention = "MENTIONED" | "NOT_MENTIONED" | "UNCLEAR"
export type AcqRecommendation = "RECOMMENDED" | "MENTIONED_NOT_RECOMMENDED" | "ADVISED_AGAINST" | "UNCLEAR"
/** Must equal the worker's MAX_PROVIDER_ATTEMPTS (asserted by a worker test). */
export const ACQ_MAX_ATTEMPTS_PER_CHECK = 4
export const ACQ_SAMPLES_MAX = 5
export const ACQ_QUESTIONS_MAX = 60
export const ACQ_SMOKE_QUESTIONS_MAX = 10

/** A business rule refused the request; `reason` is a stable machine code. */
export class AcquisitionRefused extends Data.TaggedError("AcquisitionRefused")<{ readonly reason: string; readonly line?: number | null }> {}
type AcqEffect<A> = Effect.Effect<A, SqlError | RowDecodeError | AcquisitionRefused>

const Ts = Schema.Union(Schema.instanceOf(Date), Schema.String)
const Str = Schema.String
const NullableStr = Schema.NullOr(Schema.String)
const BrandJson = Schema.Struct({ name: Str, aliases: Schema.Array(Str), domains: Schema.Array(Str), matchCase: Schema.Boolean, ambiguity: NullableStr })

const SetSchema = Schema.Struct({
  id: Schema.UUID, version: Schema.Number, basis: Schema.Literal("AUTHORIZED_CLIENT", "PUBLIC_RESEARCH", "FIXTURE"), category: Str,
  brand_name: Str, brand_aliases: Schema.Array(Str), brand_match_case: Schema.Boolean, brand_ambiguity: NullableStr,
  owned_domains: Schema.Array(Str), competitors: Schema.Array(BrandJson), spec_digest: Str, created_at: Ts,
  questions: Schema.Array(Schema.Struct({ id: Schema.UUID, question_key: Str, intent_group: Schema.Literal(...ACQ_INTENT_GROUPS), position: Schema.Number,
    buyer_question_id: Schema.UUID, prompt: Str, created_at: Ts })),
})
const BatchSchema = Schema.Struct({
  id: Schema.UUID, set_id: Schema.UUID, scope: Schema.Literal("SMOKE", "FULL"), question_count: Schema.Number, sample_count: Schema.Number,
  provider: Str, requested_model: NullableStr, retrieval_requested: Schema.Boolean, max_provider_calls: Schema.Number, created_at: Ts,
})
const JudgmentSchema = Schema.Struct({
  id: Schema.UUID, mention: Schema.Literal("MENTIONED", "NOT_MENTIONED", "UNCLEAR"),
  recommendation: Schema.NullOr(Schema.Literal("RECOMMENDED", "MENTIONED_NOT_RECOMMENDED", "ADVISED_AGAINST", "UNCLEAR")),
  detector_version: Str, candidate_count: Schema.Number, note: NullableStr, supersedes_id: Schema.NullOr(Schema.UUID),
  reviewed_by_user_id: Schema.UUID, reviewed_at: Ts,
})
const CheckSchema = Schema.Struct({
  id: Schema.UUID, acq_batch_id: Schema.UUID, acq_question_id: Schema.UUID, acq_sample: Schema.Number,
  status: Schema.Literal("QUEUED", "RUNNING", "SUCCEEDED", "FAILED"), failure_class: NullableStr, failure_detail_safe: NullableStr,
  attempt_count: Schema.Number, queued_at: Ts, completed_at: Schema.NullOr(Ts),
  observation: Schema.NullOr(Schema.Struct({
    id: Schema.UUID, provider: Str, requested_model: NullableStr, observed_model: NullableStr, collected_at: Ts, answer_text: Str,
    retrieval_mode: Str, retrieval_tool: NullableStr, request_parameters: Schema.Unknown, raw_digest: Str, synthetic: Schema.Boolean,
    provider_metadata: Schema.Unknown,
  })),
  citations: Schema.Array(Schema.Struct({ uri: NullableStr, title: NullableStr, position: Schema.NullOr(Schema.Number), attributed: Schema.Boolean })),
  judgments: Schema.Array(JudgmentSchema),
})
const ImportSchema = Schema.Struct({
  id: Schema.UUID, data_origin: Schema.Literal("GA4_EXPORT", "SYNTHETIC_FIXTURE"), property_ref: Str, date_start: Str, date_end: Str,
  time_zone: Str, attribution_basis: Schema.Literal("SESSION_SOURCE_MEDIUM"), conversion_event: NullableStr, raw_digest: Str,
  row_count: Schema.Number, imported_at: Ts,
  rows: Schema.Array(Schema.Struct({ row_number: Schema.Number, day: Str, session_source: Str, session_medium: Str, sessions: Schema.Number,
    conversions: Schema.NullOr(Schema.Number) })),
})

export interface AcqQuestion { readonly id: string; readonly key: string; readonly group: AcqIntentGroup; readonly position: number; readonly buyerQuestionId: string; readonly prompt: string; readonly createdAt: string }
export interface AcqQuestionSet {
  readonly id: string
  readonly version: number
  readonly basis: AcqBasis
  readonly category: string
  readonly target: BrandSpec
  readonly competitors: ReadonlyArray<BrandSpec>
  readonly specDigest: string
  readonly createdAt: string
  readonly questions: ReadonlyArray<AcqQuestion>
}
export interface AcqBatch {
  readonly id: string; readonly setId: string; readonly scope: "SMOKE" | "FULL"; readonly questionCount: number; readonly sampleCount: number
  readonly provider: string; readonly requestedModel: string | null; readonly retrievalRequested: boolean; readonly maxProviderCalls: number; readonly createdAt: string
}
export interface AcqJudgment {
  readonly id: string; readonly mention: AcqMention; readonly recommendation: AcqRecommendation | null; readonly detectorVersion: string
  readonly candidateCount: number; readonly note: string | null; readonly supersedesId: string | null; readonly reviewedByUserId: string; readonly reviewedAt: string
}
export interface AcqObservation {
  readonly id: string; readonly provider: string; readonly requestedModel: string | null; readonly observedModel: string | null; readonly collectedAt: string
  readonly answerText: string; readonly retrievalMode: string; readonly retrievalTool: string | null; readonly requestParameters: unknown
  readonly rawDigest: string; readonly synthetic: boolean; readonly providerMetadata: unknown
  readonly citations: ReadonlyArray<{ readonly uri: string | null; readonly title: string | null; readonly position: number | null; readonly attributed: boolean }>
}
export interface AcqCheck {
  readonly id: string; readonly batchId: string; readonly questionId: string; readonly sample: number
  readonly status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED"; readonly failureClass: string | null; readonly failureDetailSafe: string | null
  readonly attempts: number; readonly queuedAt: string; readonly completedAt: string | null
  readonly observation: AcqObservation | null; readonly judgments: ReadonlyArray<AcqJudgment>
}
export interface AcqReferralImport {
  readonly id: string; readonly dataOrigin: "GA4_EXPORT" | "SYNTHETIC_FIXTURE"; readonly propertyRef: string; readonly dateStart: string; readonly dateEnd: string
  readonly timeZone: string; readonly attributionBasis: "SESSION_SOURCE_MEDIUM"; readonly conversionEvent: string | null; readonly rawDigest: string
  readonly rowCount: number; readonly importedAt: string
  readonly rows: ReadonlyArray<{ readonly day: string; readonly sessionSource: string; readonly sessionMedium: string; readonly sessions: number; readonly conversions: number | null }>
}
export interface AcqSnapshot {
  readonly profile: { readonly businessId: string; readonly name: string; readonly websiteUrl: string; readonly engagement: string }
  readonly sets: ReadonlyArray<AcqQuestionSet>
  readonly batches: ReadonlyArray<AcqBatch>
  readonly checks: ReadonlyArray<AcqCheck>
  readonly imports: ReadonlyArray<AcqReferralImport>
}

export interface CreateSetInput {
  readonly basis: AcqBasis
  readonly category: string
  readonly target: BrandSpec
  readonly competitors: ReadonlyArray<BrandSpec>
  readonly questions: ReadonlyArray<{ readonly group: AcqIntentGroup; readonly prompt: string }>
}
export interface StartBatchInput {
  readonly setId: string
  readonly scope: "SMOKE" | "FULL"
  readonly questionKeys: ReadonlyArray<string> | null
  readonly samples: number
  readonly provider: string
  readonly requestedModel: string | null
  /** Must equal planned checks x ACQ_MAX_ATTEMPTS_PER_CHECK. */
  readonly acknowledgedMaxProviderCalls: number
}
export interface AcqJudgeInput { readonly observationId: string; readonly mention: AcqMention; readonly recommendation: AcqRecommendation | null; readonly note: string | null }

export class AcquisitionRepository extends Context.Tag("AcquisitionRepository")<AcquisitionRepository, {
  readonly createQuestionSet: (session: Session, businessId: string, input: CreateSetInput) => AcqEffect<AcqQuestionSet>
  readonly startBatch: (session: Session, businessId: string, input: StartBatchInput) => AcqEffect<AcqBatch>
  readonly judge: (session: Session, businessId: string, input: AcqJudgeInput) => AcqEffect<AcqJudgment>
  readonly importReferrals: (session: Session, businessId: string, meta: Ga4ImportMeta, text: string) => AcqEffect<{ readonly importId: string; readonly duplicate: boolean }>
  /** null when the business has no client record profile. */
  readonly snapshot: (businessId: string) => AcqEffect<AcqSnapshot | null>
}>() {}

/** Normalized, validated brand configuration, or a refusal reason. */
export const normalizeSetInput = (input: CreateSetInput): { ok: true; value: CreateSetInput } | { ok: false; reason: string } => {
  const brand = (b: BrandSpec): BrandSpec | null => {
    const name = b.name.trim()
    const aliases = [...new Set(b.aliases.map(a => a.trim()).filter(a => a && a !== name))]
    const domains = b.domains.map(normalizeDomain)
    if (!name || name.length > 120 || aliases.length > 20 || aliases.some(a => a.length > 120) || domains.some(d => d === null) || domains.length > 10) return null
    const ambiguity = b.ambiguity?.trim() ? b.ambiguity.trim().slice(0, 300) : null
    return { name, aliases, domains: [...new Set(domains as string[])], matchCase: b.matchCase, ambiguity }
  }
  const target = brand(input.target)
  if (!target || target.domains.length === 0) return { ok: false, reason: "InvalidBrand" }
  const competitors: BrandSpec[] = []
  for (const c of input.competitors) {
    const n = brand(c)
    if (!n) return { ok: false, reason: "InvalidCompetitor" }
    competitors.push(n)
  }
  if (competitors.length > 15) return { ok: false, reason: "TooManyCompetitors" }
  // One term, one brand: a shared alias would make every mention a collision.
  const owner = new Map<string, string>()
  for (const b of [target, ...competitors]) {
    for (const t of brandTerms(b)) {
      const k = t.toLowerCase()
      if (owner.has(k) && owner.get(k) !== b.name) return { ok: false, reason: "AliasCollision" }
      owner.set(k, b.name)
    }
  }
  const domainOwner = new Map<string, string>()
  for (const b of [target, ...competitors]) for (const d of b.domains) {
    if (domainOwner.has(d) && domainOwner.get(d) !== b.name) return { ok: false, reason: "DomainCollision" }
    domainOwner.set(d, b.name)
  }
  const category = input.category.trim()
  if (!category || category.length > 200) return { ok: false, reason: "InvalidCategory" }
  const questions = input.questions.map(q => ({ group: q.group, prompt: q.prompt.trim() }))
  if (questions.length < 1 || questions.length > ACQ_QUESTIONS_MAX) return { ok: false, reason: "InvalidQuestionCount" }
  if (questions.some(q => !q.prompt || q.prompt.length > 500 || !ACQ_INTENT_GROUPS.includes(q.group))) return { ok: false, reason: "InvalidQuestion" }
  if (new Set(questions.map(q => q.prompt.toLowerCase())).size !== questions.length) return { ok: false, reason: "DuplicateQuestion" }
  return { ok: true, value: { basis: input.basis, category, target, competitors, questions } }
}

/** Frozen keys in group order: CD-01.., PS-01.., AL-01.., IN-01.., PE-01.. */
export const keyQuestions = (questions: CreateSetInput["questions"]) => {
  const ordered = ACQ_INTENT_GROUPS.flatMap(g => questions.filter(q => q.group === g))
  const counters = new Map<AcqIntentGroup, number>()
  return ordered.map((q, i) => {
    const n = (counters.get(q.group) ?? 0) + 1
    counters.set(q.group, n)
    return { ...q, key: `${ACQ_GROUP_PREFIX[q.group]}-${String(n).padStart(2, "0")}`, position: i + 1 }
  })
}

/** sha256 over the canonical specification: brand configuration + exact keyed questions. */
export const specDigest = (input: CreateSetInput): string => sha256Hex(JSON.stringify({
  basis: input.basis, category: input.category,
  target: input.target, competitors: input.competitors,
  questions: keyQuestions(input.questions).map(q => ({ key: q.key, group: q.group, prompt: q.prompt })),
}))

const toSet = (s: typeof SetSchema.Type): AcqQuestionSet => ({
  id: s.id, version: s.version, basis: s.basis, category: s.category, specDigest: s.spec_digest, createdAt: iso(s.created_at),
  target: { name: s.brand_name, aliases: s.brand_aliases, domains: s.owned_domains, matchCase: s.brand_match_case, ambiguity: s.brand_ambiguity },
  competitors: s.competitors,
  questions: s.questions.map(q => ({ id: q.id, key: q.question_key, group: q.intent_group, position: q.position, buyerQuestionId: q.buyer_question_id,
    prompt: q.prompt, createdAt: iso(q.created_at) })),
})
const toBatch = (b: typeof BatchSchema.Type): AcqBatch => ({ id: b.id, setId: b.set_id, scope: b.scope, questionCount: b.question_count,
  sampleCount: b.sample_count, provider: b.provider, requestedModel: b.requested_model, retrievalRequested: b.retrieval_requested,
  maxProviderCalls: b.max_provider_calls, createdAt: iso(b.created_at) })
const toJudgment = (j: typeof JudgmentSchema.Type): AcqJudgment => ({ id: j.id, mention: j.mention, recommendation: j.recommendation,
  detectorVersion: j.detector_version, candidateCount: j.candidate_count, note: j.note, supersedesId: j.supersedes_id,
  reviewedByUserId: j.reviewed_by_user_id, reviewedAt: iso(j.reviewed_at) })

export const AcquisitionRepositoryLive = Layer.effect(AcquisitionRepository, Effect.map(PgClient.PgClient, sql => {
  const refuse = (reason: string, line: number | null = null) => Effect.fail(new AcquisitionRefused({ reason, line }))
  /** Serializes structural writes of one client (shared with the record). */
  const lockClient = (businessId: string) => sql`SELECT business_id FROM record_profiles WHERE business_id = ${businessId} FOR UPDATE`.pipe(
    Effect.flatMap(rows => rows.length === 1 ? Effect.void : refuse("ClientNotFound")))
  const setsQuery = (businessId: string, setId: string | null = null) => sql`
    SELECT s.id, s.version, s.basis, s.category, s.brand_name, s.brand_aliases, s.brand_match_case, s.brand_ambiguity, s.owned_domains,
      s.competitors, s.spec_digest, s.created_at,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('id', q.id, 'question_key', q.question_key, 'intent_group', q.intent_group, 'position', q.position,
        'buyer_question_id', q.buyer_question_id, 'prompt', bq.prompt, 'created_at', q.created_at) ORDER BY q.position)
        FROM acq_questions q JOIN buyer_questions bq ON bq.id = q.buyer_question_id AND bq.business_id = q.business_id
        WHERE q.set_id = s.id), '[]'::jsonb) AS questions
    FROM acq_question_sets s WHERE s.business_id = ${businessId} AND (${setId}::uuid IS NULL OR s.id = ${setId}::uuid)
    ORDER BY s.version`.pipe(Effect.flatMap(rows => Effect.forEach(rows, r => decodeRow(SetSchema, "acq_question_sets", r).pipe(Effect.map(toSet)))))

  return {
    createQuestionSet: (session, businessId, raw) => Effect.gen(function*() {
      const normalized = normalizeSetInput(raw)
      if (!normalized.ok) return yield* refuse(normalized.reason)
      const input = normalized.value
      yield* lockClient(businessId)
      const versionRows = yield* sql`SELECT COALESCE(max(version), 0) + 1 AS v FROM acq_question_sets WHERE business_id = ${businessId}`
      const version = Number(versionRows[0]!["v"])
      const inserted = yield* sql`INSERT INTO acq_question_sets (business_id, version, basis, category, brand_name, brand_aliases, brand_match_case,
          brand_ambiguity, owned_domains, competitors, spec_digest, created_by_user_id)
        VALUES (${businessId}, ${version}, ${input.basis}, ${input.category}, ${input.target.name}, ${JSON.stringify(input.target.aliases)}::jsonb,
          ${input.target.matchCase}, ${input.target.ambiguity}, ${JSON.stringify(input.target.domains)}::jsonb, ${JSON.stringify(input.competitors)}::jsonb,
          ${specDigest(input)}, ${session.userId}) RETURNING id`
      const setId = String(inserted[0]!["id"])
      for (const q of keyQuestions(input.questions)) {
        // A fresh buyer question per frozen question: the worker asks exactly this prompt.
        const bq = yield* sql`INSERT INTO buyer_questions (business_id, label, prompt, origin) VALUES (${businessId}, ${`AI Discovery v${version} ${q.key}`}, ${q.prompt}, 'OPERATOR_CONSTRUCTED') RETURNING id`
        yield* sql`INSERT INTO acq_questions (business_id, set_id, question_key, intent_group, position, buyer_question_id)
          VALUES (${businessId}, ${setId}, ${q.key}, ${q.group}, ${q.position}, ${String(bq[0]!["id"])})`
      }
      return (yield* setsQuery(businessId, setId))[0]!
    }).pipe(sql.withTransaction),

    startBatch: (session, businessId, input) => Effect.gen(function*() {
      yield* lockClient(businessId)
      const set = (yield* setsQuery(businessId, input.setId))[0]
      if (!set) return yield* refuse("QuestionSetNotFound")
      const active = yield* sql`SELECT 1 FROM check_runs WHERE business_id = ${businessId} AND acq_batch_id IS NOT NULL AND status IN ('QUEUED','RUNNING') LIMIT 1`
      if (active.length > 0) return yield* refuse("BatchInProgress")
      if (!Number.isInteger(input.samples) || input.samples < 1 || input.samples > ACQ_SAMPLES_MAX) return yield* refuse("InvalidSamples")
      let questions = set.questions
      if (input.scope === "SMOKE") {
        const keys = [...new Set(input.questionKeys ?? [])]
        if (keys.length < 1 || keys.length > ACQ_SMOKE_QUESTIONS_MAX) return yield* refuse("InvalidSmokeScope")
        questions = set.questions.filter(q => keys.includes(q.key))
        if (questions.length !== keys.length) return yield* refuse("UnknownQuestionKey")
      } else if (input.questionKeys !== null && input.questionKeys.length > 0) return yield* refuse("InvalidFullScope")
      const planned = questions.length * input.samples
      const maxCalls = planned * ACQ_MAX_ATTEMPTS_PER_CHECK
      if (input.acknowledgedMaxProviderCalls !== maxCalls) return yield* refuse("SpendPlanNotAcknowledged")
      const rows = yield* sql`INSERT INTO acq_batches (business_id, set_id, scope, question_count, sample_count, provider, requested_model, max_provider_calls, requested_by_user_id)
        VALUES (${businessId}, ${set.id}, ${input.scope}, ${questions.length}, ${input.samples}, ${input.provider}, ${input.requestedModel}, ${maxCalls}, ${session.userId})
        RETURNING id, set_id, scope, question_count, sample_count, provider, requested_model, retrieval_requested, max_provider_calls, created_at`
      const batch = toBatch(yield* decodeRow(BatchSchema, "acq_batches", rows[0]))
      for (const q of questions) {
        for (let sample = 1; sample <= input.samples; sample++) {
          // clock_timestamp() (not the transaction's now()) gives each check a
          // distinct queue time, so the worker asks in frozen question order.
          yield* sql`INSERT INTO check_runs (business_id, question_id, provider, requested_model, acq_batch_id, acq_question_id, acq_sample, queued_at)
            VALUES (${businessId}, ${q.buyerQuestionId}, ${input.provider}, ${input.requestedModel}, ${batch.id}, ${q.id}, ${sample}, clock_timestamp())`
        }
      }
      return batch
    }).pipe(sql.withTransaction),

    judge: (session, businessId, input) => Effect.gen(function*() {
      if ((input.mention === "MENTIONED") !== (input.recommendation !== null)) return yield* refuse("InvalidJudgment")
      const found = yield* sql`SELECT c.acq_batch_id AS batch_id, o.answer_text, b.set_id FROM observations o
        JOIN check_runs c ON c.id = o.check_run_id AND c.business_id = o.business_id
        JOIN acq_batches b ON b.id = c.acq_batch_id AND b.business_id = c.business_id
        WHERE o.id = ${input.observationId} AND o.business_id = ${businessId} FOR UPDATE OF c`
      if (found.length !== 1) return yield* refuse("ObservationNotFound")
      const set = (yield* setsQuery(businessId, String(found[0]!["set_id"])))[0]!
      // Pin what the reviewer was shown: the server re-derives the candidates.
      const candidates = detectMentions(String(found[0]!["answer_text"]), set.target, set.competitors).filter(c => c.role === "TARGET").length
      const head = yield* sql`SELECT j.id FROM acq_judgments j WHERE j.observation_id = ${input.observationId}
        AND NOT EXISTS (SELECT 1 FROM acq_judgments n WHERE n.supersedes_id = j.id)`
      const rows = yield* sql`INSERT INTO acq_judgments (business_id, observation_id, batch_id, mention, recommendation, detector_version, candidate_count, note, supersedes_id, reviewed_by_user_id)
        VALUES (${businessId}, ${input.observationId}, ${String(found[0]!["batch_id"])}, ${input.mention}, ${input.recommendation}, ${DETECTOR_VERSION}, ${candidates},
          ${input.note}, ${head[0] ? String(head[0]["id"]) : null}, ${session.userId})
        RETURNING id, mention, recommendation, detector_version, candidate_count, note, supersedes_id, reviewed_by_user_id, reviewed_at`
      return toJudgment(yield* decodeRow(JudgmentSchema, "acq_judgments", rows[0]))
    }).pipe(sql.withTransaction),

    importReferrals: (session, businessId, meta, text) => Effect.gen(function*() {
      const parsed = parseGa4Export(text, meta)
      if (!parsed.ok) return yield* refuse(parsed.reason, parsed.line)
      yield* lockClient(businessId)
      const existing = yield* sql`SELECT id, data_origin, property_ref, date_start::text AS date_start, date_end::text AS date_end, time_zone, conversion_event
        FROM acq_referral_imports WHERE business_id = ${businessId} AND raw_digest = ${parsed.digest}`
      if (existing[0]) {
        const e = existing[0]
        const same = e["data_origin"] === meta.dataOrigin && e["property_ref"] === meta.propertyRef.trim() && e["date_start"] === meta.dateStart
          && e["date_end"] === meta.dateEnd && e["time_zone"] === meta.timeZone && (e["conversion_event"] ?? null) === meta.conversionEvent
        if (!same) return yield* refuse("DuplicateExportDifferentMetadata")
        return { importId: String(e["id"]), duplicate: true }
      }
      const inserted = yield* sql`INSERT INTO acq_referral_imports (business_id, data_origin, property_ref, date_start, date_end, time_zone, attribution_basis,
          conversion_event, raw_text, raw_digest, row_count, imported_by_user_id)
        VALUES (${businessId}, ${meta.dataOrigin}, ${meta.propertyRef.trim()}, ${meta.dateStart}::date, ${meta.dateEnd}::date, ${meta.timeZone}, ${meta.attributionBasis},
          ${meta.conversionEvent}, ${text}, ${parsed.digest}, ${parsed.rows.length}, ${session.userId}) RETURNING id`
      const importId = String(inserted[0]!["id"])
      for (const r of parsed.rows) {
        yield* sql`INSERT INTO acq_referral_rows (import_id, business_id, row_number, day, session_source, session_medium, sessions, conversions)
          VALUES (${importId}, ${businessId}, ${r.rowNumber}, ${r.day}::date, ${r.sessionSource}, ${r.sessionMedium}, ${r.sessions}, ${r.conversions})`
      }
      return { importId, duplicate: false }
    }).pipe(sql.withTransaction),

    snapshot: businessId => Effect.gen(function*() {
      yield* sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`
      const profile = yield* sql`SELECT p.business_id, b.name, p.website_url, p.engagement FROM record_profiles p JOIN businesses b ON b.id = p.business_id WHERE p.business_id = ${businessId}`
      if (!profile[0]) return null
      const sets = yield* setsQuery(businessId)
      const batches = yield* sql`SELECT id, set_id, scope, question_count, sample_count, provider, requested_model, retrieval_requested, max_provider_calls, created_at
        FROM acq_batches WHERE business_id = ${businessId} ORDER BY created_at, id`.pipe(
        Effect.flatMap(rows => Effect.forEach(rows, r => decodeRow(BatchSchema, "acq_batches", r).pipe(Effect.map(toBatch)))))
      const checks = yield* sql`
        SELECT c.id, c.acq_batch_id, c.acq_question_id, c.acq_sample, c.status, c.failure_class, c.failure_detail_safe, c.attempt_count, c.queued_at, c.completed_at,
          CASE WHEN o.id IS NULL THEN NULL ELSE jsonb_build_object(
            'id', o.id, 'provider', o.provider, 'requested_model', o.requested_model, 'observed_model', o.observed_model, 'collected_at', o.collected_at,
            'answer_text', o.answer_text, 'retrieval_mode', o.retrieval_mode, 'retrieval_tool', o.retrieval_tool, 'request_parameters', o.request_parameters,
            'raw_digest', o.raw_digest, 'synthetic', o.synthetic, 'provider_metadata', re.provider_metadata) END AS observation,
          COALESCE((SELECT jsonb_agg(jsonb_build_object('uri', ci.uri, 'title', ci.title, 'position', ci.position, 'attributed', ci.attributed) ORDER BY ci.position NULLS LAST, ci.id)
            FROM observation_citations ci WHERE ci.observation_id = o.id), '[]'::jsonb) AS citations,
          COALESCE((SELECT jsonb_agg(jsonb_build_object('id', j.id, 'mention', j.mention, 'recommendation', j.recommendation, 'detector_version', j.detector_version,
            'candidate_count', j.candidate_count, 'note', j.note, 'supersedes_id', j.supersedes_id, 'reviewed_by_user_id', j.reviewed_by_user_id,
            'reviewed_at', j.reviewed_at) ORDER BY j.reviewed_at, j.id)
            FROM acq_judgments j WHERE j.observation_id = o.id AND j.business_id = o.business_id), '[]'::jsonb) AS judgments
        FROM check_runs c
        LEFT JOIN observations o ON o.check_run_id = c.id AND o.business_id = c.business_id
        LEFT JOIN raw_evidence re ON re.id = o.raw_evidence_id
        JOIN acq_batches b ON b.id = c.acq_batch_id AND b.business_id = c.business_id
        JOIN acq_questions q ON q.id = c.acq_question_id AND q.business_id = c.business_id
        WHERE c.business_id = ${businessId} AND c.acq_batch_id IS NOT NULL
        ORDER BY b.created_at, b.id, q.position, c.acq_sample`.pipe(
        Effect.flatMap(rows => Effect.forEach(rows, r => decodeRow(CheckSchema, "acq_checks", r).pipe(Effect.map((c): AcqCheck => ({
          id: c.id, batchId: c.acq_batch_id, questionId: c.acq_question_id, sample: c.acq_sample, status: c.status, failureClass: c.failure_class,
          failureDetailSafe: c.failure_detail_safe, attempts: c.attempt_count, queuedAt: iso(c.queued_at), completedAt: c.completed_at === null ? null : iso(c.completed_at),
          observation: c.observation === null ? null : {
            id: c.observation.id, provider: c.observation.provider, requestedModel: c.observation.requested_model, observedModel: c.observation.observed_model,
            collectedAt: iso(c.observation.collected_at), answerText: c.observation.answer_text, retrievalMode: c.observation.retrieval_mode,
            retrievalTool: c.observation.retrieval_tool, requestParameters: c.observation.request_parameters, rawDigest: c.observation.raw_digest,
            synthetic: c.observation.synthetic, providerMetadata: c.observation.provider_metadata, citations: c.citations,
          },
          judgments: c.judgments.map(toJudgment),
        }))))))
      const imports = yield* sql`
        SELECT i.id, i.data_origin, i.property_ref, i.date_start::text AS date_start, i.date_end::text AS date_end, i.time_zone, i.attribution_basis,
          i.conversion_event, i.raw_digest, i.row_count, i.imported_at,
          COALESCE((SELECT jsonb_agg(jsonb_build_object('row_number', r.row_number, 'day', r.day::text, 'session_source', r.session_source,
            'session_medium', r.session_medium, 'sessions', r.sessions, 'conversions', r.conversions) ORDER BY r.row_number)
            FROM acq_referral_rows r WHERE r.import_id = i.id AND r.business_id = i.business_id), '[]'::jsonb) AS rows
        FROM acq_referral_imports i WHERE i.business_id = ${businessId} ORDER BY i.imported_at, i.id`.pipe(
        Effect.flatMap(rows => Effect.forEach(rows, r => decodeRow(ImportSchema, "acq_referral_imports", r).pipe(Effect.map((i): AcqReferralImport => ({
          id: i.id, dataOrigin: i.data_origin, propertyRef: i.property_ref, dateStart: i.date_start, dateEnd: i.date_end, timeZone: i.time_zone,
          attributionBasis: i.attribution_basis, conversionEvent: i.conversion_event, rawDigest: i.raw_digest, rowCount: i.row_count, importedAt: iso(i.imported_at),
          rows: i.rows.map(r => ({ day: r.day, sessionSource: r.session_source, sessionMedium: r.session_medium, sessions: r.sessions, conversions: r.conversions })),
        }))))))
      const p = profile[0]
      return {
        profile: { businessId: String(p["business_id"]), name: String(p["name"]), websiteUrl: String(p["website_url"]), engagement: String(p["engagement"]) },
        sets, batches, checks, imports,
      }
    }).pipe(sql.withTransaction),
  }
}))
