// W5 client report repository. A report is assembled from the W4 evaluation
// (the only outcome evaluator), the initiative and its human review, and the
// digests of the imports that cover the plan, all read inside one
// REPEATABLE READ transaction. Publication is explicit, idempotent per
// request key, optimistic on the latest version, and refused when the
// evidence moved since the operator's preview. Stored snapshots are
// append-only; shares are revocable capabilities per report version.
import { createHash, randomBytes } from "node:crypto"
import { Context, Effect, Layer, Schema } from "effect"
import { PgClient } from "@effect/sql-pg"
import type { SqlError } from "@effect/sql/SqlError"
import {
  canonicalJson, decodeRouteId, GROWTH_REPORT_SCHEMA, growthReportEvidenceView, GrowthReportPublishInput, publicGrowthReport,
  type GrowthReport, type GrowthReportImportRef, type GrowthReportPreview, type GrowthReportPublishResult, type GrowthReportReview,
  type GrowthReportShare, type GrowthReportSnapshot, type GrowthReportSummary, type PublicGrowthReport,
} from "@openrecord/contracts"
import { GrowthRefused, GrowthRepository } from "./growth.js"
import { GrowthEvaluationRepository } from "./growth-evaluation.js"
import { GrowthMeasurementRefused, type GrowthMeasurementEffect } from "./growth-measurement.js"
import { iso } from "./row-codecs.js"
import type { Session } from "./auth.js"

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex")
export const growthReportEvidenceDigest = (snapshot: GrowthReportSnapshot): string => sha256(canonicalJson(growthReportEvidenceView(snapshot)))
/** 32 random bytes, base64url: the only handle the public report page accepts. */
export const newGrowthReportPublicId = (): string => randomBytes(32).toString("base64url")
export const GROWTH_REPORT_PUBLIC_ID = /^[A-Za-z0-9_-]{43}$/
const SOURCE_LIMIT = 200

export class GrowthReportRepository extends Context.Tag("GrowthReportRepository")<GrowthReportRepository, {
  readonly preview: (accountId: string, businessId: string, opportunityId: string) => GrowthMeasurementEffect<GrowthReportPreview>
  readonly publish: (session: Session, businessId: string, opportunityId: string, input: PublishInput) => GrowthMeasurementEffect<GrowthReportPublishResult>
  readonly list: (accountId: string, businessId: string, opportunityId: string) => GrowthMeasurementEffect<ReadonlyArray<GrowthReportSummary>>
  readonly get: (accountId: string, businessId: string, reportId: string) => GrowthMeasurementEffect<GrowthReport>
  readonly share: (session: Session, businessId: string, reportId: string) => GrowthMeasurementEffect<GrowthReportShare>
  readonly revokeShare: (session: Session, businessId: string, reportId: string) => GrowthMeasurementEffect<void>
  /** Null for unknown and revoked links alike. */
  readonly publicReport: (publicId: string) => GrowthMeasurementEffect<PublicGrowthReport | null>
}>() {}

type PublishInput = typeof GrowthReportPublishInput.Type
const pgCode = (e: unknown): string | undefined => (e as { cause?: { code?: string } } | null)?.cause?.code

export const GrowthReportRepositoryLive = Layer.effect(GrowthReportRepository, Effect.gen(function*() {
  const sql = yield* PgClient.PgClient
  const growth = yield* GrowthRepository
  const evaluator = yield* GrowthEvaluationRepository
  const refuse = (reason: string) => Effect.fail(new GrowthMeasurementRefused({ reason }))
  const ids = (...values: ReadonlyArray<string>) => values.some(v => decodeRouteId(v)._tag === "Left") ? refuse("InvalidRequest") : Effect.void
  const scope = (accountId: string, businessId: string) => Effect.gen(function*() {
    const rows = yield* sql`SELECT b.id FROM businesses b JOIN record_profiles r ON r.business_id=b.id WHERE b.id=${businessId} AND b.account_id=${accountId}`
    if (!rows.length) return yield* refuse("GrowthNotFound")
  })
  const member = (session: Session, businessId: string) => Effect.gen(function*() {
    yield* scope(session.accountId, businessId)
    const rows = yield* sql`SELECT 1 FROM account_users WHERE account_id=${session.accountId} AND user_id=${session.userId}`
    if (!rows.length) return yield* refuse("GrowthNotFound")
  })

  /** Every read the snapshot needs. Callers run it inside one transaction. */
  const assemble = (accountId: string, businessId: string, opportunityId: string): GrowthMeasurementEffect<GrowthReportSnapshot> => Effect.gen(function*() {
    const evaluation = yield* evaluator.evaluate(accountId, businessId, opportunityId)
    const opportunity = yield* growth.get(accountId, businessId, opportunityId).pipe(
      Effect.catchIf((e): e is GrowthRefused => e instanceof GrowthRefused, e => refuse(e.reason)))
    const business = yield* sql`SELECT b.name, r.website_url FROM businesses b JOIN record_profiles r ON r.business_id=b.id WHERE b.id=${businessId}`
    if (!business[0]) return yield* refuse("GrowthNotFound")
    const reviewed = [...opportunity.events].reverse().find(e => e.status === "REVIEWED" && e.actor === "OPERATOR" && e.conclusion !== null)
    const review: GrowthReportReview | null = reviewed ? { conclusion: reviewed.conclusion!, reason: reviewed.reason, decidedAt: reviewed.createdAt } : null
    const plan = evaluation.plan
    const sourceRows = plan ? yield* sql`SELECT i.id, i.source_kind, i.provenance, i.date_start::text AS date_start, i.date_end::text AS date_end, i.row_count, i.raw_digest, i.imported_at,
          o.connection_id, o.binding_id, o.property, o.event_name, o.provider_metric, o.time_zone, o.requested_start::text AS requested_start, o.requested_end::text AS requested_end,
          o.observed_start::text AS observed_start, o.observed_end::text AS observed_end, o.collected_at, o.response_digest, o.supersedes_import_id, o.subject_to_thresholding
        FROM growth_metric_imports i
        -- W8: an authenticated import carries its provider identity (never the Google account or any credential).
        LEFT JOIN growth_ga4_observations o ON o.import_id=i.id AND o.business_id=i.business_id
        WHERE i.business_id=${businessId} AND i.metric_definition_id=${evaluation.metric.id}
          AND i.date_start <= ${plan.observationEnd}::date AND i.date_end >= ${plan.baselineStart}::date
        ORDER BY i.imported_at, i.id LIMIT ${SOURCE_LIMIT}` : []
    const sources: GrowthReportImportRef[] = sourceRows.map(r => ({
      id: String(r["id"]), sourceKind: r["source_kind"] as GrowthReportImportRef["sourceKind"], provenance: r["provenance"] as GrowthReportImportRef["provenance"],
      dateStart: String(r["date_start"]), dateEnd: String(r["date_end"]), rowCount: Number(r["row_count"]), rawDigest: String(r["raw_digest"]),
      importedAt: iso(r["imported_at"] as Date | string),
      ...(r["connection_id"] == null ? {} : { observation: {
        provider: "GA4_DATA_API" as const, connectionId: String(r["connection_id"]), bindingId: String(r["binding_id"]), property: String(r["property"]),
        eventName: String(r["event_name"]), providerMetric: "keyEvents" as const, timeZone: String(r["time_zone"]),
        requestedStart: String(r["requested_start"]), requestedEnd: String(r["requested_end"]),
        observedStart: r["observed_start"] == null ? null : String(r["observed_start"]), observedEnd: r["observed_end"] == null ? null : String(r["observed_end"]),
        collectedAt: iso(r["collected_at"] as Date | string), responseDigest: String(r["response_digest"]),
        supersedesImportId: r["supersedes_import_id"] == null ? null : String(r["supersedes_import_id"]), subjectToThresholding: r["subject_to_thresholding"] === true,
      } }),
    }))
    return {
      schema: GROWTH_REPORT_SCHEMA,
      business: { id: businessId, name: String(business[0]["name"]), websiteUrl: String(business[0]["website_url"]) },
      initiative: { id: opportunity.id, title: opportunity.title, problemStatement: opportunity.problemStatement, proposedChange: opportunity.proposedChange,
        targetUrl: opportunity.targetUrl, approvedAt: evaluation.initiative.approvedAt, status: opportunity.status },
      review, nextSteps: null, evaluation, sources, generatedAt: evaluation.evaluatedAt, publication: null,
    } satisfies GrowthReportSnapshot
  })
  const consistent = <A>(effect: GrowthMeasurementEffect<A>) => sql.withTransaction(Effect.gen(function*() {
    // Must be the first statement: every later read sees one snapshot.
    yield* sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`
    return yield* effect
  }))

  const shareOf = (row: Record<string, unknown>): GrowthReportShare | null => row["share_id"] == null ? null : {
    id: String(row["share_id"]), publicId: String(row["public_id"]), status: row["share_status"] as GrowthReportShare["status"],
    createdAt: iso(row["share_created_at"] as Date | string), revokedAt: row["share_revoked_at"] == null ? null : iso(row["share_revoked_at"] as Date | string),
  }
  const summaryOf = (row: Record<string, unknown>): GrowthReportSummary => ({
    id: String(row["id"]), opportunityId: String(row["opportunity_id"]), version: Number(row["version"]),
    status: row["evaluation_status"] as GrowthReportSummary["status"], publishedAt: iso(row["published_at"] as Date | string),
    publishedByUserId: String(row["published_by_user_id"]), supersedesId: row["supersedes_id"] == null ? null : String(row["supersedes_id"]),
    snapshotDigest: String(row["snapshot_digest"]), evidenceDigest: String(row["evidence_digest"]), superseded: row["superseded"] === true, share: shareOf(row),
  })
  // The latest share of each report (active first, else the newest revoked one).
  const reportColumns = sql`r.id, r.opportunity_id, r.version, r.evaluation_status, r.published_at, r.published_by_user_id, r.supersedes_id,
      r.snapshot_digest, r.evidence_digest,
      EXISTS (SELECT 1 FROM growth_reports n WHERE n.supersedes_id=r.id) AS superseded,
      s.id AS share_id, s.public_id, s.status AS share_status, s.created_at AS share_created_at, s.revoked_at AS share_revoked_at`
  const shareJoin = sql`LEFT JOIN LATERAL (SELECT * FROM growth_report_shares x WHERE x.report_id=r.id AND x.business_id=r.business_id
      ORDER BY (x.status='ACTIVE') DESC, x.created_at DESC, x.id LIMIT 1) s ON true`
  const readReport = (businessId: string, reportId: string): GrowthMeasurementEffect<GrowthReport> => Effect.gen(function*() {
    const rows = yield* sql`SELECT ${reportColumns}, r.snapshot_text FROM growth_reports r ${shareJoin} WHERE r.id=${reportId} AND r.business_id=${businessId}`
    if (!rows[0]) return yield* refuse("ReportNotFound")
    return { ...summaryOf(rows[0]), snapshot: JSON.parse(String(rows[0]["snapshot_text"])) as GrowthReportSnapshot }
  })

  const publishOnce = (session: Session, businessId: string, opportunityId: string, input: GrowthReportPublishInput): GrowthMeasurementEffect<GrowthReportPublishResult> => consistent(Effect.gen(function*() {
    yield* member(session, businessId)
    const fingerprint = sha256(canonicalJson({ opportunityId, expectedLatestVersion: input.expectedLatestVersion, evidenceDigest: input.evidenceDigest, nextSteps: input.nextSteps?.trim() ?? null }))
    const seen = yield* sql`SELECT id, request_fingerprint FROM growth_reports WHERE business_id=${businessId} AND request_key=${input.idempotencyKey}`
    if (seen[0]) {
      if (seen[0]["request_fingerprint"] !== fingerprint) return yield* refuse("IdempotencyConflict")
      return { report: yield* readReport(businessId, String(seen[0]["id"])), replayed: true }
    }
    const latest = yield* sql`SELECT id, version FROM growth_reports WHERE business_id=${businessId} AND opportunity_id=${opportunityId} ORDER BY version DESC LIMIT 1`
    const latestVersion = latest[0] ? Number(latest[0]["version"]) : 0
    if (latestVersion !== input.expectedLatestVersion) return yield* refuse("StaleReport")
    const snapshot = yield* assemble(session.accountId, businessId, opportunityId)
    if (!snapshot.evaluation.initiative.approvedAt) return yield* refuse("ReportInitiativeNotApproved")
    const evidenceDigest = growthReportEvidenceDigest(snapshot)
    if (evidenceDigest !== input.evidenceDigest) return yield* refuse("ReportEvidenceChanged")
    const published: GrowthReportSnapshot = {
      ...snapshot, nextSteps: input.nextSteps?.trim() ?? null,
      publication: { version: latestVersion + 1, publishedAt: snapshot.generatedAt, supersedesReportId: latest[0] ? String(latest[0]["id"]) : null },
    }
    const text = canonicalJson(published)
    const inserted = yield* sql`INSERT INTO growth_reports(business_id,opportunity_id,version,supersedes_id,evaluation_status,snapshot_text,snapshot_digest,evidence_digest,
        published_by_user_id,published_at,request_key,request_fingerprint)
      VALUES(${businessId},${opportunityId},${published.publication!.version},${published.publication!.supersedesReportId},${snapshot.evaluation.status},${text},${sha256(text)},${evidenceDigest},
        ${session.userId},${published.publication!.publishedAt}::timestamptz,${input.idempotencyKey},${fingerprint}) RETURNING id`
    return { report: yield* readReport(businessId, String(inserted[0]!["id"])), replayed: false }
  }))

  return {
    preview: (accountId, businessId, opportunityId) => Effect.gen(function*() {
      yield* ids(businessId, opportunityId)
      yield* scope(accountId, businessId)
      return yield* consistent(Effect.gen(function*() {
        const snapshot = yield* assemble(accountId, businessId, opportunityId)
        const latest = yield* sql`SELECT COALESCE(MAX(version),0)::int AS v FROM growth_reports WHERE business_id=${businessId} AND opportunity_id=${opportunityId}`
        return { snapshot, evidenceDigest: growthReportEvidenceDigest(snapshot), latestVersion: Number(latest[0]?.["v"] ?? 0) }
      }))
    }),
    publish: (session, businessId, opportunityId, raw) => Effect.gen(function*() {
      yield* ids(businessId, opportunityId)
      const input = yield* Schema.decodeUnknown(GrowthReportPublishInput, { onExcessProperty: "error" })(raw).pipe(
        Effect.mapError(() => new GrowthMeasurementRefused({ reason: "InvalidRequest" })))
      // A concurrent publication commits first: the unique key or version
      // collision is retried on a fresh snapshot, which then replays the
      // committed report or reports the stale version.
      const attempt = publishOnce(session, businessId, opportunityId, input)
      const retryable = (e: unknown): e is SqlError => ["23505", "40001"].includes(pgCode(e) ?? "")
        || String((e as { cause?: { message?: string } } | null)?.cause?.message ?? "").includes("report version chain mismatch")
      const guarded = (e: unknown) => String((e as { cause?: { message?: string } } | null)?.cause?.message ?? "").includes("report requires an approved initiative")
      return yield* attempt.pipe(Effect.catchIf(retryable, () => attempt), Effect.catchIf(retryable, () => attempt),
        Effect.catchIf(guarded, () => refuse("ReportInitiativeNotApproved")))
    }),
    list: (accountId, businessId, opportunityId) => Effect.gen(function*() {
      yield* ids(businessId, opportunityId)
      yield* scope(accountId, businessId)
      const rows = yield* sql`SELECT ${reportColumns} FROM growth_reports r ${shareJoin}
        WHERE r.business_id=${businessId} AND r.opportunity_id=${opportunityId} ORDER BY r.version DESC LIMIT 100`
      return rows.map(summaryOf)
    }),
    get: (accountId, businessId, reportId) => Effect.gen(function*() {
      yield* ids(businessId, reportId)
      yield* scope(accountId, businessId)
      return yield* readReport(businessId, reportId)
    }),
    share: (session, businessId, reportId) => sql.withTransaction(Effect.gen(function*() {
      yield* ids(businessId, reportId)
      yield* member(session, businessId)
      const report = yield* sql`SELECT id FROM growth_reports WHERE id=${reportId} AND business_id=${businessId} FOR UPDATE`
      if (!report.length) return yield* refuse("ReportNotFound")
      const existing = yield* sql`SELECT id, public_id, status, created_at, revoked_at FROM growth_report_shares WHERE report_id=${reportId} AND status='ACTIVE'`
      const row = existing[0] ?? (yield* sql`INSERT INTO growth_report_shares(report_id,business_id,public_id,created_by_user_id)
        VALUES(${reportId},${businessId},${newGrowthReportPublicId()},${session.userId}) RETURNING id, public_id, status, created_at, revoked_at`)[0]!
      return shareOf({ share_id: row["id"], public_id: row["public_id"], share_status: row["status"], share_created_at: row["created_at"], share_revoked_at: row["revoked_at"] })!
    })),
    revokeShare: (session, businessId, reportId) => Effect.gen(function*() {
      yield* ids(businessId, reportId)
      yield* member(session, businessId)
      const report = yield* sql`SELECT id FROM growth_reports WHERE id=${reportId} AND business_id=${businessId}`
      if (!report.length) return yield* refuse("ReportNotFound")
      yield* sql`UPDATE growth_report_shares SET status='REVOKED', revoked_by_user_id=${session.userId}, revoked_at=now()
        WHERE report_id=${reportId} AND business_id=${businessId} AND status='ACTIVE'`
    }),
    publicReport: publicId => Effect.gen(function*() {
      if (!GROWTH_REPORT_PUBLIC_ID.test(publicId)) return null
      // One statement: the share state and the immutable snapshot are read together.
      const rows = yield* sql`SELECT r.id, r.snapshot_digest, r.snapshot_text, EXISTS (SELECT 1 FROM growth_reports n WHERE n.supersedes_id=r.id) AS superseded
        FROM growth_report_shares s JOIN growth_reports r ON r.id=s.report_id AND r.business_id=s.business_id
        WHERE s.public_id=${publicId} AND s.status='ACTIVE'`
      if (!rows[0]) return null
      return publicGrowthReport({ id: String(rows[0]["id"]), snapshotDigest: String(rows[0]["snapshot_digest"]), superseded: rows[0]["superseded"] === true,
        snapshot: JSON.parse(String(rows[0]["snapshot_text"])) as GrowthReportSnapshot })
    }),
  } satisfies Context.Tag.Service<GrowthReportRepository>
}))
