// W5 client report client: operator API calls, the capability fetch for the
// public page, and the plain-language copy a client reads. Codes stay in the
// evidence section; ordinary prose never shows them.
import type { GrowthEvaluationAssurance, GrowthEvaluationCaveat, GrowthEvaluationReason, GrowthReport, GrowthReportPreview, GrowthReportPublishInput,
  GrowthReportPublishResult, GrowthReportReview, GrowthReportShare, GrowthReportSummary, PublicGrowthReport } from "@openrecord/contracts"
import { api, ApiError } from "./api"

const base = (id: string) => `/api/growth/clients/${encodeURIComponent(id)}`
export const GrowthReports = {
  preview: (id: string, opportunityId: string) => api<{ preview: GrowthReportPreview }>(`${base(id)}/opportunities/${encodeURIComponent(opportunityId)}/report-preview`),
  list: (id: string, opportunityId: string) => api<{ reports: GrowthReportSummary[] }>(`${base(id)}/opportunities/${encodeURIComponent(opportunityId)}/reports`),
  publish: (id: string, opportunityId: string, input: GrowthReportPublishInput) => api<GrowthReportPublishResult>(`${base(id)}/opportunities/${encodeURIComponent(opportunityId)}/reports`, { method: "POST", body: JSON.stringify(input) }),
  get: (id: string, reportId: string) => api<{ report: GrowthReport }>(`${base(id)}/reports/${encodeURIComponent(reportId)}`),
  share: (id: string, reportId: string) => api<{ share: GrowthReportShare }>(`${base(id)}/reports/${encodeURIComponent(reportId)}/share`, { method: "POST" }),
  revoke: (id: string, reportId: string) => api<{ revoked: true }>(`${base(id)}/reports/${encodeURIComponent(reportId)}/share/revoke`, { method: "POST" }),
}
export const publicGrowthReportPath = (publicId: string) => `/reports/${publicId}`
/** Null for unknown and revoked links alike. */
export const fetchPublicGrowthReport = async (publicId: string): Promise<PublicGrowthReport | null> => {
  const res = await fetch(`/api/public/growth-reports/${encodeURIComponent(publicId)}`, { credentials: "omit", referrerPolicy: "no-referrer" })
  if (res.status === 404) return null
  if (!res.ok) throw new Error("This report is temporarily unavailable.")
  return ((await res.json()) as { report: PublicGrowthReport }).report
}
export const growthReportError = (e: unknown): string => {
  const reason = e instanceof ApiError && typeof e.body["reason"] === "string" ? e.body["reason"] : ""
  const reasons: Record<string, string> = {
    ReportEvidenceChanged: "The evidence changed since this preview. Review the new preview before publishing.",
    StaleReport: "Another version was published meanwhile. Review the latest preview before publishing.",
    IdempotencyConflict: "This publication request no longer matches. Reopen the preview and publish again.",
    ReportInitiativeNotApproved: "Only approved initiatives can be reported to a client.",
    ReportNotFound: "This report is unavailable.",
  }
  if (reasons[reason]) return reasons[reason]
  if (e instanceof ApiError && e.status === 404) return "This product or initiative is unavailable."
  return e instanceof Error ? e.message : "The request failed. Try again."
}

/** Why the figures cannot be set side by side, in client language. */
export const REPORT_REASON_COPY: Record<GrowthEvaluationReason, string> = {
  INITIATIVE_NOT_APPROVED: "This work was never approved, so it is not evaluated.",
  CURRENCY_AGGREGATION_UNSUPPORTED: "Revenue amounts are not summarised in these reports yet.",
  NO_MEASUREMENT_PLAN: "No before and after periods were agreed for this work.",
  METRIC_DEFINITION_MISMATCH: "The way this result is counted changed, so the figures cannot be set side by side.",
  INVALID_WINDOWS: "The agreed before and after periods are not valid.",
  PLAN_DECLARED_AFTER_EXECUTION: "The before and after periods were chosen after the work was done, not agreed in advance.",
  NO_RECORDED_EXECUTION: "No completed work is recorded for this initiative.",
  EXECUTION_TIMING_INCOMPATIBLE: "Work took place inside one of the measured periods, so that period mixes before and after.",
  OBSERVATION_INCOMPLETE: "The after period has not finished yet.",
  MISSING_DAYS: "Some days have no reported figure. Missing days are not counted as zero.",
  UNAVAILABLE_DAYS: "Some days were not covered by any data export.",
  CONFLICTING_DAYS: "Some days have different figures in different data exports.",
  SYNTHETIC_DAYS: "Some days contain sample data rather than real results.",
}
/** What still limits the reading, in client language. */
export const REPORT_CAVEAT_COPY: Record<GrowthEvaluationCaveat, string> = {
  OPERATOR_ATTESTED_ONLY: "The work was recorded by the team that did it. It has not been independently verified.",
  UNSPECIFIED_ASSURANCE: "Some recorded activity has no stated level of proof.",
  MULTIPLE_INITIATIVE_ACTIONS: "Several pieces of work are measured together, not one by one.",
  OTHER_ACTIONS_IN_PERIOD: "Other marketing activity happened in the same period, so any change cannot be credited to this work alone.",
  ACTIONS_TRUNCATED: "Not every recorded activity in the period is listed.",
  EXECUTION_ON_OBSERVATION_START: "Work took place on the first day of the after period.",
  UNEQUAL_WINDOW_LENGTHS: "The before and after periods have different lengths, so only daily averages are compared.",
  ZERO_BASELINE: "There were no results in the before period, so no percentage change can be given.",
  PLAN_REDECLARED: "The measured periods were revised before reporting; the latest agreed periods are used.",
  OTHER_METRIC_VERSIONS_EXCLUDED: "Figures counted under a different definition of this result are left out.",
  INITIATIVE_CANCELLED: "This initiative was later cancelled.",
  PROVIDER_REVISED_DAYS: "Google Analytics updated some daily figures after they were first collected; the latest figures are used and earlier ones are kept on record.",
}
export const REPORT_ASSURANCE_COPY: Record<GrowthEvaluationAssurance, string> = {
  OPERATOR_ATTESTED: "Recorded by the team, not independently verified",
  SYSTEM_VERIFIED: "The merge into the website's code repository was confirmed with the code host. This does not show the page is live.",
  UNSPECIFIED: "No stated level of proof",
}
/** Standing limits of every report, in client language. The evaluator's own
 * wording is kept verbatim in the evidence section. */
export const REPORT_LIMITATIONS: ReadonlyArray<string> = [
  "This report compares recorded figures before and after the work. It does not measure how much of any change the work caused, which sign-ups, bookings or sales came from it, or the return on marketing spend.",
  "Figures can also move because of the season, the mix of weekdays, pricing, other channels or outside events. None of these are controlled for.",
  "“Can be compared” is a statement about data quality. It is not a judgement that the work succeeded or failed.",
  "Figures come from exports supplied by the team. OpenRecord does not confirm them directly with the analytics or booking system.",
]
/** The last standing limit depends on where the figures came from: files the team supplied, or Google Analytics read through an authorized read-only connection. */
export const REPORT_PROVIDER_LIMITATION = "Some figures were read by OpenRecord directly from Google Analytics through a read-only connection the team authorized. Google Analytics can update recent days afterwards; this report keeps the figures as they were when it was published. Figures from uploaded files are still supplied by the team and not confirmed directly."
export const reportLimitations = (sources: ReadonlyArray<{ readonly provenance: string }>): ReadonlyArray<string> =>
  sources.some(s => s.provenance === "AUTHENTICATED_PROVIDER_API") ? [...REPORT_LIMITATIONS.slice(0, -1), REPORT_PROVIDER_LIMITATION] : REPORT_LIMITATIONS
/** How one data import is described in the evidence section. */
export const reportSourceLabel = (s: { readonly provenance: string; readonly observation?: { readonly property: string; readonly eventName: string; readonly collectedAt: string } }): string =>
  s.provenance === "AUTHENTICATED_PROVIDER_API"
    ? `read from Google Analytics (${s.observation ? `${s.observation.property}, key event ${s.observation.eventName}, collected ${s.observation.collectedAt}` : "read-only connection"})`
    : s.provenance === "SYNTHETIC_FIXTURE" ? "sample data" : "operator-supplied"
export const REPORT_DECISION_COPY: Record<GrowthReportReview["conclusion"], string> = {
  KEEP: "Keep the change", REVERT: "Undo the change", EXTEND: "Continue and extend the work", INCONCLUSIVE: "No conclusion yet",
}
