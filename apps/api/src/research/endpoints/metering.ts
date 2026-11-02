// Research call metering: whose credential serves a call, what it costs, and
// the account's prepaid research credit.
//
// The credential ladder, in order, for an endpoint whose provider takes a
// credential:
//   1. BUSINESS  the business's own connection. Never metered: the business
//                pays its provider directly.
//   2. PUBLIC    the provider needs no credential (or it is optional and none
//                is connected). Never metered.
//   3. PLATFORM  OpenRecord's own provider account, configured on the server
//                (Provider.platformKeyEnv). Only for endpoints with a
//                published price; an unpriced endpoint is refused, never
//                served free. The price is taken from the account's credit
//                before the call and returned if the call fails.
// The business's own connection always wins over the platform account.
// Nothing chooses or substitutes a different provider: the ladder only
// decides whose credential calls the provider the endpoint names.
import { SqlClient } from "@effect/sql"
import { Effect } from "effect"
import type { AnyEndpoint, Provider } from "./types.js"

export type CredentialSource = "BUSINESS" | "PUBLIC" | "PLATFORM"

/** OpenRecord's own credential for a provider, from the server environment; null when not configured. */
export const platformKey = (p: Provider, env: NodeJS.ProcessEnv = process.env) => {
  const v = p.platformKeyEnv ? env[p.platformKeyEnv]?.trim() : undefined
  return v ? v : null
}

/**
 * What OpenRecord charges for an endpoint on its own account: the server's
 * RESEARCH_PRICES_MICRO setting ("seo.serp=5000,seo.backlinks=30000",
 * micro-dollars per call) wins over the endpoint's own price. Null when
 * neither sets one; such an endpoint is never served on OpenRecord's account.
 */
export const priceOf = (e: AnyEndpoint, env: NodeJS.ProcessEnv = process.env): number | null => {
  for (const part of (env["RESEARCH_PRICES_MICRO"] ?? "").split(",")) {
    const [id, value] = part.split("=").map(x => x.trim())
    const n = Number(value)
    if (id === e.id && Number.isSafeInteger(n) && n > 0) return n
  }
  return e.price && Number.isSafeInteger(e.price.microUsd) && e.price.microUsd > 0 ? e.price.microUsd : null
}

export type Route =
  | { readonly kind: "serve"; readonly source: CredentialSource; readonly secret: string | null; readonly costMicro: number }
  | { readonly kind: "refuse"; readonly reason: "NOT_CONNECTED" | "UNPRICED" }

/** Picks whose credential serves one call. `business` is the business's own decrypted credential, if any. */
export const route = (e: AnyEndpoint, p: Provider, business: string | null, needsCredential: boolean, env: NodeJS.ProcessEnv = process.env): Route => {
  if (business) return { kind: "serve", source: "BUSINESS", secret: business, costMicro: 0 }
  if (!needsCredential) return { kind: "serve", source: "PUBLIC", secret: null, costMicro: 0 }
  const key = platformKey(p, env)
  if (!key) return { kind: "refuse", reason: "NOT_CONNECTED" }
  const price = priceOf(e, env)
  if (price === null) return { kind: "refuse", reason: "UNPRICED" }
  return { kind: "serve", source: "PLATFORM", secret: key, costMicro: price }
}

/** Whether the platform account can serve an endpoint at all (configured and priced). */
export const platformServes = (e: AnyEndpoint, p: Provider, env: NodeJS.ProcessEnv = process.env) => priceOf(e, env) !== null && platformKey(p, env) !== null

export const usd = (micro: number) => `$${(micro / 1_000_000).toFixed(micro % 10_000 === 0 ? 2 : 4)}`

const lock = (sql: SqlClient.SqlClient, accountId: string) => sql`SELECT pg_advisory_xact_lock(hashtextextended(${`research-credit:${accountId}`}, 0))`
const sum = (rows: ReadonlyArray<Record<string, unknown>>) => Number(rows[0]?.["balance"] ?? 0)

/** The account's research credit in micro-dollars. */
export const balanceOf = (accountId: string) => Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  return sum(yield* sql`SELECT COALESCE(sum(amount_micro), 0)::bigint AS balance FROM research_credit_entries WHERE account_id = ${accountId}`)
})

export interface CallStart { readonly accountId: string; readonly businessId: string; readonly endpoint: string; readonly provider: string; readonly source: CredentialSource; readonly costMicro: number }
export type Started = { readonly kind: "started"; readonly callId: string } | { readonly kind: "insufficient"; readonly balanceMicro: number; readonly costMicro: number }

/**
 * Records a call before it is made. A platform-served call takes its price
 * from the credit in the same transaction, serialised per account, so two
 * concurrent calls cannot both spend the last of it.
 */
export const startCall = (c: CallStart) => Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  return yield* sql.withTransaction(Effect.gen(function*() {
    if (c.costMicro > 0) {
      yield* lock(sql, c.accountId)
      const balance = sum(yield* sql`SELECT COALESCE(sum(amount_micro), 0)::bigint AS balance FROM research_credit_entries WHERE account_id = ${c.accountId}`)
      if (balance < c.costMicro) return { kind: "insufficient", balanceMicro: balance, costMicro: c.costMicro } satisfies Started
    }
    const id = String((yield* sql`INSERT INTO research_calls(account_id, business_id, endpoint, provider, credential_source, status, cost_micro)
      VALUES (${c.accountId}, ${c.businessId}, ${c.endpoint}, ${c.provider}, ${c.source}, 'PENDING', ${c.costMicro}) RETURNING id`)[0]!["id"])
    if (c.costMicro > 0) yield* sql`INSERT INTO research_credit_entries(account_id, kind, amount_micro, call_id) VALUES (${c.accountId}, 'CHARGE', ${-c.costMicro}, ${id})`
    return { kind: "started", callId: id } satisfies Started
  }))
})

/** Settles a call. A failed paid call gets its charge back, once. */
export const finishCall = (callId: string, outcome: { readonly ok: true } | { readonly ok: false; readonly failure: string }) => Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql.withTransaction(Effect.gen(function*() {
    const failure = outcome.ok ? null : outcome.failure.replace(/[^A-Z_]/g, "").slice(0, 40) || "FAILED"
    const rows = yield* sql`UPDATE research_calls SET status = ${outcome.ok ? "SUCCEEDED" : "FAILED"}, failure = ${failure}, finished_at = now(),
      duration_ms = GREATEST(0, (extract(epoch FROM (now() - started_at)) * 1000)::int)
      WHERE id = ${callId} AND status = 'PENDING' RETURNING account_id, cost_micro`
    const r = rows[0]
    if (!outcome.ok && r && Number(r["cost_micro"]) > 0)
      yield* sql`INSERT INTO research_credit_entries(account_id, kind, amount_micro, call_id) VALUES (${String(r["account_id"])}, 'REFUND', ${Number(r["cost_micro"])}, ${callId})
        ON CONFLICT (call_id, kind) WHERE call_id IS NOT NULL DO NOTHING`
  }))
})

/** Adds credit to an account (an operator top-up). */
export const addCredit = (accountId: string, amountMicro: number, note: string, userId: string | null) => Effect.gen(function*() {
  if (!Number.isSafeInteger(amountMicro) || amountMicro <= 0) return yield* Effect.dieMessage("credit must be a positive whole number of micro-dollars")
  const sql = yield* SqlClient.SqlClient
  yield* sql`INSERT INTO research_credit_entries(account_id, kind, amount_micro, note, created_by_user_id) VALUES (${accountId}, 'TOPUP', ${amountMicro}, ${note.slice(0, 200)}, ${userId})`
  return yield* balanceOf(accountId)
})

export interface CallRow {
  readonly id: string; readonly businessId: string; readonly endpoint: string; readonly provider: string; readonly credentialSource: CredentialSource
  readonly status: "PENDING" | "SUCCEEDED" | "FAILED"; readonly failure: string | null; readonly costMicro: number; readonly refunded: boolean
  readonly startedAt: string; readonly durationMs: number | null
}
/** The account's most recent calls, newest first, optionally for one business. */
export const recentCalls = (accountId: string, businessId: string | null, limit: number) => Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql`SELECT c.id, c.business_id, c.endpoint, c.provider, c.credential_source, c.status, c.failure, c.cost_micro, c.started_at, c.duration_ms,
      EXISTS (SELECT 1 FROM research_credit_entries r WHERE r.call_id = c.id AND r.kind = 'REFUND') AS refunded
    FROM research_calls c WHERE c.account_id = ${accountId} AND (${businessId}::uuid IS NULL OR c.business_id = ${businessId}::uuid)
    ORDER BY c.started_at DESC, c.id LIMIT ${limit}`
  return rows.map((r): CallRow => ({ id: String(r["id"]), businessId: String(r["business_id"]), endpoint: String(r["endpoint"]), provider: String(r["provider"]),
    credentialSource: r["credential_source"] as CredentialSource, status: r["status"] as CallRow["status"], failure: (r["failure"] as string | null) ?? null,
    costMicro: Number(r["cost_micro"]), refunded: r["refunded"] === true, startedAt: new Date(r["started_at"] as string).toISOString(),
    durationMs: r["duration_ms"] === null ? null : Number(r["duration_ms"]) }))
})

/** Spend over the last `days` days: calls, paid calls, and net micro-dollars charged. */
export const spendSince = (accountId: string, days: number) => Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const r = (yield* sql`SELECT count(*)::int AS calls, count(*) FILTER (WHERE credential_source = 'PLATFORM')::int AS paid,
      COALESCE((SELECT -sum(amount_micro) FROM research_credit_entries e WHERE e.account_id = ${accountId} AND e.kind IN ('CHARGE', 'REFUND') AND e.created_at >= now() - make_interval(days => ${days})), 0)::bigint AS spent
    FROM research_calls WHERE account_id = ${accountId} AND started_at >= now() - make_interval(days => ${days})`)[0]
  return { calls: Number(r?.["calls"] ?? 0), paidCalls: Number(r?.["paid"] ?? 0), spentMicro: Number(r?.["spent"] ?? 0) }
})
