// Agent proposals: human-gated execution over TEST fixtures.
// Disposable PostgreSQL fixtures. No provider calls (approvals enqueue
// QUEUED runs; no worker drains them here).
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { HttpApp } from "@effect/platform"
import { Effect, Layer, Redacted } from "effect"
import { PgClient } from "@effect/sql-pg"
import {
  AgentProposalRepositoryLive,
  AuthRepositoryLive, DiscoveryMatchRepositoryLive, DiscoveryObservationRepositoryLive,
  EvidenceLineageRepositoryLive, InterventionBindingRepositoryLive, InterventionRepositoryLive,
  RecordRepositoryLive, SourceTargetRepositoryLive,
} from "@openrecord/db"
import pg from "pg"
import { handleAgentMessage } from "./agent.js"
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
  const web = HttpApp.toWebHandlerLayer(makeRouter(), repos)
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

  it("assistant drafts a proposal for a named question; approval still runs as the human", async () => {
    const f = await fixture()
    const reply = await run(handleAgentMessage(f.account, f.user, f.business, `Please recheck ${f.question}`))
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
})
