// Spend limits on the hosted model, through the real turn path: the Gemini
// adapter behind a fetch stub, so a refused step provably never reaches the
// provider. Disposable PostgreSQL fixtures.
import { randomUUID } from "node:crypto"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { ConfigProvider, Context, Effect, Exit, Layer, Redacted, Scope } from "effect"
import { PgClient } from "@effect/sql-pg"
import { SqlClient } from "@effect/sql"
import pg from "pg"
import { handleAgentMessage } from "./agent.js"
import { AgentModelError } from "./agent-model.js"
import { assertWithinSpend, blockOf, spendStatus } from "./agent-spend.js"

const url = process.env["TEST_DATABASE_URL"] ?? ""
const suite = url ? describe : describe.skip

describe("spend limit arithmetic", () => {
  const limits = { dailyUsd: 10, monthlyUsd: 100, dailyTokens: 1000 }
  it("names the first limit reached, monthly first", () => {
    expect(blockOf(limits, { usd: 9.99, tokens: 999 }, { usd: 99 })).toBeNull()
    expect(blockOf(limits, { usd: 10, tokens: 0 }, { usd: 10 })).toBe("DAILY_USD")
    expect(blockOf(limits, { usd: 0, tokens: 1000 }, { usd: 0 })).toBe("DAILY_TOKENS")
    expect(blockOf(limits, { usd: 50, tokens: 5000 }, { usd: 100 })).toBe("MONTHLY_USD")
  })
  it("treats 0 as off", () => {
    expect(blockOf({ dailyUsd: 0, monthlyUsd: 0, dailyTokens: 0 }, { usd: 1e9, tokens: 1e12 }, { usd: 1e9 })).toBeNull()
  })
})

suite("spend limits (TEST fixtures)", () => {
  let pool: pg.Pool, scope: Scope.CloseableScope, ctx: Context.Context<SqlClient.SqlClient>
  const layer = PgClient.layer({ url: Redacted.make(url) })
  const run = <A, E>(fx: Effect.Effect<A, E, never>) => Effect.runPromise(Effect.provide(fx as Effect.Effect<A, E, SqlClient.SqlClient>, ctx))
  const env = { AGENT_TOKEN_PRICES: process.env["AGENT_TOKEN_PRICES"], AGENT_DAILY_LIMIT_TOKENS: process.env["AGENT_DAILY_LIMIT_TOKENS"] }
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url }); scope = await Effect.runPromise(Scope.make())
    ctx = await Effect.runPromise(Layer.buildWithScope(layer, scope)) as Context.Context<SqlClient.SqlClient>
    // $1 per million tokens each way, so dollars are easy to read.
    process.env["AGENT_TOKEN_PRICES"] = "gemini-fixture=1/1"
    process.env["AGENT_DAILY_LIMIT_TOKENS"] = "0"
  })
  afterEach(() => { vi.unstubAllGlobals() })
  afterAll(async () => {
    for (const [k, v] of Object.entries(env)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
    await Effect.runPromise(Scope.close(scope, Exit.void)); await pool.end()
  })

  const account = async () => {
    const accountId = String((await pool.query("INSERT INTO accounts(name) VALUES('TEST spend') RETURNING id")).rows[0].id)
    const userId = String((await pool.query("INSERT INTO users(email,password_hash) VALUES($1,'TEST-only') RETURNING id", [`spend-${randomUUID()}@example.test`])).rows[0].id)
    await pool.query("INSERT INTO account_users(account_id,user_id) VALUES($1,$2)", [accountId, userId])
    return { accountId, userId }
  }
  /** One finished turn's usage row, `tokens` each of prompt and output. */
  const used = (a: { accountId: string; userId: string }, tokens: number, opts: { provider?: string; model?: string; at?: string } = {}) => pool.query(
    `INSERT INTO agent_usage(account_id,user_id,run_id,provider,model,model_steps,tool_calls,prompt_tokens,output_tokens,total_tokens,created_at)
     VALUES($1,$2,$3,$4,$5,1,0,$6::bigint,$6::bigint,$6::bigint*2,COALESCE($7::timestamptz, now()))`,
    [a.accountId, a.userId, randomUUID(), opts.provider ?? "gemini", opts.model ?? "gemini-fixture", tokens, opts.at ?? null])
  const limits = (a: { accountId: string }, daily: number | null, monthly: number | null) =>
    pool.query("INSERT INTO account_agent_limits(account_id,daily_usd,monthly_usd) VALUES($1,$2,$3) ON CONFLICT (account_id) DO UPDATE SET daily_usd=$2, monthly_usd=$3", [a.accountId, daily, monthly])

  const turn = async (a: { accountId: string; userId: string }) => {
    let calls = 0
    vi.stubGlobal("fetch", async (input: string) => {
      if (new URL(input).host !== "generativelanguage.googleapis.com") throw new Error("unexpected network access")
      calls++
      return new Response(JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "TEST hello" }] }, finishReason: "STOP" }] }), { status: 200 })
    })
    const config = ConfigProvider.fromMap(new Map([["AGENT_EXTERNAL_PROCESSING_ENABLED", "true"], ["AGENT_PROVIDER", "gemini"], ["AGENT_MODEL", "gemini-fixture"], ["AGENT_API_KEY", "TEST-not-a-key"]]))
    const result = await run(Effect.either(handleAgentMessage(a.accountId, a.userId, null, "Hello", []).pipe(Effect.withConfigProvider(config))) as never) as
      { _tag: "Left"; left: unknown } | { _tag: "Right"; right: { text: string } }
    return { result, calls }
  }

  it("refuses the hosted model once the account is over its daily dollars, before any provider call", async () => {
    const a = await account()
    await limits(a, 5, null)
    await used(a, 2_000_000) // $4
    expect((await turn(a)).result._tag).toBe("Right")
    await used(a, 1_000_000) // $6 in all
    const blocked = await turn(a)
    expect(blocked.calls).toBe(0)
    expect(blocked.result._tag).toBe("Left")
    const error = (blocked.result as { left: unknown }).left
    expect(error).toBeInstanceOf(AgentModelError)
    expect(error).toMatchObject({ reason: "SPEND_LIMIT", detail: "DAILY_USD" })
    const status = await run(spendStatus(a.accountId) as never) as { blocked: string; resetsAt: string; today: { usd: number } }
    expect(status.blocked).toBe("DAILY_USD")
    expect(status.today.usd).toBeCloseTo(6)
    expect(new Date(status.resetsAt).getUTCHours()).toBe(0)
    // Switched off for this account: the next turn runs.
    await limits(a, 0, 0)
    expect((await turn(a)).result._tag).toBe("Right")
  })

  it("counts the month for the monthly limit and only today for the daily one", async () => {
    const a = await account()
    const now = new Date()
    // Earlier this month but not today, when today is not the 1st.
    if (now.getUTCDate() > 1) await used(a, 10_000_000, { at: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 12)).toISOString() }) // $20
    await limits(a, 5, 15)
    const status = await run(spendStatus(a.accountId) as never) as { blocked: string | null; today: { usd: number }; month: { usd: number } }
    if (now.getUTCDate() > 1) {
      expect(status.today.usd).toBe(0)
      expect(status.month.usd).toBeCloseTo(20)
      expect(status.blocked).toBe("MONTHLY_USD")
    } else expect(status.blocked).toBeNull()
  })

  it("leaves the person's own subscriptions and other accounts out", async () => {
    const a = await account()
    const b = await account()
    await limits(a, 1, null)
    await used(a, 50_000_000, { provider: "codex", model: "gemini-fixture" }) // a bridge subscription, not metered here
    await used(b, 50_000_000)
    expect(await run(Effect.either(assertWithinSpend(a.accountId)) as never)).toMatchObject({ _tag: "Right" })
  })

  it("bounds unpriced models by tokens", async () => {
    const a = await account()
    await pool.query("INSERT INTO account_agent_limits(account_id,daily_tokens) VALUES($1,1000)", [a.accountId])
    await used(a, 600, { model: "unpriced-model" }) // 1,200 tokens, no price
    const status = await run(spendStatus(a.accountId) as never) as { blocked: string | null; today: { usd: number; tokens: number; unpricedTurns: number } }
    expect(status.today).toMatchObject({ usd: 0, tokens: 1200, unpricedTurns: 1 })
    expect(status.blocked).toBe("DAILY_TOKENS")
  })
})
