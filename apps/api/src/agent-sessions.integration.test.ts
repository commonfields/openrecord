import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Effect, Layer, ManagedRuntime, Redacted } from "effect"
import { PgClient } from "@effect/sql-pg"
import { AcquisitionRepositoryLive, GrowthRepositoriesLive, AgentProposalRepositoryLive, BusinessRepositoryLive, DiscoveryScopeRepositoryLive, FactRepositoryLive, ProductReadRepositoryLive, QuestionRepositoryLive, RecordRepositoryLive, SetupRepositoryLive } from "@openrecord/db"
import pg from "pg"
import { listConversations, loadConversation, type ConversationScope } from "./agent-conversations.js"
import { agentDeclarations, dispatchAgentTool, runConversation } from "./agent.js"
import { AgentModelError, type AgentModel, type ModelInput, type ModelResponse } from "./agent-model.js"
import { cancelHarnessConversation } from "./harness-store.js"
import type { AgentToolDeps } from "./agent-tools.js"
import { createSessions, type BaseResponder } from "./agent-sessions.js"
import { MAX_SESSION_DEPTH } from "./agent-session-tools.js"

const url = process.env["TEST_DATABASE_URL"] ?? ""
const suite = url ? describe : describe.skip
const text = (value: string): ModelResponse => ({ candidates: [{ content: { role: "model", parts: [{ text: value }] }, finishReason: "STOP" }] })
const calls = (...list: Array<[string, Record<string, unknown>]>): ModelResponse => ({ candidates: [{ content: { role: "model", parts: list.map(([name, args]) => ({ functionCall: { name, args } })) }, finishReason: "STOP" }] })
const answered = (input: ModelInput) => input.contents.some(c => c.parts.some(p => typeof p === "object" && p !== null && "functionResponse" in p))
// The request this turn answers: the latest user content that is not tool results.
const said = (input: ModelInput, marker: string) => JSON.stringify([...input.contents].reverse().find(c => c.role === "user" && !c.parts.some(p => typeof p === "object" && p !== null && "functionResponse" in p)) ?? null).includes(marker)

suite("sessions that work together (disposable PostgreSQL, scripted model, no live provider)", () => {
  let pool: pg.Pool
  const repos = Layer.mergeAll(AcquisitionRepositoryLive, GrowthRepositoriesLive, AgentProposalRepositoryLive, BusinessRepositoryLive, DiscoveryScopeRepositoryLive, FactRepositoryLive, ProductReadRepositoryLive, QuestionRepositoryLive, RecordRepositoryLive, SetupRepositoryLive)
    .pipe(Layer.provideMerge(PgClient.layer({ url: Redacted.make(url) })))
  // One runtime for the whole suite: background helpers outlive the turn that
  // started them, as they do in the server, so the pool must too.
  let runtime: ManagedRuntime.ManagedRuntime<AgentToolDeps, unknown>
  const run = <A, E>(effect: Effect.Effect<A, E, AgentToolDeps>) => runtime.runPromise(Effect.either(effect))
  // The real loop, real business tools and the real session tools, driven by a
  // scripted model that answers by what it is asked. Every step checks the lease.
  const base = (script: (input: ModelInput, tools: ReadonlyArray<string>) => Effect.Effect<ModelResponse, AgentModelError>): BaseResponder =>
    (accountId, userId, businessId, message, history, _selection, assertActive, journal, extension) => Effect.gen(function*() {
      const context = yield* Effect.context<AgentToolDeps>()
      const names = new Set(extension?.tools.map(t => t.name) ?? [])
      const guard = assertActive.pipe(Effect.provide(context))
      const model: AgentModel = input => guard.pipe(Effect.andThen(script(input, [...names])))
      const answer = yield* runConversation({ message, history, model, journal, tools: [...agentDeclarations, ...(extension?.tools ?? [])],
        dispatch: (name, args) => names.has(name) ? guard.pipe(Effect.andThen(extension!.dispatch(name, args)))
          : guard.pipe(Effect.andThen(dispatchAgentTool(accountId, userId, businessId!, name, args)), Effect.provide(context)) })
      return { ...answer, provider: "gemini", requestedModel: "fixture" }
    }) as ReturnType<BaseResponder>
  beforeAll(() => { pool = new pg.Pool({ connectionString: url }); runtime = ManagedRuntime.make(repos) as typeof runtime })
  afterAll(async () => { await runtime.dispose(); await pool.end() })
  const fixture = async () => {
    const accountId = (await pool.query("INSERT INTO accounts(name) VALUES ('TEST sessions') RETURNING id")).rows[0].id as string
    const userId = (await pool.query("INSERT INTO users(email,password_hash) VALUES ($1,'TEST-only') RETURNING id", [`sessions-${randomUUID()}@example.test`])).rows[0].id as string
    await pool.query("INSERT INTO account_users(account_id,user_id) VALUES ($1,$2)", [accountId, userId])
    const businessId = (await pool.query("INSERT INTO businesses(account_id,name) VALUES ($1,'TEST Client') RETURNING id", [accountId])).rows[0].id as string
    const questionId = (await pool.query("INSERT INTO buyer_questions(business_id,prompt) VALUES ($1,'TEST opening hours?') RETURNING id", [businessId])).rows[0].id as string
    return { scope: { accountId, userId, businessId } satisfies ConversationScope, questionId }
  }
  const tasks = async (businessId: string) => (await pool.query("SELECT * FROM agent_tasks WHERE business_id=$1 ORDER BY created_at", [businessId])).rows
  const until = async <A>(read: () => Promise<A>, ok: (a: A) => boolean, ms = 15000) => {
    const end = Date.now() + ms
    for (;;) { const a = await read(); if (ok(a) || Date.now() > end) return a; await new Promise(r => setTimeout(r, 100)) }
  }

  it("runs two helpers in parallel inside one turn and brings back their results and approvals", async () => {
    const { scope, questionId } = await fixture()
    const sessions = createSessions(base(input => Effect.succeed(
      said(input, "TASK-A") ? (answered(input) ? text("Found A: one re-check proposed.") : calls(["propose_check_run", { questionId }]))
      : said(input, "TASK-B") ? text("Found B: nothing missing.")
      : answered(input) ? text("Combined: A proposed a re-check, B found nothing.")
      : calls(["delegate_task", { title: "Search check", role: "seo", task: "TASK-A check the opening hours question" }],
          ["delegate_task", { title: "AI answers check", role: "aeo", task: "TASK-B check AI answers" }]))))
    const started = Date.now()
    const reply = await run(sessions.sendTurn(scope, { message: "Plan the week", requestId: randomUUID(), revision: 0 }))
    expect(reply._tag).toBe("Right")
    const r = reply._tag === "Right" ? reply.right as unknown as Record<string, unknown> : {}
    expect(r["reply"]).toBe("Combined: A proposed a re-check, B found nothing.")
    const rows = await tasks(scope.businessId)
    expect(rows.map(t => [t.title, t.role, t.status, t.mode, t.delivered_at !== null])).toEqual([
      ["Search check", "seo", "COMPLETED", "wait", true], ["AI answers check", "aeo", "COMPLETED", "wait", true]])
    // Both helpers ran at once, not one after the other (each waits at least 750 ms).
    expect(Date.now() - started).toBeLessThan(6000)
    expect(r["tasks"]).toEqual(rows.map(t => ({ id: t.id, sessionId: t.child_conversation_id, title: t.title, role: t.role, status: "COMPLETED" })))
    const proposal = (await pool.query("SELECT id FROM agent_proposals WHERE business_id=$1", [scope.businessId])).rows[0]
    expect(r["decisions"]).toEqual([{ type: "AGENT_PROPOSAL", id: proposal.id }])
    // A helper is its own archived session, linked to the session that started it.
    const helper = (await pool.query("SELECT * FROM agent_conversations WHERE id=$1", [rows[0].child_conversation_id])).rows[0]
    expect(helper).toMatchObject({ parent_conversation_id: r["conversationId"], depth: 1, task_title: "Search check", task_role: "seo" })
    expect(helper.archived_at).not.toBeNull()
    expect(helper.messages[0]).toMatchObject({ role: "user", origin: { kind: "task", fromSessionId: r["conversationId"], taskId: rows[0].id, title: "Search check" } })
    expect(helper.messages[0].text).toContain("TASK-A check the opening hours question")
    // The operator's chat stays the default one; helpers are listed with their parent.
    const current = await run(loadConversation(scope))
    expect(current._tag === "Right" && current.right?.id).toBe(r["conversationId"])
    const list = await run(listConversations(scope))
    expect(list._tag === "Right" && list.right.filter(c => c.parentSessionId === r["conversationId"]).map(c => c.title).sort()).toEqual(["AI answers check", "Search check"])
  })

  it("posts async results into the session and continues it once every task has finished", async () => {
    const { scope } = await fixture()
    const sessions = createSessions(base(input => Effect.succeed(
      said(input, "TASK-C") ? text("Async result C")
      : said(input, "OpenRecord notice: results from the helper sessions") ? text("Synthesised C")
      : answered(input) ? text("Started a helper.")
      : calls(["delegate_task", { title: "Background check", task: "TASK-C", mode: "async" }]))))
    const first = await run(sessions.sendTurn(scope, { message: "Start async", requestId: randomUUID(), revision: 0 }))
    const r = first._tag === "Right" ? first.right as unknown as Record<string, unknown> : {}
    expect(r["reply"]).toBe("Started a helper.")
    const done = await until(async () => (await pool.query("SELECT messages FROM agent_conversations WHERE id=$1", [r["conversationId"]])).rows[0].messages as Array<Record<string, unknown>>,
      m => m.length >= 5)
    expect(done.map(m => [m["role"], (m["origin"] as { kind?: string } | undefined)?.kind ?? null])).toEqual([
      ["user", null], ["agent", null], ["agent", "result"], ["user", "wake"], ["agent", null]])
    expect(done[2]!["text"]).toBe("Result from “Background check”:\n\nAsync result C")
    expect(done[4]!["text"]).toBe("Synthesised C")
    const [task] = await tasks(scope.businessId)
    expect(task).toMatchObject({ status: "COMPLETED", mode: "async" })
    expect(task.delivered_at).not.toBeNull()
    expect(task.woke_parent_at).not.toBeNull()
    // The operator had not seen those messages; sending on the old revision is still current.
    const next = await run(sessions.sendTurn(scope, { message: "Thanks", requestId: randomUUID(), revision: Number(r["revision"]), conversationId: String(r["conversationId"]) }))
    expect(next._tag).toBe("Right")
  })

  it("stops helpers when their session is stopped", async () => {
    const { scope } = await fixture()
    const sessions = createSessions(base(input =>
      said(input, "TASK-SLOW") ? Effect.sleep("400 millis").pipe(Effect.as(calls(["read_open_issues", {}])))
      : answered(input) ? Effect.succeed(text("never"))
      : Effect.succeed(calls(["delegate_task", { title: "Slow", task: "TASK-SLOW" }]))))
    const pending = run(sessions.sendTurn(scope, { message: "Go slow", requestId: randomUUID(), revision: 0 }))
    const [task] = await until(() => tasks(scope.businessId), t => t.length === 1)
    await until(async () => (await pool.query("SELECT lease_until FROM agent_conversations WHERE id=$1", [task.child_conversation_id])).rows[0].lease_until, v => v !== null)
    await run(cancelHarnessConversation({ ...scope, conversationId: task.parent_conversation_id }))
    expect(await pending).toMatchObject({ _tag: "Left", left: { reason: "CANCELLED" } })
    const [after] = await until(() => tasks(scope.businessId), t => t[0].status !== "RUNNING")
    expect(after).toMatchObject({ status: "CANCELLED", failure_reason: "CANCELLED" })
    const child = await until(async () => (await pool.query("SELECT r.status FROM agent_runs r WHERE r.conversation_id=$1", [task.child_conversation_id])).rows, rs => rs.length > 0 && rs.every(x => x.status !== "RUNNING"))
    expect(child.map(x => x.status)).toEqual(["CANCELLED"])
  })

  it("keeps sessions inside their business, deduplicates retries and bounds depth", async () => {
    const { scope } = await fixture()
    const other = await fixture()
    const elsewhere = (await pool.query("INSERT INTO agent_conversations(account_id,business_id,user_id,messages) VALUES ($1,$2,$3,'[{\"role\":\"user\",\"text\":\"private\"}]') RETURNING id",
      [other.scope.accountId, other.scope.businessId, other.scope.userId])).rows[0].id as string
    const retry = randomUUID()
    const seen: string[][] = []
    const sessions = createSessions(base((input, tools) => {
      seen.push([...tools])
      return Effect.succeed(said(input, "TASK-D") ? text("D done") : answered(input) ? text("Checked.")
        : calls(["delegate_task", { title: "Once", task: "TASK-D", clientRequestId: retry }], ["delegate_task", { title: "Once", task: "TASK-D", clientRequestId: retry }],
            ["message_session", { sessionId: elsewhere, message: "hi" }], ["read_session", { sessionId: elsewhere }]))
    }))
    const reply = await run(sessions.sendTurn(scope, { message: "Scope check", requestId: randomUUID(), revision: 0 }))
    const r = reply._tag === "Right" ? reply.right as unknown as { toolCalls: Array<{ tool: string; summary: string }> } : { toolCalls: [] }
    expect(await tasks(scope.businessId)).toHaveLength(1)
    expect(r.toolCalls.map(c => [c.tool, c.summary])).toEqual([
      ["delegate_task", "Helper “Once” finished"], ["delegate_task", "Helper “Once” finished"],
      ["message_session", "Not sent: session not found"], ["read_session", "Not read: session not found"]])
    expect(await tasks(other.scope.businessId)).toHaveLength(0)
    // The lead may delegate; the helper (depth 1) may too; a helper at the limit only reads.
    expect(seen[0]).toContain("delegate_task")
    const turn = { conversationId: randomUUID(), runId: randomUUID(), origin: undefined, selection: undefined, deadline: Date.now() + 60000 }
    const names = (depth: number, origin?: { kind: "wake" }) => createSessions().sessionExtension(scope, { ...turn, depth, origin }, Effect.void, undefined as never).tools.map(t => t.name)
    expect(names(MAX_SESSION_DEPTH - 1)).toContain("delegate_task")
    expect(names(MAX_SESSION_DEPTH)).toEqual(["read_task", "list_sessions", "read_session", "list_models"])
    expect(names(0, { kind: "wake" })).not.toContain("delegate_task")
  })
})
