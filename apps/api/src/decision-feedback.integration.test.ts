// Decision feedback against a disposable PostgreSQL: a person's verdict and
// reason are recorded for the agent; approved work becomes due an outcome
// note after the period; the note is saved only on approved work inside the
// business.
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { HttpApp } from "@effect/platform"
import { Effect, Layer, Redacted } from "effect"
import { dispatchToolSpec } from "./agent-registry.js"
import { PgClient } from "@effect/sql-pg"
import { AdsProvider, adsConfigFromEnv } from "@openrecord/ads"
import {
  GrowthRepositoriesLive, AgentProposalRepositoryLive,
  AuthRepositoryLive, DiscoveryMatchRepositoryLive, DiscoveryObservationRepositoryLive,
  EvidenceLineageRepositoryLive, InterventionBindingRepositoryLive, InterventionRepositoryLive,
  RecordRepositoryLive, AcquisitionRepositoryLive, SourceTargetRepositoryLive,
} from "@openrecord/db"
import type { FetchInit, HttpTransport } from "@openrecord/representation"
import pg from "pg"
import { makeRouter, RepoLayers } from "./router.js"
import { ResearchHttp } from "./research/net.js"

const url = process.env["TEST_DATABASE_URL"] ?? ""
const suite = url ? describe : describe.skip

suite("decision feedback (disposable PostgreSQL)", () => {
  let pool: pg.Pool
  const repos = Layer.mergeAll(
    RepoLayers.SetupRepositoryLive, GrowthRepositoriesLive, AgentProposalRepositoryLive,
    AuthRepositoryLive, RecordRepositoryLive, AcquisitionRepositoryLive,
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
    RepoLayers.GrowthMeasurementRepositoryLive,
  ).pipe(
    Layer.provideMerge(PgClient.layer({ url: Redacted.make(url) })),
  )
  const seen: Array<{ url: URL; init: FetchInit }> = []
  const transport: HttpTransport = { lookup: async () => ["93.184.216.34"], fetch: async (raw, init) => {
    const u = new URL(raw); seen.push({ url: u, init })
    const body = { results: [{ trackId: 1, trackName: "Rival Dental", userRatingCount: 10 }] }
    return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify(body)), peerIp: "93.184.216.34" } } }
  const ads = adsConfigFromEnv({ GA4_TOKEN_ENCRYPTION_KEYS: `k1:${Buffer.alloc(32, 5).toString("base64")}` })
  const layer = Layer.mergeAll(repos, Layer.succeed(ResearchHttp, transport), Layer.succeed(AdsProvider, ads))
  beforeAll(() => { pool = new pg.Pool({ connectionString: url }) })
  afterAll(async () => { await pool.end() })
  const fixture = async () => {
    const accountId = String((await pool.query("INSERT INTO accounts(name) VALUES('TEST connections') RETURNING id")).rows[0].id)
    const userId = String((await pool.query("INSERT INTO users(email,password_hash) VALUES($1,'TEST') RETURNING id", [`conn-${randomUUID()}@example.test`])).rows[0].id)
    await pool.query("INSERT INTO account_users(account_id,user_id) VALUES($1,$2)", [accountId, userId])
    const businessId = String((await pool.query("INSERT INTO businesses(account_id,name) VALUES($1,'TEST Dental') RETURNING id", [accountId])).rows[0].id)
    const session = String((await pool.query("INSERT INTO sessions(account_id,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour') RETURNING id", [accountId, userId])).rows[0].id)
    return { accountId, userId, businessId, session, ctx: { accountId, userId, businessId } }
  }

  const tool = (ctx: { accountId: string; userId: string; businessId: string }, name: string, args: unknown): Promise<any> =>
    Effect.runPromise(Effect.either(Effect.provide(dispatchToolSpec(ctx, name, args) as never, layer) as Effect.Effect<unknown, unknown>))
  const web = () => HttpApp.toWebHandlerLayer(makeRouter(), layer as never)
  const send = async (h: ReturnType<typeof web>, path: string, init: { method?: string; session?: string; token?: string; origin?: string; body?: unknown }) => {
    const r = await h.handler(new Request(`http://localhost${path}`, { method: init.method ?? "POST",
      headers: { ...(init.session ? { cookie: `or_session=${init.session}` } : {}), ...(init.token ? { authorization: `Bearer ${init.token}` } : {}), ...(init.origin ? { origin: init.origin } : {}), ...(init.body === undefined ? {} : { "content-type": "application/json" }) },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) }))
    const text = await r.text()
    return { status: r.status, text, json: text ? JSON.parse(text) : null }
  }
  it("records verdicts and reasons for the agent, and outcome notes on approved work", async () => {
    const f = await fixture(), other = await fixture()
    const h = web()
    try {
      const post = (body: unknown, session = f.session, business = f.businessId) => send(h, `/api/businesses/${business}/decision-feedback`, { session, body })
      const rejected = randomUUID(), approved = randomUUID()
      expect((await post({ kind: "AGENT_PROPOSAL", itemId: rejected, verdict: "REJECTED", title: "Add a pricing FAQ", reason: "We already have one on /help" })).status).toBe(200)
      expect((await post({ kind: "WORDPRESS_CHANGE", itemId: approved, verdict: "APPROVED", title: "New comparison section" })).status).toBe(200)
      expect((await post({ kind: "NOPE", itemId: approved, verdict: "APPROVED", title: "x" })).status).toBe(422)
      expect((await post({ kind: "AGENT_PROPOSAL", itemId: rejected, verdict: "REJECTED", title: "x" }, other.session, f.businessId)).status).toBe(404)

      const read = await tool(f.ctx, "read_decision_feedback", {})
      expect(read.right.data.items).toEqual(expect.arrayContaining([
        expect.objectContaining({ verdict: "REJECTED", title: "Add a pricing FAQ", reason: "We already have one on /help", outcomeDue: false }),
        expect.objectContaining({ verdict: "APPROVED", title: "New comparison section", outcomeDue: false })]))
      // After the period, approved work is due an outcome note.
      await pool.query("UPDATE decision_feedback SET decided_at = now() - interval '31 days' WHERE item_id = $1", [approved])
      const due = (await tool(f.ctx, "read_decision_feedback", {})).right.data.items.find((i: { verdict: string }) => i.verdict === "APPROVED")
      expect(due.outcomeDue).toBe(true)
      const rej = (await tool(f.ctx, "read_decision_feedback", {})).right.data.items.find((i: { verdict: string }) => i.verdict === "REJECTED")
      expect((await tool(f.ctx, "record_outcome_note", { feedbackId: rej.feedbackId, note: "Rejected work has no outcome." })).right.data.status).toBe("NOT_FOUND")
      expect((await tool(other.ctx, "record_outcome_note", { feedbackId: due.feedbackId, note: "Not my business at all." })).right.data.status).toBe("NOT_FOUND")
      expect((await tool(f.ctx, "record_outcome_note", { feedbackId: due.feedbackId, note: "Clicks to /compare rose 18% in 30 days; a seasonal rise is also possible." })).right.data.status).toBe("RECORDED")
      expect((await tool(f.ctx, "read_decision_feedback", {})).right.data.items.find((i: { verdict: string }) => i.verdict === "APPROVED")).toMatchObject({ outcomeDue: false, outcomeNote: expect.stringMatching(/seasonal/) })
    } finally { await h.dispose() }
  })
})
