// When changes to the business's own site went live, for marking the Analytics
// charts: WordPress and Webflow changes when they were published, and
// code-repository changes when their merge was verified. A mark says only
// that something changed then; it never claims the change moved a number.
import { HttpRouter } from "@effect/platform"
import { SqlClient } from "@effect/sql"
import { Effect } from "effect"
import { BusinessRepository } from "@openrecord/db"
import { decodeRouteId } from "@openrecord/contracts"
import { json, operatorSessionFor, type WithSession } from "./record-routes.js"

export type LiveChange = {
  readonly at: string
  readonly title: string
  readonly source: "WORDPRESS" | "WEBFLOW" | "GITHUB"
  /** Undone afterwards (WordPress and Webflow keep an undo). */
  readonly undone: boolean
}

const PRIVATE = { "cache-control": "no-store" }

export const liveChanges = (businessId: string, days: number) => Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const since = new Date(Date.now() - days * 86_400_000).toISOString()
  const rows = yield* sql`
    SELECT decided_at AS at, target_title AS title, 'WORDPRESS' AS source, status='UNDONE' AS undone FROM wordpress_changes
      WHERE business_id=${businessId} AND status IN ('PUBLISHED','UNDONE') AND decided_at>=${since}
    UNION ALL
    SELECT published_at, target_title, 'WEBFLOW', status='UNDONE' FROM webflow_changes
      WHERE business_id=${businessId} AND status IN ('PUBLISHED','UNDONE') AND published_at>=${since}
    UNION ALL
    SELECT e.created_at, o.file_path, 'GITHUB', false FROM growth_execution_events e JOIN growth_execution_operations o ON o.id=e.operation_id
      WHERE o.business_id=${businessId} AND e.state='VERIFIED' AND e.created_at>=${since}
    ORDER BY 1 LIMIT 200`
  return rows.map((r): LiveChange => ({
    at: new Date(String(r["at"])).toISOString(),
    title: String(r["title"]).slice(0, 300),
    source: String(r["source"]) as LiveChange["source"],
    undone: r["undone"] === true,
  }))
})

export const liveChangesApi = (withSession: WithSession) => {
  const operator = operatorSessionFor(withSession)
  return HttpRouter.empty.pipe(
    HttpRouter.get("/api/businesses/:id/live-changes", operator(session => Effect.gen(function*() {
      const { params } = yield* HttpRouter.RouteContext
      const businessId = params["id"] ?? ""
      if (decodeRouteId(businessId)._tag === "Left") return yield* json(422, { _tag: "InvalidRequest" }, PRIVATE)
      if (!(yield* (yield* BusinessRepository).getScoped(session.accountId, businessId))) return yield* json(404, { _tag: "BusinessNotFound" }, PRIVATE)
      // A year covers every period the charts show.
      return yield* json(200, { changes: yield* liveChanges(businessId, 366) }, PRIVATE)
    })).pipe(Effect.catchAll(e => typeof e === "object" && e !== null && "_tag" in e && e._tag === "NotAuthenticated"
      ? json(401, { _tag: "NotAuthenticated" })
      : json(500, { _tag: "LiveChangesUnavailable" }, PRIVATE)))),
  )
}
