import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { HttpApp, HttpRouter } from "@effect/platform"
import { Effect, Either, Layer, ManagedRuntime, Redacted } from "effect"
import { PgClient } from "@effect/sql-pg"
import { AcquisitionRepositoryLive, AgentProposalRepositoryLive, AuthRepositoryLive, DiscoveryScopeRepositoryLive, FactRepositoryLive, ProductReadRepositoryLive,
  QuestionRepositoryLive, RecordRepositoryLive, SetupRepositoryLive } from "@openrecord/db"
import pg from "pg"
import { growthApi } from "./growth-routes.js"
import { readObjectiveInvestigations } from "./objectives.js"
import { requireSession, RepoLayers } from "./router.js"
import { draftMarketingCampaign } from "./campaign-agent.js"
import { loadResumeContext } from "./agent-resume.js"
import { campaignsApi } from "./campaigns.js"
import { reviseCampaign } from "./campaign-revisions.js"
import { dispatchCampaignRun } from "./campaign-engine.js"
import { dispatchInvestigation } from "./agent-investigation-tools.js"
import { readObjectiveWork } from "./objective-work.js"
import { seedObjective } from "./objective-work.test-support.js"
import type { CampaignBrief } from "@openrecord/contracts"

const url = process.env["TEST_DATABASE_URL"] ?? ""
const suite = url ? describe : describe.skip
suite("objective work lineage (disposable PostgreSQL)", () => {
  let pool: pg.Pool
  const repos = Layer.mergeAll(AuthRepositoryLive, RecordRepositoryLive, AcquisitionRepositoryLive,
    RepoLayers.GrowthRepositoriesLive, RepoLayers.BusinessRepositoryLive, AgentProposalRepositoryLive, DiscoveryScopeRepositoryLive,
    FactRepositoryLive, ProductReadRepositoryLive, QuestionRepositoryLive, SetupRepositoryLive)
    .pipe(Layer.provideMerge(PgClient.layer({ url: Redacted.make(url) })))
  const session = <A, E, R>(run: (s: import("@openrecord/db").Session) => Effect.Effect<A, E, R>) => Effect.flatMap(requireSession, ({ session: s }) => run(s))
  const web = HttpApp.toWebHandlerLayer(HttpRouter.concat(growthApi(session), campaignsApi(session)), repos)
  const runtime = ManagedRuntime.make(repos)
  beforeAll(() => { pool = new pg.Pool({ connectionString: url }) })
  afterAll(async () => { await web.dispose(); await runtime.dispose(); await pool.end() })
  const call = (method: string, path: string, cookie: string, body: unknown) => web.handler(new Request(`http://localhost${path}`, {
    method, headers: { "content-type": "application/json", cookie: `or_session=${cookie}` }, body: JSON.stringify(body),
  }))
  const fixture = async () => {
    const accountId = String((await pool.query("INSERT INTO accounts(name) VALUES('TEST lineage') RETURNING id")).rows[0].id)
    const userId = String((await pool.query("INSERT INTO users(email,password_hash) VALUES($1,'TEST') RETURNING id", [`lineage-${randomUUID()}@example.test`])).rows[0].id)
    await pool.query("INSERT INTO account_users(account_id,user_id) VALUES($1,$2)", [accountId, userId])
    const cookie = String((await pool.query("INSERT INTO sessions(account_id,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour') RETURNING id", [accountId, userId])).rows[0].id)
    const response = await call("POST", "/api/growth/products", cookie, { name: "TEST product", websiteUrl: "https://example.test", engagement: "DOGFOOD", category: "Software", audience: "Teams", valueProposition: "Help teams", goalStatement: "More qualified leads", idempotencyKey: randomUUID(), metric: { conversionKind: "SIGNUP", label: "Signups", sourceKind: "GA4_AGGREGATE_EXPORT", sourceIdentity: "Test", eventName: "signup", countingSemantics: "EVENT_COUNT", unit: "COUNT", currency: null, reportingTimeZone: "UTC", propertyRef: "Test" } })
    expect(response.status).toBe(200)
    const data = await response.json() as { profile: { businessId: string; primaryGoal: { id: string } } }
    return { cookie, accountId, userId, businessId: data.profile.businessId, goalId: data.profile.primaryGoal.id }
  }
  const draft = { title: "Lineage campaign", deliverables: [{ title: "Landing page copy", channel: "WEBSITE" as const, content: "Draft" }] }

  it("REPRO: a campaign saved under the active objective, with no note, is recoverable from the objective in a fresh conversation", async () => {
    const f = await fixture()
    const ctx = { accountId: f.accountId, userId: f.userId, businessId: f.businessId }
    const saved = await runtime.runPromise(draftMarketingCampaign(ctx, draft))
    const campaignId = String(saved.data.campaignId)
    // The model wrote no investigation note. A fresh conversation has only structured reads.
    expect(await runtime.runPromise(loadResumeContext(f.accountId, f.businessId))).toContain(campaignId)
    const overview = await runtime.runPromise(readObjectiveInvestigations(f.accountId, f.businessId))
    const work = (overview.data as unknown as { objectiveWork?: { goalId: string; campaigns: Array<{ id: string }> } }).objectiveWork
    expect(work?.goalId).toBe(f.goalId)
    expect(work?.campaigns.map(c => c.id)).toEqual([campaignId])
    // Structured query by objective: the persisted row itself must name the goal.
    const row = await pool.query("SELECT to_jsonb(c) AS c FROM marketing_campaigns c WHERE id=$1", [campaignId])
    expect(row.rows[0].c.objective_goal_id).toBe(f.goalId)
  })
  const lineage = async (table: string, id: string) => (await pool.query(`SELECT objective_goal_id FROM ${table} WHERE id=$1`, [id])).rows[0]?.objective_goal_id ?? null
  const work = (businessId: string) => runtime.runPromise(readObjectiveWork(businessId))
  const brief = (title: string): CampaignBrief => ({ title, goal: "", audience: "", offer: "", message: "", hypothesis: "", metric: "", baseline: "", target: "", owner: "",
    launchDate: "", reviewDate: "", status: "DRAFT", result: "", decision: "UNDECIDED", learning: "", nextMove: "",
    tasks: [{ id: randomUUID(), title: "Landing page", channel: "WEBSITE", owner: "", due: "", status: "TODO", note: "Draft" }] })
  const wordpressChange = async (f: { businessId: string; accountId: string; userId: string }, goal: string | null) => String((await pool.query(
    `INSERT INTO wordpress_changes(business_id,account_id,kind,post_type,post_id,target_title,before_values,after_values,rationale,status,proposed_by,created_by_user_id,request_key,objective_goal_id)
     VALUES($1,$2,'UPDATE_COPY','pages',1,'Landing page','{}','{"content":"Draft"}','TEST','PROPOSED','ASSISTANT',$3,$4,$5) RETURNING id`,
    [f.businessId, f.accountId, f.userId, randomUUID().replaceAll("-", "").repeat(2), goal])).rows[0].id)

  it("writes lineage in the creating statement for agent and operator campaigns; replays, revisions and runs keep it", async () => {
    const f = await fixture()
    const ctx = { accountId: f.accountId, userId: f.userId, businessId: f.businessId }
    const first = await runtime.runPromise(draftMarketingCampaign(ctx, draft))
    const agentId = String(first.data.campaignId)
    expect(await lineage("marketing_campaigns", agentId)).toBe(f.goalId)
    const replay = await runtime.runPromise(draftMarketingCampaign(ctx, draft))
    expect(replay.data).toMatchObject({ campaignId: agentId, reused: true })

    const operatorId = randomUUID()
    expect((await call("POST", `/api/businesses/${f.businessId}/campaigns`, f.cookie, { id: operatorId, revision: 0, brief: brief("Operator campaign") })).status).toBe(200)
    expect(await lineage("marketing_campaigns", operatorId)).toBe(f.goalId)
    expect((await call("POST", `/api/businesses/${f.businessId}/campaigns`, f.cookie, { id: operatorId, revision: 1, brief: brief("Operator campaign, edited") })).status).toBe(200)
    expect(await lineage("marketing_campaigns", operatorId)).toBe(f.goalId)

    // Revisions and runs are unchanged in behaviour and inherit the campaign's lineage.
    const before = (await pool.query("SELECT revision, actor, brief FROM marketing_campaign_revisions WHERE campaign_id=$1 ORDER BY revision", [agentId])).rows
    const revised = await runtime.runPromise(reviseCampaign(ctx, { campaignId: agentId, expectedRevision: 1, reason: "TEST requested edit", changes: { audience: "Ops teams" } }))
    expect(revised.data).toMatchObject({ revision: 2, reused: false })
    const after = (await pool.query("SELECT revision, actor, brief FROM marketing_campaign_revisions WHERE campaign_id=$1 ORDER BY revision", [agentId])).rows
    expect(after.slice(0, 1)).toEqual(before)
    expect(after).toHaveLength(2)
    expect(await lineage("marketing_campaigns", agentId)).toBe(f.goalId)
    await runtime.runPromise(dispatchCampaignRun(ctx, "record_campaign_run", { campaignId: agentId }))
    const run = (await pool.query(`SELECT c.objective_goal_id FROM marketing_campaign_runs r JOIN marketing_campaigns c ON c.id=r.campaign_id AND c.business_id=r.business_id
      WHERE r.campaign_id=$1`, [agentId])).rows
    expect(run).toEqual([{ objective_goal_id: f.goalId }])

    const recovered = await work(f.businessId)
    expect(new Set(recovered.campaigns.map(c => c["id"]))).toEqual(new Set([agentId, operatorId]))
    expect(recovered.campaigns.find(c => c["id"] === agentId)).toMatchObject({ revision: 2, deliverables: 1, currentObjective: true, goalVersion: 1 })
  })

  it("recovers exact linked work by objective in a fresh conversation, across goal versions, and reports delivery mismatches", async () => {
    const f = await fixture()
    const ctx = { accountId: f.accountId, userId: f.userId, businessId: f.businessId }
    const v1Campaign = String((await runtime.runPromise(draftMarketingCampaign(ctx, draft))).data.campaignId)
    const v1Change = await wordpressChange(f, f.goalId)
    const v2 = await seedObjective(pool, f.businessId, f.userId, "More qualified demos")
    const v2Campaign = String((await runtime.runPromise(draftMarketingCampaign(ctx, { ...draft, title: "Demo campaign" }))).data.campaignId)
    expect(await lineage("marketing_campaigns", v2Campaign)).toBe(v2)
    expect(await lineage("marketing_campaigns", v1Campaign)).toBe(f.goalId)
    // A change prepared under v2, delivered for the v1 campaign: reported, not refused.
    const v2Change = await wordpressChange(f, v2)
    const runId = String((await runtime.runPromise(dispatchCampaignRun(ctx, "record_campaign_run", { campaignId: v1Campaign }))).data.runs[0]!.id)
    const taskId = String((await pool.query("SELECT brief->'tasks'->0->>'id' AS id FROM marketing_campaigns WHERE id=$1", [v1Campaign])).rows[0].id)
    await runtime.runPromise(dispatchCampaignRun(ctx, "record_campaign_delivery", { runId, taskId, wordpressChangeId: v2Change }))
    await wordpressChange({ ...f }, null) // legacy or unknown: never recovered

    const recovered = await work(f.businessId)
    expect(recovered).toMatchObject({ goalId: v2, goalVersion: 2 })
    expect(recovered.campaigns.map(c => [c["id"], c["currentObjective"], c["goalVersion"]])).toEqual([[v2Campaign, true, 2], [v1Campaign, false, 1]])
    expect(recovered.wordpressChanges.map(c => [c["id"], c["currentObjective"], c["campaignId"] ?? null, c["objectiveMismatch"]]))
      .toEqual([[v2Change, true, v1Campaign, true], [v1Change, false, null, false]])
    const resume = await runtime.runPromise(loadResumeContext(f.accountId, f.businessId))
    for (const id of [v1Campaign, v2Campaign, v1Change, v2Change]) expect(resume).toContain(id)
  })

  it("leaves existing investigation notes and their campaign links byte for byte; notes are never the lineage source", async () => {
    const f = await fixture()
    const ctx = { accountId: f.accountId, userId: f.userId, businessId: f.businessId }
    const opened = await runtime.runPromise(dispatchInvestigation(ctx, "open_investigation", { goalId: f.goalId, question: "Does onboarding lift leads?" }))
    const investigationId = String(opened.data.investigationId)
    const campaignId = String((await runtime.runPromise(draftMarketingCampaign(ctx, draft))).data.campaignId)
    await runtime.runPromise(dispatchInvestigation(ctx, "record_investigation_note", { investigationId, kind: "OBSERVATION", note: "Saved the onboarding draft.", campaignId, expectedCampaignRevision: 1 }))
    await runtime.runPromise(dispatchInvestigation(ctx, "record_investigation_note", { investigationId, kind: "HYPOTHESIS", note: "Unlinked context." }))
    const snapshot = async () => (await pool.query("SELECT to_jsonb(n) AS n FROM growth_investigation_notes n WHERE investigation_id=$1 ORDER BY sequence", [investigationId])).rows
    const before = await snapshot()
    await runtime.runPromise(draftMarketingCampaign(ctx, { ...draft, title: "Second campaign, no note" }))
    await runtime.runPromise(reviseCampaign(ctx, { campaignId, expectedRevision: 1, reason: "TEST edit", changes: { offer: "Trial" } }))
    expect(await snapshot()).toEqual(before)
    const overview = await runtime.runPromise(readObjectiveInvestigations(f.accountId, f.businessId))
    expect(overview.data.investigations[0]?.campaign).toMatchObject({ campaignId, notedRevision: 1, currentRevision: 2, revisionChanged: true })
    expect((await work(f.businessId)).campaigns).toHaveLength(2)
    // Notes stay append-only.
    await expect(pool.query("UPDATE growth_investigation_notes SET note='rewritten' WHERE investigation_id=$1", [investigationId])).rejects.toThrow()
  })

  it("links nothing when the objective is unknown, never takes it from input, and refuses cross-tenant or unauthorized lineage", async () => {
    const f = await fixture(), other = await fixture()
    const ctx = { accountId: f.accountId, userId: f.userId, businessId: f.businessId }
    // Unknown objective: a business without a growth profile.
    const bare = String((await pool.query("INSERT INTO businesses(account_id,name) VALUES($1,'TEST bare') RETURNING id", [f.accountId])).rows[0].id)
    const unknown = String((await runtime.runPromise(draftMarketingCampaign({ ...ctx, businessId: bare }, draft))).data.campaignId)
    expect(await lineage("marketing_campaigns", unknown)).toBeNull()
    expect(await work(bare)).toMatchObject({ goalId: null, campaigns: [], wordpressChanges: [], accountActions: [] })
    // The model cannot supply lineage.
    const injected = await runtime.runPromise(Effect.either(draftMarketingCampaign(ctx, { ...draft, objectiveGoalId: other.goalId })))
    expect(Either.isLeft(injected)).toBe(true)
    // Unauthorized: another account's business is refused before any write.
    const count = async () => Number((await pool.query("SELECT count(*) FROM marketing_campaigns WHERE business_id=$1", [other.businessId])).rows[0].count)
    const denied = await runtime.runPromise(Effect.either(draftMarketingCampaign({ ...ctx, businessId: other.businessId }, draft)))
    expect(Either.isLeft(denied) && (denied.left as { _tag?: string })._tag).toBe("AgentNotInScope")
    expect(await count()).toBe(0)
    expect(Either.isLeft(await runtime.runPromise(Effect.either(readObjectiveInvestigations(f.accountId, other.businessId))))).toBe(true)
    // Cross-tenant goal: refused by the composite key, even for a raw insert.
    await expect(wordpressChange(f, other.goalId)).rejects.toThrow(/objective_goal_fk/)
    await expect(pool.query("INSERT INTO marketing_campaigns(business_id,created_by_user_id,brief,objective_goal_id) VALUES($1,$2,'{}',$3)", [f.businessId, f.userId, other.goalId])).rejects.toThrow(/objective_goal_fk/)
    // Lineage is immutable after creation, including adding one to a null row.
    const own = String((await runtime.runPromise(draftMarketingCampaign(ctx, draft))).data.campaignId)
    await expect(pool.query("UPDATE marketing_campaigns SET objective_goal_id=NULL WHERE id=$1", [own])).rejects.toThrow(/immutable/)
    await expect(pool.query("UPDATE marketing_campaigns SET objective_goal_id=$2 WHERE id=$1", [unknown, f.goalId])).rejects.toThrow()
    const change = await wordpressChange(f, f.goalId)
    await expect(pool.query("UPDATE wordpress_changes SET objective_goal_id=NULL WHERE id=$1", [change])).rejects.toThrow(/immutable/)
    // Status changes (approval paths) still work and keep lineage.
    await pool.query("UPDATE wordpress_changes SET status='REJECTED', decided_by_user_id=$2, decided_at=now() WHERE id=$1", [change, f.userId])
    expect(await lineage("wordpress_changes", change)).toBe(f.goalId)
    expect((await work(other.businessId)).campaigns).toEqual([])
  })
})

