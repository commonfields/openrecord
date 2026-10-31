import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { HttpApp } from "@effect/platform"
import { Effect, Layer, Redacted, Schema } from "effect"
import { PgClient } from "@effect/sql-pg"
import pg from "pg"
import { AuthRepositoryLive, BusinessRepositoryLive, AcquisitionRepositoryLive, GrowthRepositoriesLive, AgentProposalRepositoryLive, DiscoveryScopeRepositoryLive, FactRepositoryLive, ProductReadRepositoryLive, QuestionRepositoryLive, RecordRepositoryLive, SetupRepositoryLive } from "@openrecord/db"
import { HarnessCatalog, type HarnessReport } from "@openrecord/contracts"
import { harnessApi } from "./harness-routes.js"
import { requireSession } from "./router.js"
import {
  activateHarness, chooseHarnessModel,
  authenticateBridge,
  cancelHarnessConversation,
  completeHarnessJob,
  createPair,
  harnessCatalog,
  invokeHarness,
  longPollHarnessJobs,
  pollHarnessJobs,
  recordHarnessProgress,
  registerBridge,
  requestHarnessRefresh,
  resolveHarness,
  revokeBridge
} from "./harness-store.js"

const url = process.env["TEST_DATABASE_URL"] ?? ""
const suite = url ? describe : describe.skip
suite("user-owned harness bridges (disposable PostgreSQL, no provider calls)", () => {
  const repos = Layer.mergeAll(AuthRepositoryLive, BusinessRepositoryLive, AcquisitionRepositoryLive, GrowthRepositoriesLive, AgentProposalRepositoryLive, DiscoveryScopeRepositoryLive, FactRepositoryLive, ProductReadRepositoryLive, QuestionRepositoryLive, RecordRepositoryLive, SetupRepositoryLive).pipe(
    Layer.provideMerge(PgClient.layer({ url: Redacted.make(url) }))
  )
  const run = async <A, E>(
    fx: Effect.Effect<
      A,
      E,
      | import("@effect/sql").SqlClient.SqlClient
      | import("@openrecord/db").AuthRepository
      | import("@openrecord/db").BusinessRepository
    >
  ) => {
    const result = await Effect.runPromise(fx.pipe(Effect.provide(repos), Effect.either))
    if (result._tag === "Left") throw result.left
    return result.right
  }
  const router = harnessApi((act) => Effect.flatMap(requireSession, ({ session }) => act(session)))
  const web = HttpApp.toWebHandlerLayer(router, repos)
  let pool: pg.Pool
  beforeAll(() => {
    pool = new pg.Pool({ connectionString: url })
  })
  afterAll(async () => {
    await web.dispose()
    await pool.end()
  })
  const fixture = async (sameAccount?: string) => {
    const accountId =
      sameAccount ??
      String((await pool.query("INSERT INTO accounts(name) VALUES('TEST harness') RETURNING id")).rows[0].id)
    const userId = String(
      (
        await pool.query("INSERT INTO users(email,password_hash) VALUES($1,'TEST') RETURNING id", [
          `harness-${randomUUID()}@example.test`
        ])
      ).rows[0].id
    )
    await pool.query("INSERT INTO account_users(account_id,user_id) VALUES($1,$2)", [accountId, userId])
    const cookie = String(
      (
        await pool.query(
          "INSERT INTO sessions(account_id,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour') RETURNING id",
          [accountId, userId]
        )
      ).rows[0].id
    )
    const businessId = String(
      (
        await pool.query("INSERT INTO businesses(account_id,name) VALUES($1,'TEST harness client') RETURNING id", [
          accountId
        ])
      ).rows[0].id
    )
    return { accountId, userId, businessId, cookie }
  }
  const report = (): HarnessReport => ({
    localId: randomUUID(),
    driver: "codex",
    name: "Personal Codex",
    installed: true,
    version: "TEST",
    auth: "authenticated",
    state: "ready",
    models: [{ id: "fixture-model", name: "TEST model", reasoningEfforts: ["low", "high"] }]
  })
  const connect = async (scope: Awaited<ReturnType<typeof fixture>>, status = report()) => {
    const pair = await run(createPair(scope, "TEST laptop"))
    const registered = await run(registerBridge(pair.code))
    const bridge = await run(authenticateBridge(registered.token))
    await run(pollHarnessJobs(bridge, [status]))
    const instance = (await run(harnessCatalog(scope))).instances[0]!
    return { pair, registered, bridge, status, instance }
  }
  const call = (method: string, path: string, cookie?: string, body?: unknown, headers: Record<string, string> = {}) =>
    web.handler(
      new Request(`http://localhost${path}`, {
        method,
        headers: {
          "content-type": "application/json",
          ...(cookie ? { cookie: `or_session=${cookie}` } : {}),
          ...headers
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      })
    )
  it("protects non-destructive new-chat creation with sessions, origin checks, ownership and retry identity", async () => {
    const a = await fixture(), foreign = await fixture()
    const path = `/api/businesses/${a.businessId}/agent/conversation`
    const body = { conversationId: randomUUID() }
    expect((await call("POST", path, undefined, body)).status).toBe(401)
    expect((await call("POST", path, foreign.cookie, body)).status).toBe(404)
    expect((await call("POST", path, a.cookie, body, { origin: "https://evil.test" })).status).toBe(403)
    const headers = { origin: "http://localhost:3000" }
    expect((await call("POST", path, a.cookie, { conversationId: "invalid" }, headers)).status).toBe(422)
    const first = await call("POST", path, a.cookie, body, headers)
    expect(first.status).toBe(200)
    expect(await first.json()).toMatchObject({ conversation: { id: body.conversationId, messages: [], revision: 0 } })
    expect((await call("POST", path, a.cookie, body, headers)).status).toBe(200)
  })
  it("creates genuinely unscoped general chats and protects their read and cancel routes", async () => {
    const a = await fixture(), other = await fixture(), conversationId = randomUUID()
    const headers = { origin: "http://localhost:3000" }
    expect((await call("POST", "/api/agent/conversation", undefined, { conversationId }, headers)).status).toBe(401)
    expect((await call("POST", "/api/agent/conversation", a.cookie, { conversationId }, { origin: "https://evil.test" })).status).toBe(403)
    expect((await call("POST", "/api/agent/conversation", a.cookie, { conversationId, businessId: a.businessId }, headers)).status).toBe(422)
    expect((await call("POST", "/api/agent/conversation", a.cookie, { conversationId }, headers)).status).toBe(200)
    const rows = await pool.query("SELECT business_id FROM agent_conversations WHERE id=$1", [conversationId])
    expect(rows.rows).toEqual([{ business_id: null }])
    const foreign = await call("GET", `/api/agent/conversation?conversationId=${conversationId}`, other.cookie)
    expect(await foreign.json()).toEqual({ conversation: null })
    const own = await call("GET", `/api/agent/conversation?conversationId=${conversationId}`, a.cookie)
    expect(await own.json()).toMatchObject({ conversation: { id: conversationId } })
    expect((await call("POST", "/api/agent/cancel", a.cookie, {}, headers)).status).toBe(422)
    expect((await call("POST", "/api/agent/cancel", a.cookie, { conversationId }, headers)).status).toBe(200)
  })
  it("pairs once, stores only capability hashes, and refuses expired or revoked credentials", async () => {
    const scope = await fixture(),
      c = await connect(scope)
    await expect(run(registerBridge(c.pair.code))).rejects.toMatchObject({ reason: "PAIR_EXPIRED" })
    const stored = (await pool.query("SELECT token_hash,pair_hash FROM agent_bridges WHERE id=$1", [c.bridge.id]))
      .rows[0]
    expect(stored.pair_hash).toBeNull()
    expect(stored.token_hash).not.toBe(c.registered.token)
    expect(stored.token_hash).toMatch(/^[a-f0-9]{64}$/)
    const expired = await run(createPair(scope, "expired"))
    await pool.query(
      "UPDATE agent_bridges SET pair_expires_at=now()-interval '1 second' WHERE pair_hash IS NOT NULL AND user_id=$1",
      [scope.userId]
    )
    await expect(run(registerBridge(expired.code))).rejects.toMatchObject({ reason: "PAIR_EXPIRED" })
    await run(revokeBridge(scope, c.bridge.id))
    await expect(run(authenticateBridge(c.registered.token))).rejects.toMatchObject({ reason: "UNAUTHENTICATED" })
  })
  it("isolates providers between accounts and between users in the same account", async () => {
    const a = await fixture(),
      b = await fixture(),
      sibling = await fixture(a.accountId),
      c = await connect(a)
    for (const foreign of [b, sibling]) {
      expect((await run(harnessCatalog(foreign))).instances).toHaveLength(0)
      await expect(run(activateHarness(foreign, c.instance.id, true))).rejects.toMatchObject({ reason: "NOT_FOUND" })
      await expect(run(revokeBridge(foreign, c.bridge.id))).rejects.toMatchObject({ reason: "NOT_FOUND" })
      await expect(run(requestHarnessRefresh(foreign, c.instance.id))).rejects.toMatchObject({ reason: "NOT_FOUND" })
    }
    await run(requestHarnessRefresh(a, c.instance.id))
    expect((await run(pollHarnessJobs(c.bridge, [c.status], false))).refresh).toBe(true)
    expect((await run(pollHarnessJobs(c.bridge, [c.status], false))).refresh).toBe(false)
    await expect(run(resolveHarness(a, { instanceId: c.instance.id, model: "fixture-model" }))).rejects.toMatchObject({
      reason: "UNAVAILABLE"
    })
    await run(activateHarness(a, c.instance.id, true))
    expect((await run(pollHarnessJobs(c.bridge, [c.status], false))).refresh).toBe(true)
    expect((await run(pollHarnessJobs(c.bridge, [c.status], false))).refresh).toBe(false)
    await expect(
      run(
        invokeHarness(
          a,
          { instanceId: c.instance.id, model: "fixture-model" },
          {
            system: "TEST",
            contents: [{ role: "user", parts: [{ text: "界".repeat(120000) }] }],
            tools: []
          }
        )
      )
    ).rejects.toMatchObject({ reason: "CONTEXT_LIMIT" })
    await expect(run(resolveHarness(a, { instanceId: c.instance.id, model: "not-advertised" }))).rejects.toMatchObject({
      reason: "MODEL_UNAVAILABLE"
    })
    await expect(run(resolveHarness(a, { instanceId: c.instance.id, model: "fixture-model", reasoningEffort: "medium" }))).rejects.toMatchObject({ reason: "MODEL_UNAVAILABLE" })
  })
  it("offers only the models the person left on, and only the owner can turn them off", async () => {
    const a = await fixture(), other = await fixture()
    const c = await connect(a, { ...report(), models: [{ id: "fixture-model", name: "TEST model" }, { id: "fixture-fast", name: "TEST fast" }] })
    await run(activateHarness(a, c.instance.id, true))
    await run(chooseHarnessModel(a, c.instance.id, "fixture-fast", false))
    await run(chooseHarnessModel(a, c.instance.id, "fixture-fast", false))
    expect((await run(harnessCatalog(a))).instances[0]).toMatchObject({ disabledModels: ["fixture-fast"], models: [{ id: "fixture-model" }, { id: "fixture-fast" }] })
    await expect(run(resolveHarness(a, { instanceId: c.instance.id, model: "fixture-fast" }))).rejects.toMatchObject({ reason: "MODEL_UNAVAILABLE" })
    await expect(run(resolveHarness(a, { instanceId: c.instance.id, model: "fixture-model" }))).resolves.toMatchObject({ id: c.instance.id })
    await expect(run(chooseHarnessModel(other, c.instance.id, "fixture-model", false))).rejects.toMatchObject({ reason: "NOT_FOUND" })
    await run(chooseHarnessModel(a, c.instance.id, "fixture-fast", true))
    expect((await run(harnessCatalog(a))).instances[0]?.disabledModels).toEqual([])
    await expect(run(resolveHarness(a, { instanceId: c.instance.id, model: "fixture-fast" }))).resolves.toMatchObject({ id: c.instance.id })
  })
  it("allows only the native reasoning levels advertised by an enabled OpenCode model", async () => {
    const a = await fixture()
    const c = await connect(a, { ...report(), driver: "opencode", models: [{ id: "fixture-model", name: "TEST model", reasoningEfforts: ["none", "thinking"] }] })
    await run(activateHarness(a, c.instance.id, true))
    await expect(run(resolveHarness(a, { instanceId: c.instance.id, model: "fixture-model", reasoningEffort: "thinking" }))).resolves.toMatchObject({ driver: "opencode" })
    await expect(run(resolveHarness(a, { instanceId: c.instance.id, model: "fixture-model", reasoningEffort: "high" }))).rejects.toMatchObject({ reason: "MODEL_UNAVAILABLE" })
  })
  it("binds one claim to one selected model and refuses foreign, duplicate and late completion", async () => {
    const a = await fixture(),
      c = await connect(a),
      other = await connect(await fixture())
    await run(activateHarness(a, c.instance.id, true))
    const selection = { instanceId: c.instance.id, model: "fixture-model", reasoningEffort: "high" as const }
    const pending = run(
      invokeHarness(a, selection, {
        system: "TEST",
        contents: [{ role: "user", parts: [{ text: "TEST prompt" }] }],
        tools: []
      })
    )
    let claimed: Awaited<ReturnType<typeof pollOnce>> | null = null
    async function pollOnce() {
      return run(pollHarnessJobs(c.bridge, [c.status]))
    }
    for (let i = 0; i < 30; i++) {
      const next = await pollOnce()
      if (next.job) {
        claimed = next
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    const job = claimed?.job
    expect(job?.model).toBe("fixture-model")
    expect(job?.input.reasoningEffort).toBe("high")
    if (!job) throw new Error("TEST job was not claimed")
    const result = {
      lease: job.lease,
      kind: "completed" as const,
      answer: { kind: "text" as const, text: "TEST reply" }
    }
    await expect(run(completeHarnessJob(other.bridge, job.id, result))).rejects.toMatchObject({ reason: "CANCELLED" })
    await run(completeHarnessJob(c.bridge, job.id, result))
    expect(await pending).toMatchObject({ kind: "completed", answer: { text: "TEST reply" } })
    await expect(run(completeHarnessJob(c.bridge, job.id, result))).rejects.toMatchObject({ reason: "CANCELLED" })
    expect((await pool.query("SELECT input FROM agent_harness_jobs WHERE id=$1", [job.id])).rows[0].input).toEqual({})
  })
  it("cancels on disable or explicit stop and fences a late bridge response", async () => {
    const a = await fixture(),
      c = await connect(a)
    await run(activateHarness(a, c.instance.id, true))
    const id = randomUUID(),
      lease = randomUUID()
    await pool.query(
      "INSERT INTO agent_harness_jobs(id,instance_id,bridge_id,account_id,user_id,business_id,model,input,status,lease) VALUES($1,$2,$3,$4,$5,$6,'fixture-model','{}','RUNNING',$7)",
      [id, c.instance.id, c.bridge.id, a.accountId, a.userId, a.businessId, lease]
    )
    await run(activateHarness(a, c.instance.id, false))
    expect((await pool.query("SELECT status,input,lease FROM agent_harness_jobs WHERE id=$1", [id])).rows[0]).toEqual({
      status: "CANCELLED",
      input: {},
      lease: null
    })
    await expect(
      run(completeHarnessJob(c.bridge, id, { lease, kind: "completed", answer: { kind: "text", text: "late" } }))
    ).rejects.toMatchObject({ reason: "CANCELLED" })
    await run(cancelHarnessConversation(a))
    await expect(pool.query("UPDATE agent_harness_jobs SET status='QUEUED' WHERE id=$1", [id])).rejects.toThrow(
      /terminal state/
    )
  })
  it("requires sessions and same-origin mutations, while bridge routes reject browser origins", async () => {
    const a = await fixture(),
      c = await connect(a)
    expect((await call("GET", "/api/agent/providers")).status).toBe(401)
    for (const headers of [{ origin: "https://evil.test" }, { "sec-fetch-site": "cross-site" }])
      expect(
        (await call("PATCH", `/api/agent/providers/${c.instance.id}`, a.cookie, { enabled: true }, headers)).status
      ).toBe(403)
    expect((await call("POST", "/api/bridge/poll", a.cookie, { reports: [] })).status).toBe(401)
    expect(
      (
        await call(
          "POST",
          "/api/bridge/poll",
          undefined,
          { reports: [] },
          { authorization: `Bearer ${c.registered.token}`, origin: "https://evil.test" }
        )
      ).status
    ).toBe(403)
    const response = await call("GET", "/api/agent/providers", a.cookie)
    expect(response.status).toBe(200)
    const catalog = Schema.decodeUnknownSync(HarnessCatalog)(await response.json())
    expect(catalog.instances[0]?.enabled).toBe(false)
    expect(JSON.stringify(catalog)).not.toContain(c.registered.token)
  })
  it("hands a job to a waiting bridge at once and streams its reasoning to the turn", async () => {
    const scope = await fixture(), c = await connect(scope)
    await run(activateHarness(scope, c.instance.id, true))
    await run(pollHarnessJobs(c.bridge, [c.status]))
    const selection = { instanceId: c.instance.id, model: "fixture-model" }
    const thoughts: string[] = []
    // A bridge already waiting in a long poll receives the job as soon as it is queued.
    const waiting = run(longPollHarnessJobs(c.bridge, [], true, 5000))
    const started = Date.now()
    const turn = run(invokeHarness({ ...scope }, selection, { system: "TEST", tools: [],
      contents: [{ role: "user", parts: [{ text: "Question" }] }, { role: "model", parts: [{ text: "earlier reasoning", thought: true }, { text: "Earlier answer" }] }] },
      thought => Effect.sync(() => { thoughts.push(thought) })))
    const polled = await waiting
    expect(polled.job).not.toBeNull()
    expect(Date.now() - started).toBeLessThan(2000)
    // Reasoning shown in the chat is never sent to the provider again.
    expect(JSON.stringify(polled.job!.input.contents)).not.toContain("earlier reasoning")
    await run(recordHarnessProgress(c.bridge, polled.job!.id, { lease: polled.job!.lease, thought: "Reading the question" }))
    for (let i = 0; i < 40 && !thoughts.length; i++) await new Promise(r => setTimeout(r, 50))
    expect(thoughts).toEqual(["Reading the question"])
    await expect(run(recordHarnessProgress(c.bridge, polled.job!.id, { lease: randomUUID(), thought: "forged" }))).rejects.toMatchObject({ reason: "CANCELLED" })
    await run(completeHarnessJob(c.bridge, polled.job!.id, { lease: polled.job!.lease, kind: "completed", answer: { kind: "text", text: "Answer", thought: "Final reasoning" } }))
    expect(await turn).toMatchObject({ kind: "completed", answer: { kind: "text", text: "Answer", thought: "Final reasoning" } })
    // A finished job accepts no more progress.
    await expect(run(recordHarnessProgress(c.bridge, polled.job!.id, { lease: polled.job!.lease, thought: "late" }))).rejects.toMatchObject({ reason: "CANCELLED" })
  })
})
