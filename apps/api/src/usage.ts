// Usage and cost for an account: what its agent turns, research provider calls
// and AI answer checks used over a period.
//
//   GET /api/usage?days=30
//
// Token counts are as each provider reported them; a turn whose provider
// reported none is counted, with its tokens unknown, never zero. Estimated
// model cost appears only for models the server has prices for
// (AGENT_TOKEN_PRICES, "model=input/output" in dollars per million tokens,
// comma-separated); it is an estimate at those prices, not a bill, and
// subscription-based providers are not billed per token at all. Research
// spend is what OpenRecord actually charged from research credit.
import { SqlClient } from "@effect/sql"
import { HttpRouter, HttpServerRequest } from "@effect/platform"
import { Effect } from "effect"
import { json, type WithSession } from "./record-routes.js"

export interface TokenPrice { readonly inputPerM: number; readonly outputPerM: number }

/** Server-set prices per model, from AGENT_TOKEN_PRICES ("gemini-2.5-flash=0.30/2.50,..."); malformed entries are ignored. */
export const tokenPrices = (raw = process.env["AGENT_TOKEN_PRICES"] ?? ""): ReadonlyMap<string, TokenPrice> => {
  const out = new Map<string, TokenPrice>()
  for (const part of raw.split(",")) {
    const m = /^\s*([A-Za-z0-9._:/-]{1,200})\s*=\s*(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)\s*$/.exec(part)
    if (m) out.set(m[1]!, { inputPerM: Number(m[2]), outputPerM: Number(m[3]) })
  }
  return out
}

/** Estimated dollars for a model's tokens, or null when the model has no price or no reported tokens. Reasoning is billed as output. */
export const estimate = (price: TokenPrice | undefined, t: { prompt: number | null; output: number | null; thought: number | null }) => {
  if (!price || (t.prompt === null && t.output === null && t.thought === null)) return null
  return ((t.prompt ?? 0) * price.inputPerM + ((t.output ?? 0) + (t.thought ?? 0)) * price.outputPerM) / 1_000_000
}

const n = (v: unknown) => v === null || v === undefined ? null : Number(v)

export const loadUsage = (accountId: string, days: number) => Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const since = new Date(Date.now() - days * 86_400_000).toISOString()
  const prices = tokenPrices()
  const totals = (yield* sql`SELECT count(*)::int AS turns, sum(prompt_tokens)::bigint AS prompt, sum(output_tokens)::bigint AS output, sum(thought_tokens)::bigint AS thought,
      sum(total_tokens)::bigint AS total, sum(tool_calls)::int AS tools, sum(model_steps)::int AS steps, avg(duration_ms)::int AS avg_ms,
      count(*) FILTER (WHERE total_tokens IS NULL AND prompt_tokens IS NULL)::int AS unreported
    FROM agent_usage WHERE account_id = ${accountId} AND created_at >= ${since}`)[0] ?? {}
  const byModelRows = yield* sql`SELECT provider, model, count(*)::int AS turns, sum(prompt_tokens)::bigint AS prompt, sum(output_tokens)::bigint AS output,
      sum(thought_tokens)::bigint AS thought, sum(total_tokens)::bigint AS total, sum(tool_calls)::int AS tools
    FROM agent_usage WHERE account_id = ${accountId} AND created_at >= ${since} GROUP BY provider, model ORDER BY turns DESC LIMIT 30`
  const byModel = byModelRows.map(r => {
    const t = { prompt: n(r["prompt"]), output: n(r["output"]), thought: n(r["thought"]) }
    const cost = estimate(prices.get(String(r["model"])), t)
    return { provider: String(r["provider"]), model: String(r["model"]), turns: Number(r["turns"]), promptTokens: t.prompt, outputTokens: t.output, thoughtTokens: t.thought,
      totalTokens: n(r["total"]), toolCalls: Number(r["tools"] ?? 0), estimatedUsd: cost, priced: prices.has(String(r["model"])) }
  })
  const byBusiness = (yield* sql`SELECT u.business_id, b.name, count(*)::int AS turns, sum(u.total_tokens)::bigint AS total, sum(u.tool_calls)::int AS tools
    FROM agent_usage u LEFT JOIN businesses b ON b.id = u.business_id
    WHERE u.account_id = ${accountId} AND u.created_at >= ${since} GROUP BY u.business_id, b.name ORDER BY turns DESC LIMIT 30`)
    .map(r => ({ businessId: (r["business_id"] as string | null) ?? null, name: (r["name"] as string | null) ?? (r["business_id"] ? "Removed business" : "General chat"),
      turns: Number(r["turns"]), totalTokens: n(r["total"]), toolCalls: Number(r["tools"] ?? 0) }))
  const daily = (yield* sql`WITH days AS (SELECT generate_series((${since}::timestamptz AT TIME ZONE 'UTC')::date, (now() AT TIME ZONE 'UTC')::date, interval '1 day')::date AS day)
    SELECT to_char(d.day, 'YYYY-MM-DD') AS date, count(u.id)::int AS turns, sum(u.total_tokens)::bigint AS total
    FROM days d LEFT JOIN agent_usage u ON (u.created_at AT TIME ZONE 'UTC')::date = d.day AND u.account_id = ${accountId}
    GROUP BY d.day ORDER BY d.day`).map(r => ({ date: String(r["date"]), turns: Number(r["turns"]), totalTokens: n(r["total"]) }))
  const research = (yield* sql`SELECT provider, count(*)::int AS calls, count(*) FILTER (WHERE status = 'FAILED')::int AS failed,
      count(*) FILTER (WHERE credential_source = 'PLATFORM')::int AS paid,
      COALESCE(sum(cost_micro) FILTER (WHERE credential_source = 'PLATFORM' AND status = 'SUCCEEDED'), 0)::bigint AS cost
    FROM research_calls WHERE account_id = ${accountId} AND started_at >= ${since} GROUP BY provider ORDER BY calls DESC LIMIT 40`)
    .map(r => ({ provider: String(r["provider"]), calls: Number(r["calls"]), failed: Number(r["failed"]), paidCalls: Number(r["paid"]), chargedUsd: Number(r["cost"]) / 1_000_000 }))
  const checks = (yield* sql`SELECT o.provider, count(*)::int AS answers FROM observations o JOIN businesses b ON b.id = o.business_id
    WHERE b.account_id = ${accountId} AND o.collected_at >= ${since} GROUP BY o.provider ORDER BY answers DESC LIMIT 20`)
    .map(r => ({ provider: String(r["provider"]), answers: Number(r["answers"]) }))
  const estimated = byModel.filter(m => m.estimatedUsd !== null)
  return {
    days, since,
    agent: { turns: Number(totals["turns"] ?? 0), promptTokens: n(totals["prompt"]), outputTokens: n(totals["output"]), thoughtTokens: n(totals["thought"]), totalTokens: n(totals["total"]),
      toolCalls: Number(totals["tools"] ?? 0), modelSteps: Number(totals["steps"] ?? 0), averageMs: n(totals["avg_ms"]), turnsWithoutTokenCounts: Number(totals["unreported"] ?? 0),
      estimatedUsd: estimated.length ? estimated.reduce((s, m) => s + m.estimatedUsd!, 0) : null, unpricedTurns: byModel.filter(m => !m.priced).reduce((s, m) => s + m.turns, 0) },
    byModel, byBusiness, daily,
    research: { calls: research.reduce((s, r) => s + r.calls, 0), chargedUsd: research.reduce((s, r) => s + r.chargedUsd, 0), byProvider: research },
    checks: { answers: checks.reduce((s, c) => s + c.answers, 0), byProvider: checks },
    note: "Token counts are as each provider reported them. Estimated cost uses the prices this server is configured with and is not a bill; subscription providers are not billed per token. Research charges are what OpenRecord took from research credit.",
  }
})

export const usageApi = (withSession: WithSession) => HttpRouter.empty.pipe(
  HttpRouter.get("/api/usage", withSession(session => Effect.gen(function*() {
    const req = yield* HttpServerRequest.HttpServerRequest
    const days = Number(new URL(req.url, "http://localhost").searchParams.get("days") ?? "30")
    if (!Number.isInteger(days) || days < 1 || days > 365) return yield* json(422, { _tag: "InvalidRequest" })
    return yield* json(200, yield* loadUsage(session.accountId, days), { "cache-control": "no-store" })
  })).pipe(Effect.catchAll(e => json(typeof e === "object" && e !== null && "_tag" in e && e._tag === "NotAuthenticated" ? 401 : 500, { _tag: "UsageUnavailable" })))),
)
