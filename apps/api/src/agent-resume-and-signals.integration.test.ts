// Against a disposable PostgreSQL, with no live model: a chat picks its work
// back up after the owner decides on a card it saved; one chat's background
// work runs in order; the agent's notes about missing capabilities and poor
// results are kept and shape how tools and research sources are ranked.
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { HttpApp, HttpRouter } from "@effect/platform"
import { Effect, Layer, ManagedRuntime, Redacted } from "effect"
import { PgClient } from "@effect/sql-pg"
import pg from "pg"
import { AuthRepositoryLive, BusinessRepositoryLive } from "@openrecord/db"
import { requireSession } from "./router.js"
import { decisionFeedbackApi } from "./decision-feedback.js"
import { decisionResumeMessage, writeDecisionResumeJob } from "./decision-resume.js"
import { capabilitySignalsApi, dispatchCapabilitySignal } from "./capability-signals.js"
import { claimAgentWork, enqueueAgentWork, executeAgentWorkWith, AgentWorkRetry } from "./agent-work-queue.js"
import { AgentConversationRefused } from "./agent-conversations.js"
import { capabilityStats } from "./capabilities/discovery.js"
import { measuredResearch, rankResearch, researchStats } from "./research/ranking.js"
import { CAPABILITIES } from "./research/catalog.js"
import { findResearch } from "./research/tools.js"

const url = process.env["TEST_DATABASE_URL"] ?? ""
const suite = url ? describe : describe.skip

suite("chat resume, ordered work and capability signals (disposable PostgreSQL, no live model)", () => {
  const pool = new pg.Pool({ connectionString: url })
  const repos = Layer.mergeAll(AuthRepositoryLive, BusinessRepositoryLive).pipe(Layer.provideMerge(PgClient.layer({ url: Redacted.make(url) })))
  const runtime = ManagedRuntime.make(repos)
  const withSession = <A, E, R>(r: (s: { accountId: string; userId: string }) => Effect.Effect<A, E, R>) => Effect.flatMap(requireSession, ({ session }) => r(session))
  const web = HttpApp.toWebHandlerLayer(HttpRouter.concat(decisionFeedbackApi(withSession), capabilitySignalsApi(withSession)), repos)
  const run = <A, E>(fx: Effect.Effect<A, E, any>) => runtime.runPromise(fx as Effect.Effect<A, E, never>)
  beforeAll(async () => {
    await pool.query(readFileSync(new URL("../../../packages/db/migrations/0107_agent_resume_and_capability_signals.sql", import.meta.url), "utf8"))
  })
  // Claims take the oldest queued job anywhere; leftovers from other files would be claimed first.
  beforeEach(async () => { await pool.query("UPDATE agent_work_jobs SET status='CANCELLED', finished_at=now() WHERE status IN ('QUEUED','RUNNING')") })
  afterAll(async () => { await web.dispose(); await runtime.dispose(); await pool.end() })

  const fixture = async () => {
    const accountId = String((await pool.query("INSERT INTO accounts(name) VALUES('TEST resume') RETURNING id")).rows[0].id)
    const userId = String((await pool.query("INSERT INTO users(email,password_hash) VALUES($1,'TEST') RETURNING id", [`resume-${randomUUID()}@example.test`])).rows[0].id)
    await pool.query("INSERT INTO account_users(account_id,user_id) VALUES($1,$2)", [accountId, userId])
    const businessId = String((await pool.query("INSERT INTO businesses(account_id,name) VALUES($1,'TEST resume') RETURNING id", [accountId])).rows[0].id)
    const cookie = String((await pool.query("INSERT INTO sessions(id,account_id,user_id,expires_at,token_digest) SELECT u,$1::uuid,$2::uuid,now()+interval '1 hour',encode(sha256(convert_to(u::text,'UTF8')),'hex') FROM gen_random_uuid() u RETURNING id", [accountId, userId])).rows[0].id)
    const conversationId = String((await pool.query("INSERT INTO agent_conversations(account_id,user_id,business_id) VALUES($1,$2,$3) RETURNING id", [accountId, userId, businessId])).rows[0].id)
    return { accountId, userId, businessId, cookie, conversationId }
  }
  type F = Awaited<ReturnType<typeof fixture>>
  /** The chat's agent reply carried these items as decision cards. */
  const carried = (f: F, cards: Array<{ type: string; id: string }>) => pool.query("UPDATE agent_conversations SET messages=$2::jsonb WHERE id=$1",
    [f.conversationId, JSON.stringify([{ role: "user", text: "Fix the title" }, { role: "agent", text: "Prepared", decisions: cards }])])
  const decide = (f: F, body: Record<string, unknown>) => web.handler(new Request(`http://localhost/api/businesses/${f.businessId}/decision-feedback`, {
    method: "POST", headers: { "content-type": "application/json", cookie: `or_session=${f.cookie}` }, body: JSON.stringify(body) }))
  const jobsOf = (f: F) => pool.query("SELECT kind, ref_id, status, payload FROM agent_work_jobs WHERE business_id=$1 ORDER BY created_at", [f.businessId]).then(r => r.rows)

  it("picks the chat back up after the owner decides on a card it saved, and only that chat", async () => {
    const f = await fixture(), change = randomUUID(), loose = randomUUID(), initiative = randomUUID()
    await carried(f, [{ type: "WORDPRESS_CHANGE", id: change }])
    expect((await decide(f, { kind: "WORDPRESS_CHANGE", itemId: change, verdict: "REJECTED", title: "Homepage title", reason: "Too salesy" })).status).toBe(200)
    // A card no chat carried, and a growth initiative (which has its own make-and-revise work), resume nothing here.
    expect((await decide(f, { kind: "WORDPRESS_CHANGE", itemId: loose, verdict: "APPROVED", title: "Other" })).status).toBe(200)
    expect((await decide(f, { kind: "GROWTH_OPPORTUNITY", itemId: initiative, verdict: "APPROVED", title: "Initiative" })).status).toBe(200)
    const jobs = (await jobsOf(f)).filter(j => j.kind === "DECISION_RESUME_WRITE")
    expect(jobs).toHaveLength(1)
    expect(jobs[0]).toMatchObject({ ref_id: change, status: "QUEUED", payload: { conversationId: f.conversationId, kind: "WORDPRESS_CHANGE", itemId: change } })
    expect(jobs[0].payload.message).toBe(decisionResumeMessage({ approved: false, title: "Homepage title", reason: "Too salesy" }))
    expect(jobs[0].payload.message).toContain("Do not offer the same thing again")
    expect(decisionResumeMessage({ approved: true, title: "T", reason: null })).toContain("say plainly what happened")

    // The turn runs in that chat, marked as OpenRecord's, at the chat's current revision.
    const sent: Array<Record<string, unknown>> = []
    const ok = (_s: unknown, body: Record<string, unknown>) => { sent.push(body); return Effect.succeed({ reply: "Revised" }) }
    await run(writeDecisionResumeJob(jobs[0].payload, ok, { finalAttempt: false }))
    expect(sent[0]).toMatchObject({ conversationId: f.conversationId, revision: 0, origin: { kind: "wake", title: "After your decision" } })
    // A chat busy with another turn is tried again later; on the last attempt it gives up.
    const busy = () => Effect.fail(new AgentConversationRefused({ reason: "BUSY" }))
    expect(await run(writeDecisionResumeJob(jobs[0].payload, busy, { finalAttempt: false }).pipe(Effect.flip))).toMatchObject({ _tag: "AgentWorkRetry", reason: "CHAT_BUSY" })
    expect(await run(writeDecisionResumeJob(jobs[0].payload, busy, { finalAttempt: true }).pipe(Effect.flip))).toBe("DECISION_RESUME_FAILED")
    // A chat the person archived meanwhile is set aside, and no new decision on it resumes it.
    await pool.query("UPDATE agent_conversations SET user_archived_at=now() WHERE id=$1", [f.conversationId])
    expect(await run(writeDecisionResumeJob(jobs[0].payload, ok, { finalAttempt: false }).pipe(Effect.flip))).toBe("DECISION_RESUME_CHAT_GONE")
    const later = randomUUID()
    await carried(f, [{ type: "WORDPRESS_CHANGE", id: later }])
    await pool.query("UPDATE agent_conversations SET user_archived_at=now() WHERE id=$1", [f.conversationId])
    expect((await decide(f, { kind: "WORDPRESS_CHANGE", itemId: later, verdict: "APPROVED", title: "Later" })).status).toBe(200)
    expect((await jobsOf(f)).filter(j => j.ref_id === later)).toEqual([])
  })

  it("runs one chat's work in order: a later job waits while an earlier one is running or waiting to retry", async () => {
    const f = await fixture(), other = await fixture()
    const job = (g: F) => run(enqueueAgentWork({ accountId: g.accountId, userId: g.userId, businessId: g.businessId, kind: "DECISION_RESUME_WRITE", refId: randomUUID(), payload: { conversationId: g.conversationId } }))
    const first = await job(f), second = await job(f), elsewhere = await job(other)
    const claim = () => run(claimAgentWork)
    const a = await claim()
    expect(a?.job_id).toBe(first)
    // The second job is for the same chat: the other chat's job comes up instead.
    const b = await claim()
    expect(b?.job_id).toBe(elsewhere)
    expect(await claim()).toBeNull()
    // The first asks to run again later: still queued, so the second keeps waiting.
    await run(executeAgentWorkWith(a!, () => Effect.fail(new AgentWorkRetry({ reason: "CHAT_BUSY" }))))
    expect((await pool.query("SELECT status FROM agent_work_jobs WHERE job_id=$1", [first])).rows[0].status).toBe("QUEUED")
    expect(await claim()).toBeNull()
    // Once the first has finished, the second comes up.
    await pool.query("UPDATE agent_work_jobs SET status='COMPLETED', finished_at=now() WHERE job_id=$1", [first])
    expect((await claim())?.job_id).toBe(second)
  })

  it("keeps the agent's notes about missing capabilities and poor results, and ranks tools by them", async () => {
    const f = await fixture(), other = await fixture()
    const ctx = { accountId: f.accountId, userId: f.userId, businessId: f.businessId }
    const say = (args: Record<string, unknown>, c = ctx) => run(dispatchCapabilitySignal(c, "tool_feedback", args))
    await say({ kind: "MISSING", text: "Read TikTok ad spend", })
    await say({ kind: "MISSING", text: "read tiktok ad spend" })
    await say({ kind: "STALE", tool: "read_search_performance", text: "Numbers end last month" })
    await say({ kind: "STALE", tool: "read_search_performance", text: "Same again" })
    await say({ kind: "WRONG", tool: "site.pricing", text: "Prices contradict the live page" })
    // Invalid notes are refused; another account's notes never show here.
    expect(await run(dispatchCapabilitySignal(ctx, "tool_feedback", { kind: "WRONG", text: "no tool named" }).pipe(Effect.flip))).toMatchObject({ _tag: "AgentInvalidInput" })
    expect(await run(dispatchCapabilitySignal({ ...ctx, businessId: other.businessId }, "tool_feedback", { kind: "MISSING", text: "x y" }).pipe(Effect.flip))).toMatchObject({ _tag: "AgentNotInScope" })
    await say({ kind: "MISSING", text: "Read TikTok ad spend" }, { accountId: other.accountId, userId: other.userId, businessId: other.businessId })

    const seen = await (await web.handler(new Request(`http://localhost/api/businesses/${f.businessId}/capability-signals`, { headers: { cookie: `or_session=${f.cookie}` } }))).json() as {
      missing: Array<{ need: string; times: number; askedByAgent: boolean }>; poorResults: Array<{ tool: string; problem: string; times: number }> }
    // The same need twice in a day, or the same problem twice in an hour, counts once.
    expect(seen.missing).toEqual([expect.objectContaining({ need: "read tiktok ad spend", times: 1, askedByAgent: true })])
    expect(seen.poorResults).toEqual(expect.arrayContaining([expect.objectContaining({ tool: "read_search_performance", problem: "STALE", times: 1 }), expect.objectContaining({ tool: "site.pricing", problem: "WRONG", times: 1 })]))
    expect((await web.handler(new Request(`http://localhost/api/businesses/${f.businessId}/capability-signals`, { headers: { cookie: `or_session=${other.cookie}` } }))).status).toBe(404)

    // A reported result counts against the tool's measured successes.
    const runId = (await pool.query("INSERT INTO agent_runs(conversation_id,account_id,business_id,user_id,request_id,lease_id,objective) VALUES($1,$2,$3,$4,$5,$6,'TEST') RETURNING id",
      [f.conversationId, f.accountId, f.businessId, f.userId, randomUUID(), randomUUID()])).rows[0].id
    for (let i = 0; i < 5; i++) {
      const invocationId = randomUUID()
      await pool.query("INSERT INTO agent_run_events(run_id,seq,type,payload) VALUES($1,$2,'TOOL_STARTED',$3),($1,$4,'TOOL_COMPLETED',$3)", [runId, i * 2, { invocationId, tool: "read_search_performance" }, i * 2 + 1])
    }
    expect((await run(capabilityStats(f.accountId, ["read_search_performance"]))).get("read_search_performance")).toMatchObject({ calls: 5, succeeded: 4, reported: 1 })
  })

  it("ranks research sources by what they found here and saves a search that found nothing", async () => {
    const f = await fixture()
    const ctx = { accountId: f.accountId, userId: f.userId, businessId: f.businessId }
    const [first, second] = CAPABILITIES.filter(c => c.id === "site.pricing" || c.id === "site.technologies")
    const observe = (operation: string, status: string, n: number) => Promise.all(Array.from({ length: n }, () => pool.query(
      `INSERT INTO research_observations(account_id,business_id,request_key,source,operation,subject,question,params,status,requested_by_user_id,observed_at,created_at)
       VALUES($1,$2,$3,'PUBLIC_WEB',$4,'example.test','TEST','{}',$5,$6,now(),now()-interval '2 seconds')`, [f.accountId, f.businessId, randomUUID().replaceAll("-", "").repeat(2), operation, status, f.userId])))
    // Pricing mostly found nothing here; technologies found data every time.
    await observe("site.pricing", "NO_DATA", 4); await observe("site.pricing", "OBSERVED", 1)
    await observe("site.technologies", "OBSERVED", 5)
    const stats = await run(researchStats(f.accountId, ["site.pricing", "site.technologies"]))
    expect(measuredResearch(stats.get("site.pricing"))).toMatchObject({ runs: 5, foundShare: 0.2, noDataShare: 0.8, medianSeconds: 2 })
    const ordered = [first!, second!].sort((a, b) => a.id === "site.pricing" ? -1 : b.id === "site.pricing" ? 1 : 0)
    expect(rankResearch(ordered, stats).map(c => c.id)).toEqual(["site.technologies", "site.pricing"])

    const miss = await run(findResearch(ctx, { need: "qqzx vvbw" }))
    expect(miss.data).toMatchObject({ capabilities: [], found: false })
    expect((await pool.query("SELECT kind, source, need FROM agent_capability_signals WHERE business_id=$1", [f.businessId])).rows).toEqual([{ kind: "MISSING", source: "SEARCH_MISS", need: "qqzx vvbw" }])
  })
})
