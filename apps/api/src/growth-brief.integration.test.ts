// The weekly growth brief against a disposable database with a fixture sender
// in place of a model: one brief at a time per business, written in its own
// titled chat, the model the person last used tried first, the hosted model
// as the fallback, failures recorded as a code, and the weekly schedule's lease.
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Effect, ManagedRuntime, Redacted } from "effect"
import { PgClient } from "@effect/sql-pg"
import pg from "pg"
import { runDueBriefs, startBrief, BRIEF_PROMPT, type BriefSender } from "./growth-brief.js"

const url = process.env["TEST_DATABASE_URL"] ?? ""
const suite = url ? describe : describe.skip

suite("weekly growth brief (disposable PostgreSQL, fixture model)", () => {
  // One runtime for the whole suite, as in the server: a brief keeps writing after startBrief returns.
  const runtime = ManagedRuntime.make(PgClient.layer({ url: Redacted.make(url) }))
  const run = <A, E>(fx: Effect.Effect<A, E, import("@effect/sql").SqlClient.SqlClient>) => runtime.runPromise(fx)
  let pool: pg.Pool
  beforeAll(() => { pool = new pg.Pool({ connectionString: url }) })
  afterAll(async () => { await runtime.dispose(); await pool.end() })

  const setup = async () => {
    const accountId = String((await pool.query("INSERT INTO accounts(name) VALUES('TEST brief') RETURNING id")).rows[0].id)
    const userId = String((await pool.query("INSERT INTO users(email,password_hash) VALUES($1,'TEST') RETURNING id", [`brief-${randomUUID()}@example.test`])).rows[0].id)
    await pool.query("INSERT INTO account_users(account_id,user_id) VALUES($1,$2)", [accountId, userId])
    const businessId = String((await pool.query("INSERT INTO businesses(account_id,name) VALUES($1,'TEST Salon') RETURNING id", [accountId])).rows[0].id)
    return { accountId, userId, businessId }
  }
  const settled = async (id: string) => {
    for (let i = 0; i < 100; i++) {
      const row = (await pool.query("SELECT * FROM growth_briefs WHERE id=$1", [id])).rows[0]
      if (row.status !== "RUNNING") return row
      await new Promise(r => setTimeout(r, 50))
    }
    throw new Error("brief never finished")
  }

  it("writes one brief at a time in its own chat, trying the person's model before the hosted one", async () => {
    const scope = await setup()
    // The person last used a subscription model for this business.
    await pool.query(`INSERT INTO agent_conversations(account_id,business_id,user_id,messages) VALUES($1,$2,$3,$4::jsonb)`, [scope.accountId, scope.businessId, scope.userId,
      JSON.stringify([{ role: "user", text: "hi" }, { role: "agent", text: "hello", inference: { provider: "codex", requestedModel: "gpt-5", instanceId: "11111111-1111-4111-8111-111111111111", usage: [] } }])])
    const calls: Array<{ selection: unknown; message: string; conversationId: string }> = []
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const sender: BriefSender<never> = (_scope, body) => Effect.promise(async () => {
      calls.push(body)
      await gate
      // The subscription is gone; the hosted model answers.
      if (body.selection) throw new Error("instance unavailable")
      return { reply: "**What changed**\n- Clicks up 12%", decisions: [{ type: "GROWTH_OPPORTUNITY", id: randomUUID() }], provider: "gemini", requestedModel: "gemini-2.5-pro" }
    }).pipe(Effect.catchAllDefect(e => Effect.fail(e)))
    const first = await run(startBrief(scope, "MANUAL", sender))
    const again = await run(startBrief(scope, "SCHEDULE", sender))
    expect(again.id).toBe(first.id)
    release()
    const done = await settled(first.id)
    expect(done).toMatchObject({ status: "READY", text: "**What changed**\n- Clicks up 12%", provider: "gemini", model: "gemini-2.5-pro", trigger: "MANUAL" })
    expect(done.decisions).toHaveLength(1)
    expect(calls.map(c => c.selection)).toEqual([{ instanceId: "11111111-1111-4111-8111-111111111111", model: "gpt-5" }, undefined])
    expect(calls[0]!.message).toBe(BRIEF_PROMPT(new Date().toISOString().slice(0, 10)))
    const chat = (await pool.query("SELECT archived_at, last_reply->>'title' AS title FROM agent_conversations WHERE id=$1", [first.conversationId])).rows[0]
    expect(chat.archived_at).not.toBeNull()
    expect(chat.title).toMatch(/^Weekly brief for [A-Z][a-z]{2} \d{1,2}$/)
  })

  it("records a failure as a code, and the schedule runs a due brief once and moves a week ahead", async () => {
    const scope = await setup()
    const failing: BriefSender<never> = () => Effect.fail({ _tag: "AgentModelError", reason: "UNCONFIGURED" })
    const brief = await run(startBrief(scope, "MANUAL", failing))
    expect(await settled(brief.id)).toMatchObject({ status: "FAILED", failure: "MODEL_UNCONFIGURED", text: null })

    await pool.query("INSERT INTO growth_brief_schedules(business_id,account_id,user_id,next_run_at) VALUES($1,$2,$3,now() - interval '1 minute')", [scope.businessId, scope.accountId, scope.userId])
    // Only this business's schedule matters here; others in the database may also be due.
    const before = (await pool.query("SELECT count(*)::int AS n FROM growth_briefs WHERE business_id=$1", [scope.businessId])).rows[0].n
    const quiet: BriefSender<never> = () => Effect.succeed({ reply: "Brief", decisions: [] })
    await run(runDueBriefs(quiet))
    const schedule = (await pool.query("SELECT next_run_at, lease_until FROM growth_brief_schedules WHERE business_id=$1", [scope.businessId])).rows[0]
    expect(new Date(schedule.next_run_at).getTime()).toBeGreaterThan(Date.now() + 86_400_000)
    expect(schedule.lease_until).not.toBeNull()
    const after = (await pool.query("SELECT count(*)::int AS n FROM growth_briefs WHERE business_id=$1", [scope.businessId])).rows[0].n
    expect(after).toBe(before + 1)
    // Not due again until next week.
    await run(runDueBriefs(quiet))
    expect((await pool.query("SELECT count(*)::int AS n FROM growth_briefs WHERE business_id=$1", [scope.businessId])).rows[0].n).toBe(after)
    const latest = (await pool.query("SELECT id FROM growth_briefs WHERE business_id=$1 ORDER BY started_at DESC LIMIT 1", [scope.businessId])).rows[0].id
    await settled(latest).catch(() => undefined)
  }, 20000)
})
