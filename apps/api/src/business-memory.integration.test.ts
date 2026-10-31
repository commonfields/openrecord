import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { HttpApp } from "@effect/platform"
import { Effect, Layer, Redacted } from "effect"
import { PgClient } from "@effect/sql-pg"
import {
  GrowthRepositoriesLive, AgentProposalRepositoryLive,
  AuthRepositoryLive, DiscoveryMatchRepositoryLive, DiscoveryObservationRepositoryLive,
  EvidenceLineageRepositoryLive, InterventionBindingRepositoryLive, InterventionRepositoryLive,
  RecordRepositoryLive, AcquisitionRepositoryLive, SourceTargetRepositoryLive,
} from "@openrecord/db"
import pg from "pg"
import { dispatchToolSpec } from "./agent-registry.js"
import { loadResumeContext } from "./agent-resume.js"
import { MAX_ACTIVE, formatMemory, rememberNote } from "./business-memory.js"
import type { AgentToolDeps } from "./agent-tools.js"
import { makeRouter, RepoLayers } from "./router.js"

const url = process.env["TEST_DATABASE_URL"] ?? ""
const suite = url ? describe : describe.skip

suite("business memory (disposable PostgreSQL)", () => {
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
  const web = HttpApp.toWebHandlerLayer(makeRouter(), repos)
  const run = <A, E>(effect: Effect.Effect<A, E, AgentToolDeps>) => Effect.runPromise(Effect.either(effect.pipe(Effect.provide(repos))))
  beforeAll(() => { pool = new pg.Pool({ connectionString: url }) })
  afterAll(async () => { await web.dispose(); await pool.end() })
  const call = (method: string, path: string, session: string | null, body?: unknown, origin?: string) => web.handler(new Request(`http://localhost${path}`, {
    method, headers: { ...(session ? { cookie: `or_session=${session}` } : {}), ...(origin ? { origin } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }))
  const fixture = async () => {
    const accountId = String((await pool.query("INSERT INTO accounts(name) VALUES('TEST memory') RETURNING id")).rows[0].id)
    const userId = String((await pool.query("INSERT INTO users(email,password_hash) VALUES($1,'TEST') RETURNING id", [`memory-${randomUUID()}@example.test`])).rows[0].id)
    await pool.query("INSERT INTO account_users(account_id,user_id) VALUES($1,$2)", [accountId, userId])
    const businessId = String((await pool.query("INSERT INTO businesses(account_id,name) VALUES($1,'TEST Bakery') RETURNING id", [accountId])).rows[0].id)
    const session = String((await pool.query("INSERT INTO sessions(account_id,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour') RETURNING id", [accountId, userId])).rows[0].id)
    return { accountId, userId, businessId, session }
  }

  it("lets the agent remember and forget notes that every later turn for the business reads", async () => {
    const f = await fixture(), ctx = { accountId: f.accountId, userId: f.userId, businessId: f.businessId }
    const saved = await run(dispatchToolSpec(ctx, "remember", { kind: "AVOID", text: "Never offer discounts on the wedding cakes." }))
    expect(saved._tag).toBe("Right")
    const memoryId = saved._tag === "Right" ? (saved.right.data as { memoryId: string }).memoryId : ""
    // The same text again, with different spacing and case, reuses the note.
    const again = await run(dispatchToolSpec(ctx, "remember", { kind: "AVOID", text: "  never offer discounts on the   wedding cakes. " }))
    expect(again._tag === "Right" && again.right.data).toMatchObject({ memoryId, saved: false })
    const brief = await run(loadResumeContext(f.accountId, f.businessId))
    expect(brief._tag === "Right" && brief.right).toContain("[AVOID, ")
    expect(brief._tag === "Right" && brief.right).toContain("Never offer discounts on the wedding cakes.")
    expect(brief._tag === "Right" && brief.right).toContain("not verified evidence")
    // Another business cannot read or forget it.
    const other = await fixture()
    expect((await run(dispatchToolSpec({ ...ctx, accountId: other.accountId, businessId: other.businessId, userId: other.userId }, "forget_memory", { memoryId })))._tag).toBe("Left")
    expect((await run(loadResumeContext(other.accountId, other.businessId)))).toMatchObject({ _tag: "Right", right: expect.stringContaining("nothing saved yet") })
    expect((await run(dispatchToolSpec(ctx, "forget_memory", { memoryId })))._tag).toBe("Right")
    expect((await run(loadResumeContext(f.accountId, f.businessId)))).toMatchObject({ _tag: "Right", right: expect.not.stringContaining("wedding cakes") })
  })

  it("keeps the memory short: a capped number of notes and a bounded brief", async () => {
    const f = await fixture(), ctx = { accountId: f.accountId, userId: f.userId, businessId: f.businessId }
    for (let i = 0; i < MAX_ACTIVE; i++) await run(rememberNote(ctx, { kind: "CONTEXT", text: `TEST note ${i} ${"x".repeat(60)}` }, "ASSISTANT"))
    const full = await run(dispatchToolSpec(ctx, "remember", { kind: "LESSON", text: "One too many" }))
    expect(full._tag === "Left" && (full.left as { _tag?: string })._tag).toBe("MemoryFull")
    const brief = await run(loadResumeContext(f.accountId, f.businessId))
    const memory = brief._tag === "Right" ? brief.right.slice(brief.right.indexOf("Business memory")) : ""
    expect(memory.length).toBeLessThanOrEqual(3100)
    expect(memory).toMatch(/older notes not shown/)
    expect(formatMemory([])).toContain("nothing saved yet")
  })

  it("lets the team read, add and forget notes over HTTP, refusing other accounts and other sites", async () => {
    const f = await fixture(), other = await fixture()
    const path = `/api/businesses/${f.businessId}/memory`
    expect((await call("GET", path, null)).status).toBe(401)
    expect((await call("GET", path, other.session)).status).toBe(404)
    expect((await call("POST", path, f.session, { kind: "PREFERENCE", text: "Write in Indonesian" }, "https://hostile.example.test")).status).toBe(403)
    expect((await call("POST", path, f.session, { kind: "WRONG", text: "x" })).status).toBe(422)
    const added = await call("POST", path, f.session, { kind: "PREFERENCE", text: "Write in Indonesian" })
    expect(added.status).toBe(201)
    const note = (await added.json() as { memory: { id: string; source: string } }).memory
    expect(note.source).toBe("OPERATOR")
    const list = await (await call("GET", path, f.session)).json() as { memories: Array<{ id: string; text: string }>; limit: number }
    expect(list).toMatchObject({ limit: MAX_ACTIVE, memories: [{ id: note.id, text: "Write in Indonesian" }] })
    expect((await call("POST", `/api/businesses/${other.businessId}/memory/${note.id}/forget`, other.session, {})).status).toBe(404)
    expect((await call("POST", `${path}/${note.id}/forget`, f.session, {})).status).toBe(200)
    expect((await call("POST", `${path}/${note.id}/forget`, f.session, {})).status).toBe(404)
    expect((await (await call("GET", path, f.session)).json() as { memories: unknown[] }).memories).toEqual([])
  })
})
