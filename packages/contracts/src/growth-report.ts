// W5 client report contracts: an immutable, versioned snapshot of one W4
// outcome evaluation plus the human decision, published explicitly by an
// operator and shared view-only through a revocable capability link. The W4
// evaluation is embedded verbatim; nothing here recomputes outcomes.
import { Schema } from "effect"
import type { GrowthEvaluationAction, GrowthEvaluationCaveat, GrowthEvaluationComparison, GrowthEvaluationFinding, GrowthEvaluationMetric,
  GrowthEvaluationReason, GrowthEvaluationStatus, GrowthEvaluationWindow, GrowthOutcomeEvaluation } from "./growth-evaluation.js"
import type { GrowthPlanTiming } from "./growth-measurement.js"

export const GROWTH_REPORT_SCHEMA = "openrecord.growth-report/v1"
const Digest = Schema.String.pipe(Schema.pattern(/^[a-f0-9]{64}$/))
/** Explicit publication. `evidenceDigest` is the digest of the preview the
 * operator reviewed; publication is refused when the evidence moved since.
 * `expectedLatestVersion` is 0 for the first report of an initiative. */
export const GrowthReportPublishInput = Schema.Struct({
  idempotencyKey: Schema.UUID,
  expectedLatestVersion: Schema.Int.pipe(Schema.greaterThanOrEqualTo(0), Schema.lessThanOrEqualTo(10_000)),
  evidenceDigest: Digest,
  /** Operator-written next steps for the client; never generated. */
  nextSteps: Schema.NullOr(Schema.String.pipe(Schema.maxLength(2000), Schema.filter(s => s.trim().length > 0))),
})
export type GrowthReportPublishInput = typeof GrowthReportPublishInput.Type

export interface GrowthReportImportRef {
  readonly id: string
  readonly sourceKind: "GA4_AGGREGATE_EXPORT" | "OPERATOR_AGGREGATE_EXPORT"
  readonly provenance: "OPERATOR_SUPPLIED_EXPORT" | "SYNTHETIC_FIXTURE"
  readonly dateStart: string
  readonly dateEnd: string
  readonly rowCount: number
  readonly rawDigest: string
  readonly importedAt: string
}
/** The latest human review, exactly as recorded. Null when none exists. */
export interface GrowthReportReview {
  readonly conclusion: "KEEP" | "REVERT" | "EXTEND" | "INCONCLUSIVE"
  readonly reason: string
  readonly decidedAt: string
}
export interface GrowthReportSnapshot {
  readonly schema: typeof GROWTH_REPORT_SCHEMA
  readonly business: { readonly id: string; readonly name: string; readonly websiteUrl: string }
  readonly initiative: {
    readonly id: string; readonly title: string; readonly problemStatement: string; readonly proposedChange: string
    readonly targetUrl: string | null; readonly approvedAt: string | null; readonly status: string
  }
  readonly review: GrowthReportReview | null
  readonly nextSteps: string | null
  /** The W4 evaluation, verbatim. */
  readonly evaluation: GrowthOutcomeEvaluation
  /** Imports of the goal's metric definition overlapping the planned period. Digests only; raw files never leave the workspace. */
  readonly sources: ReadonlyArray<GrowthReportImportRef>
  /** Database time at which every input was read, in one consistent snapshot. */
  readonly generatedAt: string
  /** Null in a preview; set once, inside the digest, when published. */
  readonly publication: { readonly version: number; readonly publishedAt: string; readonly supersedesReportId: string | null } | null
}
export interface GrowthReportPreview {
  readonly snapshot: GrowthReportSnapshot
  readonly evidenceDigest: string
  readonly latestVersion: number
}
export interface GrowthReportShare {
  readonly id: string; readonly publicId: string; readonly status: "ACTIVE" | "REVOKED"; readonly createdAt: string; readonly revokedAt: string | null
}
export interface GrowthReportSummary {
  readonly id: string
  readonly opportunityId: string
  readonly version: number
  readonly status: GrowthEvaluationStatus
  readonly publishedAt: string
  readonly publishedByUserId: string
  readonly supersedesId: string | null
  readonly snapshotDigest: string
  readonly evidenceDigest: string
  readonly superseded: boolean
  readonly share: GrowthReportShare | null
}
export interface GrowthReport extends GrowthReportSummary {
  readonly snapshot: GrowthReportSnapshot
}
export interface GrowthReportPublishResult {
  readonly report: GrowthReport
  readonly replayed: boolean
}

/** The client-facing projection: no user ids, internal notes, approval
 * reasons, raw files or other customers. Identifiers stay in `evidence`. */
export interface PublicGrowthReport {
  readonly business: { readonly name: string; readonly websiteUrl: string }
  /** Null while the report is an unpublished preview. */
  readonly version: number | null
  readonly publishedAt: string | null
  readonly generatedAt: string
  readonly superseded: boolean
  readonly initiative: { readonly title: string; readonly problemStatement: string; readonly proposedChange: string; readonly targetUrl: string | null; readonly approvedAt: string | null }
  readonly goal: { readonly statement: string; readonly version: number }
  readonly metric: Omit<GrowthEvaluationMetric, "id">
  readonly plan: { readonly baselineStart: string; readonly baselineEnd: string; readonly observationStart: string; readonly observationEnd: string; readonly declaredAt: string; readonly timing: GrowthPlanTiming } | null
  readonly status: GrowthEvaluationStatus
  readonly reasons: ReadonlyArray<GrowthEvaluationFinding<GrowthEvaluationReason>>
  readonly caveats: ReadonlyArray<GrowthEvaluationFinding<GrowthEvaluationCaveat>>
  readonly baseline: GrowthEvaluationWindow | null
  readonly observation: GrowthEvaluationWindow | null
  readonly comparison: GrowthEvaluationComparison | null
  readonly actions: ReadonlyArray<Omit<GrowthEvaluationAction, "description" | "actor" | "initiative" | "verification"> & {
    readonly initiativeTitle: string | null; readonly verification: { readonly kind: string; readonly claim: string } | null
  }>
  readonly review: GrowthReportReview | null
  readonly nextSteps: string | null
  readonly assumptions: ReadonlyArray<string>
  readonly limitations: ReadonlyArray<string>
  readonly evidence: {
    readonly reportId: string | null; readonly snapshotDigest: string | null; readonly initiativeId: string; readonly goalId: string
    readonly metricDefinitionId: string; readonly metricVersion: number; readonly planId: string | null
    readonly sources: ReadonlyArray<GrowthReportImportRef>; readonly actionIds: ReadonlyArray<string>
  }
}

/** Deterministic JSON: object keys sorted at every depth, no whitespace. */
export const canonicalJson = (value: unknown): string => {
  const order = (v: unknown): unknown => Array.isArray(v) ? v.map(order)
    : v !== null && typeof v === "object" ? Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined)
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, x]) => [k, order(x)]))
    : v
  return JSON.stringify(order(value))
}
/** The evidence a preview showed, independent of when it was read or published. */
export const growthReportEvidenceView = (snapshot: GrowthReportSnapshot): unknown => ({
  ...snapshot, generatedAt: null, publication: null, nextSteps: null, evaluation: { ...snapshot.evaluation, evaluatedAt: null },
})

/** Pass `id`/`snapshotDigest` null to render an unpublished preview. */
export const publicGrowthReport = (report: { readonly id: string | null; readonly snapshotDigest: string | null; readonly superseded: boolean; readonly snapshot: GrowthReportSnapshot }): PublicGrowthReport => {
  const s = report.snapshot, e = s.evaluation
  const { id: _metricId, ...metric } = e.metric
  return {
    business: { name: s.business.name, websiteUrl: s.business.websiteUrl },
    version: s.publication?.version ?? null, publishedAt: s.publication?.publishedAt ?? null, generatedAt: s.generatedAt, superseded: report.superseded,
    initiative: { title: s.initiative.title, problemStatement: s.initiative.problemStatement, proposedChange: s.initiative.proposedChange, targetUrl: s.initiative.targetUrl, approvedAt: s.initiative.approvedAt },
    goal: { statement: e.goal.statement, version: e.goal.version }, metric,
    plan: e.plan ? { baselineStart: e.plan.baselineStart, baselineEnd: e.plan.baselineEnd, observationStart: e.plan.observationStart, observationEnd: e.plan.observationEnd, declaredAt: e.plan.declaredAt, timing: e.plan.timing } : null,
    status: e.status, reasons: e.reasons, caveats: e.caveats, baseline: e.baseline, observation: e.observation, comparison: e.comparison,
    actions: e.actions.map(a => ({
      id: a.id, type: a.type, channel: a.channel, performedAt: a.performedAt, recordedAt: a.recordedAt, performedDay: a.performedDay, phase: a.phase,
      assurance: a.assurance,
      // A verified merge's reference is a pull request URL in the customer's repository: the client-facing page does not name it.
      reference: a.verification ? "Pull request in the website's code repository" : a.reference, association: a.association, initiativeTitle: a.initiative?.title ?? null,
      verification: a.verification ? { kind: a.verification.kind, claim: a.verification.claim } : null,
    })),
    review: s.review, nextSteps: s.nextSteps, assumptions: e.assumptions, limitations: e.limitations,
    evidence: {
      reportId: report.id, snapshotDigest: report.snapshotDigest, initiativeId: s.initiative.id, goalId: e.goal.id,
      metricDefinitionId: e.metric.id, metricVersion: e.metric.version, planId: e.plan?.id ?? null, sources: s.sources, actionIds: e.actions.map(a => a.id),
    },
  }
}
