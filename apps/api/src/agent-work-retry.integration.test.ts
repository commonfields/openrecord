import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { Effect, Layer, Redacted } from "effect"
import { PgClient } from "@effect/sql-pg"
import type { SqlClient } from "@effect/sql"
import pg from "pg"
import { AgentModelError } from "./agent-model.js"
import { AgentWorkRetry, MAX_WORK_ATTEMPTS, claimAgentWork, enqueueAgentWork, executeAgentWork, retryDelaySeconds } from "./agent-work-queue.js"
import { retryableTurnFailure } from "./unattended-agent.js"
import { capabilityStats, rankCapabilities } from "./capabilities/discovery.js"

const url = process.env["TEST_DATABASE_URL"] ?? ""
const suite = url ? describe : describe.skip

suite("agent work retries and measured capabilities (disposable PostgreSQL, no live model)", () => {
  const pool = new pg.Pool({ connectionString: url })
  const sql = PgClient.layer({ url: Redacted.make(url) })
  // Handlers are replaced in these tests, so only the database is needed.
  const run = <A, E, R>(fx: Effect.Effect<A, E, R>) => Effect.runPromise((fx as Effect.Effect<A, E, SqlClient.SqlClient>).pipe(Effect.provide(Layer.orDie(sql))))
  beforeAll(async () => {
    await pool.query(readFileSync(new URL("../../../packages/db/migrations/0103_agent_retry_and_continuation.sql", import.meta.url), "utf8"))
  })
  // Claims take the oldest queued job anywhere; leftovers from other files would be claimed first.
  beforeEach(async () => { await pool.query("UPDATE agent_work_jobs SET status='CANCELLED', finished_at=now() WHERE status IN ('QUEUED','RUNNING')") })
  afterAll(async () => { await pool.end() })

  const fixture = async () => {
    const accountId = (await pool.query("INSERT INTO accounts(name) VALUES('TEST retry') RETURNING id")).rows[0].id as string
    const userId = (await pool.query("INSERT INTO users(email,password_hash) VALUES($1,'TEST') RETURNING id", [`retry-${randomUUID()}@example.test`])).rows[0].id as string
    await pool.query("INSERT INTO account_users(account_id,user_id) VALUES($1,$2)", [accountId, userId])
    const businessId = (await pool.query("INSERT INTO businesses(account_id,name) VALUES($1,'TEST retry') RETURNING id", [accountId])).rows[0].id as string
    const conversationId = (await pool.query("INSERT INTO agent_conversations(account_id,user_id,business_id,archived_at) VALUES($1,$2,$3,now()) RETURNING id", [accountId, userId, businessId])).rows[0].id as string
    return { accountId, userId, businessId, conversationId }
  }
  const job = (id: string) => pool.query("SELECT status, attempt_count, failure_reason, execution_started_at, available_at > now() + interval '30 seconds' AS later FROM agent_work_jobs WHERE job_id=$1", [id]).then(r => r.rows[0])
  /** A run journal entry: one tool call that started and finished. */
  const runWith = async (f: Awaited<ReturnType<typeof fixture>>, calls: ReadonlyArray<{ tool: string; effect: string; ok: boolean; code?: string }>) => {
    const runId = (await pool.query("INSERT INTO agent_runs(conversation_id,account_id,business_id,user_id,request_id,lease_id,objective) VALUES($1,$2,$3,$4,$5,$6,'TEST') RETURNING id",
      [f.conversationId, f.accountId, f.businessId, f.userId, randomUUID(), randomUUID()])).rows[0].id as string
    let seq = 0
    for (const c of calls) {
      const invocationId = randomUUID()
      await pool.query("INSERT INTO agent_run_events(run_id,seq,type,payload,created_at) VALUES($1,$2,'TOOL_STARTED',$3,now()-interval '3 seconds')", [runId, seq++, { invocationId, tool: c.tool, effect: c.effect }])
      await pool.query("INSERT INTO agent_run_events(run_id,seq,type,payload) VALUES($1,$2,$3,$4)",
        [runId, seq++, c.ok ? "TOOL_COMPLETED" : "TOOL_FAILED", { invocationId, tool: c.tool, effect: c.effect, ...(c.code ? { code: c.code } : {}) }])
    }
  }

  it("runs a job again after a growing delay when its handler saved nothing, and stops at the last attempt", async () => {
    const f = await fixture()
    const id = await run(enqueueAgentWork({ ...f, kind: "GROWTH_BRIEF_WRITE", refId: randomUUID(), payload: {} }))
    if (!id) throw new Error("not queued")
    const seen: Array<boolean | undefined> = []
    const failing = (_kind: unknown, _payload: unknown, tries: { finalAttempt?: boolean }) => {
      seen.push(tries.finalAttempt)
      return Effect.fail(new AgentWorkRetry({ reason: "MODEL_UNAVAILABLE" }))
    }
    for (let attempt = 1; attempt <= MAX_WORK_ATTEMPTS; attempt++) {
      const claimed = await run(claimAgentWork)
      expect(claimed?.job_id).toBe(id)
      await run(executeAgentWork(claimed!, failing))
      const row = await job(id)
      expect(row.attempt_count).toBe(attempt)
      expect(row.failure_reason).toBe("MODEL_UNAVAILABLE")
      if (attempt < MAX_WORK_ATTEMPTS) {
        // Waiting for its delay: queued again, not claimable yet, and not counted as started.
        expect(row).toMatchObject({ status: "QUEUED", execution_started_at: null, later: true })
        expect(await run(claimAgentWork)).toBeNull()
        await pool.query("UPDATE agent_work_jobs SET available_at=now()-interval '1 second' WHERE job_id=$1", [id])
      } else expect(row.status).toBe("FAILED")
    }
    expect(seen).toEqual([false, false, false, true])
    expect([1, 2, 3].map(retryDelaySeconds)).toEqual([60, 180, 540])
  })

  it("never runs again after any other failure once execution started", async () => {
    const f = await fixture()
    const id = await run(enqueueAgentWork({ ...f, kind: "GROWTH_BRIEF_WRITE", refId: randomUUID(), payload: {} }))
    const claimed = await run(claimAgentWork)
    await run(executeAgentWork(claimed!, () => Effect.fail("HELPER_TASK_FAILED" as const)))
    expect(await job(id!)).toMatchObject({ status: "FAILED", attempt_count: 1, failure_reason: "HELPER_TASK_FAILED" })
    expect(await run(claimAgentWork)).toBeNull()
  })

  it("retries a turn only for a passing model failure, and never after it saved work", async () => {
    const f = await fixture(), since = new Date(Date.now() - 60_000)
    const down = new AgentModelError({ reason: "UNAVAILABLE" })
    expect(await run(retryableTurnFailure(down, f.conversationId, since))).toBe("MODEL_UNAVAILABLE")
    expect(await run(retryableTurnFailure(new AgentModelError({ reason: "UNCONFIGURED" }), f.conversationId, since))).toBe("MODEL_UNCONFIGURED")
    expect(await run(retryableTurnFailure(new AgentModelError({ reason: "CANCELLED" }), f.conversationId, since))).toBeNull()
    expect(await run(retryableTurnFailure(new Error("boom"), f.conversationId, since))).toBeNull()
    // Reads that finished do not block a retry; a save does.
    await runWith(f, [{ tool: "read_results", effect: "read", ok: true }])
    expect(await run(retryableTurnFailure(down, f.conversationId, since))).toBe("MODEL_UNAVAILABLE")
    await runWith(f, [{ tool: "propose_growth_opportunity", effect: "propose", ok: true }])
    expect(await run(retryableTurnFailure(down, f.conversationId, since))).toBeNull()
    // Work saved before this attempt began is not this attempt's.
    expect(await run(retryableTurnFailure(down, f.conversationId, new Date(Date.now() + 60_000)))).toBe("MODEL_UNAVAILABLE")
  })

  it("measures tools from this account's runs only, ignores the model's own mistakes, and lists unreliable ones last", async () => {
    const f = await fixture(), other = await fixture()
    await runWith(f, [
      ...Array.from({ length: 5 }, () => ({ tool: "read_proposals", effect: "read", ok: false })),
      { tool: "read_proposals", effect: "read", ok: true },
      { tool: "read_proposals", effect: "read", ok: false, code: "INVALID_INPUT" },
      ...Array.from({ length: 6 }, () => ({ tool: "analyse_prompts", effect: "read", ok: true })),
    ])
    await runWith(other, Array.from({ length: 9 }, () => ({ tool: "read_proposals", effect: "read", ok: true })))
    const stats = await run(capabilityStats(f.accountId, ["read_proposals", "analyse_prompts", "read_results"]))
    expect(stats.get("read_proposals")).toEqual({ calls: 6, succeeded: 1, medianSeconds: 3 })
    expect(stats.get("analyse_prompts")).toMatchObject({ calls: 6, succeeded: 6 })
    expect(stats.has("read_results")).toBe(false)
    const ranked = rankCapabilities(["read_proposals", "analyse_prompts", "read_results"], stats)
    expect(ranked.map(m => m.name)).toEqual(["analyse_prompts", "read_results", "read_proposals"])
    expect(ranked.find(m => m.name === "read_proposals")?.measured).toEqual({ calls: 6, successRate: 0.17, medianSeconds: 3 })
    expect(ranked.find(m => m.name === "read_results")?.measured).toBeNull()
  })
})
