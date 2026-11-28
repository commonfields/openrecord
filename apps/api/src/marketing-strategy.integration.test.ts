// The shared marketing strategy against a disposable database: the agent
// proposes a version, a person approves it, every turn's business context then
// carries it, stale and duplicate proposals are refused, and its phrases to
// avoid are flagged on campaign pages.
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { HttpApp } from "@effect/platform"
import { Effect, Layer, Redacted } from "effect"
import { PgClient } from "@effect/sql-pg"
import pg from "pg"
import { AuthRepositoryLive, BusinessRepositoryLive } from "@openrecord/db"
import { requireSession } from "./router.js"
import { dispatchStrategy, pendingStrategies, strategyApi, strategyContext } from "./marketing-strategy.js"
import { staticFindings } from "./deliverable-checks.js"

describe("strategy in the turn's context", () => {
  it("is empty without an approved strategy and says budget never authorizes spend", () => {
    expect(strategyContext(null)).toBe("")
    const text = strategyContext({ id: randomUUID(), version: 2, status: "APPROVED", audience: "Trust and safety leads", positioning: "One endpoint for every content type", offer: "Free migration help", voice: "Plain, technical",
      avoidPhrases: ["AI-powered", "revolutionary"], priorityBets: ["Perspective API migrations"], budgetLimit: "$0 paid", rationale: "x", createdAt: new Date().toISOString() })
    expect(text).toContain("version 2")
    expect(text).toContain('Avoid: "AI-powered", "revolutionary"')
    expect(text).toContain("never authorizes spend")
    expect(text).not.toContain("·")
  })
  it("warns when a campaign page uses a phrase the strategy says to avoid", () => {
    const found = staticFindings("HTML", "<h1>Our revolutionary moderation</h1>", [], true, ["Revolutionary", "game-changing"])
    expect(found).toEqual([{ code: "AVOIDED_PHRASE", severity: "WARNING", message: 'Uses "Revolutionary", which the approved strategy says to avoid.' }])
  })
})

const url = process.env["TEST_DATABASE_URL"] ?? ""
const suite = url ? describe : describe.skip
suite("marketing strategy versions (disposable PostgreSQL)", () => {
  let pool: pg.Pool
  const layer = Layer.mergeAll(AuthRepositoryLive, BusinessRepositoryLive).pipe(Layer.provideMerge(PgClient.layer({ url: Redacted.make(url) })))
  const web = HttpApp.toWebHandlerLayer(strategyApi(r => Effect.flatMap(requireSession, ({ session }) => r(session))), layer)
  const run = <A, E>(e: Effect.Effect<A, E, import("@effect/sql").SqlClient.SqlClient | import("@openrecord/db").BusinessRepository>) => Effect.runPromise(Effect.either(e).pipe(Effect.provide(layer)))
  beforeAll(() => { pool = new pg.Pool({ connectionString: url }) })
  afterAll(async () => { await web.dispose(); await pool.end() })
  const fixture = async () => {
    const accountId = String((await pool.query("INSERT INTO accounts(name) VALUES('TEST strategy') RETURNING id")).rows[0].id)
    const userId = String((await pool.query("INSERT INTO users(email,password_hash) VALUES($1,'TEST') RETURNING id", [`strategy-${randomUUID()}@example.test`])).rows[0].id)
    await pool.query("INSERT INTO account_users(account_id,user_id) VALUES($1,$2)", [accountId, userId])
    const businessId = String((await pool.query("INSERT INTO businesses(account_id,name) VALUES($1,'TEST Moderation') RETURNING id", [accountId])).rows[0].id)
    const cookie = String((await pool.query("INSERT INTO sessions(id,account_id,user_id,expires_at,token_digest) SELECT u,$1::uuid,$2::uuid,now()+interval '1 hour',encode(sha256(convert_to(u::text,'UTF8')),'hex') FROM gen_random_uuid() u RETURNING id", [accountId, userId])).rows[0].id)
    const ctx = { accountId, userId, businessId }
    const call = (path: string, origin?: string) => web.handler(new Request(`http://localhost/api/businesses/${businessId}/marketing-strategy${path}`, { method: "POST", headers: { "content-type": "application/json", cookie: `or_session=${cookie}`, ...(origin ? { origin } : {}) }, body: "{}" }))
    const propose = (basedOnVersion: number | null, positioning = "One endpoint for text, images and video") => run(dispatchStrategy(ctx, "propose_marketing_strategy", {
      basedOnVersion, audience: "Trust and safety leads at platforms with user content", positioning, offer: "Free migration help before Dec 31",
      voice: "Plain and technical", avoidPhrases: ["revolutionary", "revolutionary", " "], priorityBets: ["Perspective API migrations"], budgetLimit: "$0 paid; outreach only", rationale: "From the site and the owner's goal" }))
    return { ctx, call, propose }
  }

  it("proposes a version, waits for the owner, then carries the approved one", async () => {
    const f = await fixture()
    const first = await propose_ok(f.propose(null))
    expect(first).toMatchObject({ version: 1, reused: false })
    expect((await propose_ok(f.propose(null))).reused).toBe(true)
    const other = await f.propose(null, "Something else")
    expect(other._tag === "Left" && (other.left as { reason?: string }).reason).toBe("StrategyAlreadyWaiting")
    const waiting = await pendingStrategies(f.ctx.accountId, f.ctx.businessId).pipe(Effect.provide(layer), Effect.runPromise)
    expect(waiting).toHaveLength(1)
    expect(waiting[0]).toMatchObject({ version: 1, avoidPhrases: ["revolutionary"], replaces: null })
    expect((await f.call(`/${first.strategyId}/approve`, "https://evil.test")).status).toBe(403)
    expect((await f.call(`/${first.strategyId}/approve`)).status).toBe(200)
    expect((await f.call(`/${first.strategyId}/approve`)).status).toBe(409)
    const read = await run(dispatchStrategy(f.ctx, "read_marketing_strategy", {}))
    expect(read._tag === "Right" && read.right.summary).toBe("Approved strategy version 1")
    // A proposal written against no approved version is stale now; one against version 1 is not, and approving it supersedes version 1.
    const stale = await f.propose(null, "Newer")
    expect(stale._tag === "Left" && (stale.left as { reason?: string }).reason).toBe("StaleStrategy")
    const second = await propose_ok(f.propose(1, "Fastest switch from Perspective API"))
    expect((await f.call(`/${second.strategyId}/approve`)).status).toBe(200)
    expect((await pool.query("SELECT version,status FROM marketing_strategy_versions WHERE business_id=$1 ORDER BY version", [f.ctx.businessId])).rows).toEqual([{ version: 1, status: "SUPERSEDED" }, { version: 2, status: "APPROVED" }])
  })

  it("keeps one business's strategy from another account", async () => {
    const a = await fixture(), b = await fixture()
    const p = await propose_ok(a.propose(null))
    expect((await (await pendingStrategies(b.ctx.accountId, a.ctx.businessId).pipe(Effect.provide(layer), Effect.runPromise)))).toEqual([])
    const res = await web.handler(new Request(`http://localhost/api/businesses/${a.ctx.businessId}/marketing-strategy/${p.strategyId}/approve`, { method: "POST", headers: { "content-type": "application/json", cookie: `or_session=${(await pool.query("SELECT id FROM sessions WHERE user_id=$1", [b.ctx.userId])).rows[0].id}` }, body: "{}" }))
    expect(res.status).toBe(404)
  })

  async function propose_ok(p: ReturnType<ReturnType<typeof Object>["propose"]> | Promise<unknown>) {
    const r = await p as { _tag: string; right?: { data: { strategyId: string; version: number; reused: boolean } }; left?: unknown }
    if (r._tag !== "Right") throw new Error(`proposal refused: ${JSON.stringify(r.left)}`)
    return r.right!.data
  }
})
