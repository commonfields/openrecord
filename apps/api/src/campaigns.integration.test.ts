import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { HttpApp } from "@effect/platform"
import { Effect, Layer, Redacted } from "effect"
import { PgClient } from "@effect/sql-pg"
import { AuthRepositoryLive, BusinessRepositoryLive } from "@openrecord/db"
import pg from "pg"
import { readFileSync } from "node:fs"
import { campaignsApi, readMarketingWork } from "./campaigns.js"
import { campaignDraftDeclarations, draftMarketingCampaign } from "./campaign-agent.js"
import { agentDeclarations, runConversation } from "./agent.js"
import type { AgentModel } from "./agent-model.js"
import { memoryJournal } from "./agent-run.js"
import { dispatchCampaignRun } from "./campaign-engine.js"
import { reviseCampaign } from "./campaign-revisions.js"
import { requireSession } from "./router.js"
import type { CampaignBrief } from "@openrecord/contracts"

const url = process.env["TEST_DATABASE_URL"] ?? ""
const suite = url ? describe : describe.skip
suite("campaign API isolation, concurrency and audit", () => {
  const pool = new pg.Pool({ connectionString: url })
  const repos = Layer.mergeAll(AuthRepositoryLive, BusinessRepositoryLive).pipe(Layer.provideMerge(PgClient.layer({ url: Redacted.make(url) })))
  const web = HttpApp.toWebHandlerLayer(campaignsApi(run => Effect.flatMap(requireSession, ({ session }) => run(session))), repos)
  let businessId: string, cookie: string, foreignCookie: string, accountId: string, userId: string, foreignAccountId: string
  const c: CampaignBrief = { title: "TEST Campaign", goal: "", audience: "", offer: "", message: "", hypothesis: "", metric: "", baseline: "", target: "", owner: "", launchDate: "", reviewDate: "", status: "DRAFT", tasks: [], result: "", decision: "UNDECIDED", learning: "", nextMove: "" }
  const call = (method: string, session?: string, body?: unknown, origin?: string) => web.handler(new Request(`http://localhost/api/businesses/${businessId}/campaigns`, {
    method, headers: { "content-type": "application/json", ...(session ? { cookie: `or_session=${session}` } : {}), ...(origin ? { origin } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }))
  beforeAll(async () => {
    await pool.query(readFileSync(new URL("../../../packages/db/migrations/0070_marketing_campaigns.sql", import.meta.url), "utf8"))
    await pool.query(readFileSync(new URL("../../../packages/db/migrations/0071_campaign_agent_drafts.sql", import.meta.url), "utf8"))
    await pool.query(readFileSync(new URL("../../../packages/db/migrations/0072_campaign_runs.sql", import.meta.url), "utf8"))
    await pool.query(readFileSync(new URL("../../../packages/db/migrations/0073_campaign_agent_revisions.sql", import.meta.url), "utf8"))
    for (let i = 0; i < 2; i++) {
      const a = (await pool.query("INSERT INTO accounts(name) VALUES('TEST campaigns') RETURNING id")).rows[0].id
      const u = (await pool.query("INSERT INTO users(email,password_hash) VALUES($1,'TEST') RETURNING id", [`campaign-${randomUUID()}@example.test`])).rows[0].id
      await pool.query("INSERT INTO account_users(account_id,user_id) VALUES($1,$2)", [a, u])
      const s = (await pool.query("INSERT INTO sessions(account_id,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour') RETURNING id", [a, u])).rows[0].id
      if (i === 0) {
        accountId = a; userId = u
        cookie = s
        businessId = (await pool.query("INSERT INTO businesses(account_id,name) VALUES($1,'TEST campaigns') RETURNING id", [a])).rows[0].id
      } else { foreignCookie = s; foreignAccountId = a }
    }
  })
  afterAll(async () => { await web.dispose(); await pool.end() })
  it("assesses scoped marketing work, persists distribution and preserves approval boundaries through the agent loop", async () => {
    const id = randomUUID(), taskId = randomUUID()
    const brief: CampaignBrief = { ...c, title: "TEST Actionable marketing", goal: "Qualified bookings", audience: "Existing trials", offer: "Guided onboarding", tasks: [
      { id: taskId, title: "Welcome email", channel: "EMAIL", owner: "Founder", due: "2026-11-07", status: "TODO", note: "" },
    ] }
    expect((await call("POST", cookie, { id, revision: 0, brief })).status).toBe(200)
    const assess = (campaignId: string, account = accountId) => Effect.runPromise(readMarketingWork(account, businessId, { campaignId }).pipe(Effect.provide(repos)))
    const first = await assess(id)
    expect(first.data.work.find(w => w.key === "distribution")).toMatchObject({ campaignId: id, revision: 1, kind: "AGENT_WORK" })
    expect(first.data.coverage.assessedLimit).toBe(10)
    await expect(assess(id, foreignAccountId)).rejects.toThrow()
    await expect(assess(randomUUID())).rejects.toThrow()
    const distribution = { primaryChannel: "Email to consenting trial users", rationale: "Reach existing interest before buying traffic", motion: "OWNED", funnelStage: "ACTIVATION",
      destination: "Onboarding booking page", cadence: "One welcome email", budget: "Suggested: no paid spend", trackingPlan: "Tagged links and CRM booking event; not yet verified", conversionEvent: "Qualified booking" }
    const revision = { campaignId: id, expectedRevision: 1, reason: "User requested marketing preparation", changes: { distribution }, taskUpdates: [{ taskId, content: "Subject: Want a hand? Book a guided onboarding session." }] }
    const steps = [{ name: "read_marketing_work", args: { campaignId: id } }, { name: "record_campaign_revision", args: revision }, { name: "read_marketing_work", args: { campaignId: id } }]
    let step = 0
    const model: AgentModel = input => {
      expect(input.system).toContain("Marketing operating loop")
      const next = steps[step++]
      return Effect.succeed({ candidates: [{ content: { role: "model", parts: next ? [{ functionCall: next }] : [{ text: "Saved the distribution plan and email draft. Sending remains a manual handoff; tracking is not verified." }] }, finishReason: "STOP" }] })
    }
    const reply = await Effect.runPromise(runConversation({ message: `/marketing Prepare the next step for campaign ${id}`, history: [], model,
      tools: agentDeclarations.filter(t => ["read_marketing_work", "record_campaign_revision"].includes(t.name)),
      dispatch: (name, args) => name === "read_marketing_work"
        ? readMarketingWork(accountId, businessId, args as { campaignId: string }).pipe(Effect.provide(repos))
        : reviseCampaign({ accountId, businessId, userId }, args).pipe(Effect.provide(repos)),
    }))
    expect(reply.toolCalls.map(t => t.tool)).toEqual(steps.map(s => s.name))
    expect(reply.decisions).toEqual([])
    const row = (await pool.query("SELECT brief,revision FROM marketing_campaigns WHERE id=$1", [id])).rows[0]
    expect(row.revision).toBe(2)
    expect(row.brief).toMatchObject({ distribution, goal: brief.goal, offer: brief.offer, audience: brief.audience, status: "DRAFT", result: "", decision: "UNDECIDED" })
    expect(row.brief.tasks[0]).toMatchObject({ id: taskId, note: revision.taskUpdates[0]!.content, status: "TODO" })
    const after = await assess(id)
    expect(after.data.work.some(w => w.key === "distribution" || w.key === "drafts")).toBe(false)
    expect(after.data.work.find(w => w.key === "measurement-evidence")?.kind).toBe("CAPABILITY_GAP")
    expect((await pool.query("SELECT count(*)::int AS n FROM marketing_campaign_runs WHERE campaign_id=$1", [id])).rows[0].n).toBe(0)
    const repeat = await Effect.runPromise(reviseCampaign({ accountId, businessId, userId }, revision).pipe(Effect.provide(repos)))
    expect(repeat.data.reused).toBe(true)
  })
  it("edits the existing draft conversationally without overwriting other work or replaying writes", async () => {
    const id = randomUUID(), taskId = randomUUID(), doneId = randomUUID()
    const brief: CampaignBrief = { ...c, title: "Conversational edit", audience: "Original audience", offer: "Keep this offer", tasks: [
      { id: taskId, title: "Email", owner: "Lifecycle", channel: "EMAIL", due: "", status: "TODO", note: "Original draft" },
      { id: doneId, title: "Completed research", owner: "Team", channel: "OTHER", due: "", status: "DONE", note: "Do not overwrite" },
    ] }
    expect((await call("POST", cookie, { id, revision: 0, brief })).status).toBe(200)
    const ctx = { accountId, businessId, userId }
    await Effect.runPromise(dispatchCampaignRun(ctx, "record_campaign_run", { campaignId: id }).pipe(Effect.provide(repos)))
    const edit = (raw: unknown, account = accountId) => Effect.runPromise(reviseCampaign({ ...ctx, accountId: account }, raw).pipe(Effect.provide(repos)))
    const request = { campaignId: id, expectedRevision: 1, reason: "User asked to focus on new trials", changes: { audience: "New trials" }, taskUpdates: [{ taskId, content: "New welcome draft" }], addDeliverables: [{ title: "Follow-up email", channel: "EMAIL", content: "Follow-up draft" }] }
    expect((await edit(request)).data).toMatchObject({ revision: 2, currentRevision: 2, reused: false, executed: false })
    const saved = (await pool.query("SELECT brief,revision FROM marketing_campaigns WHERE id=$1", [id])).rows[0]
    expect(saved.brief).toMatchObject({ audience: "New trials", offer: "Keep this offer", status: "DRAFT", decision: "UNDECIDED", result: "" })
    expect(saved.brief.tasks[0]).toMatchObject({ id: taskId, note: "New welcome draft", owner: "Lifecycle", status: "TODO" })
    expect(saved.brief.tasks[1]).toEqual(brief.tasks[1])
    expect(saved.brief.tasks[2]).toMatchObject({ title: "Follow-up email", status: "TODO" })
    expect((await edit(request)).data.reused).toBe(true)
    const runs = await Effect.runPromise(dispatchCampaignRun(ctx, "read_campaign_runs", { campaignId: id }).pipe(Effect.provide(repos)))
    expect(runs.data.runs[0]!.status).toBe("STALE")
    expect((await call("POST", cookie, { id, revision: 2, brief: { ...saved.brief, title: "Human edit" } })).status).toBe(200)
    expect((await edit(request)).data).toMatchObject({ revision: 2, currentRevision: 3, reused: true })
    expect((await pool.query("SELECT brief->>'title' AS title FROM marketing_campaigns WHERE id=$1", [id])).rows[0].title).toBe("Human edit")
    await expect(edit({ ...request, reason: "Another stale edit" })).rejects.toThrow()
    await expect(edit({ ...request, expectedRevision: 3 }, foreignAccountId)).rejects.toThrow()
    await expect(edit({ campaignId: id, expectedRevision: 3, reason: "Change done task", changes: {}, taskUpdates: [{ taskId: doneId, content: "Unsafe overwrite" }] })).rejects.toThrow()
    for (const changes of [{ status: "ACTIVE" }, { result: "Sent" }, { decision: "KEEP" }]) {
      await expect(edit({ campaignId: id, expectedRevision: 3, reason: "Forbidden state change", changes })).rejects.toThrow()
    }
    const concurrent = await Promise.allSettled(["A", "B"].map(message => edit({ campaignId: id, expectedRevision: 3, reason: "User refinement", changes: { message } })))
    expect(concurrent.map(r => r.status).sort()).toEqual(["fulfilled", "rejected"])
    const audit = await pool.query("SELECT revision,actor,revision_reason FROM marketing_campaign_revisions WHERE campaign_id=$1 ORDER BY revision", [id])
    expect(audit.rows.map(r => r.revision)).toEqual([1, 2, 3, 4])
    expect(audit.rows[1]).toMatchObject({ actor: "ASSISTANT", revision_reason: request.reason })
    await pool.query("UPDATE marketing_campaigns SET brief=jsonb_set(brief,'{status}','\"ACTIVE\"') WHERE id=$1", [id])
    await expect(edit({ campaignId: id, expectedRevision: 4, reason: "Too late", changes: { audience: "Other" } })).rejects.toThrow()
  })
  it("persists resumable bounded runs, follows adapter receipts, and refuses stale or cancelled links", async () => {
    const id = randomUUID(), taskId = randomUUID()
    const brief: CampaignBrief = { ...c, title: "Run test", goal: "More demos", audience: "Trials", offer: "Onboarding", message: "Get a result", hypothesis: "Guidance helps", metric: "CRM demos", baseline: "Unknown; first test", target: "Suggested: 10", owner: "Marketing", launchDate: "2026-11-05", reviewDate: "2026-11-12", tasks: [{ id: taskId, title: "Landing page", channel: "WEBSITE", owner: "Marketing", due: "2026-11-05", status: "TODO", note: "Draft landing page copy" }] }
    expect((await call("POST", cookie, { id, revision: 0, brief })).status).toBe(200)
    const ctx = { accountId, businessId, userId }
    const run = (name: string, args: unknown, account = accountId) => Effect.runPromise(dispatchCampaignRun({ ...ctx, accountId: account }, name, args).pipe(Effect.provide(repos)))
    const [first, second] = await Promise.all([run("record_campaign_run", { campaignId: id }), run("record_campaign_run", { campaignId: id })])
    const runId = String(first.data.runs[0]!.id)
    expect(second.data.runs[0]!.id).toBe(runId)
    expect(first.data.runs[0]!.status).toBe("WAITING_FOR_REVIEW")
    const foreignBusiness = (await pool.query("INSERT INTO businesses(account_id,name) VALUES($1,'TEST other business') RETURNING id", [foreignAccountId])).rows[0].id
    const change = async (business: string, account: string) => (await pool.query(`INSERT INTO wordpress_changes(business_id,account_id,kind,post_type,post_id,target_title,before_values,after_values,rationale,status,proposed_by,created_by_user_id,request_key)
      VALUES($1,$2,'UPDATE_COPY','pages',1,'Landing page','{}','{"content":"Draft landing page copy"}','TEST campaign delivery','PROPOSED','ASSISTANT',$3,$4) RETURNING id`, [business, account, userId, randomUUID().replaceAll("-", "").repeat(2)])).rows[0].id
    const foreignChange = await change(foreignBusiness, foreignAccountId)
    await expect(run("record_campaign_delivery", { runId, taskId, wordpressChangeId: foreignChange })).rejects.toThrow()
    await expect(run("read_campaign_runs", { campaignId: id }, foreignAccountId)).rejects.toThrow()
    const wordpressChangeId = await change(businessId, accountId)
    const link = { runId, taskId, wordpressChangeId }
    expect((await run("record_campaign_delivery", link)).data.runs[0]!.status).toBe("WAITING_FOR_APPROVAL")
    await expect(Effect.runPromise(reviseCampaign(ctx, { campaignId: id, expectedRevision: 1, reason: "Changing prepared text", changes: { message: "New text" } }).pipe(Effect.provide(repos)))).rejects.toThrow()
    await run("record_campaign_delivery", link)
    expect((await pool.query("SELECT count(*)::int AS n FROM marketing_campaign_deliveries WHERE run_id=$1", [runId])).rows[0].n).toBe(1)
    await pool.query("UPDATE wordpress_changes SET status='PUBLISHED' WHERE id=$1", [wordpressChangeId])
    expect((await run("read_campaign_runs", { campaignId: id })).data.runs[0]!.status).toBe("VERIFYING")
    await pool.query("UPDATE wordpress_changes SET live_check='{\"observed\":true}' WHERE id=$1", [wordpressChangeId])
    expect((await run("read_campaign_runs", { campaignId: id })).data.runs[0]!.status).toBe("DELIVERY_OBSERVED")
    expect((await call("POST", cookie, { id, revision: 1, brief: { ...brief, message: "Revised" } })).status).toBe(200)
    expect((await run("read_campaign_runs", { campaignId: id })).data.runs[0]!.status).toBe("STALE")
    await expect(run("record_campaign_delivery", link)).rejects.toThrow()
    const latest = await run("record_campaign_run", { campaignId: id })
    const latestId = String(latest.data.runs[0]!.id)
    const cancel = (session: string) => web.handler(new Request(`http://localhost/api/businesses/${businessId}/campaign-runs/cancel`, { method: "POST", headers: { "content-type": "application/json", cookie: `or_session=${session}` }, body: JSON.stringify({ runId: latestId }) }))
    expect((await cancel(foreignCookie)).status).toBe(404)
    expect((await cancel(cookie)).status).toBe(200)
    expect((await run("read_campaign_runs", { campaignId: id })).data.runs[0]!.status).toBe("CANCELLED")
    await expect(run("record_campaign_delivery", { ...link, runId: latestId })).rejects.toThrow()
    expect((await pool.query("SELECT status FROM wordpress_changes WHERE id=$1", [wordpressChangeId])).rows[0].status).toBe("PUBLISHED")
    const oversized = { ...brief, tasks: Array.from({ length: 31 }, () => ({ ...brief.tasks[0]!, id: randomUUID() })) }
    const largeId = randomUUID()
    expect((await call("POST", cookie, { id: largeId, revision: 0, brief: oversized })).status).toBe(200)
    await expect(run("record_campaign_run", { campaignId: largeId })).rejects.toThrow()
  })
  it("refuses anonymous, foreign and cross-origin requests", async () => {
    expect((await call("GET")).status).toBe(401)
    expect((await call("GET", foreignCookie)).status).toBe(404)
    expect((await call("POST", cookie, {}, "https://hostile.test")).status).toBe(403)
  })
  it("persists drafts, rejects stale writes, and atomically records revisions", async () => {
    const id = randomUUID()
    expect((await call("POST", cookie, { id, revision: 0, brief: c })).status).toBe(200)
    const concurrent = await Promise.all([1, 2].map(n => call("POST", cookie, { id, revision: 1, brief: { ...c, title: `Revision ${n}` } })))
    expect(concurrent.map(r => r.status).sort()).toEqual([200, 409])
    const rows = await pool.query("SELECT revision FROM marketing_campaign_revisions WHERE campaign_id=$1 ORDER BY revision", [id])
    expect(rows.rows.map(r => r.revision)).toEqual([1, 2])
    const response = await call("GET", cookie)
    expect(response.headers.get("cache-control")).toBe("no-store")
    const saved = await response.json() as { campaigns: { id: string; revision: number }[] }
    expect(saved.campaigns.find(r => r.id === id)?.revision).toBe(2)
    expect((await call("POST", foreignCookie, { id, revision: 2, brief: c })).status).toBe(404)
    expect((await call("POST", cookie, { id, revision: 2, brief: { ...c, status: "ACTIVE" } })).status).toBe(422)
    expect((await call("POST", cookie, { id, revision: 2, brief: { ...c, status: "CLOSED" } })).status).toBe(422)
  })
  it("lets the agent save replay-safe draft content, never launch or attest completion", async () => {
    const ctx = { accountId, userId, businessId }
    const input = { title: "Agent nurture draft", goal: "More activated trials", deliverables: [{ title: "Welcome email", channel: "EMAIL", content: "Subject: Your first result. Book an onboarding session." }] }
    const run = (raw: unknown, scope = ctx) => Effect.runPromise(draftMarketingCampaign(scope, raw).pipe(Effect.provide(repos)))
    const results = await Promise.all([run(input), run(input)])
    expect(results[0]!.data.campaignId).toBe(results[1]!.data.campaignId)
    expect(results.map(r => r.data.reused).sort()).toEqual([false, true])
    const id = results[0]!.data.campaignId
    const stored = (await pool.query("SELECT brief,created_by_actor FROM marketing_campaigns WHERE id=$1", [id])).rows[0]
    expect(stored.created_by_actor).toBe("ASSISTANT")
    expect(stored.brief.status).toBe("DRAFT")
    expect(stored.brief.tasks[0]).toMatchObject({ status: "TODO", note: input.deliverables[0]!.content })
    expect(stored.brief.result).toBe("")
    expect(stored.brief.decision).toBe("UNDECIDED")
    expect(results[0]!.data.executed).toBe(false)
    for (const hostile of [{ ...input, status: "ACTIVE" }, { ...input, result: "Published" }, { ...input, deliverables: [{ ...input.deliverables[0], status: "DONE" }] }]) {
      await expect(run(hostile)).rejects.toThrow()
    }
    await expect(run(input, { ...ctx, accountId: foreignAccountId })).rejects.toThrow()
    expect((await pool.query("SELECT actor FROM marketing_campaign_revisions WHERE campaign_id=$1", [id])).rows).toEqual([{ actor: "ASSISTANT" }])
    // A retry must never replace a human's later revision with the original generated text.
    expect((await call("POST", cookie, { id, revision: 1, brief: { ...stored.brief, title: "Human revision" } })).status).toBe(200)
    const retry = await run(input)
    expect(retry.data.reused).toBe(true)
    expect(retry.data.revision).toBe(2)
    const saved = await (await call("GET", cookie)).json() as { campaigns: { id: string; brief: CampaignBrief; last_edited_by_actor: string }[] }
    expect(saved.campaigns.find(c => c.id === id)).toMatchObject({ brief: { title: "Human revision" }, last_edited_by_actor: "OPERATOR" })
  })
  it("runs a campaign slash request through the real agent loop and saves a draft without approval receipts", async () => {
    let step = 0
    const input = { title: "Agent loop campaign", goal: "More demos", deliverables: [{ title: "Landing page draft", channel: "WEBSITE", content: "Book your onboarding demo. See your first result in one session." }] }
    const model: AgentModel = () => Effect.succeed({ candidates: [{ content: { role: "model", parts: step++ === 0
      ? [{ functionCall: { name: "record_campaign_draft", args: input } }]
      : [{ text: "Saved the campaign and landing-page draft. Nothing was published." }] }, finishReason: "STOP" }] })
    const { journal, events } = memoryJournal()
    const reply = await Effect.runPromise(runConversation({ message: "/campaign Get more qualified demos", history: [], model,
      tools: campaignDraftDeclarations, journal,
      dispatch: (_name, args) => draftMarketingCampaign({ accountId, userId, businessId }, args).pipe(Effect.provide(repos)),
    }))
    expect(reply.toolCalls).toHaveLength(1)
    expect(reply.decisions).toEqual([])
    expect(events.find(e => e.type === "TOOL_COMPLETED")?.payload["effect"]).toBe("record")
    const rows = await pool.query("SELECT brief->>'status' AS status FROM marketing_campaigns WHERE business_id=$1 AND brief->>'title'=$2", [businessId, input.title])
    expect(rows.rows).toEqual([{ status: "DRAFT" }])
  })
  it("bounds portfolio work and can still assess an older explicitly selected campaign", async () => {
    const oldId = randomUUID()
    await pool.query("INSERT INTO marketing_campaigns(id,business_id,created_by_user_id,brief,updated_at) VALUES($1,$2,$3,$4::jsonb,now()-interval '2 days')", [oldId, businessId, userId, JSON.stringify({ ...c, title: "TEST Older campaign" })])
    await pool.query("INSERT INTO marketing_campaigns(business_id,created_by_user_id,brief) SELECT $1,$2,$3::jsonb FROM generate_series(1,101)", [businessId, userId, JSON.stringify({ ...c, title: "TEST Portfolio limit" })])
    const before = (await pool.query("SELECT count(*)::int AS n FROM marketing_campaigns WHERE business_id=$1", [businessId])).rows[0].n
    const portfolio = await Effect.runPromise(readMarketingWork(accountId, businessId).pipe(Effect.provide(repos)))
    expect(portfolio.data.campaigns).toHaveLength(10)
    expect(portfolio.data.work.length).toBeGreaterThan(0)
    expect(portfolio.data.work.length).toBeLessThanOrEqual(30)
    expect(Buffer.byteLength(JSON.stringify(portfolio), "utf8")).toBeLessThanOrEqual(16000)
    expect(portfolio.data.moreWorkNotReturned).toBe(true)
    expect(portfolio.data.coverage).toMatchObject({ moreCampaignsNotAssessed: true, fullPortfolio: false })
    const selected = await Effect.runPromise(readMarketingWork(accountId, businessId, { campaignId: oldId }).pipe(Effect.provide(repos)))
    expect(selected.data.campaigns).toHaveLength(1)
    expect(selected.data.campaigns[0]?.campaignId).toBe(oldId)
    expect((await pool.query("SELECT count(*)::int AS n FROM marketing_campaigns WHERE business_id=$1", [businessId])).rows[0].n).toBe(before)
  })
  it("keeps multilingual learning and closed-campaign summaries within the tool envelope", async () => {
    const closed = { ...c, title: "客".repeat(200), audience: "客".repeat(2000), status: "CLOSED", decision: "INCONCLUSIVE",
      learning: "客".repeat(4000), result: "客".repeat(4000), nextMove: "客".repeat(2000) }
    const rows = await pool.query("INSERT INTO marketing_campaigns(business_id,created_by_user_id,brief) SELECT $1,$2,$3::jsonb FROM generate_series(1,6) RETURNING id", [businessId, userId, JSON.stringify(closed)])
    const portfolio = await Effect.runPromise(readMarketingWork(accountId, businessId).pipe(Effect.provide(repos)))
    expect(Buffer.byteLength(JSON.stringify(portfolio), "utf8")).toBeLessThanOrEqual(16000)
    expect(portfolio.data.moreLearningNotReturned).toBe(true)
    const selected = await Effect.runPromise(readMarketingWork(accountId, businessId, { campaignId: rows.rows[0].id }).pipe(Effect.provide(repos)))
    expect(Buffer.byteLength(JSON.stringify(selected), "utf8")).toBeLessThanOrEqual(16000)
    expect(selected.data.campaigns[0]).not.toHaveProperty("learning")
    expect(selected.data.candidateLearning[0]?.campaignId).toBe(rows.rows[0].id)
    expect((await pool.query("SELECT length(brief->>'learning') AS n FROM marketing_campaigns WHERE id=$1", [rows.rows[0].id])).rows[0].n).toBe(4000)
  })
})
