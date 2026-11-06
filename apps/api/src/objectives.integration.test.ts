import { createHash, randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { HttpApp, HttpRouter } from "@effect/platform"
import { Effect, Layer, ManagedRuntime, Redacted } from "effect"
import { PgClient } from "@effect/sql-pg"
import { AcquisitionRepositoryLive, AgentProposalRepositoryLive, AuthRepositoryLive, DiscoveryScopeRepositoryLive, FactRepositoryLive, ProductReadRepositoryLive,
  QuestionRepositoryLive, RecordRepositoryLive, SetupRepositoryLive } from "@openrecord/db"
import pg from "pg"
import { growthApi } from "./growth-routes.js"
import { objectivesApi, readObjectiveInvestigations } from "./objectives.js"
import { requireSession, RepoLayers } from "./router.js"
import { dispatchInvestigation, INVESTIGATION_READ_TOOLS } from "./agent-investigation-tools.js"
import { followupPolicyApi } from "./agent-followup-policy.js"
import { claimFollowup } from "./agent-followups.js"
import { sendConversation, type Responder } from "./agent-conversations.js"
import { AgentModelError, type AgentModel } from "./agent-model.js"
import { dispatchCampaignRun } from "./campaign-engine.js"
import { draftMarketingCampaign } from "./campaign-agent.js"
import { agentDeclarations, runConversation } from "./agent.js"
import { loadResumeContext } from "./agent-resume.js"
import type { CampaignBrief } from "@openrecord/contracts"

const url = process.env["TEST_DATABASE_URL"] ?? ""
const suite = url ? describe : describe.skip
suite("objective investigations (disposable PostgreSQL)", () => {
  let pool: pg.Pool
  const repos = Layer.mergeAll(AuthRepositoryLive, RecordRepositoryLive, AcquisitionRepositoryLive,
    RepoLayers.GrowthRepositoriesLive, RepoLayers.BusinessRepositoryLive, AgentProposalRepositoryLive, DiscoveryScopeRepositoryLive,
    FactRepositoryLive, ProductReadRepositoryLive, QuestionRepositoryLive, SetupRepositoryLive).pipe(Layer.provideMerge(PgClient.layer({ url: Redacted.make(url) })))
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
    expect({ ...first.data, reused: true }).toEqual({ ...replay.data, reused: true })
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
    const close = { investigationId, expectedStateNoteId: reopened.data.investigations[0]?.["state_note_id"], workState: "CLOSED", kind: "CONCLUSION", note: "Set aside; this is not proof the goal succeeded" }
    const closed = await runtime.runPromise(dispatchInvestigation(ctx, "record_investigation_note", close))
    expect((await runtime.runPromise(dispatchInvestigation(ctx, "record_investigation_note", close))).data.noteId).toBe(closed.data.noteId)
    await runtime.runPromise(dispatchInvestigation(ctx, "record_investigation_note", { investigationId, kind: "OBSERVATION", note: "Historical context only; no state change requested" }))
    expect((await runtime.runPromise(readObjectiveInvestigations(f.accountId, f.businessId))).data.investigations[0]).toMatchObject({ work_state: "CLOSED", follow_up: null })
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
    expect({ ...one.data, reused: true }).toEqual({ ...two.data, reused: true })
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

  const brief = (title: string, tasks: CampaignBrief["tasks"] = []): CampaignBrief => ({ title, goal: "More qualified leads", audience: "Teams", offer: "Guided onboarding",
    message: "Get your first result", hypothesis: "Guidance helps", metric: "Qualified leads in CRM", baseline: "Unknown; first test", target: "Suggested: 10", owner: "Marketing",
    launchDate: "2026-11-05", reviewDate: "2026-11-12", status: "DRAFT", tasks, result: "", decision: "UNDECIDED", learning: "", nextMove: "" })
  const campaign = async (businessId: string, userId: string, saved = brief("TEST linked campaign")) => String((await pool.query(
    "INSERT INTO marketing_campaigns(business_id,created_by_user_id,brief) VALUES($1,$2,$3::jsonb) RETURNING id", [businessId, userId, JSON.stringify(saved)])).rows[0].id)
  const openInvestigation = async (ctx: { accountId: string; userId: string; businessId: string }, goalId: string, question: string) => {
    await runtime.runPromise(dispatchInvestigation(ctx, "open_investigation", { goalId, question }))
    return String((await pool.query("SELECT id FROM growth_investigations WHERE business_id=$1 AND question=$2", [ctx.businessId, question])).rows[0].id)
  }
  // Pins the persisted request key of notes saved before campaign links existed.
  const unlinkedKey = (parts: ReadonlyArray<string>) => {
    const hex = createHash("sha256").update(JSON.stringify(parts)).digest("hex")
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
  }

  it("links notes to a scoped campaign revision and replays them after campaign edits", async () => {
    const f = await fixture(), other = await fixture()
    const ctx = { accountId: f.accountId, userId: f.userId, businessId: f.businessId }
    const note = (raw: unknown, scope = ctx) => runtime.runPromise(dispatchInvestigation(scope, "record_investigation_note", raw))
    const attempt = (raw: unknown, scope = ctx, tool = "record_investigation_note") => runtime.runPromise(Effect.either(dispatchInvestigation(scope, tool, raw)))
    const investigationId = await openInvestigation(ctx, f.goalId, "Which campaign moves qualified leads?")
    const campaignId = await campaign(f.businessId, f.userId), foreignCampaignId = await campaign(other.businessId, other.userId)
    const count = async () => (await pool.query("SELECT count(*)::int AS n FROM growth_investigation_notes WHERE investigation_id=$1", [investigationId])).rows[0].n
    const plain = { investigationId, kind: "OBSERVATION", note: "Saved the onboarding campaign draft; next, plan distribution." }
    const unlinked = await note(plain)
    expect((await pool.query("SELECT request_id FROM growth_investigation_notes WHERE id=$1", [unlinked.data.noteId])).rows[0].request_id)
      .toBe(unlinkedKey(["investigation-note:v1", f.userId, f.businessId, investigationId, "OBSERVATION", plain.note, "", "", "", "", ""]))
    expect(unlinked.data).toMatchObject({ campaign: null })

    const linked = { ...plain, campaignId }
    const [one, two] = await Promise.all([note(linked), note(linked)])
    expect({ ...one.data, reused: true }).toEqual({ ...two.data, reused: true })
    expect([one.data.reused, two.data.reused].sort()).toEqual([false, true])
    expect(one.data).toMatchObject({ campaign: { campaignId, notedRevision: 1 } })
    expect(one.data.noteId).not.toBe(unlinked.data.noteId)
    expect(await count()).toBe(2)

    await pool.query("UPDATE marketing_campaigns SET revision=revision+1 WHERE id=$1", [campaignId])
    expect((await note(linked)).data).toEqual({ ...one.data, reused: true })
    expect((await pool.query("SELECT campaign_revision FROM growth_investigation_notes WHERE investigation_id=$1 AND campaign_id=$2", [investigationId, campaignId])).rows)
      .toEqual([{ campaign_revision: 1 }])
    expect((await note({ ...linked, note: "Distribution plan saved to the campaign." })).data).toMatchObject({ campaign: { campaignId, notedRevision: 2 } })
    expect(await count()).toBe(3)
    const detail = await (await call("GET", `/api/businesses/${f.businessId}/investigations/${investigationId}`, f.cookie)).json() as { notes: Array<{ id: string; campaign_id: string | null; campaign_revision: number | null }> }
    expect(detail.notes.find(n => n.id === one.data.noteId)).toMatchObject({ campaign_id: campaignId, campaign_revision: 1 })
    expect(detail.notes.find(n => n.id === unlinked.data.noteId)).toMatchObject({ campaign_id: null, campaign_revision: null })
    const history = await runtime.runPromise(INVESTIGATION_READ_TOOLS[0]!.run(f.accountId, f.businessId, { investigationId }))
    expect(JSON.stringify(history.data)).toContain(`"campaign_id":"${campaignId}","campaign_revision":2`)

    for (const refused of [
      await attempt({ ...linked, campaignId: foreignCampaignId }), await attempt({ ...linked, campaignId: randomUUID() }),
      await attempt(linked, { ...ctx, businessId: other.businessId }), await attempt(linked, { ...ctx, accountId: other.accountId }),
    ]) expect(refused).toMatchObject({ _tag: "Left", left: { _tag: "AgentNotInScope" } })
    expect((await attempt({ investigationId, expectedStateNoteId: null, note: "Review later", resumeAfter: "2020-01-01T00:00:00Z", campaignId }, ctx, "wait_for_investigation"))._tag).toBe("Left")
    expect(await count()).toBe(3)

    const raw = (campaign: string | null, revision: number | null) => pool.query(`INSERT INTO growth_investigation_notes(investigation_id,business_id,request_id,kind,note,created_by_user_id,campaign_id,campaign_revision)
      VALUES($1,$2,$3,'OBSERVATION','TEST raw link',$4,$5,$6)`, [investigationId, f.businessId, randomUUID(), f.userId, campaign, revision])
    await expect(raw(foreignCampaignId, 1)).rejects.toMatchObject({ code: "23503" })
    await expect(raw(campaignId, null)).rejects.toMatchObject({ code: "23514" })
    await expect(raw(null, 1)).rejects.toMatchObject({ code: "23514" })
    await expect(raw(campaignId, 0)).rejects.toMatchObject({ code: "23514" })
    await expect(pool.query("UPDATE growth_investigation_notes SET campaign_id=$2, campaign_revision=2 WHERE id=$1", [unlinked.data.noteId, campaignId])).rejects.toMatchObject({ code: "23514" })

    await note({ ...linked, note: "Waiting for the owner's offer decision", workState: "WAITING_FOR_INPUT", expectedStateNoteId: null })
    const stale = await attempt({ ...linked, note: "Offer decided; resume distribution", workState: "OPEN", expectedStateNoteId: null })
    expect(stale).toMatchObject({ _tag: "Left", left: { _tag: "AgentInvestigationConflict" } })
    expect(await count()).toBe(4)
  })

  it("resumes a fresh conversation from the latest linked campaign's live state", async () => {
    const f = await fixture()
    const ctx = { accountId: f.accountId, userId: f.userId, businessId: f.businessId }
    const investigationId = await openInvestigation(ctx, f.goalId, "Does the onboarding landing page lift qualified leads?")
    const taskId = randomUUID()
    const campaignId = await campaign(f.businessId, f.userId, brief("TEST verifying campaign", [
      { id: taskId, title: "Landing page", channel: "WEBSITE", owner: "Marketing", due: "2026-11-05", status: "TODO", note: "Draft landing page copy" },
    ]))
    const runId = String((await runtime.runPromise(dispatchCampaignRun(ctx, "record_campaign_run", { campaignId }))).data.runs[0]!.id)
    const wordpressChangeId = String((await pool.query(`INSERT INTO wordpress_changes(business_id,account_id,kind,post_type,post_id,target_title,before_values,after_values,rationale,status,proposed_by,created_by_user_id,request_key)
      VALUES($1,$2,'UPDATE_COPY','pages',1,'Landing page','{}','{"content":"Draft landing page copy"}','TEST campaign delivery','PROPOSED','ASSISTANT',$3,$4) RETURNING id`,
      [f.businessId, f.accountId, f.userId, randomUUID().replaceAll("-", "").repeat(2)])).rows[0].id)
    await runtime.runPromise(dispatchCampaignRun(ctx, "record_campaign_delivery", { runId, taskId, wordpressChangeId }))
    await pool.query("UPDATE wordpress_changes SET status='PUBLISHED' WHERE id=$1", [wordpressChangeId])
    const linked = await runtime.runPromise(dispatchInvestigation(ctx, "record_investigation_note", {
      investigationId, kind: "OBSERVATION", note: "Linked the published landing page change; the live check has not observed it yet.", campaignId }))
    for (let i = 0; i < 5; i++) await runtime.runPromise(dispatchInvestigation(ctx, "record_investigation_note", { investigationId, kind: "HYPOTHESIS", note: `Unrelated idea ${i}` }))

    const overview = (await runtime.runPromise(readObjectiveInvestigations(f.accountId, f.businessId))).data.investigations[0]!
    expect(overview.notes).toHaveLength(4)
    expect(overview.campaign?.linkedAt).toBeInstanceOf(Date)
    expect(JSON.stringify(overview.notes)).not.toContain(String(linked.data.noteId))
    expect(overview.campaign).toMatchObject({ campaignId, linkedNoteId: linked.data.noteId, notedRevision: 1, currentRevision: 1, revisionChanged: false,
      latestRun: { id: runId, campaignRevision: 1, status: "VERIFYING", deliverables: { VERIFYING: 1 } } })

    const resumeContext = await runtime.runPromise(loadResumeContext(f.accountId, f.businessId, f.userId))
    let firstRequest = ""
    const model: AgentModel = input => {
      const part = input.contents[0]?.parts[0]
      firstRequest ||= typeof part === "object" && part !== null && "text" in part && typeof part.text === "string" ? part.text : ""
      return Effect.succeed({ candidates: [{ content: { role: "model", parts: [{ text: "The landing page change is still being verified." }] }, finishReason: "STOP" }] })
    }
    await Effect.runPromise(runConversation({ message: "/marketing Continue the objective", history: [], model, tools: [], resumeContext,
      dispatch: name => Effect.fail({ _tag: "Unexpected", name }) }))
    const resumed = JSON.parse(firstRequest.split("\n")[1] ?? "") as { investigations: Array<{ id: string; campaign: { campaignId: string; latestRun: { status: string } } }> }
    expect(firstRequest).toContain("VERIFYING or WAITING_FOR_APPROVAL is not delivery or success")
    expect(resumed.investigations[0]).toMatchObject({ id: investigationId, campaign: { campaignId, latestRun: { status: "VERIFYING" } } })

    await pool.query("UPDATE marketing_campaigns SET revision=revision+1 WHERE id=$1", [campaignId])
    expect((await runtime.runPromise(readObjectiveInvestigations(f.accountId, f.businessId))).data.investigations[0]?.campaign)
      .toMatchObject({ notedRevision: 1, currentRevision: 2, revisionChanged: true, latestRun: { id: runId, status: "STALE" } })
  })

  it("keeps objective context when campaign evidence is invalid and ignores older invalid runs", async () => {
    const f = await fixture()
    const ctx = { accountId: f.accountId, userId: f.userId, businessId: f.businessId }
    const investigationId = await openInvestigation(ctx, f.goalId, "Resume despite unavailable delivery evidence")
    const campaignId = await campaign(f.businessId, f.userId)
    const runId = String((await runtime.runPromise(dispatchCampaignRun(ctx, "record_campaign_run", { campaignId }))).data.runs[0]!.id)
    await runtime.runPromise(dispatchInvestigation(ctx, "record_investigation_note", { investigationId, campaignId, kind: "OBSERVATION", note: "Draft saved; delivery evidence still needed" }))
    await pool.query("UPDATE marketing_campaign_runs SET snapshot='{}'::jsonb WHERE id=$1", [runId])
    const unreadable = await runtime.runPromise(readObjectiveInvestigations(f.accountId, f.businessId))
    expect(unreadable.data.goal).toMatchObject({ id: f.goalId })
    expect(unreadable.data.investigations[0]).toMatchObject({ id: investigationId, campaign: { campaignId, latestRun: { status: "UNAVAILABLE" } } })
    expect(await runtime.runPromise(loadResumeContext(f.accountId, f.businessId))).toContain(investigationId)
    await pool.query("UPDATE marketing_campaigns SET revision=revision+1 WHERE id=$1", [campaignId])
    await pool.query(`INSERT INTO marketing_campaign_runs(business_id,campaign_id,campaign_revision,created_by_user_id,snapshot)
      SELECT business_id,id,revision,$2,brief FROM marketing_campaigns WHERE id=$1`, [campaignId, f.userId])
    const recovered = await runtime.runPromise(readObjectiveInvestigations(f.accountId, f.businessId))
    expect(recovered.data.investigations[0]?.campaign).toMatchObject({ currentRevision: 2, latestRun: { campaignRevision: 2, status: "BLOCKED" } })
  })

  it("fences progress links against intervening campaign edits and distinguishes new work from retries", async () => {
    const f = await fixture()
    const ctx = { accountId: f.accountId, userId: f.userId, businessId: f.businessId }
    const investigationId = await openInvestigation(ctx, f.goalId, "Carry forward the exact saved draft")
    const campaignId = await campaign(f.businessId, f.userId)
    const input = { investigationId, campaignId, expectedCampaignRevision: 1, kind: "OBSERVATION", note: "Saved the offer draft" }
    const write = (raw: unknown) => runtime.runPromise(dispatchInvestigation(ctx, "record_investigation_note", raw))
    const first = await write(input)
    expect(first.data).toMatchObject({ reused: false, campaign: { notedRevision: 1 } })
    await pool.query("UPDATE marketing_campaigns SET revision=revision+1 WHERE id=$1", [campaignId])
    expect((await write(input)).data).toMatchObject({ reused: true, noteId: first.data.noteId, campaign: { notedRevision: 1 } })
    await expect(write({ ...input, note: "Another revision-one change" })).rejects.toThrow()
    const next = await write({ ...input, expectedCampaignRevision: 2 })
    expect(next.data).toMatchObject({ reused: false, campaign: { notedRevision: 2 } })
    expect(next.data.noteId).not.toBe(first.data.noteId)
    const racing = await Promise.allSettled([
      write({ ...input, expectedCampaignRevision: 2, note: "Prepared the final handoff" }),
      pool.query("UPDATE marketing_campaigns SET revision=revision+1 WHERE id=$1", [campaignId]),
    ])
    expect(racing[1]?.status).toBe("fulfilled")
    const notes = (await pool.query("SELECT campaign_revision FROM growth_investigation_notes WHERE investigation_id=$1 AND note='Prepared the final handoff'", [investigationId])).rows
    if (racing[0]?.status === "fulfilled") expect(notes).toEqual([{ campaign_revision: 2 }])
    else expect(notes).toEqual([])
    expect((await runtime.runPromise(readObjectiveInvestigations(f.accountId, f.businessId))).data.investigations[0]?.campaign)
      .toMatchObject({ currentRevision: 3, revisionChanged: true })
  })

  it("does not duplicate a saved campaign or its note when a lost reply is retried", async () => {
    const f = await fixture()
    const ctx = { accountId: f.accountId, userId: f.userId, businessId: f.businessId }
    const investigationId = await openInvestigation(ctx, f.goalId, "Can a guided onboarding offer raise qualified leads?")
    const draft = { title: "TEST Retry campaign", goal: "More qualified leads", deliverables: [{ title: "Welcome email", channel: "EMAIL", content: "Subject: Book your guided onboarding." }] }
    const noteIds: unknown[] = []
    const turn = (replyLost: boolean) => {
      let step = 0, campaignId = ""
      const call = (name: string, args: Record<string, unknown>): ReturnType<AgentModel> => Effect.succeed({ candidates: [{ content: { role: "model", parts: [{ functionCall: { name, args } }] }, finishReason: "STOP" }] })
      const model: AgentModel = () => {
        step++
        if (step === 1) return call("record_campaign_draft", draft)
        if (step === 2) return call("record_investigation_note", { investigationId, kind: "OBSERVATION", note: "Saved the retry campaign draft; next, plan distribution.", campaignId })
        return replyLost ? Effect.fail(new AgentModelError({ reason: "CANCELLED" }))
          : Effect.succeed({ candidates: [{ content: { role: "model", parts: [{ text: "Saved the campaign draft and linked it to the investigation." }] }, finishReason: "STOP" }] })
      }
      return Effect.runPromise(Effect.either(runConversation({ message: "/marketing Prepare a guided onboarding campaign", history: [], model,
        tools: agentDeclarations.filter(t => ["record_campaign_draft", "record_investigation_note"].includes(t.name)),
        dispatch: (name, args) => name === "record_campaign_draft"
          ? draftMarketingCampaign(ctx, args).pipe(Effect.tap(r => Effect.sync(() => { campaignId = String(r.data.campaignId) })), Effect.provide(repos))
          : dispatchInvestigation(ctx, name, args).pipe(Effect.tap(r => Effect.sync(() => { noteIds.push(r.data.investigationId === investigationId && "noteId" in r.data ? r.data.noteId : null) })), Effect.provide(repos)),
      })))
    }
    expect(await turn(true)).toMatchObject({ _tag: "Left", left: { reason: "CANCELLED" } })
    expect((await turn(false))._tag).toBe("Right")
    expect(noteIds).toHaveLength(2)
    expect(noteIds[1]).toBe(noteIds[0])
    const campaigns = (await pool.query("SELECT id FROM marketing_campaigns WHERE business_id=$1 AND brief->>'title'=$2", [f.businessId, draft.title])).rows
    expect(campaigns).toHaveLength(1)
    expect((await pool.query("SELECT id,campaign_id,campaign_revision FROM growth_investigation_notes WHERE investigation_id=$1", [investigationId])).rows)
      .toEqual([{ id: noteIds[0], campaign_id: campaigns[0].id, campaign_revision: 1 }])
  })
})
