// Search Console site bindings: which Search Console property describes which
// business, through which Google connection. One active binding per business;
// rebinding ends the previous one in the same transaction. The 0041 guards
// carry the same rules. Credentials stay in the GA4 connection tables.
import { Context, Effect, Layer } from "effect"
import { PgClient } from "@effect/sql-pg"
import type { SqlError } from "@effect/sql/SqlError"
import { decodeRouteId, type SearchConsoleBinding } from "@openrecord/contracts"
import { GrowthGa4Refused } from "./growth-ga4.js"
import { iso } from "./row-codecs.js"
import type { Session } from "./auth.js"

export type SearchConsoleEffect<A> = Effect.Effect<A, SqlError | GrowthGa4Refused>

export class SearchConsoleRepository extends Context.Tag("SearchConsoleRepository")<SearchConsoleRepository, {
  /** The active binding of a business in this account, or null. */
  readonly binding: (accountId: string, businessId: string) => SearchConsoleEffect<SearchConsoleBinding | null>
  /** Binds a site the caller has already confirmed the connection can read. */
  readonly bind: (session: Session, businessId: string, input: { readonly connectionId: string; readonly siteUrl: string; readonly permissionLevel: string }) => SearchConsoleEffect<SearchConsoleBinding>
  readonly unbind: (session: Session, businessId: string) => SearchConsoleEffect<void>
}>() {}

const toBinding = (r: Record<string, unknown>): SearchConsoleBinding => ({
  id: String(r["id"]), businessId: String(r["business_id"]), connectionId: String(r["connection_id"]), siteUrl: String(r["site_url"]),
  permissionLevel: String(r["permission_level"]), createdByUserId: String(r["created_by_user_id"]), createdAt: iso(r["created_at"] as Date | string),
})

export const SearchConsoleRepositoryLive = Layer.effect(SearchConsoleRepository, Effect.gen(function*() {
  const sql = yield* PgClient.PgClient
  const refuse = (reason: string) => Effect.fail(new GrowthGa4Refused({ reason }))
  const scoped = (accountId: string, businessId: string) => Effect.gen(function*() {
    if (decodeRouteId(businessId)._tag === "Left") return yield* refuse("InvalidRequest")
    const rows = yield* sql`SELECT id FROM businesses WHERE id=${businessId} AND account_id=${accountId}`
    if (!rows.length) return yield* refuse("GrowthNotFound")
  })
  const member = (session: Session) => Effect.gen(function*() {
    const rows = yield* sql`SELECT 1 FROM account_users WHERE account_id=${session.accountId} AND user_id=${session.userId}`
    if (!rows.length) return yield* refuse("GrowthNotFound")
  })
  const active = (businessId: string) => sql`SELECT id, business_id, connection_id, site_url, permission_level, created_by_user_id, created_at
    FROM search_console_bindings WHERE business_id=${businessId} AND ended_at IS NULL`
  return {
    binding: (accountId, businessId) => Effect.gen(function*() {
      yield* scoped(accountId, businessId)
      const rows = yield* active(businessId)
      return rows[0] ? toBinding(rows[0]) : null
    }),
    bind: (session, businessId, input) => sql.withTransaction(Effect.gen(function*() {
      yield* member(session)
      yield* scoped(session.accountId, businessId)
      if (decodeRouteId(input.connectionId)._tag === "Left") return yield* refuse("InvalidRequest")
      const connection = yield* sql`SELECT status FROM growth_ga4_connections WHERE id=${input.connectionId} AND account_id=${session.accountId} FOR SHARE`
      if (!connection[0]) return yield* refuse("Ga4ConnectionNotFound")
      if (connection[0]["status"] !== "ACTIVE") return yield* refuse("Ga4ReauthorizationRequired")
      yield* sql`SELECT id FROM businesses WHERE id=${businessId} FOR UPDATE`
      const current = (yield* active(businessId))[0]
      // Binding the same site again through the same connection changes nothing.
      if (current && current["site_url"] === input.siteUrl && current["connection_id"] === input.connectionId) return toBinding(current)
      if (current) yield* sql`UPDATE search_console_bindings SET ended_at=now(), ended_by_user_id=${session.userId} WHERE id=${String(current["id"])}`
      const rows = yield* sql`INSERT INTO search_console_bindings(account_id,business_id,connection_id,site_url,permission_level,created_by_user_id)
        VALUES(${session.accountId},${businessId},${input.connectionId},${input.siteUrl},${input.permissionLevel},${session.userId})
        RETURNING id, business_id, connection_id, site_url, permission_level, created_by_user_id, created_at`
      return toBinding(rows[0]!)
    })),
    unbind: (session, businessId) => sql.withTransaction(Effect.gen(function*() {
      yield* member(session)
      yield* scoped(session.accountId, businessId)
      yield* sql`UPDATE search_console_bindings SET ended_at=now(), ended_by_user_id=${session.userId} WHERE business_id=${businessId} AND ended_at IS NULL`
    })),
  }
}))
