// Agent proposals: human-gated execution over TEST fixtures.
// Disposable PostgreSQL fixtures. No provider calls (approvals enqueue
// QUEUED runs; no worker drains them here).
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { HttpApp } from "@effect/platform"
import { ConfigProvider, Effect, Layer, Redacted } from "effect"
import { PgClient } from "@effect/sql-pg"
import {
  AgentProposalRepositoryLive,
  AuthRepositoryLive, DiscoveryMatchRepositoryLive, DiscoveryObservationRepositoryLive,
  EvidenceLineageRepositoryLive, InterventionBindingRepositoryLive, InterventionRepositoryLive,
  RecordRepositoryLive, SourceTargetRepositoryLive,
} from "@openrecord/db"
import pg from "pg"
import { dispatchAgentTool, runConversation } from "./agent.js"
import type { AgentToolDeps } from "./agent-tools.js"
import { makeRouter, RepoLayers } from "./router.js"

const url = process.env["TEST_DATABASE_URL"] ?? ""
const suite = url ? describe : describe.skip

suite("agent proposal-gated writes (TEST fixtures)", () => {
  let pool: pg.Pool
  const repos = Layer.mergeAll(
    AgentProposalRepositoryLive,
    AuthRepositoryLive, RecordRepositoryLive,
    InterventionRepositoryLive, InterventionBindingRepositoryLive, SourceTargetRepositoryLive,
    EvidenceLineageRepositoryLive, DiscoveryObservationRepositoryLive, DiscoveryMatchRepositoryLive,
    RepoLayers.AssayRepositoryLive,
    RepoLayers.AssayReviewRepositoryLive,
    RepoLayers.BusinessRepositoryLive,
    RepoLayers.FactRepositoryLive,
    RepoLayers.QuestionRepositoryLive,
    RepoLayers.CheckRunRepositoryLive,
    RepoLayers.ObservationRepositoryLive,
    RepoLayers.ClaimRepositoryLive,
    RepoLayers.JudgmentRepositoryLive,
    RepoLayers.ReobservationIntentRepositoryLive,
    RepoLayers.ReobservationRepositoryLive,
    RepoLayers.ProductReadRepositoryLive,
    RepoLayers.DiscoveryScopeRepositoryLive,
    RepoLayers.DiscoveryRunRepositoryLive,
    RepoLayers.DiscoveryFrontierRepositoryLive,
    RepoLayers.SiteTargetRepositoryLive,
    RepoLayers.SiteRunRepositoryLive,
    RepoLayers.SitePageObservationRepositoryLive,
    RepoLayers.SiteFindingRepositoryLive,
    RepoLayers.SiteFindingEventRepositoryLive,
    RepoLayers.SiteFixProposalRepositoryLive,
    RepoLayers.SiteMutationRepositoryLive,
    RepoLayers.SiteVerificationRepositoryLive,
    RepoLayers.SiteOperatorEventRepositoryLive,
    RepoLayers.SiteGscRepositoryLive,
  ).pipe(
    Layer.provideMerge(PgClient.layer({ url: Redacted.make(url) })),
  )
  const fixtureConfig = ConfigProvider.fromMap(new Map([["AGENT_EXTERNAL_PROCESSING_ENABLED", "true"], ["AGENT_MODEL", "fixture-model"], ["AGENT_API_KEY", "TEST-only-key"]]))
  const web = HttpApp.toWebHandlerLayer(makeRouter(), Layer.merge(repos, Layer.setConfigProvider(fixtureConfig)))
  const run = <A, E>(effect: Effect.Effect<A, E, AgentToolDeps>) => Effect.runPromise(Effect.either(effect.pipe(Effect.provide(repos))))
  beforeAll(() => {
    pool = new pg.Pool({ connectionString: url })
  })
  afterAll(async () => {
    await web.dispose()
    await pool.end()
  })

  const fixture = async () => {
    const account = (await pool.query("INSERT INTO accounts(name) VALUES ('TEST agent proposals') RETURNING id")).rows[0].id as string
    const user = (await pool.query("INSERT INTO users(email,password_hash) VALUES ($1,'TEST-only') RETURNING id", [`proposal-${randomUUID()}@example.test`])).rows[0].id as string
    await pool.query("INSERT INTO account_users(account_id,user_id) VALUES ($1,$2)", [account, user])
    const session = (await pool.query("INSERT INTO sessions(account_id,user_id,expires_at) VALUES ($1,$2,now()+interval '1 hour') RETURNING id", [account, user])).rows[0].id as string
    const business = (await pool.query("INSERT INTO businesses(account_id,name) VALUES ($1,'TEST Brand') RETURNING id", [account])).rows[0].id as string
    const question = (await pool.query("INSERT INTO buyer_questions(business_id,prompt) VALUES ($1,'TEST opening time?') RETURNING id", [business])).rows[0].id as string
    return { account, user, business, question, session }
  }
  const call = (method: string, path: string, session: string | null, body?: unknown) =>
    web.handler(
      new Request(`http://localhost${path}`, {
        method,
        headers: { ...(session ? { cookie: `or_session=${session}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
        body: body === undefined ? null : JSON.stringify(body),
      }),
    )
  const checksOf = async (business: string) =>
    Number((await pool.query("SELECT count(*)::int n FROM check_runs WHERE business_id = $1", [business])).rows[0].n)

  it("proposes without executing; approval executes once with approver attribution", async () => {
    const f = await fixture()
    const proposed = await call("POST", `/api/businesses/${f.business}/agent/proposals`, f.session, { kind: "REQUEST_CHECK", questionId: f.question })
    expect(proposed.status).toBe(200)
    const created = (await proposed.json()) as { proposal: Record<string, unknown> }
    expect(created.proposal).toMatchObject({ status: "PROPOSED", kind: "REQUEST_CHECK", proposer: "operator", proposedByUserId: f.user })
    expect(await checksOf(f.business)).toBe(0)

    const listed = await (await call("GET", `/api/businesses/${f.business}/agent/proposals?status=PROPOSED`, f.session)).json() as { proposals: unknown[] }
    expect(listed.proposals).toHaveLength(1)

    const approved = await call("POST", `/api/businesses/${f.business}/agent/proposals/${String(created.proposal["id"])}/approve`, f.session, { provider: "mock" })
    expect(approved.status).toBe(200)
    const done = (await approved.json()) as { proposal: Record<string, unknown>; checkRunId: string }
    expect(done.proposal).toMatchObject({ status: "EXECUTED", decidedByUserId: f.user })
    expect(typeof done.checkRunId).toBe("string")
    expect(await checksOf(f.business)).toBe(1)

    // Idempotent replay: a second approval returns the same execution.
    const replay = await call("POST", `/api/businesses/${f.business}/agent/proposals/${String(created.proposal["id"])}/approve`, f.session, { provider: "mock" })
    expect(replay.status).toBe(200)
    expect(((await replay.json()) as { checkRunId: string }).checkRunId).toBe(done.checkRunId)
    expect(await checksOf(f.business)).toBe(1)
  })

  it("deduplicates identical pending proposals instead of spamming rows", async () => {
    const f = await fixture()
    const first = (await (await call("POST", `/api/businesses/${f.business}/agent/proposals`, f.session, { kind: "REQUEST_CHECK", questionId: f.question })).json()) as {
      proposal: Record<string, unknown>
    }
    const second = (await (await call("POST", `/api/businesses/${f.business}/agent/proposals`, f.session, { kind: "REQUEST_CHECK", questionId: f.question })).json()) as {
      proposal: Record<string, unknown>
    }
    expect(second.proposal["id"]).toBe(first.proposal["id"])
    expect(Number((await pool.query("SELECT count(*)::int n FROM agent_proposals WHERE business_id = $1", [f.business])).rows[0].n)).toBe(1)
  })

  it("decides at most once and keeps proposal content immutable", async () => {
    const f = await fixture()
    const created = (await (await call("POST", `/api/businesses/${f.business}/agent/proposals`, f.session, { kind: "REQUEST_CHECK", questionId: f.question })).json()) as {
      proposal: Record<string, unknown>
    }
    const id = String(created.proposal["id"])
    // A first decision through any path is legal; a second is refused.
    await pool.query("UPDATE agent_proposals SET status = 'REJECTED', decided_by_user_id = $2, decided_at = now() WHERE id = $1", [id, f.user])
    await expect(pool.query("UPDATE agent_proposals SET status = 'EXECUTED', decided_by_user_id = $2, decided_at = now(), executed_check_run_id = $3 WHERE id = $1", [id, f.user, randomUUID()])).rejects.toThrow(/already decided/)
    expect((await pool.query("SELECT status FROM agent_proposals WHERE id = $1", [id])).rows[0].status).toBe("REJECTED")
    // Content is immutable even before any decision.
    const g = await fixture()
    const pending = (await (await call("POST", `/api/businesses/${g.business}/agent/proposals`, g.session, { kind: "REQUEST_CHECK", questionId: g.question })).json()) as {
      proposal: Record<string, unknown>
    }
    const pendingId = String(pending.proposal["id"])
    await expect(pool.query("UPDATE agent_proposals SET message = 'edited' WHERE id = $1", [pendingId])).rejects.toThrow(/immutable/)
    expect((await pool.query("SELECT message, status FROM agent_proposals WHERE id = $1", [pendingId])).rows[0]).toMatchObject({ status: "PROPOSED" })
  })

  it("rejects without executing; decided proposals stay decided", async () => {
    const f = await fixture()
    const created = (await (await call("POST", `/api/businesses/${f.business}/agent/proposals`, f.session, { kind: "REQUEST_CHECK", questionId: f.question })).json()) as {
      proposal: Record<string, unknown>
    }
    const rejected = await call("POST", `/api/businesses/${f.business}/agent/proposals/${String(created.proposal["id"])}/reject`, f.session)
    expect(rejected.status).toBe(200)
    expect(((await rejected.json()) as { proposal: Record<string, unknown> }).proposal).toMatchObject({ status: "REJECTED", decidedByUserId: f.user })
    expect(await checksOf(f.business)).toBe(0)
    expect((await call("POST", `/api/businesses/${f.business}/agent/proposals/${String(created.proposal["id"])}/approve`, f.session, { provider: "mock" })).status).toBe(409)
    expect(await checksOf(f.business)).toBe(0)
  })

  it("reads nothing across tenants and validates inputs", async () => {
    const f = await fixture()
    const foreign = await fixture()
    const created = (await (await call("POST", `/api/businesses/${f.business}/agent/proposals`, f.session, { kind: "REQUEST_CHECK", questionId: f.question })).json()) as {
      proposal: Record<string, unknown>
    }
    expect((await call("POST", `/api/businesses/${f.business}/agent/proposals`, foreign.session, { kind: "REQUEST_CHECK", questionId: f.question })).status).toBe(404)
    expect((await call("POST", `/api/businesses/${f.business}/agent/proposals/${created.proposal["id"]}/approve`, foreign.session, { provider: "mock" })).status).toBe(404)
    expect((await call("GET", `/api/businesses/${foreign.business}/agent/proposals`, f.session)).status).toBe(404)
    expect(await checksOf(f.business)).toBe(0)
    expect((await call("POST", `/api/businesses/${f.business}/agent/proposals`, f.session, { kind: "REQUEST_CHECK", questionId: foreign.question })).status).toBe(404)
    expect((await call("POST", `/api/businesses/${f.business}/agent/proposals`, f.session, { kind: "NOPE", questionId: f.question })).status).toBe(422)
    expect((await call("POST", `/api/businesses/${f.business}/agent/proposals/${created.proposal["id"]}/approve`, f.session, { provider: "gemini" })).status).toBe(422)
    expect((await call("POST", `/api/businesses/${f.business}/agent/proposals/not-a-uuid/approve`, f.session, { provider: "mock" })).status).toBe(422)
    expect((await call("POST", `/api/businesses/${f.business}/agent/proposals/${randomUUID()}/approve`, f.session, { provider: "mock" })).status).toBe(404)
    expect((await call("GET", `/api/businesses/${f.business}/agent/proposals?status=BOGUS`, f.session)).status).toBe(422)
    expect((await call("POST", `/api/businesses/${f.business}/agent/proposals`, null, { kind: "REQUEST_CHECK", questionId: f.question })).status).toBe(401)
  })

  it("assistant compare answers include live record outcomes", async () => {
    const f = await fixture()
    const reply = await run(dispatchAgentTool(f.account, f.user, f.business, "read_record_outcomes", {}))
    expect(reply._tag).toBe("Right")
    if (reply._tag !== "Right") return
    expect(reply.right.data).toEqual({ hasRecord: false })
  })

  it("assistant drafts a proposal for a named question; approval still runs as the human", async () => {
    const f = await fixture()
    let round = 0
    const reply = await run(runConversation({ message: `Please recheck ${f.question}`, history: [],
      model: () => Effect.succeed({ candidates: [{ content: { role: "model", parts: round++ === 0
        ? [{ functionCall: { name: "propose_check_run", args: { questionId: f.question } } }]
        : [{ text: "Proposed re-check; approval required." }] }, finishReason: "STOP" }] }),
      dispatch: (name, args) => dispatchAgentTool(f.account, f.user, f.business, name, args).pipe(Effect.provide(repos)),
    }))
    expect(reply._tag).toBe("Right")
    if (reply._tag !== "Right") return
    expect(reply.right.reply).toContain("Proposed re-check")
    expect(reply.right.toolCalls.map((t) => t.tool)).toContain("propose_check_run")
    const listed = await (await call("GET", `/api/businesses/${f.business}/agent/proposals?status=PROPOSED`, f.session)).json() as {
      proposals: Array<Record<string, unknown>>
    }
    expect(listed.proposals).toHaveLength(1)
    expect(listed.proposals[0]).toMatchObject({ proposer: "assistant-v1", proposedByUserId: f.user, questionId: f.question })
    expect(await checksOf(f.business)).toBe(0)
    const approved = await call("POST", `/api/businesses/${f.business}/agent/proposals/${listed.proposals[0]!["id"]}/approve`, f.session, {
      provider: "mock",
    })
    expect(approved.status).toBe(200)
    const done = (await approved.json()) as { proposal: Record<string, unknown> }
    expect(done.proposal).toMatchObject({ status: "EXECUTED", decidedByUserId: f.user })
  })
  it("completes the HTTP conversation, evidence follow-up and proposal scenario without execution", async () => {
    const f = await fixture()
    const responses = [
      [{ functionCall: { name: "discover_buyer_questions", args: {} } }],
      [{ text: "One stored buyer question is available. No reviewed evidence yet." }],
      [{ functionCall: { name: "read_record_outcomes", args: {} } }],
      [{ text: "This client has no record evidence. A missing record is not a positive finding." }],
      [{ functionCall: { name: "propose_check_run", args: { questionId: f.question } } }],
      [{ text: "A re-check is proposed. Review and approve it before execution." }],
    ]
    let round = 0
    const transport = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { contents: Array<{ parts: Array<{ text?: string }> }> }
      if (round === 2) expect(JSON.stringify(body.contents)).toContain("One stored buyer question")
      return new Response(JSON.stringify({ candidates: [{ content: { role: "model", parts: responses[round++] }, finishReason: "STOP" }], modelVersion: "fixture-model", usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 } }))
    })
    try {
      let revision = 0
      let conversationId: string | undefined
      for (const message of ["What problems does this client have?", "Show me the evidence", "Run another check"]) {
        const response = await call("POST", `/api/businesses/${f.business}/agent/messages`, f.session, { message, requestId: randomUUID(), revision, conversationId })
        expect(response.status).toBe(200)
        const answer = await response.json() as { revision: number; conversationId: string; citations: Array<{ id: string }>; requestedModel: string }
        revision = answer.revision; conversationId = answer.conversationId
        expect(answer.requestedModel).toBe("fixture-model")
      }
      expect(revision).toBe(3)
      expect(transport).toHaveBeenCalledTimes(6)
      expect(await checksOf(f.business)).toBe(0)
      const saved = await (await call("GET", `/api/businesses/${f.business}/agent/conversation`, f.session)).json() as { conversation: { messages: unknown[] } }
      expect(saved.conversation.messages).toHaveLength(6)
      const foreign = await fixture()
      expect((await call("GET", `/api/businesses/${f.business}/agent/conversation`, foreign.session)).status).toBe(404)
      const proposal = (await (await call("GET", `/api/businesses/${f.business}/agent/proposals`, f.session)).json()) as { proposals: Array<{ id: string }> }
      expect(proposal.proposals).toHaveLength(1)
      const approve = () => call("POST", `/api/businesses/${f.business}/agent/proposals/${proposal.proposals[0]!.id}/approve`, f.session, { provider: "mock" })
      expect((await approve()).status).toBe(200)
      expect((await approve()).status).toBe(200)
      expect(await checksOf(f.business)).toBe(1)
    } finally { transport.mockRestore() }
  })

  it("rejects hostile browser origins before inference or proposal writes", async () => {
    const f = await fixture()
    for (const path of [`/api/businesses/${f.business}/agent/messages`, `/api/businesses/${f.business}/agent/proposals`]) {
      const res = await web.handler(new Request(`http://localhost${path}`, { method: "POST", headers: { cookie: `or_session=${f.session}`, origin: "https://hostile.example.test", "content-type": "application/json" }, body: JSON.stringify({ message: "Read", requestId: randomUUID(), revision: 0, kind: "REQUEST_CHECK", questionId: f.question }) }))
      expect(res.status).toBe(403)
    }
    expect(await checksOf(f.business)).toBe(0)
  })

  it("refuses stale pending proposals without starting a measurement", async () => {
    const f = await fixture()
    const id = (await pool.query("INSERT INTO agent_proposals(business_id,kind,question_id,message,proposer,proposed_by_user_id,created_at) VALUES ($1,'REQUEST_CHECK',$2,'TEST stale proposal','operator',$3,now()-interval '25 hours') RETURNING id", [f.business, f.question, f.user])).rows[0].id as string
    expect((await call("POST", `/api/businesses/${f.business}/agent/proposals/${id}/approve`, f.session, { provider: "mock" })).status).toBe(422)
    expect(await checksOf(f.business)).toBe(0)
  })

})
