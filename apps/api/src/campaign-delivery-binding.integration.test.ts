import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { HttpApp, HttpRouter } from "@effect/platform"
import { Effect, Either, Layer, ManagedRuntime, Redacted } from "effect"
import { PgClient } from "@effect/sql-pg"
import { AcquisitionRepositoryLive, AgentProposalRepositoryLive, AuthRepositoryLive, DiscoveryScopeRepositoryLive, FactRepositoryLive, ProductReadRepositoryLive,
  QuestionRepositoryLive, RecordRepositoryLive, SetupRepositoryLive } from "@openrecord/db"
import pg from "pg"
import { growthApi } from "./growth-routes.js"
import { requireSession, RepoLayers } from "./router.js"
import { draftMarketingCampaign } from "./campaign-agent.js"
import { dispatchCampaignRun } from "./campaign-engine.js"
import { growthMeasurementApi } from "./growth-measurement-routes.js"
import { bindCampaignMeasurement, campaignOutcomeApi, readCampaignOutcome } from "./campaign-outcome.js"
import { AGENT_TOOL_SPECS } from "./agent-registry.js"

const url = process.env["TEST_DATABASE_URL"] ?? ""
const suite = url ? describe : describe.skip
suite("campaign delivery binding (disposable PostgreSQL)", () => {
  let pool: pg.Pool
  const repos = Layer.mergeAll(AuthRepositoryLive, RecordRepositoryLive, AcquisitionRepositoryLive,
    RepoLayers.GrowthRepositoriesLive, RepoLayers.GrowthMeasurementRepositoryLive, RepoLayers.BusinessRepositoryLive, AgentProposalRepositoryLive, DiscoveryScopeRepositoryLive,
    FactRepositoryLive, ProductReadRepositoryLive, QuestionRepositoryLive, SetupRepositoryLive)
    .pipe(Layer.provideMerge(PgClient.layer({ url: Redacted.make(url) })))
  const session = <A, E, R>(run: (s: import("@openrecord/db").Session) => Effect.Effect<A, E, R>) => Effect.flatMap(requireSession, ({ session: s }) => run(s))
  const web = HttpApp.toWebHandlerLayer(HttpRouter.concat(HttpRouter.concat(growthApi(session), growthMeasurementApi(session)), campaignOutcomeApi(session)), repos)
  const runtime = ManagedRuntime.make(repos)
  beforeAll(() => { pool = new pg.Pool({ connectionString: url }) })
  afterAll(async () => { await web.dispose(); await runtime.dispose(); await pool.end() })
  const fixture = async () => {
    const accountId = String((await pool.query("INSERT INTO accounts(name) VALUES('TEST delivery') RETURNING id")).rows[0].id)
    const userId = String((await pool.query("INSERT INTO users(email,password_hash) VALUES($1,'TEST') RETURNING id", [`delivery-${randomUUID()}@example.test`])).rows[0].id)
    await pool.query("INSERT INTO account_users(account_id,user_id) VALUES($1,$2)", [accountId, userId])
    const cookie = String((await pool.query("INSERT INTO sessions(account_id,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour') RETURNING id", [accountId, userId])).rows[0].id)
    const response = await web.handler(new Request("http://localhost/api/growth/products", { method: "POST", headers: { "content-type": "application/json", cookie: `or_session=${cookie}` },
      body: JSON.stringify({ name: "TEST product", websiteUrl: "https://example.test", engagement: "DOGFOOD", category: "Software", audience: "Teams", valueProposition: "Help teams", goalStatement: "More qualified leads", idempotencyKey: randomUUID(), metric: { conversionKind: "SIGNUP", label: "Signups", sourceKind: "GA4_AGGREGATE_EXPORT", sourceIdentity: "Test", eventName: "signup", countingSemantics: "EVENT_COUNT", unit: "COUNT", currency: null, reportingTimeZone: "UTC", propertyRef: "Test" } }) }))
    expect(response.status).toBe(200)
    const data = await response.json() as { profile: { businessId: string; primaryGoal: { id: string } } }
    return { accountId, userId, cookie, businessId: data.profile.businessId, goalId: data.profile.primaryGoal.id }
  }
  const change = async (f: { businessId: string; accountId: string; userId: string; goalId: string }, status: "PROPOSED" | "PUBLISHED") => String((await pool.query(
    `INSERT INTO wordpress_changes(business_id,account_id,kind,post_type,post_id,target_title,target_link,before_values,after_values,rationale,status,proposed_by,created_by_user_id,request_key,objective_goal_id,
       decided_by_user_id,decided_at,published_post_id,published_link,live_check)
     VALUES($1,$2,'UPDATE_COPY','pages',7,'Pricing','https://example.test/pricing','{"title":"Old"}','{"title":"Unrelated earlier edit"}','TEST','${status}','OPERATOR',$3,$4,$5,
       ${status === "PUBLISHED" ? "$3,now()-interval '30 days',7,'https://example.test/pricing','{\"status\":200,\"observed\":true}'" : "NULL,NULL,NULL,NULL,NULL"}) RETURNING id`,
    [f.businessId, f.accountId, f.userId, randomUUID().replaceAll("-", "").repeat(2), f.goalId])).rows[0].id)

  it("REPRO: a change that was already published before the campaign cannot be claimed as that campaign's delivery", async () => {
    const f = await fixture()
    const ctx = { accountId: f.accountId, userId: f.userId, businessId: f.businessId }
    const earlier = await change(f, "PUBLISHED")
    const campaignId = String((await runtime.runPromise(draftMarketingCampaign(ctx, { title: "Pricing clarity", deliverables: [{ title: "Pricing page headline", channel: "WEBSITE", content: "Clear pricing for teams" }] }))).data.campaignId)
    const runs = await runtime.runPromise(dispatchCampaignRun(ctx, "record_campaign_run", { campaignId }))
    const run = runs.data.runs[0]!
    const linked = await runtime.runPromise(Effect.either(dispatchCampaignRun(ctx, "record_campaign_delivery", { runId: run.id, taskId: String((await pool.query("SELECT brief->'tasks'->0->>'id' AS id FROM marketing_campaigns WHERE id=$1", [campaignId])).rows[0].id), wordpressChangeId: earlier })))
    // Today the link is accepted and the run reports the old edit as observed delivery of this campaign.
    expect(Either.isLeft(linked)).toBe(true)
  })

  const call = (method: string, path: string, cookie: string | null, body?: unknown, origin?: string) => web.handler(new Request(`http://localhost${path}`, {
    method, headers: { "content-type": "application/json", ...(cookie ? { cookie: `or_session=${cookie}` } : {}), ...(origin ? { origin } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) }))
  const ok = async <T>(r: Promise<Response>): Promise<T> => { const x = await r; if (x.status !== 200) throw new Error(`${x.status} ${await x.text()}`); return await x.json() as T }
  type F = Awaited<ReturnType<typeof fixture>>
  const opportunity = async (f: F, approve = true) => {
    const created = await ok<{ opportunity: { id: string } }>(call("POST", `/api/growth/clients/${f.businessId}/opportunities`, f.cookie, {
      goalId: f.goalId, title: "TEST clearer pricing", problemStatement: "Visitors do not understand pricing", audience: "Teams", buyerIntent: "Compare plans", targetUrl: null,
      source: "TEST fixture", proposedChange: "Clarify the pricing headline", expectedMechanism: "Less uncertainty", assumptions: "Visitors read the headline", uncertainty: "Unmeasured",
      baselineAvailability: "UNKNOWN", ownerUserId: f.userId, initialStatus: "PROPOSED", idempotencyKey: randomUUID(), evidence: [{ type: "OPERATOR_HYPOTHESIS", note: "TEST" }] }))
    if (approve) await ok(call("POST", `/api/growth/clients/${f.businessId}/opportunities/${created.opportunity.id}/approve`, f.cookie, { expectedStatus: "PROPOSED", expectedRevision: 1, idempotencyKey: randomUUID(), reason: "TEST approval" }))
    return created.opportunity.id
  }
  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)
  const plan = async (f: F, opportunityId: string, windows: [number, number, number, number]) => (await ok<{ plan: { plan: { id: string } } }>(call("POST",
    `/api/growth/clients/${f.businessId}/opportunities/${opportunityId}/measurement-plan`, f.cookie,
    { baselineStart: day(windows[0]), baselineEnd: day(windows[1]), observationStart: day(windows[2]), observationEnd: day(windows[3]), idempotencyKey: randomUUID() }))).plan.plan.id
  const campaignWithRun = async (f: F) => {
    const ctx = { accountId: f.accountId, userId: f.userId, businessId: f.businessId, origin: { provider: "fixture", model: "fixture-model-1" } }
    const campaignId = String((await runtime.runPromise(draftMarketingCampaign(ctx, { title: `Pricing ${randomUUID()}`, deliverables: [
      { title: "Pricing headline", channel: "WEBSITE", content: "Clear pricing for teams" }, { title: "FAQ", channel: "WEBSITE", content: "Pricing FAQ" },
      { title: "Email", channel: "EMAIL", content: "Announce" }] }))).data.campaignId)
    const runId = String((await runtime.runPromise(dispatchCampaignRun(ctx, "record_campaign_run", { campaignId }))).data.runs[0]!.id)
    const tasks = (await pool.query("SELECT t->>'id' AS id FROM marketing_campaigns c, jsonb_array_elements(c.brief->'tasks') t WHERE c.id=$1", [campaignId])).rows.map(r => String(r.id))
    return { ctx, campaignId, runId, tasks }
  }
  const link = (ctx: { accountId: string; userId: string; businessId: string }, runId: string, taskId: string, wordpressChangeId: string) =>
    runtime.runPromise(Effect.either(dispatchCampaignRun(ctx, "record_campaign_delivery", { runId, taskId, wordpressChangeId })))
  const reason = (r: Either.Either<unknown, unknown>) => Either.isLeft(r) ? (r.left as { reason?: string; _tag?: string }).reason ?? (r.left as { _tag?: string })._tag : "ACCEPTED"
  // Mirrors the adapter: claim (PUBLISHING, decided) then record the verified publication.
  const publish = async (f: F, changeId: string, publishedAt = "now()") => {
    await pool.query("UPDATE wordpress_changes SET status='PUBLISHING', decided_by_user_id=$2, decided_at=now() WHERE id=$1", [changeId, f.userId])
    await pool.query(`UPDATE wordpress_changes SET status='PUBLISHED', published_at=${publishedAt}, published_post_id=7, live_check='{"status":200,"observed":true}' WHERE id=$1`, [changeId])
  }
  const outcome = (f: F, campaignId: string) => runtime.runPromise(readCampaignOutcome(f.accountId, f.businessId, { campaignId }))
  const bind = (ctx: Parameters<typeof bindCampaignMeasurement>[0], input: unknown) => runtime.runPromise(Effect.either(bindCampaignMeasurement(ctx, input)))

  it("links only a pending change prepared for the run under the campaign objective, pins it, and refuses every overlap explicitly", async () => {
    const f = await fixture()
    const { ctx, runId, tasks } = await campaignWithRun(f)
    const pending = await change(f, "PROPOSED")
    expect(reason(await link(ctx, runId, tasks[0]!, pending))).toBe("ACCEPTED")
    const pinned = (await pool.query("SELECT prepared_digest, wordpress_prepared_digest(w.after_values) AS now FROM marketing_campaign_deliveries d JOIN wordpress_changes w ON w.id=d.wordpress_change_id WHERE d.wordpress_change_id=$1", [pending])).rows[0]
    expect(pinned.prepared_digest).toMatch(/^[a-f0-9]{64}$/)
    expect(pinned.prepared_digest).toBe(pinned.now)
    expect(reason(await link(ctx, runId, tasks[0]!, pending))).toBe("ACCEPTED") // replay
    expect(reason(await link(ctx, runId, tasks[0]!, await change(f, "PROPOSED")))).toBe("DeliverableAlreadyLinked")
    expect(reason(await link(ctx, runId, tasks[1]!, pending))).toBe("ChangeAlreadyLinked")
    expect(reason(await link(ctx, runId, tasks[2]!, await change(f, "PROPOSED")))).toBe("UnsupportedDeliverable")
    const decided = await change(f, "PROPOSED")
    await pool.query("UPDATE wordpress_changes SET status='REJECTED', decided_by_user_id=$2, decided_at=now() WHERE id=$1", [decided, f.userId])
    expect(reason(await link(ctx, runId, tasks[1]!, decided))).toBe("ChangeAlreadyDecided")
    // Replay stays safe after the operator decides the linked change.
    await publish(f, pending)
    expect(reason(await link(ctx, runId, tasks[0]!, pending))).toBe("ACCEPTED")
    // Database guards hold even for raw writes.
    await expect(pool.query("UPDATE wordpress_changes SET after_values='{\"title\":\"Swapped\"}' WHERE id=$1", [pending])).rejects.toThrow(/immutable/)
    await expect(pool.query("DELETE FROM marketing_campaign_deliveries WHERE wordpress_change_id=$1", [pending])).rejects.toThrow()
    const raw = await change(f, "PROPOSED")
    await pool.query("UPDATE wordpress_changes SET status='REJECTED', decided_at=now(), decided_by_user_id=$2 WHERE id=$1", [raw, f.userId])
    await expect(pool.query("INSERT INTO marketing_campaign_deliveries(business_id,run_id,task_id,wordpress_change_id,linked_by_user_id,prepared_digest) SELECT $1,$2,$3,id,$4,wordpress_prepared_digest(after_values) FROM wordpress_changes WHERE id=$5",
      [f.businessId, runId, tasks[1]!, f.userId, raw])).rejects.toThrow(/pending change/)
    await expect(pool.query("INSERT INTO marketing_campaign_deliveries(business_id,run_id,task_id,wordpress_change_id,linked_by_user_id) VALUES($1,$2,$3,$4,$5)",
      [f.businessId, runId, tasks[1]!, await change(f, "PROPOSED"), f.userId])).rejects.toThrow(/pending change/)
  })

  it("records published_at only with the publication and never from any other write", async () => {
    const f = await fixture()
    const id = await change(f, "PROPOSED")
    await expect(pool.query("UPDATE wordpress_changes SET published_at=now() WHERE id=$1", [id])).rejects.toThrow(/published_at/)
    await expect(pool.query(`INSERT INTO wordpress_changes(business_id,account_id,kind,post_type,post_id,target_title,before_values,after_values,rationale,status,proposed_by,created_by_user_id,request_key,published_at)
      VALUES($1,$2,'UPDATE_COPY','pages',7,'x','{}','{}','TEST','PROPOSED','OPERATOR',$3,$4,now())`, [f.businessId, f.accountId, f.userId, randomUUID().replaceAll("-", "").repeat(2)])).rejects.toThrow(/published_at/)
    await publish(f, id)
    const at = (await pool.query("SELECT published_at FROM wordpress_changes WHERE id=$1", [id])).rows[0].published_at
    expect(at).toBeInstanceOf(Date)
    await expect(pool.query("UPDATE wordpress_changes SET published_at=now()-interval '1 day' WHERE id=$1", [id])).rejects.toThrow(/published_at/)
    await expect(pool.query("UPDATE wordpress_changes SET status='UNDONE', published_at=NULL WHERE id=$1", [id])).rejects.toThrow(/published_at/)
  })

  it("binds measurement auditably, refuses double or late binding explicitly, and lets only an operator dissolve", async () => {
    const f = await fixture()
    const { ctx, runId, tasks } = await campaignWithRun(f)
    const opp = await opportunity(f)
    const planId = await plan(f, opp, [-20, -11, 5, 20])
    const first = await bind(ctx, { runId, taskId: tasks[0], opportunityId: opp, planId })
    expect(Either.isRight(first)).toBe(true)
    const bindingId = Either.isRight(first) ? String(first.right.data.bindingId) : ""
    const audit = (await pool.query("SELECT * FROM marketing_campaign_measurement_bindings WHERE id=$1", [bindingId])).rows[0]
    expect(audit).toMatchObject({ bound_by_user_id: f.userId, bound_by_actor: "ASSISTANT", origin_provider: "fixture", origin_model: "fixture-model-1",
      run_id: runId, task_id: tasks[0], opportunity_id: opp, plan_id: planId, dissolved_at: null })
    expect(audit.bound_at).toBeInstanceOf(Date)
    const replay = await bind(ctx, { runId, taskId: tasks[0], opportunityId: opp, planId })
    expect(Either.isRight(replay) && replay.right.data).toMatchObject({ bindingId, reused: true })
    // Several deliverables may share one plan.
    expect(Either.isRight(await bind(ctx, { runId, taskId: tasks[1], opportunityId: opp, planId }))).toBe(true)
    // A different binding for a bound deliverable is refused with the existing binding, never replaced.
    const other = await opportunity(f)
    const otherPlan = await plan(f, other, [-20, -11, 5, 20])
    const conflict = await bind(ctx, { runId, taskId: tasks[0], opportunityId: other, planId: otherPlan })
    expect(reason(conflict)).toBe("MeasurementAlreadyBound")
    expect(Either.isLeft(conflict) && (conflict.left as { bindingId?: string }).bindingId).toBe(bindingId)
    expect(reason(await bind(ctx, { runId, taskId: tasks[2], opportunityId: opp, planId }))).toBe("UnsupportedDeliverable")
    const unapproved = await opportunity(f, false)
    expect(reason(await bind({ ...ctx }, { runId, taskId: tasks[0], opportunityId: unapproved, planId }))).toBe("MeasurementAlreadyBound")
    // Plan freshness, approval and timing on a fresh run.
    const g = await campaignWithRun(f)
    expect(reason(await bind(g.ctx, { runId: g.runId, taskId: g.tasks[0], opportunityId: unapproved, planId }))).toBe("OpportunityNotApproved")
    const newer = await plan(f, opp, [-30, -21, 6, 21])
    expect(reason(await bind(g.ctx, { runId: g.runId, taskId: g.tasks[0], opportunityId: opp, planId }))).toBe("PlanNotLatest")
    const linked = await change(f, "PROPOSED")
    expect(reason(await link(g.ctx, g.runId, g.tasks[0]!, linked))).toBe("ACCEPTED")
    await publish(f, linked)
    expect(reason(await bind(g.ctx, { runId: g.runId, taskId: g.tasks[0], opportunityId: opp, planId: newer }))).toBe("DeliveryAlreadyDecided")
    // Raw writes cannot rewrite or delete a binding.
    await expect(pool.query("UPDATE marketing_campaign_measurement_bindings SET plan_id=$2 WHERE id=$1", [bindingId, newer])).rejects.toThrow(/append-only/)
    await expect(pool.query("DELETE FROM marketing_campaign_measurement_bindings WHERE id=$1", [bindingId])).rejects.toThrow()
    // The agent has no dissolve tool; an operator dissolves through the authenticated route, once.
    expect(AGENT_TOOL_SPECS.some(t => /dissolve/.test(t.declaration.name))).toBe(false)
    const path = `/api/businesses/${f.businessId}/campaign-measurement-bindings/${bindingId}/dissolve`
    expect((await call("POST", path, null, { reason: "TEST" })).status).toBe(401)
    expect((await call("POST", path, f.cookie, { reason: "TEST" }, "https://hostile.example")).status).toBe(403)
    expect((await call("POST", path, f.cookie, { reason: "Wrong plan chosen" })).status).toBe(200)
    expect((await call("POST", path, f.cookie, { reason: "again" })).status).toBe(409)
    const dissolved = (await pool.query("SELECT dissolved_by_user_id, dissolution_reason, dissolved_at FROM marketing_campaign_measurement_bindings WHERE id=$1", [bindingId])).rows[0]
    expect(dissolved).toMatchObject({ dissolved_by_user_id: f.userId, dissolution_reason: "Wrong plan chosen" })
    // Rebinding after dissolution is a new, separately audited row; history keeps both.
    const rebound = await bind(ctx, { runId, taskId: tasks[0], opportunityId: other, planId: otherPlan })
    expect(Either.isRight(rebound) && rebound.right.data.bindingId).not.toBe(bindingId)
    expect((await outcome(f, (await pool.query("SELECT campaign_id FROM marketing_campaign_runs WHERE id=$1", [runId])).rows[0].campaign_id)).data.deliverables[0]).toMatchObject({ dissolvedBindings: 1 })
  })

  it("walks the chain from binding to an observed, descriptive-only reading", async () => {
    const f = await fixture()
    const { ctx, runId, tasks, campaignId } = await campaignWithRun(f)
    const state = async () => (await outcome(f, campaignId)).data.deliverables.map(d => [d.state, d.reason])
    expect(await state()).toEqual([["NOT_BOUND", "NO_MEASUREMENT_BINDING"], ["NOT_BOUND", "NO_MEASUREMENT_BINDING"]])
    const opp = await opportunity(f)
    const future = await plan(f, opp, [-14, -1, 1, 20])
    await bind(ctx, { runId, taskId: tasks[0], opportunityId: opp, planId: future })
    expect((await state())[0]).toEqual(["AWAITING_DELIVERY", "NO_DELIVERY_LINK"])
    const id = await change(f, "PROPOSED")
    await link(ctx, runId, tasks[0]!, id)
    expect((await state())[0]).toEqual(["AWAITING_APPROVAL", "OPERATOR_DECISION_PENDING"])
    await pool.query("UPDATE wordpress_changes SET status='PUBLISHING', decided_by_user_id=$2, decided_at=now() WHERE id=$1", [id, f.userId])
    expect((await state())[0]).toEqual(["AWAITING_DELIVERY", "PUBLISHING"])
    await pool.query("UPDATE wordpress_changes SET status='PUBLISHED', published_at=now(), live_check='{\"status\":200,\"observed\":null}' WHERE id=$1", [id])
    expect((await state())[0]).toEqual(["DELIVERY_UNVERIFIED", "LIVE_CHECK_NOT_OBSERVED"])
    await pool.query("UPDATE wordpress_changes SET live_check='{\"status\":200,\"observed\":true}' WHERE id=$1", [id])
    const open = (await outcome(f, campaignId)).data.deliverables[0]!
    expect([open.state, open.timing.planPredeclared, open.timing.windowsStraddleDelivery]).toEqual(["AWAITING_OBSERVATION_WINDOW", true, true])
    expect(open.reading).toBeNull()

    // A closed window: the reading is descriptive and flags that this plan did not precede the delivery or straddle it.
    const g = await campaignWithRun(f)
    const past = await plan(f, opp, [-40, -31, -30, -2])
    await bind(g.ctx, { runId: g.runId, taskId: g.tasks[0], opportunityId: opp, planId: past })
    const late = await change(f, "PROPOSED")
    await link(g.ctx, g.runId, g.tasks[0]!, late)
    await publish(f, late, "now() - interval '1 day'")
    const closed = (await outcome(f, g.campaignId)).data.deliverables[0]!
    expect(closed.state).toBe("OBSERVED")
    expect(closed.timing).toMatchObject({ planPredeclared: false, windowsStraddleDelivery: false })
    expect(closed.reading).toMatchObject({ interpretation: "DESCRIPTIVE_ONLY" })
    expect(JSON.stringify(closed.reading)).not.toMatch(/"lift"|attribut(ed|ion)":/)
  })

  it("refuses cross-tenant chain access for the binding write and the outcome read", async () => {
    const f = await fixture(), other = await fixture()
    const { ctx, runId, tasks, campaignId } = await campaignWithRun(f)
    const opp = await opportunity(f)
    const planId = await plan(f, opp, [-14, -1, 1, 20])
    const foreignOpp = await opportunity(other)
    const foreignPlan = await plan(other, foreignOpp, [-14, -1, 1, 20])
    const otherCtx = { accountId: other.accountId, userId: other.userId, businessId: other.businessId }
    expect(reason(await bind(otherCtx, { runId, taskId: tasks[0], opportunityId: opp, planId }))).toBe("AgentNotInScope")
    expect(reason(await bind({ ...otherCtx, businessId: f.businessId }, { runId, taskId: tasks[0], opportunityId: opp, planId }))).toBe("AgentNotInScope")
    expect(reason(await bind(ctx, { runId, taskId: tasks[0], opportunityId: foreignOpp, planId: foreignPlan }))).toBe("AgentNotInScope")
    expect(reason(await link(otherCtx, runId, tasks[0]!, await change(f, "PROPOSED")))).toBe("AgentNotInScope")
    expect(reason(await link(ctx, runId, tasks[0]!, await change({ ...other }, "PROPOSED")))).toBe("AgentNotInScope")
    // Raw cross-tenant binding fails in the database.
    await expect(pool.query(`INSERT INTO marketing_campaign_measurement_bindings(business_id,campaign_id,run_id,task_id,opportunity_id,plan_id,request_key,bound_by_user_id,bound_by_actor)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'ASSISTANT')`, [f.businessId, campaignId, runId, tasks[0], foreignOpp, foreignPlan, "a".repeat(64), f.userId])).rejects.toThrow()
    await expect(pool.query(`INSERT INTO marketing_campaign_measurement_bindings(business_id,campaign_id,run_id,task_id,opportunity_id,plan_id,request_key,bound_by_user_id,bound_by_actor)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'ASSISTANT')`, [f.businessId, campaignId, runId, tasks[0], opp, planId, "b".repeat(64), other.userId])).rejects.toThrow(/outside scope/)
    // Outcome reads.
    expect(Either.isLeft(await runtime.runPromise(Effect.either(readCampaignOutcome(other.accountId, f.businessId, { campaignId }))))).toBe(true)
    expect(Either.isLeft(await runtime.runPromise(Effect.either(readCampaignOutcome(other.accountId, other.businessId, { campaignId }))))).toBe(true)
    expect((await call("GET", `/api/businesses/${f.businessId}/campaigns/${campaignId}/outcome`, other.cookie)).status).toBe(404)
    expect((await call("GET", `/api/businesses/${other.businessId}/campaigns/${campaignId}/outcome`, other.cookie)).status).toBe(404)
    expect((await call("GET", `/api/businesses/${f.businessId}/campaigns/${campaignId}/outcome`, null)).status).toBe(401)
    expect((await call("GET", `/api/businesses/${f.businessId}/campaigns/${campaignId}/outcome`, f.cookie)).status).toBe(200)
    // Dissolve across tenants.
    const bound = await bind(ctx, { runId, taskId: tasks[0], opportunityId: opp, planId })
    const bindingId = Either.isRight(bound) ? String(bound.right.data.bindingId) : ""
    expect((await call("POST", `/api/businesses/${f.businessId}/campaign-measurement-bindings/${bindingId}/dissolve`, other.cookie, { reason: "x" })).status).toBe(404)
    expect((await call("POST", `/api/businesses/${other.businessId}/campaign-measurement-bindings/${bindingId}/dissolve`, other.cookie, { reason: "x" })).status).toBe(404)
    expect((await pool.query("SELECT dissolved_at FROM marketing_campaign_measurement_bindings WHERE id=$1", [bindingId])).rows[0].dissolved_at).toBeNull()
  })
})

