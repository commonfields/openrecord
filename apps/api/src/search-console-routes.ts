// Search Console routes and the one performance reader the agent shares.
// Operator-only, session-scoped and no-store like the GA4 routes they extend:
// the Google connection, its encrypted tokens and its refresh handling are the
// GA4 connection's. A site can be bound only when the connection lists it, so a
// connection is never taken as proof of access to another site.
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "@effect/platform"
import { PgClient } from "@effect/sql-pg"
import { Effect } from "effect"
import { GrowthGa4Refused, GrowthGa4Repository, SearchConsoleRepository, type Session } from "@openrecord/db"
import {
  BindSearchConsoleSite, SEARCH_PERFORMANCE_DAYS, decodeRouteId, hasSearchConsoleScope, searchConsoleSiteMatchesHost, searchConsoleWindows,
  type SearchPerformance, type SearchPerformanceDays,
} from "@openrecord/contracts"
import { listSearchConsoleSites, searchTopRows, searchTotals } from "@openrecord/ga4"
import { configured, ga4Failure, providerConfig, read } from "./growth-ga4-routes.js"
import { decode, json, operatorSessionFor, readJson, type WithSession } from "./record-routes.js"

const PRIVATE_HEADERS = { "cache-control": "no-store" }
const refuse = (reason: string) => Effect.fail(new GrowthGa4Refused({ reason }))

/** Live search performance for a business's bound site, or null when no site is bound. */
export const searchPerformance = (accountId: string, businessId: string, days: SearchPerformanceDays) => Effect.gen(function*() {
  const binding = yield* (yield* SearchConsoleRepository).binding(accountId, businessId)
  if (!binding) return null
  const config = yield* configured
  const windows = searchConsoleWindows(Date.now(), days)
  const result = yield* read(config, accountId, binding.connectionId, token => Promise.all([
    searchTotals(config.api, token, binding.siteUrl, windows.current),
    searchTotals(config.api, token, binding.siteUrl, windows.previous),
    searchTopRows(config.api, token, binding.siteUrl, windows.current, "query"),
    searchTopRows(config.api, token, binding.siteUrl, windows.current, "page"),
  ]))
  const [current, previous, topQueries, topPages] = result
  return {
    siteUrl: binding.siteUrl, days,
    current: { ...windows.current, totals: current }, previous: { ...windows.previous, totals: previous },
    topQueries, topPages, collectedAt: new Date().toISOString(),
  } satisfies SearchPerformance
})

const websiteHost = (businessId: string) => Effect.gen(function*() {
  const sql = yield* PgClient.PgClient
  const rows = yield* sql`SELECT website_url FROM record_profiles WHERE business_id=${businessId}`
  const raw = rows[0]?.["website_url"]
  try { return typeof raw === "string" ? new URL(raw).hostname : null } catch { return null }
})

export const searchConsoleApi = (withSession: WithSession) => {
  const operator = operatorSessionFor(withSession)
  const business = <E, R>(run: (session: Session, businessId: string) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
    operator(session => Effect.gen(function*() {
      const { params } = yield* HttpRouter.RouteContext
      const businessId = params["id"] ?? ""
      if (decodeRouteId(businessId)._tag === "Left") return yield* json(422, { _tag: "InvalidRequest" }, PRIVATE_HEADERS)
      return yield* run(session, businessId)
    })).pipe(Effect.catchAll(ga4Failure))
  const base = "/api/growth/clients/:id/search-console"

  return HttpRouter.empty.pipe(
    // Status: whether Google is configured, which connections can read Search Console, and the bound site.
    HttpRouter.get(base, business((session, businessId) => Effect.gen(function*() {
      const config = yield* providerConfig
      const binding = yield* (yield* SearchConsoleRepository).binding(session.accountId, businessId)
      const connections = config.configured ? yield* (yield* GrowthGa4Repository).connections(session.accountId) : []
      return yield* json(200, {
        configured: config.configured,
        binding,
        connections: connections.filter(c => c.status !== "DISCONNECTED").map(c => ({ id: c.id, googleEmail: c.googleEmail, status: c.status, searchConsole: hasSearchConsoleScope(c.grantedScopes) })),
      }, PRIVATE_HEADERS)
    }))),
    // Sites the connection can read, marked when they cover the business's website.
    HttpRouter.get(`${base}/sites`, business((session, businessId) => Effect.gen(function*() {
      const request = yield* HttpServerRequest.HttpServerRequest
      const connectionId = new URL(request.url, "http://localhost").searchParams.get("connectionId") ?? ""
      if (decodeRouteId(connectionId)._tag === "Left") return yield* json(422, { _tag: "InvalidRequest" }, PRIVATE_HEADERS)
      yield* (yield* SearchConsoleRepository).binding(session.accountId, businessId)
      const config = yield* configured
      const connection = yield* (yield* GrowthGa4Repository).connection(session.accountId, connectionId)
      if (!hasSearchConsoleScope(connection.grantedScopes)) return yield* refuse("SearchConsoleScopeMissing")
      const sites = yield* read(config, session.accountId, connectionId, token => listSearchConsoleSites(config.api, token))
      const host = yield* websiteHost(businessId)
      return yield* json(200, { sites: sites.map(s => ({ ...s, matchesWebsite: host !== null && searchConsoleSiteMatchesHost(s.siteUrl, host) })) }, PRIVATE_HEADERS)
    }))),
    HttpRouter.post(`${base}/binding`, business((session, businessId) => Effect.gen(function*() {
      const input = decode(BindSearchConsoleSite, yield* readJson)
      if (!input) return yield* json(422, { _tag: "InvalidRequest" }, PRIVATE_HEADERS)
      const repo = yield* SearchConsoleRepository
      yield* repo.binding(session.accountId, businessId)
      const config = yield* configured
      const connection = yield* (yield* GrowthGa4Repository).connection(session.accountId, input.connectionId)
      if (!hasSearchConsoleScope(connection.grantedScopes)) return yield* refuse("SearchConsoleScopeMissing")
      // Only a site this connection can read today may be bound.
      const sites = yield* read(config, session.accountId, input.connectionId, token => listSearchConsoleSites(config.api, token))
      const site = sites.find(s => s.siteUrl === input.siteUrl)
      if (!site) return yield* refuse("SiteNotAccessible")
      return yield* json(200, { binding: yield* repo.bind(session, businessId, { connectionId: input.connectionId, siteUrl: site.siteUrl, permissionLevel: site.permissionLevel }) }, PRIVATE_HEADERS)
    }))),
    HttpRouter.post(`${base}/binding/end`, business((session, businessId) => Effect.gen(function*() {
      yield* (yield* SearchConsoleRepository).unbind(session, businessId)
      return yield* json(200, { binding: null }, PRIVATE_HEADERS)
    }))),
    HttpRouter.get(`${base}/performance`, business((session, businessId) => Effect.gen(function*() {
      const request = yield* HttpServerRequest.HttpServerRequest
      const raw = Number(new URL(request.url, "http://localhost").searchParams.get("days") ?? 28)
      const days = SEARCH_PERFORMANCE_DAYS.find(d => d === raw)
      if (!days) return yield* json(422, { _tag: "InvalidRequest" }, PRIVATE_HEADERS)
      const performance = yield* searchPerformance(session.accountId, businessId, days)
      if (!performance) return yield* refuse("SearchConsoleNotBound")
      return yield* json(200, { performance }, PRIVATE_HEADERS)
    }))),
  )
}
