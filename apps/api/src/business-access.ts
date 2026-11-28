// One business-ownership check in front of every route whose path names a
// business.
//
// Each handler still checks for itself (getScoped and the client/route
// wrappers); this is the backstop that makes forgetting impossible. It runs
// inside the router, after matching, so it reads the matched route pattern
// and its `:id` parameter rather than parsing the URL: an encoded or oddly
// shaped path that reaches a handler reaches this check too.
//
// For a route under one of BUSINESS_ROUTES:
//   - no session: 401, so no such route can serve anyone signed out;
//   - a malformed id: left to the handler, which answers its own 422;
//   - a business outside the session's account: 404 with the tag that
//     module already uses, so a foreign business is indistinguishable from
//     a missing one;
//   - otherwise the handler runs.
import { type HttpApp, HttpRouter, HttpServerResponse } from "@effect/platform"
import { SqlClient } from "@effect/sql"
import { decodeRouteId } from "@openrecord/contracts"
import type { Session } from "@openrecord/db"
import { Effect, Option } from "effect"

/** Route prefixes whose `:id` is a business id, with the tag each module answers for a missing one. */
export const BUSINESS_ROUTES = [
  { prefix: "/api/businesses/:id", notFound: "BusinessNotFound" },
  { prefix: "/api/growth/clients/:id", notFound: "GrowthNotFound" },
  { prefix: "/api/acquisition/clients/:id", notFound: "ClientNotFound" },
  { prefix: "/api/record/clients/:id", notFound: "ClientNotFound" },
  { prefix: "/api/ads/clients/:id", notFound: "ClientNotFound" },
] as const

/** The business-route entry a route pattern falls under, if any. */
export const businessRouteOf = (pattern: string) =>
  BUSINESS_ROUTES.find(r => pattern === r.prefix || pattern.startsWith(`${r.prefix}/`))

export const withBusinessAccess = <EA, RA>(resolveSession: Effect.Effect<{ readonly session: Session }, EA, RA>) =>
  <E, R>(handler: HttpApp.Default<E, R>) =>
    Effect.gen(function*() {
      const ctx = yield* HttpRouter.RouteContext
      const route = businessRouteOf(ctx.route.path)
      if (!route) return yield* handler
      const id = ctx.params["id"]
      if (id === undefined || decodeRouteId(id)._tag === "Left") return yield* handler
      const resolved = yield* Effect.option(resolveSession)
      if (Option.isNone(resolved)) return yield* HttpServerResponse.json({ _tag: "NotAuthenticated" }, { status: 401 })
      const sql = yield* SqlClient.SqlClient
      const owned = yield* sql`SELECT 1 FROM businesses WHERE id = ${id} AND account_id = ${resolved.value.session.accountId}`
      if (!owned.length) return yield* HttpServerResponse.json({ _tag: route.notFound }, { status: 404 })
      return yield* handler
    })
