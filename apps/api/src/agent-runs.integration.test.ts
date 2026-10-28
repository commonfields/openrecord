import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { HttpApp } from "@effect/platform"
import { Effect, Layer, Redacted } from "effect"
import { PgClient } from "@effect/sql-pg"
import { AuthRepositoryLive, AcquisitionRepositoryLive, GrowthRepositoriesLive, AgentProposalRepositoryLive, BusinessRepositoryLive, DiscoveryScopeRepositoryLive, FactRepositoryLive, ProductReadRepositoryLive, QuestionRepositoryLive, RecordRepositoryLive, SetupRepositoryLive } from "@openrecord/db"
import pg from "pg"
import { createConversation, loadConversation, sendConversation, type ConversationScope } from "./agent-conversations.js"
import { dispatchAgentTool, runConversation, type AgentHistory } from "./agent.js"
import { AgentModelError, type AgentModel, type ModelResponse } from "./agent-model.js"
import { readRunProgress, type RunJournal } from "./agent-run.js"
import { cancelHarnessConversation } from "./harness-store.js"
import type { AgentToolDeps } from "./agent-tools.js"
import { harnessApi } from "./harness-routes.js"
import { decisionApi } from "./decision-routes.js"
import { requireSession } from "./router.js"

const url = process.env["TEST_DATABASE_URL"] ?? ""
const suite = url ? describe : describe.skip
const text = (value: string): ModelResponse => ({ candidates: [{ content: { role: "model", parts: [{ text: value }] }, finishReason: "STOP" }] })
const call = (name: string, args: Record<string, unknown>): ModelResponse => ({ candidates: [{ content: { role: "model", parts: [{ functionCall: { name, args } }] }, finishReason: "STOP" }] })

suite("durable agent runs (disposable PostgreSQL, fixture models, no live provider)", () => {
  let pool: pg.Pool
  const repos = Layer.mergeAll(AcquisitionRepositoryLive, GrowthRepositoriesLive, AgentProposalRepositoryLive, BusinessRepositoryLive, DiscoveryScopeRepositoryLive, FactRepositoryLive, ProductReadRepositoryLive, QuestionRepositoryLive, RecordRepositoryLive, SetupRepositoryLive)
    .pipe(Layer.provideMerge(PgClient.layer({ url: Redacted.make(url) })))
  const run = <A, E>(effect: Effect.Effect<A, E, AgentToolDeps>) => Effect.runPromise(Effect.either(effect.pipe(Effect.provide(repos))))
  // The production responder minus provider configuration: the real loop,
  // real tools and the conversation's lease guard, driven by a fixture model.
  const responder = (model: AgentModel) => (accountId: string, userId: string, businessId: string | null, message: string, history: AgentHistory = [],
    _selection: unknown, assertActive: Effect.Effect<void, AgentModelError, import("@effect/sql").SqlClient.SqlClient>, journal: RunJournal) =>
    Effect.gen(function*() {
      const context = yield* Effect.context<AgentToolDeps>()
      const answer = yield* runConversation({ message, history, model, journal,
        dispatch: (name, args) => assertActive.pipe(Effect.andThen(dispatchAgentTool(accountId, userId, businessId!, name, args)), Effect.provide(context)) })
      return { ...answer, provider: "gemini", requestedModel: "fixture" }
    })
  const web = HttpApp.toWebHandlerLayer(harnessApi(act => Effect.flatMap(requireSession, ({ session }) => act(session))),
    Layer.mergeAll(AuthRepositoryLive, AcquisitionRepositoryLive, GrowthRepositoriesLive, AgentProposalRepositoryLive, BusinessRepositoryLive, DiscoveryScopeRepositoryLive, FactRepositoryLive, ProductReadRepositoryLive, QuestionRepositoryLive, RecordRepositoryLive, SetupRepositoryLive)
      .pipe(Layer.provideMerge(PgClient.layer({ url: Redacted.make(url) }))))
  const decisionsWeb = HttpApp.toWebHandlerLayer(decisionApi(act => Effect.flatMap(requireSession, ({ session }) => act(session))),
    Layer.mergeAll(AuthRepositoryLive, GrowthRepositoriesLive, AgentProposalRepositoryLive, BusinessRepositoryLive).pipe(Layer.provideMerge(PgClient.layer({ url: Redacted.make(url) }))))
  const get = (path: string, cookie?: string) => web.handler(new Request(`http://localhost${path}`, { headers: cookie ? { cookie: `or_session=${cookie}` } : {} }))
  const session = async (accountId: string, userId: string) =>
    String((await pool.query("INSERT INTO sessions(account_id,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour') RETURNING id", [accountId, userId])).rows[0].id)
  beforeAll(() => { pool = new pg.Pool({ connectionString: url }) })
  afterAll(async () => { await web.dispose(); await decisionsWeb.dispose(); await pool.end() })
  const fixture = async () => {
    const accountId = (await pool.query("INSERT INTO accounts(name) VALUES ('TEST runs') RETURNING id")).rows[0].id as string
    const userId = (await pool.query("INSERT INTO users(email,password_hash) VALUES ($1,'TEST-only') RETURNING id", [`runs-${randomUUID()}@example.test`])).rows[0].id as string
    await pool.query("INSERT INTO account_users(account_id,user_id) VALUES ($1,$2)", [accountId, userId])
    const businessId = (await pool.query("INSERT INTO businesses(account_id,name) VALUES ($1,'TEST Client') RETURNING id", [accountId])).rows[0].id as string
    const questionId = (await pool.query("INSERT INTO buyer_questions(business_id,prompt) VALUES ($1,'TEST opening hours?') RETURNING id", [businessId])).rows[0].id as string
    return { scope: { accountId, userId, businessId } satisfies ConversationScope, questionId }
  }
  const runs = async (businessId: string) => (await pool.query("SELECT id, status, outcome, failure_reason, settled_at, model_steps, tool_calls FROM agent_runs WHERE business_id=$1 ORDER BY started_at", [businessId])).rows
  const events = async (runId: string) => (await pool.query("SELECT type, payload FROM agent_run_events WHERE run_id=$1 ORDER BY seq", [runId])).rows as Array<{ type: string; payload: Record<string, unknown> }>
  const proposals = async (businessId: string) => (await pool.query("SELECT id FROM agent_proposals WHERE business_id=$1", [businessId])).rows.map(r => String(r.id))

  it("keeps a saved proposal explained when the provider fails before the reply, and a retry reuses it", async () => {
    const { scope, questionId } = await fixture()
    const failing: ModelResponse[] = [call("propose_check_run", { questionId })]
    const first = await run(sendConversation(scope, { message: "Re-check the opening hours", requestId: randomUUID(), revision: 0 },
      responder(() => failing.length ? Effect.succeed(failing.shift()!) : Effect.fail(new AgentModelError({ reason: "TIMEOUT" })))))
    expect(first).toMatchObject({ _tag: "Left", left: { reason: "TIMEOUT" } })
    const saved = await proposals(scope.businessId)
    expect(saved).toHaveLength(1)
    // The conversation states what happened instead of silently losing the turn.
    const after = await run(loadConversation(scope))
    expect(after._tag === "Right" && after.right).toMatchObject({ revision: 1, messages: [
      { role: "user", text: "Re-check the opening hours" },
      { role: "agent", run: { status: "FAILED" }, citations: [{ kind: "question", id: questionId }],
        toolCalls: [{ tool: "propose_check_run", summary: "Re-check proposed; approval required" }],
        // The saved proposal stays decidable from the note itself.
        decisions: [{ type: "AGENT_PROPOSAL", id: saved[0] }] },
    ] })
    const note = after._tag === "Right" ? after.right!.messages[1]!.text : ""
    expect(note).toContain("This request timed out before it finished.")
    expect(note).toContain("Saved for your review before stopping: Re-check proposed; approval required.")
    const [failed] = await runs(scope.businessId)
    expect(failed).toMatchObject({ status: "FAILED", failure_reason: "TIMEOUT", model_steps: 1, tool_calls: 1 })
    expect(failed.settled_at).not.toBeNull()
    const journal = await events(failed.id)
    expect(journal.map(e => e.type)).toEqual(["RUN_STARTED", "CONTEXT_BUILT", "MODEL_STEP", "TOOL_STARTED", "TOOL_COMPLETED", "RUN_FINISHED"])
    expect(journal[4]!.payload).toMatchObject({ effect: "propose", receipt: { proposalId: saved[0], status: "PROPOSED", executed: false } })
    // Retrying continues from the note and returns the same pending proposal.
    let context = ""
    const retry: ModelResponse[] = [call("propose_check_run", { questionId }), text("The re-check awaits your approval.")]
    const second = await run(sendConversation(scope, { message: "Please continue", requestId: randomUUID(), revision: 1 },
      responder(input => { context ||= JSON.stringify(input.contents); return Effect.succeed(retry.shift()!) })))
    expect(second._tag).toBe("Right")
    expect(context).toContain("Saved for your review before stopping")
    expect(await proposals(scope.businessId)).toEqual(saved)
    const done = (await runs(scope.businessId))[1]
    expect(done).toMatchObject({ status: "COMPLETED", outcome: "ANSWERED" })
    expect((await events(done.id)).find(e => e.type === "TOOL_COMPLETED")!.payload).toMatchObject({ receipt: { proposalId: saved[0] } })
    const reloaded = await run(loadConversation(scope))
    expect(reloaded._tag === "Right" && reloaded.right!.messages[3]).toMatchObject({ role: "agent", decisions: [{ type: "AGENT_PROPOSAL", id: saved[0] }] })
  })

  it("lists what waits on the signed-in account, across its businesses, until it is decided", async () => {
    const { scope, questionId } = await fixture(), other = await fixture()
    const steps: ModelResponse[] = [call("propose_check_run", { questionId }), text("A re-check is waiting for your approval.")]
    const sent = await run(sendConversation(scope, { message: "Re-check the hours", requestId: randomUUID(), revision: 0 }, responder(() => Effect.succeed(steps.shift()!))))
    expect(sent._tag === "Right" && sent.right).toMatchObject({ decisions: [{ type: "AGENT_PROPOSAL" }] })
    const [proposalId] = await proposals(scope.businessId)
    const list = (cookie?: string) => decisionsWeb.handler(new Request("http://localhost/api/decisions", { headers: cookie ? { cookie: `or_session=${cookie}` } : {} }))
    expect((await list()).status).toBe(401)
    const owner = await session(scope.accountId, scope.userId)
    const response = await list(owner)
    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(await response.json()).toMatchObject({ count: 1, items: [{ type: "AGENT_PROPOSAL", business: { id: scope.businessId, name: "TEST Client" }, proposal: { id: proposalId, status: "PROPOSED" } }] })
    expect(await (await list(await session(other.scope.accountId, other.scope.userId))).json()).toEqual({ items: [], count: 0 })
    await pool.query("UPDATE agent_proposals SET status='REJECTED', decided_by_user_id=$2, decided_at=now() WHERE id=$1", [proposalId, scope.userId])
    expect(await (await list(owner)).json()).toEqual({ items: [], count: 0 })
  })

  it("leaves the conversation untouched and sendable when a run fails before any tool work", async () => {
    const { scope } = await fixture()
    const out = await run(sendConversation(scope, { message: "Hello", requestId: randomUUID(), revision: 0 },
      responder(() => Effect.fail(new AgentModelError({ reason: "UNAVAILABLE" })))))
    expect(out._tag).toBe("Left")
    expect(await run(loadConversation(scope))).toMatchObject({ _tag: "Right", right: { revision: 0, messages: [] } })
    expect(await runs(scope.businessId)).toMatchObject([{ status: "FAILED", failure_reason: "UNAVAILABLE" }])
    expect((await run(sendConversation(scope, { message: "Hello", requestId: randomUUID(), revision: 0 }, responder(() => Effect.succeed(text("Hi"))))))._tag).toBe("Right")
  })

  it("settles a crashed run on the next read with what its journal recorded", async () => {
    const { scope, questionId } = await fixture()
    const id = randomUUID()
    expect((await run(createConversation(scope, id)))._tag).toBe("Right")
    // A process that died mid-run leaves a RUNNING row under a lease that no longer exists.
    const runId = (await pool.query(`INSERT INTO agent_runs(conversation_id,account_id,business_id,user_id,request_id,lease_id,objective)
      VALUES ($1,$2,$3,$4,$5,$6,'Draft the report') RETURNING id`, [id, scope.accountId, scope.businessId, scope.userId, randomUUID(), randomUUID()])).rows[0].id as string
    const record = (seq: number, type: string, payload: unknown) => pool.query("INSERT INTO agent_run_events(run_id,seq,type,payload) VALUES ($1,$2,$3,$4)", [runId, seq, type, JSON.stringify(payload)])
    await record(0, "TOOL_STARTED", { invocationId: "i1", tool: "propose_check_run", effect: "propose" })
    await record(1, "TOOL_COMPLETED", { invocationId: "i1", tool: "propose_check_run", effect: "propose", summary: "Re-check proposed; approval required", citations: [{ kind: "question", id: questionId, text: "Opening hours" }] })
    await record(2, "TOOL_STARTED", { invocationId: "i2", tool: "prepare_client_report", effect: "propose" })
    const loaded = await run(loadConversation(scope))
    const messages = loaded._tag === "Right" ? loaded.right!.messages : []
    expect(messages.map(m => m.role)).toEqual(["user", "agent"])
    expect(messages[1]).toMatchObject({ run: { id: runId, status: "INTERRUPTED" }, citations: [{ kind: "question", id: questionId }] })
    expect(messages[1]!.text).toContain("This request was interrupted before it finished.")
    expect(messages[1]!.text).toContain("A save was in progress (preparing client report) and may not have completed.")
    expect(await runs(scope.businessId)).toMatchObject([{ status: "INTERRUPTED" }])
    // Settlement happens once.
    expect(await run(loadConversation(scope))).toMatchObject({ _tag: "Right", right: { revision: 1 } })
    // The journal is append-only and a finished run is final.
    await expect(pool.query("UPDATE agent_run_events SET payload='{}' WHERE run_id=$1", [runId])).rejects.toThrow(/append-only/)
    await expect(pool.query("UPDATE agent_runs SET status='COMPLETED', outcome='ANSWERED' WHERE id=$1", [runId])).rejects.toThrow(/final/)
  })

  it("ends a stopped run as cancelled and records what it had saved", async () => {
    const { scope, questionId } = await fixture()
    let step = 0
    const out = await run(sendConversation(scope, { message: "Re-check, then read everything", requestId: randomUUID(), revision: 0 }, responder(() => {
      if (step++ === 0) return Effect.succeed(call("propose_check_run", { questionId }))
      // The operator presses stop while the model is choosing its next tool.
      return cancelHarnessConversation({ ...scope, expiresAt: new Date() } as unknown as Parameters<typeof cancelHarnessConversation>[0]).pipe(
        Effect.as(call("read_open_issues", {})), Effect.provide(repos), Effect.orDie)
    })))
    expect(out).toMatchObject({ _tag: "Left", left: { reason: "CANCELLED" } })
    expect(await runs(scope.businessId)).toMatchObject([{ status: "CANCELLED" }])
    const loaded = await run(loadConversation(scope))
    expect(loaded._tag === "Right" && loaded.right!.messages[1]!.text).toContain("Stopped before finishing.\nSaved for your review before stopping")
  })

  it("commits a completed run with its reply and exposes scoped, resumable progress while it runs", async () => {
    const { scope } = await fixture(), other = await fixture()
    const requestId = randomUUID()
    let release: () => void = () => {}, reached: () => void = () => {}
    const gate = new Promise<void>(r => { release = r }), waiting = new Promise<void>(r => { reached = r })
    let step = 0
    const sending = run(sendConversation(scope, { message: "What is open?", requestId, revision: 0 }, responder(() => {
      if (step++ === 0) return Effect.succeed(call("read_open_issues", {}))
      return Effect.promise(async () => { reached(); await gate; return text("Nothing is open.") })
    })))
    await waiting
    const live = await run(readRunProgress(scope, requestId, -1))
    expect(live._tag === "Right" && live.right.run).toMatchObject({ status: "RUNNING", toolCalls: 1 })
    const seen = live._tag === "Right" ? live.right.events : []
    expect(seen.map(e => e.type)).toEqual(["RUN_STARTED", "CONTEXT_BUILT", "MODEL_STEP", "TOOL_STARTED", "TOOL_COMPLETED", "MODEL_STEP"].slice(0, seen.length))
    expect(seen.find(e => e.type === "TOOL_STARTED")!.payload).toMatchObject({ tool: "read_open_issues", label: "Reading open issues" })
    expect(await run(readRunProgress(other.scope, requestId, -1))).toMatchObject({ _tag: "Right", right: { run: null, events: [] } })
    release()
    const reply = await sending
    expect(reply._tag === "Right" && reply.right).toMatchObject({ outcome: "ANSWERED", gaps: [] })
    const lastSeen = seen.at(-1)!.seq
    const rest = await run(readRunProgress(scope, requestId, lastSeen))
    expect(rest._tag === "Right" && rest.right.run).toMatchObject({ status: "COMPLETED", outcome: "ANSWERED" })
    expect(rest._tag === "Right" && rest.right.events.every(e => e.seq > lastSeen)).toBe(true)
    expect(rest._tag === "Right" && rest.right.events.at(-1)!.type).toBe("RUN_FINISHED")
    const loaded = await run(loadConversation(scope))
    expect(loaded._tag === "Right" && loaded.right!.messages[1]).toMatchObject({ run: { status: "COMPLETED", outcome: "ANSWERED", gaps: [] } })
  })

  it("serves run progress over HTTP only to the signed-in owner, resuming after a sequence", async () => {
    const { scope } = await fixture(), other = await fixture()
    const requestId = randomUUID()
    expect((await run(sendConversation(scope, { message: "Anything open?", requestId, revision: 0 },
      responder(input => Effect.succeed(JSON.stringify(input.contents).includes("functionResponse") ? text("Nothing is open.") : call("read_open_issues", {}))))))._tag).toBe("Right")
    const path = `/api/agent/runs/progress?requestId=${requestId}&after=-1`
    expect((await get(path)).status).toBe(401)
    const owner = await session(scope.accountId, scope.userId)
    expect((await get("/api/agent/runs/progress?requestId=not-a-uuid&after=-1", owner)).status).toBe(422)
    expect((await get(`/api/agent/runs/progress?requestId=${requestId}&after=-2`, owner)).status).toBe(422)
    const all = await get(path, owner)
    expect(all.status).toBe(200)
    expect(all.headers.get("cache-control")).toBe("no-store")
    const body = await all.json() as { run: { status: string }; events: Array<{ seq: number; type: string }> }
    expect(body.run).toMatchObject({ status: "COMPLETED", outcome: "ANSWERED", modelSteps: 2, toolCalls: 1 })
    expect(body.events.map(e => e.type)).toEqual(["RUN_STARTED", "CONTEXT_BUILT", "MODEL_STEP", "TOOL_STARTED", "TOOL_COMPLETED", "MODEL_STEP", "VERIFICATION", "RUN_FINISHED"])
    const resumed = await (await get(`/api/agent/runs/progress?requestId=${requestId}&after=${body.events[4]!.seq}`, owner)).json() as { events: Array<{ type: string }> }
    expect(resumed.events.map(e => e.type)).toEqual(["MODEL_STEP", "VERIFICATION", "RUN_FINISHED"])
    const foreign = await get(path, await session(other.scope.accountId, other.scope.userId))
    expect(await foreign.json()).toEqual({ run: null, events: [] })
  })
})
