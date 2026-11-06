// Opted-in setup continues from persisted state without a browser. No publishing.
import { PgClient } from "@effect/sql-pg"
import { Cause, Effect, Schedule } from "effect"
import { SetupRepository } from "@openrecord/db"
import { setupDraft } from "./setup-draft.js"
import { proposeSetup } from "./setup-routes.js"

const metric = { LEAD: "Leads", SIGNUP: "Signups", PURCHASE: "Purchases", BOOKING: "Bookings" } as const
export const runSetupPass = (accountId?: string) => Effect.gen(function*() {
  const sql = yield* PgClient.PgClient
  const setups = yield* SetupRepository
  const candidates = yield* sql`SELECT s.id,s.account_id,s.business_id,s.started_by_user_id
    FROM business_setups s JOIN account_users au ON au.account_id=s.account_id AND au.user_id=s.started_by_user_id
    WHERE (${accountId ?? null}::uuid IS NULL OR s.account_id=${accountId ?? null}::uuid)
      AND s.auto_advance AND (s.discovery_status='DONE' OR s.brief IS NOT NULL) AND s.opportunity_id IS NULL
      AND (s.brief IS NOT NULL OR s.draft_status IS NULL OR s.draft_status='READY'
        OR (s.draft_status='RUNNING' AND (s.draft_started_at IS NULL OR s.draft_started_at<now()-interval '25 minutes')))
    ORDER BY s.updated_at,s.id LIMIT 100`
  for (const candidate of candidates) {
    const session = { accountId: String(candidate["account_id"]), userId: String(candidate["started_by_user_id"]) }
    const businessId = String(candidate["business_id"])
    yield* Effect.gen(function*() {
      let row = yield* setups.get(session.accountId, businessId)
      if (!row || row.opportunityId) return
      if (!row.brief) {
        const draft = yield* setupDraft({ ...session, businessId }, row.id)
        if (draft?.status !== "READY") return
        const d = draft.value
        row = yield* setups.confirm(session, businessId, {
          expectedRevision: row.revision, businessName: d.businessName, category: d.category, audience: d.audience,
          valueProposition: d.valueProposition, goalStatement: row.goalStatement?.trim() || d.goalStatement,
          conversionKind: d.conversionKind, metricLabel: d.metricLabel.trim() || metric[d.conversionKind], reportingTimeZone: "UTC", facts: [],
        })
      }
      if (!row.channelsReviewedAt) row = yield* setups.reviewChannels(session, businessId, row.revision)
      if (!row.opportunityId) yield* proposeSetup(session, businessId, row.revision)
    }).pipe(Effect.catchAllCause(cause => Effect.logWarning("setup could not advance").pipe(
      Effect.annotateLogs({ business: businessId, cause: Cause.pretty(cause).slice(0, 300) }))))
  }
})
export const setupScheduler = runSetupPass().pipe(
  Effect.catchAllCause(cause => Effect.logWarning("setup scheduler failed").pipe(Effect.annotateLogs({ cause: Cause.pretty(cause).slice(0, 300) }))),
  Effect.repeat(Schedule.spaced("5 seconds")),
)
