import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { HttpApp, HttpRouter } from "@effect/platform"
import { Effect, Layer, ManagedRuntime, Redacted } from "effect"
import { PgClient } from "@effect/sql-pg"
import { AcquisitionRepositoryLive, AuthRepositoryLive, RecordRepositoryLive } from "@openrecord/db"
import pg from "pg"
import { growthApi } from "./growth-routes.js"
import { objectivesApi, readObjectiveInvestigations } from "./objectives.js"
import { requireSession, RepoLayers } from "./router.js"
import { dispatchInvestigation } from "./agent-investigation-tools.js"
import { followupPolicyApi } from "./agent-followup-policy.js"
import { claimFollowup } from "./agent-followups.js"
import { sendConversation, type Responder } from "./agent-conversations.js"
import { AgentModelError } from "./agent-model.js"

const url = process.env["TEST_DATABASE_URL"] ?? ""
const suite = url ? describe : describe.skip
suite("objective investigations (disposable PostgreSQL)", () => {
  let pool: pg.Pool
  const repos = Layer.mergeAll(AuthRepositoryLive, RecordRepositoryLive, AcquisitionRepositoryLive,
    RepoLayers.GrowthRepositoriesLive, RepoLayers.BusinessRepositoryLive).pipe(Layer.provideMerge(PgClient.layer({ url: Redacted.make(url) })))
  const session = <A, E, R>(run: (s: import("@openrecord/db").Session) => Effect.Effect<A, E, R>) => Effect.flatMap(requireSession, ({ session: s }) => run(s))
  const web = HttpApp.toWebHandlerLayer(HttpRouter.concat(HttpRouter.concat(growthApi(session), objectivesApi(session)), followupPolicyApi(session)), repos)
  const runtime = ManagedRuntime.make(repos)
  beforeAll(() => { pool = new pg.Pool({ connectionString: url }) })
  afterAll(async () => { await web.dispose(); await runtime.dispose(); await pool.end() })
  const call = (method: string, path: string, cookie?: string, body?: unknown, headers: Record<string, string> = {}) => web.handler(new Request(`http://localhost${path}`, {
    method, headers: { "content-type": "application/json", ...(cookie ? { cookie: `or_session=${cookie}` } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }))
  const fixture = async () => {
    const accountId = String((await pool.query("INSERT INTO accounts(name) VALUES('TEST objective') RETURNING id")).rows[0].id)
    const userId = String((await pool.query("INSERT INTO users(email,password_hash) VALUES($1,'TEST') RETURNING id", [`objective-${randomUUID()}@example.test`])).rows[0].id)
    await pool.query("INSERT INTO account_users(account_id,user_id) VALUES($1,$2)", [accountId, userId])
    const cookie = String((await pool.query("INSERT INTO sessions(account_id,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour') RETURNING id", [accountId, userId])).rows[0].id)
    const response = await call("POST", "/api/growth/products", cookie, { name: "TEST product", websiteUrl: "https://example.test", engagement: "DOGFOOD", category: "Software", audience: "Teams", valueProposition: "Help teams", goalStatement: "More qualified leads", idempotencyKey: randomUUID(), metric: { conversionKind: "SIGNUP", label: "Signups", sourceKind: "GA4_AGGREGATE_EXPORT", sourceIdentity: "Test", eventName: "signup", countingSemantics: "EVENT_COUNT", unit: "COUNT", currency: null, reportingTimeZone: "UTC", propertyRef: "Test" } })
    expect(response.status).toBe(200)
    const data = await response.json() as { profile: { businessId: string; primaryGoal: { id: string } } }
    return { cookie, accountId, userId, businessId: data.profile.businessId, goalId: data.profile.primaryGoal.id }
  }
  it("preserves scoped investigations, safe retries and uncertainty across reads", async () => {
    const f = await fixture(), other = await fixture()
    const path = `/api/businesses/${f.businessId}/investigations`
    expect((await call("GET", path)).status).toBe(401)
    expect((await call("GET", path, other.cookie)).status).toBe(404)
    const request = { requestId: randomUUID(), goalId: f.goalId, question: "Why are leads not converting?" }
    expect((await call("POST", path, f.cookie, request, { origin: "https://hostile.test" })).status).toBe(403)
    const first = await call("POST", path, f.cookie, request)
    expect(first.status).toBe(200)
    const created = await first.json() as { investigation: { id: string } }
    const replay = await call("POST", path, f.cookie, request)
    expect((await replay.json() as typeof created).investigation.id).toBe(created.investigation.id)
    expect((await call("POST", path, f.cookie, { ...request, question: "Different question" })).status).toBe(409)
    expect((await call("POST", path, f.cookie, { ...request, requestId: randomUUID(), goalId: other.goalId })).status).toBe(409)
    const notesPath = `${path}/${created.investigation.id}/notes`
    const note = { requestId: randomUUID(), kind: "HYPOTHESIS", note: "Follow-up may be slow; CRM data not yet checked." }
    expect((await call("POST", notesPath, f.cookie, note)).status).toBe(200)
    expect((await call("POST", notesPath, f.cookie, note)).status).toBe(200)
    expect((await call("POST", notesPath, f.cookie, { ...note, note: "Different note" })).status).toBe(409)
    expect((await call("POST", notesPath, other.cookie, note)).status).toBe(404)
    const detail = await call("GET", `${path}/${created.investigation.id}`, f.cookie)
    expect(detail.status).toBe(200)
    expect((await detail.json() as { notes: Array<{ note: string }> }).notes[0]?.note).toBe(note.note)
    const read = await call("GET", path, f.cookie)
    expect(read.status).toBe(200)
    const data = await read.json() as { data: { investigations: Array<{ notes: unknown[] }>; note: string } }
    expect(data.data.investigations).toHaveLength(1)
    expect(data.data.investigations[0]?.notes).toHaveLength(1)
    expect(data.data.note).toContain("not independently verified evidence")
  })

  it("persists timed follow-ups, replays safely and refuses stale state changes", async () => {
    const f = await fixture()
    const ctx = { accountId: f.accountId, userId: f.userId, businessId: f.businessId }
    await runtime.runPromise(dispatchInvestigation(ctx, "open_investigation", { goalId: f.goalId, question: "Reassess lead quality after the reporting period" }))
    const investigationId = (await pool.query("SELECT id FROM growth_investigations WHERE business_id=$1", [f.businessId])).rows[0].id
    const input = { investigationId, expectedStateNoteId: null, note: "Review the new period before making a recommendation", resumeAfter: "2020-01-01T00:00:00Z" }
    const wait = () => runtime.runPromise(dispatchInvestigation(ctx, "wait_for_investigation", input))
    const [first, replay] = await Promise.all([wait(), wait()])
    expect(first.data).toEqual(replay.data)
    expect(first.data).toMatchObject({ followUp: { backgroundRunScheduled: false } })
    const overview = await runtime.runPromise(readObjectiveInvestigations(f.accountId, f.businessId))
    expect(overview.data.investigations[0]).toMatchObject({ work_state: "WAITING_FOR_INPUT", follow_up: { condition: "TIME_REACHED" } })
    const stale = await runtime.runPromise(Effect.either(dispatchInvestigation(ctx, "record_investigation_note", {
      investigationId, expectedStateNoteId: null, workState: "CLOSED", kind: "CONCLUSION", note: "Set aside",
    })))
    expect(stale).toMatchObject({ _tag: "Left", left: { _tag: "AgentInvestigationConflict" } })
    const row = (await pool.query("SELECT id FROM growth_investigation_notes WHERE investigation_id=$1", [investigationId])).rows[0]
    await runtime.runPromise(dispatchInvestigation(ctx, "record_investigation_note", {
      investigationId, expectedStateNoteId: row.id, workState: "OPEN", kind: "OBSERVATION", note: "Period is ready; review current evidence",
    }))
    const reopened = await runtime.runPromise(readObjectiveInvestigations(f.accountId, f.businessId))
    expect(reopened.data.investigations[0]).toMatchObject({ work_state: "OPEN", follow_up: null })
    // A late delivery of the old save must not restore its waiting state.
    await wait()
    expect((await runtime.runPromise(readObjectiveInvestigations(f.accountId, f.businessId))).data.investigations[0]).toMatchObject({ work_state: "OPEN" })
  })

  it("waits for a scoped proposal decision without treating rejection as execution", async () => {
    const f = await fixture(), other = await fixture()
    const ctx = { accountId: f.accountId, userId: f.userId, businessId: f.businessId }
    await runtime.runPromise(dispatchInvestigation(ctx, "open_investigation", { goalId: f.goalId, question: "Reassess after the operator decision" }))
    const investigationId = (await pool.query("SELECT id FROM growth_investigations WHERE business_id=$1", [f.businessId])).rows[0].id
    const proposal = async (businessId: string, userId: string) => String((await pool.query(
      "INSERT INTO agent_proposals(business_id,kind,message,proposer,proposed_by_user_id) VALUES($1,'REQUEST_CHECK','TEST follow-up','assistant-v1',$2) RETURNING id", [businessId, userId],
    )).rows[0].id)
    const own = await proposal(f.businessId, f.userId), foreign = await proposal(other.businessId, other.userId)
    const input = { investigationId, expectedStateNoteId: null, note: "Reassess the operator's decision without replaying the action" }
    const denied = await runtime.runPromise(Effect.either(dispatchInvestigation(ctx, "wait_for_investigation", { ...input, proposalId: foreign })))
    expect(denied).toMatchObject({ _tag: "Left", left: { _tag: "AgentNotInScope" } })
    await runtime.runPromise(dispatchInvestigation(ctx, "wait_for_investigation", { ...input, proposalId: own }))
    expect((await runtime.runPromise(readObjectiveInvestigations(f.accountId, f.businessId))).data.investigations[0]).toMatchObject({ follow_up: { condition: "WAITING", proposalStatus: "PROPOSED" } })
    await pool.query("UPDATE agent_proposals SET status='REJECTED',decided_by_user_id=$2,decided_at=now() WHERE id=$1", [own, f.userId])
    expect((await runtime.runPromise(readObjectiveInvestigations(f.accountId, f.businessId))).data.investigations[0]).toMatchObject({ follow_up: { condition: "PROPOSAL_CHANGED", proposalStatus: "REJECTED" } })
    expect((await pool.query("SELECT status FROM agent_proposals WHERE id=$1", [own])).rows[0].status).toBe("REJECTED")
  })

  it("claims opted-in wake-ups once, enforces the daily limit and revokes authority", async () => {
    const f = await fixture(), other = await fixture()
    const path = `/api/businesses/${f.businessId}/agent/follow-ups`
    expect((await call("GET", path)).status).toBe(401)
    expect((await call("GET", path, other.cookie)).status).toBe(404)
    expect(await (await call("GET", path, f.cookie)).json()).toMatchObject({ policy: { kind: "unconfigured" } })
    const conversationId = String((await pool.query("INSERT INTO agent_conversations(account_id,user_id,business_id,archived_at) VALUES($1,$2,$3,now()) RETURNING id", [f.accountId, f.userId, f.businessId])).rows[0].id)
    const ctx = { accountId: f.accountId, userId: f.userId, businessId: f.businessId }
    await runtime.runPromise(dispatchInvestigation(ctx, "open_investigation", { goalId: f.goalId, question: "Reassess with explicit background consent" }))
    const investigationId = (await pool.query("SELECT id FROM growth_investigations WHERE business_id=$1", [f.businessId])).rows[0].id
    await runtime.runPromise(dispatchInvestigation(ctx, "wait_for_investigation", { investigationId, expectedStateNoteId: null, note: "Review the new period", resumeAfter: "2020-01-01T00:00:00Z" }))
    const grantId = randomUUID()
    const policyId = String((await pool.query("INSERT INTO growth_investigation_wake_policies(account_id,user_id,business_id,conversation_id,grant_id,enabled,provider,model) VALUES($1,$2,$3,$4,$5,true,'gemini','fixture') RETURNING id", [f.accountId, f.userId, f.businessId, conversationId, grantId])).rows[0].id)
    const [one, two] = await Promise.all([runtime.runPromise(claimFollowup), runtime.runPromise(claimFollowup)])
    const claimed = [one, two].filter(wake => wake?.policy_id === policyId)
    expect(claimed).toHaveLength(1)
    expect(claimed[0]).toMatchObject({ grant_id: grantId, conversation_id: conversationId })
    const wakeId = claimed[0]?.id
    // An ambiguous failed attempt consumes the limit and cannot replay this note.
    await pool.query("UPDATE growth_investigation_wakes SET status='FAILED',finished_at=now() WHERE id=$1", [wakeId])
    expect(await runtime.runPromise(claimFollowup)).toBeNull()
    expect((await call("PUT", path, f.cookie, { enabled: false }, { origin: "https://hostile.test" })).status).toBe(403)
    expect((await call("PUT", path, f.cookie, { enabled: false })).status).toBe(200)
    const policy = (await pool.query("SELECT enabled,grant_id FROM growth_investigation_wake_policies WHERE id=$1", [policyId])).rows[0]
    expect(policy.enabled).toBe(false)
    expect(policy.grant_id).not.toBe(grantId)
  })

  it("refuses a late reply when its background commit authority was revoked", async () => {
    const f = await fixture()
    const conversationId = String((await pool.query("INSERT INTO agent_conversations(account_id,user_id,business_id,archived_at) VALUES($1,$2,$3,now()) RETURNING id", [f.accountId, f.userId, f.businessId])).rows[0].id)
    const responder: Responder<never> = () => Effect.succeed({ reply: "This answer must not commit", citations: [], toolCalls: [], usage: [], provider: "fixture", requestedModel: "fixture" })
    const result = await runtime.runPromise(Effect.either(sendConversation({ accountId: f.accountId, userId: f.userId, businessId: f.businessId }, {
      conversationId, revision: 0, requestId: randomUUID(), message: "Review ready work", origin: { kind: "wake" },
    }, responder, Effect.fail(new AgentModelError({ reason: "CANCELLED" })))))
    expect(result._tag).toBe("Left")
    const conversation = (await pool.query("SELECT messages FROM agent_conversations WHERE id=$1", [conversationId])).rows[0]
    expect(JSON.stringify(conversation.messages)).not.toContain("This answer must not commit")
    expect((await pool.query("SELECT status FROM agent_runs WHERE conversation_id=$1", [conversationId])).rows[0].status).toBe("CANCELLED")
  })

  it("attributes agent notes, requires revision reasons, deduplicates writes and preserves history", async () => {
    const f = await fixture(), other = await fixture()
    const ctx = { accountId: f.accountId, userId: f.userId, businessId: f.businessId, origin: { provider: "gemini" as const, model: "fixture" } }
    const open = () => runtime.runPromise(dispatchInvestigation(ctx, "open_investigation", { goalId: f.goalId, question: "Why are qualified leads falling?" }))
    const [first, replay] = await Promise.all([open(), open()])
    expect(first.data).toEqual(replay.data)
    const row = (await pool.query("SELECT * FROM growth_investigations WHERE business_id=$1", [f.businessId])).rows[0]
    expect(row).toMatchObject({ created_by_actor: "ASSISTANT", origin_provider: "gemini", origin_model: "fixture" })
    const input = { investigationId: row.id, kind: "REVISION", note: "Lead follow-up now appears more relevant than search traffic.", reason: "The reported search traffic was stable; CRM response time remains unverified." }
    const write = () => runtime.runPromise(dispatchInvestigation(ctx, "record_investigation_note", input))
    const [one, two] = await Promise.all([write(), write()])
    expect(one.data).toEqual(two.data)
    const notes = (await pool.query("SELECT * FROM growth_investigation_notes WHERE investigation_id=$1", [row.id])).rows
    expect(notes).toHaveLength(1)
    expect(notes[0]).toMatchObject({ created_by_actor: "ASSISTANT", revision_reason: input.reason })
    const invalid = await runtime.runPromise(Effect.either(dispatchInvestigation(ctx, "record_investigation_note", { investigationId: row.id, kind: "REVISION", note: "Unexplained change" })))
    expect(invalid._tag).toBe("Left")
    const foreign = await runtime.runPromise(Effect.either(dispatchInvestigation({ ...ctx, businessId: other.businessId }, "record_investigation_note", input)))
    expect(foreign).toMatchObject({ _tag: "Left", left: { _tag: "AgentNotInScope" } })
    await expect(pool.query("UPDATE growth_investigation_notes SET note='Rewritten' WHERE id=$1", [notes[0].id])).rejects.toMatchObject({ code: "23514" })
    const detail = await call("GET", `/api/businesses/${f.businessId}/investigations/${row.id}`, f.cookie)
    expect(detail.status).toBe(200)
    expect((await detail.json() as { notes: Array<{ created_by_actor: string; revision_reason: string }> }).notes[0]).toMatchObject({ created_by_actor: "ASSISTANT", revision_reason: input.reason })
  })
})
