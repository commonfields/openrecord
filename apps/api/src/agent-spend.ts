// Spend limits on the hosted agent model.
//
// Every turn, chat or background (follow-ups, campaign milestones, scheduled
// investigations), records its tokens in agent_usage when it finishes. Before
// each model step, the hosted-model paths ask `assertWithinSpend`; once the
// account is over a limit the step fails with SPEND_LIMIT and the chat says
// why and when it resets.
//
// Three limits, each 0 to switch it off:
//   - dollars today and this month (UTC), for models the server has prices
//     for (AGENT_TOKEN_PRICES);
//   - tokens today, so a model without a price is still bounded.
// Server defaults come from AGENT_DAILY_LIMIT_USD, AGENT_MONTHLY_LIMIT_USD and
// AGENT_DAILY_LIMIT_TOKENS; an account_agent_limits row overrides them.
//
// Only the hosted providers count: a subscription reached through the bridge
// is the person's own plan, not billed per token by this server. A turn in
// flight is counted when it finishes, so one turn can run past a limit by at
// most its own step budget; the next step after that is refused.
import { SqlClient } from "@effect/sql"
import { Effect } from "effect"
import { AGENT_PROVIDERS, AgentModelError } from "./agent-model.js"
import { estimate, tokenPrices } from "./usage.js"

export interface SpendLimits { readonly dailyUsd: number; readonly monthlyUsd: number; readonly dailyTokens: number }

const DEFAULTS: SpendLimits = { dailyUsd: 25, monthlyUsd: 300, dailyTokens: 20_000_000 }

const envNumber = (name: string, fallback: number) => {
  const raw = process.env[name]?.trim()
  if (raw === undefined || raw === "") return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

/** The server's defaults; malformed values fall back to the built-in ones. */
export const serverLimits = (): SpendLimits => ({
  dailyUsd: envNumber("AGENT_DAILY_LIMIT_USD", DEFAULTS.dailyUsd),
  monthlyUsd: envNumber("AGENT_MONTHLY_LIMIT_USD", DEFAULTS.monthlyUsd),
  dailyTokens: envNumber("AGENT_DAILY_LIMIT_TOKENS", DEFAULTS.dailyTokens),
})

export const isHostedProvider = (provider: string) => (AGENT_PROVIDERS as ReadonlyArray<string>).includes(provider)

const startOfUtcDay = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
const startOfUtcMonth = (now: Date) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))

export type SpendBlock = "DAILY_USD" | "MONTHLY_USD" | "DAILY_TOKENS"

export interface SpendStatus {
  readonly limits: SpendLimits & { readonly source: { readonly dailyUsd: "account" | "server"; readonly monthlyUsd: "account" | "server"; readonly dailyTokens: "account" | "server" } }
  readonly today: { readonly usd: number; readonly tokens: number; readonly unpricedTurns: number }
  readonly month: { readonly usd: number }
  /** The first limit reached, or null. */
  readonly blocked: SpendBlock | null
  /** When the blocking limit resets (ISO), or null. */
  readonly resetsAt: string | null
}

/** Pure: which limit, if any, the spend has reached. A limit of 0 is off. */
export const blockOf = (limits: SpendLimits, today: { usd: number; tokens: number }, month: { usd: number }): SpendBlock | null =>
  limits.monthlyUsd > 0 && month.usd >= limits.monthlyUsd ? "MONTHLY_USD"
    : limits.dailyUsd > 0 && today.usd >= limits.dailyUsd ? "DAILY_USD"
    : limits.dailyTokens > 0 && today.tokens >= limits.dailyTokens ? "DAILY_TOKENS"
    : null

const num = (v: unknown) => v === null || v === undefined ? null : Number(v)

export const spendStatus = (accountId: string, now = new Date()) => Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const server = serverLimits()
  const row = (yield* sql`SELECT daily_usd, monthly_usd, daily_tokens FROM account_agent_limits WHERE account_id = ${accountId}`)[0]
  const pick = (column: string, fallback: number) => {
    const v = num(row?.[column])
    return v === null ? { value: fallback, source: "server" as const } : { value: v, source: "account" as const }
  }
  const daily = pick("daily_usd", server.dailyUsd), monthly = pick("monthly_usd", server.monthlyUsd), tokens = pick("daily_tokens", server.dailyTokens)
  const limits = { dailyUsd: daily.value, monthlyUsd: monthly.value, dailyTokens: tokens.value,
    source: { dailyUsd: daily.source, monthlyUsd: monthly.source, dailyTokens: tokens.source } }
  const dayStart = startOfUtcDay(now), monthStart = startOfUtcMonth(now)
  const rows = yield* sql`SELECT model, created_at >= ${dayStart.toISOString()} AS today,
      sum(prompt_tokens)::bigint AS prompt, sum(output_tokens)::bigint AS output, sum(thought_tokens)::bigint AS thought,
      sum(coalesce(total_tokens, coalesce(prompt_tokens, 0) + coalesce(output_tokens, 0) + coalesce(thought_tokens, 0)))::bigint AS tokens,
      count(*)::int AS turns
    FROM agent_usage
    WHERE account_id = ${accountId} AND created_at >= ${(dayStart < monthStart ? dayStart : monthStart).toISOString()}
      AND provider IN ${sql.in([...AGENT_PROVIDERS])}
    GROUP BY model, 2`
  const prices = tokenPrices()
  let todayUsd = 0, monthUsd = 0, todayTokens = 0, unpricedTurns = 0
  for (const r of rows) {
    const cost = estimate(prices.get(String(r["model"])), { prompt: num(r["prompt"]), output: num(r["output"]), thought: num(r["thought"]) })
    const isToday = r["today"] === true
    monthUsd += cost ?? 0
    if (isToday) {
      todayUsd += cost ?? 0
      todayTokens += num(r["tokens"]) ?? 0
      if (cost === null) unpricedTurns += Number(r["turns"])
    }
  }
  const today = { usd: todayUsd, tokens: todayTokens, unpricedTurns }
  const month = { usd: monthUsd }
  const blocked = blockOf(limits, today, month)
  const nextDay = new Date(dayStart.getTime() + 86_400_000)
  const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
  return { limits, today, month, blocked, resetsAt: blocked === null ? null : (blocked === "MONTHLY_USD" ? nextMonth : nextDay).toISOString() } satisfies SpendStatus
})

/**
 * Fails with SPEND_LIMIT when the account is over a limit on the hosted
 * model. A database failure here does not stop the turn: the limit is a
 * budget guard, and the usage it reads may simply be unavailable.
 */
export const assertWithinSpend = (accountId: string) =>
  spendStatus(accountId).pipe(
    Effect.catchAll(() => Effect.succeed(null)),
    Effect.flatMap(status => status?.blocked
      ? Effect.fail(new AgentModelError({ reason: "SPEND_LIMIT", detail: status.blocked }))
      : Effect.void),
  )
