// When a campaign's deliverables were added, started and finished, read from
// records that already exist: the saved brief revisions, linked artifacts,
// hosted page publications and the owner's own sent reports. A moment nobody
// recorded is null, never guessed. Days of views and inquiries are the hosted
// pages' own counts (test views and inquiries are excluded).
import { SqlClient } from "@effect/sql"
import { Effect } from "effect"

export interface TimelineRevision { readonly at: string; readonly tasks: ReadonlyArray<{ readonly id: string; readonly status: string }> }
export interface TimelineReceipts { readonly started?: string | null; readonly waitingFrom?: string | null; readonly waitingUntil?: string | null; readonly finished?: string | null }
export interface TaskTimes { readonly taskId: string; readonly added: string | null; readonly started: string | null; readonly waitingFrom: string | null; readonly waitingUntil: string | null; readonly finished: string | null }

const earliest = (...xs: ReadonlyArray<string | null | undefined>): string | null => xs.filter((x): x is string => !!x).sort()[0] ?? null

/** Revisions oldest first. Work reopened after being done starts counting as unfinished again. */
export const taskTimes = (taskId: string, revisions: ReadonlyArray<TimelineRevision>, receipts: TimelineReceipts = {}): TaskTimes => {
  let added: string | null = null, started: string | null = null, done: string | null = null, imported = false
  for (const r of revisions) {
    const task = r.tasks.find(t => t.id === taskId)
    if (!task) continue
    const first = added === null
    added ??= r.at
    if (task.status === "IN_PROGRESS" || task.status === "BLOCKED") started ??= r.at
    // Already done when first saved: when it finished is unknown.
    if (first && task.status === "DONE") imported = true
    else if (task.status !== "DONE") { imported = false; done = null }
    else if (!imported) done ??= r.at
  }
  const finished = earliest(done, receipts.finished)
  const begun = earliest(started, receipts.started)
  return { taskId, added, started: begun && finished && begun > finished ? null : begun,
    waitingFrom: receipts.waitingFrom ?? null, waitingUntil: receipts.waitingUntil ?? null, finished }
}

const iso = (v: unknown): string | null => v ? new Date(v as string | Date).toISOString() : null

/** The caller has checked that the campaign belongs to the business. */
export const campaignTimeline = (businessId: string, campaignId: string) => Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql`SELECT r.created_at, (SELECT jsonb_agg(jsonb_build_object('id',t->>'id','status',t->>'status')) FROM jsonb_array_elements(r.brief->'tasks') t) AS tasks
    FROM marketing_campaign_revisions r JOIN marketing_campaigns c ON c.id=r.campaign_id WHERE c.id=${campaignId} AND c.business_id=${businessId} ORDER BY r.revision`
  const bound = yield* sql`SELECT task_id, min(created_at) AS at FROM campaign_artifact_bindings WHERE campaign_id=${campaignId} AND business_id=${businessId} GROUP BY task_id`
  const pages = yield* sql`SELECT DISTINCT ON (b.task_id) b.task_id, p.prepared_at, p.decided_at, p.status, p.published_at
    FROM campaign_publications p JOIN campaign_artifact_bindings b ON b.id=p.binding_id
    WHERE b.campaign_id=${campaignId} AND p.business_id=${businessId} ORDER BY b.task_id, p.prepared_at DESC`
  const sent = yield* sql`SELECT task_id, reported_at FROM campaign_handoffs WHERE campaign_id=${campaignId} AND business_id=${businessId}`
  const days = yield* sql`WITH live AS (SELECT p.id FROM campaign_publications p JOIN campaign_artifact_bindings b ON b.id=p.binding_id
      WHERE b.campaign_id=${campaignId} AND p.business_id=${businessId} AND p.published_at IS NOT NULL),
    views AS (SELECT day, sum(views)::int AS n FROM campaign_page_days WHERE publication_id IN (SELECT id FROM live) GROUP BY day),
    asked AS (SELECT created_at::date AS day, count(*)::int AS n FROM campaign_inquiries WHERE purpose='PRODUCTION' AND publication_id IN (SELECT id FROM live) GROUP BY 1)
    SELECT to_char(COALESCE(v.day,a.day),'YYYY-MM-DD') AS day, COALESCE(v.n,0) AS views, COALESCE(a.n,0) AS inquiries
    FROM views v FULL JOIN asked a ON a.day=v.day ORDER BY 1`
  const revisions = rows.map((r): TimelineRevision => ({ at: iso(r["created_at"])!, tasks: (r["tasks"] ?? []) as TimelineRevision["tasks"] }))
  const current = revisions.at(-1)?.tasks ?? []
  const of = (list: ReadonlyArray<Record<string, unknown>>, id: string) => list.find(x => String(x["task_id"]) === id)
  return {
    tasks: current.map(t => {
      const page = of(pages, t.id), live = page?.["status"] === "PUBLISHED"
      return taskTimes(t.id, revisions, {
        started: iso(of(bound, t.id)?.["at"]),
        waitingFrom: iso(page?.["prepared_at"]), waitingUntil: iso(page?.["decided_at"]),
        finished: earliest(live ? iso(page?.["published_at"]) : null, iso(of(sent, t.id)?.["reported_at"])),
      })
    }),
    days: days.map(d => ({ day: String(d["day"]), views: Number(d["views"]), inquiries: Number(d["inquiries"]) })),
    note: "Dates are when a change was saved or reported. Sent reports are the owner's own; nothing here shows the campaign caused a result.",
  }
})
