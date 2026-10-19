import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { HttpApp } from "@effect/platform"
import { Context, Effect, Exit, Layer, Redacted, Scope } from "effect"
import { PgClient } from "@effect/sql-pg"
import pg from "pg"
import { AcquisitionRepositoryLive, AuthRepositoryLive, GrowthRepository, RecordRepository, RecordRepositoryLive, type Session } from "@openrecord/db"
import type { GrowthOpportunity, GrowthProfile } from "@openrecord/contracts"
import { growthApi } from "./growth-routes.js"
import { requireSession, RepoLayers } from "./router.js"
import { dispatchAgentTool, runConversation } from "./agent.js"
import { runAgentTool, type AgentToolDeps } from "./agent-tools.js"
import type { AgentModel } from "./agent-model.js"

const url = process.env["TEST_DATABASE_URL"] ?? ""
const product = { name: "TEST Growth product", websiteUrl: "https://growth.test", engagement: "DOGFOOD", category: "TEST SaaS", audience: "TEST operators", valueProposition: "TEST positioning",
  goalStatement: "Increase trial signups", metric: { conversionKind: "SIGNUP", label: "Trial signups", sourceKind: "GA4_AGGREGATE_EXPORT", sourceIdentity: "TEST GA4", eventName: "trial_signup", countingSemantics: "EVENT_COUNT", unit: "COUNT", currency: null, reportingTimeZone: "UTC", propertyRef: "TEST property" } }
const suite = url ? describe : describe.skip
suite("growth HTTP and fixture-model agent (no provider calls)", () => {
  let pool: pg.Pool, scope: Scope.CloseableScope, ctx: Context.Context<AgentToolDeps>
  const repos = Layer.mergeAll(
    AuthRepositoryLive, RecordRepositoryLive, AcquisitionRepositoryLive,
    RepoLayers.GrowthRepositoriesLive, RepoLayers.AgentProposalRepositoryLive, RepoLayers.BusinessRepositoryLive,
    RepoLayers.DiscoveryScopeRepositoryLive, RepoLayers.FactRepositoryLive,
    RepoLayers.ProductReadRepositoryLive, RepoLayers.QuestionRepositoryLive,
  )
    .pipe(Layer.provideMerge(PgClient.layer({ url: Redacted.make(url) })))
  const web = HttpApp.toWebHandlerLayer(growthApi(run => Effect.flatMap(requireSession, ({ session }) => run(session))), repos)
  const run = <A, E>(fx: Effect.Effect<A, E, AgentToolDeps>) => Effect.runPromise(Effect.provide(fx, ctx))
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url }); scope = await Effect.runPromise(Scope.make())
    ctx = await Effect.runPromise(Layer.buildWithScope(repos, scope))
  })
  afterAll(async () => { await web.dispose(); await Effect.runPromise(Scope.close(scope, Exit.void)); await pool.end() })
  const call = (method: string, path: string, cookie?: string, body?: unknown, extraHeaders = {}) => web.handler(new Request(`http://localhost${path}`, {
    method, headers: { "content-type": "application/json", ...(cookie ? { cookie: `or_session=${cookie}` } : {}), ...extraHeaders },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }))
  const ok = async <T>(response: Promise<Response>): Promise<T> => {
    const r = await response
    if (r.status !== 200) throw new Error(`Expected 200, got ${r.status}: ${await r.text()}`)
    return await r.json() as T
  }
  const fixture = async () => {
    const accountId = String((await pool.query("INSERT INTO accounts(name) VALUES('TEST Growth API') RETURNING id")).rows[0].id)
    const userId = String((await pool.query("INSERT INTO users(email,password_hash) VALUES($1,'TEST-only') RETURNING id", [`growth-api-${randomUUID()}@example.test`])).rows[0].id)
    await pool.query("INSERT INTO account_users(account_id,user_id) VALUES($1,$2)", [accountId, userId])
    const cookie = String((await pool.query("INSERT INTO sessions(account_id,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour') RETURNING id", [accountId, userId])).rows[0].id)
    const { profile } = await ok<{ profile: GrowthProfile }>(call("POST", "/api/growth/products", cookie, { ...product, idempotencyKey: randomUUID() }))
    return { session: { accountId, userId } satisfies Session, cookie, profile, path: `/api/growth/clients/${profile.businessId}` }
  }
  const proposal = (f: Awaited<ReturnType<typeof fixture>>) => ({ goalId: f.profile.primaryGoal.id, title: "TEST explain eligibility", problemStatement: "Trial eligibility unclear", audience: "TEST operators",
    buyerIntent: "Try software", targetUrl: "https://growth.test/trial", source: "TEST fixture investigation", proposedChange: "Clarify requirements", expectedMechanism: "Reduce uncertainty",
    assumptions: "Audience needs clarity", uncertainty: "No impact measured", baselineAvailability: "UNKNOWN", idempotencyKey: randomUUID() })
  it("requires auth, refuses sibling origins and returns 404 for all foreign resources", async () => {
    const f = await fixture(), other = await fixture()
    expect((await call("GET", f.path)).status).toBe(401)
    for (const [method, path, body] of [["GET", f.path, undefined], ["PUT", f.path, product], ["GET", `${f.path}/opportunities`, undefined], ["POST", `${f.path}/opportunities`, {}],
      ["GET", `${f.path}/opportunities/${randomUUID()}`, undefined], ["POST", `${f.path}/opportunities/${randomUUID()}/approve`, {}]] as const) {
      const r = await call(method, path, other.cookie, body); expect(r.status).toBe(404)
      expect(await r.text()).not.toContain(f.profile.primaryGoal.id)
    }
    for (const headers of [{ origin: "https://hostile.test" }, { "sec-fetch-site": "same-site" }, { "sec-fetch-site": "cross-site" }]) expect((await call("PUT", f.path, f.cookie, product, headers)).status).toBe(403)
    const invalid = await call("PUT", f.path, f.cookie, { category: "TEST", audience: "TEST", valueProposition: "TEST", metric: { ...product.metric, countingSemantics: "DISTINCT_USERS" } })
    expect(invalid.status).toBe(422)
  })
  it("lets operators create, approve/reject and replay decisions while rejecting forged authority/evidence", async () => {
    const f = await fixture()
    const body = { ...proposal(f), initialStatus: "PROPOSED", ownerUserId: f.session.userId, evidence: [{ type: "OPERATOR_HYPOTHESIS", note: "TEST operator hypothesis" }] }
    const { opportunity: o } = await ok<{ opportunity: GrowthOpportunity }>(call("POST", `${f.path}/opportunities`, f.cookie, body))
    const other = await fixture()
    for (const goalId of [other.profile.primaryGoal.id, randomUUID()]) {
      const foreignGoal = await call("POST", `${f.path}/opportunities`, f.cookie, { ...body, goalId, idempotencyKey: randomUUID() })
      expect(foreignGoal.status).toBe(404); expect(await foreignGoal.text()).not.toContain(goalId)
    }
    const foreignOpportunity = await call("GET", `${other.path}/opportunities/${o.id}`, other.cookie)
    expect(foreignOpportunity.status).toBe(404); expect(await foreignOpportunity.text()).not.toContain(o.title)
    const replay = await ok<{ opportunity: GrowthOpportunity }>(call("POST", `${f.path}/opportunities`, f.cookie, body)); expect(replay.opportunity.id).toBe(o.id)
    for (const type of ["VERIFIED_ACTION", "MEASURED_OUTCOME", "MODEL_SUGGESTION"]) expect((await call("POST", `${f.path}/opportunities`, f.cookie, { ...body, idempotencyKey: randomUUID(), evidence: [{ type, note: "TEST forged" }] })).status).toBe(422)
    expect((await call("POST", `${f.path}/opportunities`, f.cookie, { ...body, initialStatus: "APPROVED" })).status).toBe(422)
    const d = { expectedStatus: "PROPOSED", expectedRevision: 1, idempotencyKey: randomUUID(), reason: "TEST human review" }
    expect((await call("POST", `${f.path}/opportunities/${o.id}/approve`, f.cookie, { ...d, actor: "ASSISTANT" })).status).toBe(422)
    const approve = () => ok<{ opportunity: GrowthOpportunity }>(call("POST", `${f.path}/opportunities/${o.id}/approve`, f.cookie, d))
    const [x, y] = await Promise.all([approve(), approve()]); expect(x).toEqual(y); expect(x.opportunity.status).toBe("APPROVED")
    expect((await call("POST", `${f.path}/opportunities/${o.id}/cancel`, f.cookie, { ...d, idempotencyKey: randomUUID() })).status).toBe(409)
    const discovered = await ok<{ opportunity: GrowthOpportunity }>(call("POST", `${f.path}/opportunities`, f.cookie, { ...body, initialStatus: "DISCOVERED", idempotencyKey: randomUUID() }))
    const proposed = await ok<{ opportunity: GrowthOpportunity }>(call("POST", `${f.path}/opportunities/${discovered.opportunity.id}/propose`, f.cookie, { ...d, expectedStatus: "DISCOVERED", idempotencyKey: randomUUID() }))
    expect(proposed.opportunity.status).toBe("PROPOSED"); expect(proposed.opportunity.events).toHaveLength(2)
    const fresh = await ok<{ opportunity: GrowthOpportunity }>(call("POST", `${f.path}/opportunities`, f.cookie, { ...body, idempotencyKey: randomUUID() }))
    const rejected = await ok<{ opportunity: GrowthOpportunity }>(call("POST", `${f.path}/opportunities/${fresh.opportunity.id}/reject`, f.cookie, { ...d, idempotencyKey: randomUUID() }))
    expect(rejected.opportunity.status).toBe("CANCELLED"); expect(rejected.opportunity.events[1]?.actor).toBe("OPERATOR")
  })
  it("fixture conversation reads scoped goal/opportunities and proposes MODEL_SUGGESTION with validated observed references", async () => {
    const f = await fixture(), other = await fixture()
    const action = await run(Effect.flatMap(RecordRepository, r => r.recordAction(f.session, f.profile.businessId, { type: "OTHER", slot: null, note: "TEST stored action", links: [], performedAt: new Date().toISOString() })))
    const args = { ...proposal(f), observedReferences: [{ kind: "RECORD_ACTION", id: action.id }, { kind: "RECORD_ACTION", id: randomUUID() }] }
    let step = 0
    const model: AgentModel = input => {
      expect(input.system).toContain("MODEL_SUGGESTION hypotheses")
      const name = ["read_growth_goal", "read_growth_opportunities", "propose_growth_opportunity"][step++]
      if (name) return Effect.succeed({ candidates: [{ content: { role: "model", parts: [{ functionCall: { name, args: name === "propose_growth_opportunity" ? args : {} } }] }, finishReason: "STOP" }] })
      expect(JSON.stringify(input.contents)).toContain('"droppedReferences":1')
      return Effect.succeed({ candidates: [{ content: { role: "model", parts: [{ text: "A trial eligibility hypothesis is ready for your review in the growth workspace." }] }, finishReason: "STOP" }] })
    }
    const answer = await run(runConversation({ message: "What should we improve for this product?", history: [], model,
      dispatch: (name, raw) => dispatchAgentTool(f.session.accountId, f.session.userId, f.profile.businessId, name, raw).pipe(Effect.provide(ctx)) }))
    expect(answer.toolCalls).toHaveLength(3); expect(answer.citations.some(c => c.kind === "growth_opportunity")).toBe(true)
    const list = await run(Effect.flatMap(GrowthRepository, r => r.list(f.session.accountId, f.profile.businessId)))
    expect(list).toHaveLength(1); expect(list[0]?.status).toBe("PROPOSED"); expect(list[0]?.createdByActor).toBe("ASSISTANT")
    expect(list[0]?.evidence.map(e => e.type).sort()).toEqual(["MODEL_SUGGESTION", "OBSERVED"])
    const replay = await run(dispatchAgentTool(f.session.accountId, f.session.userId, f.profile.businessId, "propose_growth_opportunity", args))
    expect(replay.data).toMatchObject({ opportunityId: list[0]?.id })
    for (const name of ["read_growth_goal", "read_growth_opportunities"]) {
      const foreign = await run(Effect.either(runAgentTool(other.session.accountId, f.profile.businessId, name, {})))
      expect(foreign).toMatchObject({ _tag: "Left", left: { _tag: "AgentNotInScope" } })
    }
    for (const name of ["approve_growth_opportunity", "cancel_growth_opportunity"]) {
      const out = await run(Effect.either(dispatchAgentTool(f.session.accountId, f.session.userId, f.profile.businessId, name, { opportunityId: list[0]?.id })))
      expect(out).toMatchObject({ _tag: "Left", left: { _tag: "AgentUnknownTool" } })
    }
    const foreignProposal = await run(Effect.either(dispatchAgentTool(other.session.accountId, other.session.userId, f.profile.businessId, "propose_growth_opportunity", args)))
    expect(foreignProposal).toMatchObject({ _tag: "Left", left: { _tag: "AgentNotInScope" } })
    const foreignGoal = await run(Effect.either(dispatchAgentTool(f.session.accountId, f.session.userId, f.profile.businessId, "propose_growth_opportunity", { ...args, goalId: other.profile.primaryGoal.id, idempotencyKey: randomUUID() })))
    expect(foreignGoal).toMatchObject({ _tag: "Left", left: { reason: "GoalNotFound" } })
    const noEvidence = await run(dispatchAgentTool(f.session.accountId, f.session.userId, f.profile.businessId, "propose_growth_opportunity", { ...args, idempotencyKey: randomUUID(), observedReferences: [] }))
    expect(noEvidence.data).toMatchObject({ hypothesis: true, validatedObservedReferences: 0 })
    const updated = await run(Effect.flatMap(GrowthRepository, r => r.list(f.session.accountId, f.profile.businessId)))
    expect(updated.find(o => o.evidence.length === 1)?.evidence[0]?.type).toBe("MODEL_SUGGESTION")
    const malformed = await run(Effect.either(dispatchAgentTool(f.session.accountId, f.session.userId, f.profile.businessId, "propose_growth_opportunity", { ...args, initialStatus: "APPROVED" })))
    expect(malformed._tag).toBe("Left")
  })
  it.each(["SIGNUP", "BOOKING"] as const)("onboards a %s business, preserves versions and accepts a human review", async kind => {
    const f = await fixture()
    const metric = kind === "SIGNUP" ? product.metric : { conversionKind: "BOOKING", label: "Confirmed bookings", sourceKind: "OPERATOR_AGGREGATE_EXPORT", sourceIdentity: "TEST appointment system",
      eventName: null, countingSemantics: "EVENT_COUNT", unit: "COUNT", currency: null, reportingTimeZone: "Europe/London", propertyRef: null }
    const { profile } = await ok<{ profile: GrowthProfile }>(call("PUT", f.path, f.cookie, { category: kind === "BOOKING" ? "TEST local appointment service" : product.category, audience: kind === "BOOKING" ? "TEST patients" : product.audience, valueProposition: product.valueProposition, goalStatement: `Improve TEST ${kind}`, metric }))
    expect(profile.primaryGoal.metricDefinition.conversionKind).toBe(kind)
    expect(profile.category).toBe(kind === "BOOKING" ? "TEST local appointment service" : "TEST SaaS")
    const { opportunity } = await ok<{ opportunity: GrowthOpportunity }>(call("POST", `${f.path}/opportunities`, f.cookie, { ...proposal(f), goalId: profile.primaryGoal.id, targetUrl: null,
      initialStatus: "PROPOSED", ownerUserId: f.session.userId, evidence: [{ type: "OPERATOR_HYPOTHESIS", note: "TEST W0 scenario" }] }))
    const request = { expectedStatus: "PROPOSED", expectedRevision: 1, idempotencyKey: randomUUID(), reason: "TEST approved" }
    await ok(call("POST", `${f.path}/opportunities/${opportunity.id}/approve`, f.cookie, request))
    const row = (await pool.query("INSERT INTO interventions(business_id,type,target,performed_at,actor,actor_id,channel,assurance) VALUES($1,'CAMPAIGN_SENT','TEST email',now(),'HUMAN',$2,'EMAIL','OPERATOR_ATTESTED') RETURNING id", [profile.businessId, f.session.userId])).rows[0]
    await pool.query("INSERT INTO growth_initiative_actions(intervention_id,opportunity_id,business_id,request_key,created_by_user_id) VALUES($1,$2,$3,$4,$5)", [row.id, opportunity.id, profile.businessId, randomUUID(), f.session.userId])
    const { opportunity: fresh } = await ok<{ opportunity: GrowthOpportunity }>(call("GET", `${f.path}/opportunities/${opportunity.id}`, f.cookie))
    expect(fresh).toMatchObject({ status: "APPROVED", progress: "EXECUTED", executionCount: 1, targetUrl: null, revision: 2 })
    const review = { expectedStatus: "APPROVED", expectedRevision: 2, idempotencyKey: randomUUID(), reason: "TEST observation only", conclusion: "INCONCLUSIVE" }
    expect((await call("POST", `${f.path}/opportunities/${opportunity.id}/review`, undefined, review)).status).toBe(401)
    expect((await call("POST", `${f.path}/opportunities/${opportunity.id}/review`, f.cookie, review, { origin: "https://hostile.test" })).status).toBe(403)
    const other = await fixture()
    expect((await call("POST", `${f.path}/opportunities/${opportunity.id}/review`, other.cookie, review)).status).toBe(404)
    const reviewed = await ok<{ opportunity: GrowthOpportunity }>(call("POST", `${f.path}/opportunities/${opportunity.id}/review`, f.cookie, review))
    expect(reviewed.opportunity.status).toBe("REVIEWED")
    expect((await ok<{ opportunity: GrowthOpportunity }>(call("GET", `${f.path}/opportunities/${opportunity.id}`, f.cookie))).opportunity).toEqual(reviewed.opportunity)
    expect((await call("POST", `${f.path}/opportunities/${opportunity.id}/review`, f.cookie, { ...review, conclusion: "KEEP" })).status).toBe(409)
  })

})
