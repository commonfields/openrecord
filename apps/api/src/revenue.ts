// Revenue, server side: a business's Stripe account connected with a
// restricted read-only key the business pastes in. The key is checked before
// it is stored (it must be restricted, valid, and allowed to read charges),
// kept only as ciphertext, and never returned, logged or redirected. Revenue
// is read live for a window and the window before it.
import { randomUUID } from "node:crypto"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "@effect/platform"
import { SqlClient } from "@effect/sql"
import { Effect } from "effect"
import { BusinessRepository, type Session } from "@openrecord/db"
import { AD_PERFORMANCE_DAYS, ConnectStripe, adWindows, decodeRouteId, type AdPerformanceDays, type RevenueConnection, type RevenuePerformance } from "@openrecord/contracts"
import { stripeAccount, stripeKeyKind, stripeRevenue } from "@openrecord/ads"
import { AdsRefused, adsConfig, call } from "./ads.js"
import { decode, json, operatorSessionFor, readJson, type WithSession } from "./record-routes.js"

const PRIVATE = { "cache-control": "no-store" }
const refuse = (reason: string) => Effect.fail(new AdsRefused({ reason }))
const stripeOf = Effect.flatMap(adsConfig, c => c.stripe.configured && c.cipher ? Effect.succeed({ stripe: c.stripe.config, cipher: c.cipher }) : refuse("RevenueNotConfigured"))

type Row = RevenueConnection & { readonly ciphertext: string | null }
const toRow = (r: Record<string, unknown>): Row => ({
  id: String(r["id"]), provider: "stripe", displayName: String(r["display_name"]), livemode: r["livemode"] === true, last4: String(r["key_last4"]),
  status: r["status"] === "REVOKED" ? "REVOKED" : "ACTIVE", connectedAt: new Date(r["connected_at"] as string).toISOString(), ciphertext: (r["key_ciphertext"] as string | null) ?? null,
})
const active = (accountId: string, businessId: string) => Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const row = (yield* sql`SELECT * FROM revenue_connections WHERE account_id = ${accountId} AND business_id = ${businessId} AND provider = 'stripe' AND status <> 'DISCONNECTED'`)[0]
  return row ? toRow(row) : null
})

/** Live revenue for the business's Stripe account, or null when none is connected. A refused key is marked so the person reconnects. */
export const revenuePerformance = (accountId: string, businessId: string, days: AdPerformanceDays) => Effect.gen(function*() {
  const c = yield* active(accountId, businessId)
  if (!c) return null
  if (c.status !== "ACTIVE" || !c.ciphertext) return yield* refuse("RevenueKeyRefused")
  const { stripe, cipher } = yield* stripeOf
  const key = cipher.decrypt(c.ciphertext, `revenue:${c.id}:key`)
  if (!key) return yield* refuse("RevenueKeyRefused")
  const windows = adWindows(Date.now(), days)
  const read = yield* call(() => Promise.all([stripeRevenue(stripe, key, windows.current), stripeRevenue(stripe, key, windows.previous)])).pipe(Effect.either)
  if (read._tag === "Left") {
    if (read.left.kind === "AUTH" || read.left.kind === "FORBIDDEN") {
      const sql = yield* SqlClient.SqlClient
      yield* sql`UPDATE revenue_connections SET status = 'REVOKED' WHERE id = ${c.id} AND status = 'ACTIVE'`
      return yield* refuse("RevenueKeyRefused")
    }
    return yield* refuse(read.left.kind === "QUOTA" ? "ProviderQuota" : "ProviderUnavailable")
  }
  const [current, previous] = read.right
  return { provider: "stripe", accountName: c.displayName, livemode: c.livemode, days, current: { ...windows.current, totals: current },
    previous: { ...windows.previous, totals: previous }, collectedAt: new Date().toISOString() } satisfies RevenuePerformance
})

const STATUS: Readonly<Record<string, number>> = { InvalidRequest: 422, RevenueNotConfigured: 503, ProviderUnavailable: 503, ProviderQuota: 503 }
const failure = (e: unknown) => {
  if (e instanceof AdsRefused) return json(STATUS[e.reason] ?? (e.reason.endsWith("NotFound") ? 404 : 409), { _tag: "RevenueRefused", reason: e.reason }, PRIVATE)
  if (typeof e === "object" && e !== null && "_tag" in e && e._tag === "NotAuthenticated") return json(401, { _tag: "NotAuthenticated" }, PRIVATE)
  return json(500, { _tag: "RevenueRequestFailed" }, PRIVATE)
}

export const revenueApi = (withSession: WithSession) => {
  const operator = operatorSessionFor(withSession)
  const business = <E, R>(run: (session: Session, businessId: string) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
    operator(session => Effect.gen(function*() {
      const { params } = yield* HttpRouter.RouteContext
      const businessId = params["id"] ?? ""
      if (decodeRouteId(businessId)._tag === "Left") return yield* refuse("InvalidRequest")
      if (!(yield* (yield* BusinessRepository).getScoped(session.accountId, businessId))) return yield* refuse("BusinessNotFound")
      return yield* run(session, businessId)
    })).pipe(Effect.catchAll(failure))
  const base = "/api/revenue/clients/:id"
  return HttpRouter.empty.pipe(
    HttpRouter.get(base, business((session, businessId) => Effect.gen(function*() {
      const config = yield* adsConfig
      const c = yield* active(session.accountId, businessId)
      const { ciphertext: _c, ...connection } = c ?? { ciphertext: null }
      return yield* json(200, { configured: config.stripe.configured, connection: c ? connection : null }, PRIVATE)
    }))),
    HttpRouter.post(`${base}/stripe`, business((session, businessId) => Effect.gen(function*() {
      const input = decode(ConnectStripe, yield* readJson)
      if (!input) return yield* refuse("InvalidRequest")
      const kind = stripeKeyKind(input.key)
      // A full secret key could charge and refund: never kept, never used.
      if (!kind.ok) return yield* refuse(kind.reason === "SECRET_KEY" ? "SecretKeyRefused" : "NotARestrictedKey")
      const { stripe, cipher } = yield* stripeOf
      const key = input.key.trim()
      // The key must work and be allowed to read charges before it is kept.
      const probe = yield* call(() => stripeRevenue(stripe, key, adWindows(Date.now(), 7).current)).pipe(Effect.either)
      if (probe._tag === "Left") return yield* refuse(probe.left.kind === "AUTH" ? "KeyInvalid" : probe.left.kind === "FORBIDDEN" ? "KeyCannotReadCharges" : "ProviderUnavailable")
      const account = yield* call(() => stripeAccount(stripe, key)).pipe(Effect.orElseSucceed(() => ({ id: null, name: null })))
      const id = randomUUID()
      const sql = yield* SqlClient.SqlClient
      yield* sql.withTransaction(Effect.gen(function*() {
        yield* sql`UPDATE revenue_connections SET status = 'DISCONNECTED', key_ciphertext = NULL, disconnected_at = now()
          WHERE account_id = ${session.accountId} AND business_id = ${businessId} AND provider = 'stripe' AND status <> 'DISCONNECTED'`
        yield* sql`INSERT INTO revenue_connections(id, account_id, business_id, provider, external_account, display_name, livemode, key_ciphertext, key_last4, connected_by_user_id)
          VALUES (${id}, ${session.accountId}, ${businessId}, 'stripe', ${account.id}, ${(account.name ?? "Stripe account").slice(0, 200)}, ${kind.livemode},
            ${cipher.encrypt(key, `revenue:${id}:key`)}, ${kind.last4}, ${session.userId})`
      }))
      const { ciphertext: _c, ...connection } = (yield* active(session.accountId, businessId))!
      return yield* json(200, { connection }, PRIVATE)
    }))),
    HttpRouter.post(`${base}/stripe/disconnect`, business((session, businessId) => Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      yield* sql`UPDATE revenue_connections SET status = 'DISCONNECTED', key_ciphertext = NULL, disconnected_at = now()
        WHERE account_id = ${session.accountId} AND business_id = ${businessId} AND provider = 'stripe' AND status <> 'DISCONNECTED'`
      return yield* json(200, { disconnected: true }, PRIVATE)
    }))),
    HttpRouter.get(`${base}/performance`, business((session, businessId) => Effect.gen(function*() {
      const request = yield* HttpServerRequest.HttpServerRequest
      const raw = Number(new URL(request.url, "http://localhost").searchParams.get("days") ?? 28)
      const days = AD_PERFORMANCE_DAYS.find(d => d === raw)
      if (!days) return yield* refuse("InvalidRequest")
      return yield* json(200, { revenue: yield* revenuePerformance(session.accountId, businessId, days) }, PRIVATE)
    }))),
  )
}
