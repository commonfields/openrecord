// Hosted pilot deployment path: the readiness endpoint and the fixture gate
// that keeps mock evidence out of production check-runs. Disposable
// PostgreSQL fixtures; no provider calls (9router runs stay QUEUED here).
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { HttpApp } from "@effect/platform"
import { Layer, Redacted } from "effect"
import { PgClient } from "@effect/sql-pg"
import { makeRouter, RepoLayers } from "./router.js"
import {
  GrowthRepositoriesLive, AgentProposalRepositoryLive, AuthRepositoryLive, RecordRepositoryLive, AcquisitionRepositoryLive,
  InterventionRepositoryLive, InterventionBindingRepositoryLive, SourceTargetRepositoryLive, EvidenceLineageRepositoryLive,
  DiscoveryMatchRepositoryLive, DiscoveryObservationRepositoryLive,
} from "@openrecord/db"
import pg from "pg"

const url = process.env["TEST_DATABASE_URL"] ?? ""
const suite = url ? describe : describe.skip

suite("hosted deployment path (TEST fixtures)", () => {
  let pool: pg.Pool
  const repos = Layer.mergeAll(
    RepoLayers.SetupRepositoryLive, GrowthRepositoriesLive, AgentProposalRepositoryLive, AuthRepositoryLive, RecordRepositoryLive, AcquisitionRepositoryLive,
    InterventionRepositoryLive, InterventionBindingRepositoryLive, SourceTargetRepositoryLive, EvidenceLineageRepositoryLive,
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
    DiscoveryObservationRepositoryLive,
    DiscoveryMatchRepositoryLive,
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
  ).pipe(Layer.provideMerge(PgClient.layer({ url: Redacted.make(url) })))
  const web = HttpApp.toWebHandlerLayer(makeRouter(), repos)
  beforeAll(() => { pool = new pg.Pool({ connectionString: url }) })
  afterAll(async () => { await web.dispose(); await pool.end() })

  const fixture = async () => {
    const account = String((await pool.query("INSERT INTO accounts(name) VALUES('TEST hosted pilot') RETURNING id")).rows[0].id)
    const user = String((await pool.query("INSERT INTO users(email,password_hash) VALUES($1,'TEST-only') RETURNING id", [`pilot-${randomUUID()}@example.test`])).rows[0].id)
    await pool.query("INSERT INTO account_users(account_id,user_id) VALUES($1,$2)", [account, user])
    const session = String((await pool.query("INSERT INTO sessions(account_id,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour') RETURNING id", [account, user])).rows[0].id)
    const business = String((await pool.query("INSERT INTO businesses(account_id,name) VALUES($1,'TEST Pilot Client') RETURNING id", [account])).rows[0].id)
    const question = String((await pool.query("INSERT INTO buyer_questions(business_id,prompt) VALUES($1,'TEST opening hours?') RETURNING id", [business])).rows[0].id)
    return { account, user, session, business, question }
  }
  const call = async (method: string, path: string, body?: unknown, cookie?: string, env?: Record<string, string>) => {
    const previous = env ? Object.entries(env).map(([k]) => [k, process.env[k]]) as Array<[string, string | undefined]> : []
    for (const [k, v] of Object.entries(env ?? {})) process.env[k] = v
    try {
      const res = await web.handler(new Request(`http://localhost${path}`, {
        method,
        headers: { "content-type": "application/json", "origin": "http://localhost:3000", ...(cookie ? { cookie: `or_session=${cookie}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }))
      const json = await res.json().catch(() => null) as Record<string, unknown> | null
      return { status: res.status, json }
    } finally {
      for (const [k, v] of previous) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
    }
  }

  it("reports readiness with a database answer, and never configuration or secrets", async () => {
    const r = await call("GET", "/api/health")
    expect(r.status).toBe(200)
    // version is the deployed commit when the deployment states one (null otherwise).
    expect(r.json).toMatchObject({ ok: true, db: true, version: null })
    expect(JSON.stringify(r.json)).not.toMatch(/DATABASE_URL|SECRET|postgres:\/\//i)
  })

  it("refuses fixture (mock) check-runs unless the deployment explicitly allows fixtures", async () => {
    const f = await fixture()
    // Production-like: no NODE_ENV=test, no fixture flag -> refused before any run exists.
    const refused = await call("POST", `/api/businesses/${f.business}/check-runs`, { questionId: f.question, provider: "mock" }, f.session, { NODE_ENV: "production" })
    expect(refused.status).toBe(409)
    expect(refused.json).toMatchObject({ _tag: "CheckRunRefused", reason: "FixtureProviderDisabled" })
    const rows = await pool.query("SELECT count(*)::int AS n FROM check_runs WHERE business_id=$1", [f.business])
    expect(rows.rows[0].n).toBe(0)
    // The deployment's fixture allowance reopens it (developer/test deployments only).
    const allowed = await call("POST", `/api/businesses/${f.business}/check-runs`, { questionId: f.question, provider: "mock" }, f.session, { RECORD_ALLOW_FIXTURE: "1", NODE_ENV: "production" })
    expect(allowed.status).toBe(200)
  })

  it("defaults an omitted provider to the real hosted provider, never the fixture", async () => {
    const f = await fixture()
    const created = await call("POST", `/api/businesses/${f.business}/check-runs`, { questionId: f.question }, f.session)
    expect(created.status).toBe(200)
    expect(created.json?.checkRun).toMatchObject({ provider: "9router", status: "QUEUED" })
  })
})
