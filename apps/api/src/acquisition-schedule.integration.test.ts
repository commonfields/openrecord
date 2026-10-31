// Scheduled AI-answer tracking: approval of the exact run ceiling, runs the
// server starts on its own, and an alert when visibility drops. The worker is
// simulated by saving Gemini-shaped answers, as in the AI Discovery tests.
import { createHash, randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { HttpApp, HttpRouter } from "@effect/platform"
import { ConfigProvider, Effect, Layer, Redacted } from "effect"
import { PgClient } from "@effect/sql-pg"
import pg from "pg"
import { AcquisitionRepositoryLive, AuthRepositoryLive, BusinessRepositoryLive, ObservationRepository, ObservationRepositoryLive, RecordRepositoryLive } from "@openrecord/db"
import { requireSession } from "./router.js"
import { acquisitionApi } from "./acquisition-routes.js"
import { recordApi } from "./record-routes.js"
import { alertQuestion, runCeiling, runScheduledTracking, trackingScheduleApi, visibilityDrops } from "./acquisition-schedule.js"

const url = process.env["TEST_DATABASE_URL"] ?? ""
const suite = url ? describe : describe.skip
const MODEL = "gemini-2.5-flash"

describe("visibility drops", () => {
  const metrics = (candidates: [number, number], owned: [number, number]) => ({ candidateSamples: { n: candidates[0], d: candidates[1] }, ownedCitationRate: { n: owned[0], d: owned[1] } }) as never
  it("alerts on a drop of at least the approved points, with enough answers on both sides", () => {
    expect(visibilityDrops(metrics([8, 10], [5, 10]), metrics([4, 10], [4, 10]), 15)).toEqual([{ kind: "BRAND_MENTIONS_DROPPED", before: { n: 8, d: 10 }, after: { n: 4, d: 10 } }])
    expect(visibilityDrops(metrics([8, 10], [5, 10]), metrics([7, 10], [5, 10]), 15)).toEqual([])
    expect(visibilityDrops(metrics([5, 5], [5, 5]), metrics([0, 5], [0, 5]), 15)).toEqual([])
    expect(visibilityDrops(metrics([2, 10], [9, 10]), metrics([2, 10], [1, 10]), 15).map(d => d.kind)).toEqual(["OWN_CITATIONS_DROPPED"])
  })
  it("states the numbers plainly in the investigation question", () => {
    expect(alertQuestion({ kind: "BRAND_MENTIONS_DROPPED", before: { n: 8, d: 10 }, after: { n: 4, d: 10 } }))
      .toBe("AI answers named the business less often in the latest scheduled measurement: 4 of 10 answers (40%), down from 8 of 10 answers (80%). Why, and what should change?")
  })
})

suite("scheduled AI-answer tracking (TEST fixtures only)", () => {
  let pool: pg.Pool
  const repos = Layer.mergeAll(AuthRepositoryLive, BusinessRepositoryLive, RecordRepositoryLive, AcquisitionRepositoryLive, ObservationRepositoryLive)
    .pipe(Layer.provideMerge(PgClient.layer({ url: Redacted.make(url) })))
  const config = Layer.setConfigProvider(ConfigProvider.fromMap(new Map([["RECORD_PROVIDER", "gemini"], ["GEMINI_MODEL", MODEL], ["AGENT_MEASUREMENT_MAX_USD_PER_ATTEMPT", "0.01"]])))
  const withSession = <A, E, R>(run: (s: { accountId: string; userId: string }) => Effect.Effect<A, E, R>) => Effect.flatMap(requireSession, ({ session }) => run(session))
  const web = HttpApp.toWebHandlerLayer(HttpRouter.concat(HttpRouter.concat(recordApi(withSession), acquisitionApi(withSession)), trackingScheduleApi(withSession)), Layer.merge(repos, config))
  const run = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.runPromise((effect as Effect.Effect<A, E, never>).pipe(Effect.provide(Layer.merge(repos, config))))
  beforeAll(() => { pool = new pg.Pool({ connectionString: url }) })
  afterAll(async () => { await web.dispose(); await pool.end() })
  const agency = async () => {
    const account = (await pool.query("INSERT INTO accounts(name) VALUES ('TEST Agency') RETURNING id")).rows[0].id as string
    const user = (await pool.query("INSERT INTO users(email,password_hash) VALUES ($1,'TEST-only') RETURNING id", [`acq-api-${randomUUID()}@example.test`])).rows[0].id as string
    await pool.query("INSERT INTO account_users(account_id,user_id) VALUES ($1,$2)", [account, user])
    const session = (await pool.query("INSERT INTO sessions(account_id,user_id,expires_at) VALUES ($1,$2,now()+interval '1 hour') RETURNING id", [account, user])).rows[0].id as string
    return { account, user, session }
  }
  const call = (method: string, path: string, session?: string, body?: unknown, headers: Record<string, string> = {}) => web.handler(new Request(`http://localhost${path}`, {
    method, headers: { ...(session ? { cookie: `or_session=${session}` } : {}), "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }))
  const ok = async <T>(r: Response | Promise<Response>): Promise<T> => {
    const res = await r
    if (res.status !== 200) throw new Error(`expected 200, got ${res.status}: ${await res.text()}`)
    return await res.json() as T
  }
  const client = async (session: string) => (await ok<{ client: { businessId: string } }>(call("POST", "/api/record/clients", session,
    { name: "TEST Supportly", websiteUrl: "https://supportly.test/", engagement: "FIXTURE" }))).client.businessId
  const base = (id: string) => `/api/acquisition/clients/${id}`
  const setBody2 = () => ({
    basis: "FIXTURE", category: "TEST customer support agents",
    target: { name: "Supportly", aliases: [], domains: ["supportly.test"] },
    competitors: [{ name: "HelpHub", aliases: [], domains: ["helphub.test"] }],
    questions: [0, 1].map(i => ({ group: "CATEGORY_DISCOVERY", prompt: `What are good TEST AI support agents ${i}? ${randomUUID()}` })),
  })
  /** Answers every queued check of a batch, as the worker would. */
  const answerAll = async (businessId: string, batchId: string, text: string) => {
    const checks = (await pool.query("SELECT id FROM check_runs WHERE acq_batch_id = $1 AND status = 'QUEUED'", [batchId])).rows as Array<{ id: string }>
    for (const c of checks) {
      await pool.query("UPDATE check_runs SET status='RUNNING', started_at=now(), heartbeat_at=now() WHERE id=$1", [c.id])
      const raw = JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }], nonce: randomUUID() })
      await run(Effect.flatMap(ObservationRepository, o => o.create({
        businessId, checkRunId: c.id, provider: "gemini", requestedModel: MODEL, observedModel: MODEL, collectedAt: new Date().toISOString(),
        answerText: text, retrievalMode: "PROVIDER_GROUNDING", modelVersion: MODEL, retrievalTool: "google_search",
        requestParameters: { model: MODEL, tools: ["google_search"] }, rawResponse: JSON.parse(raw), rawDigest: createHash("sha256").update(raw).digest("hex"),
        rawBytesHex: Buffer.from(raw).toString("hex"), rawContentType: "application/json", providerMetadata: {}, synthetic: false, completeRun: true, citations: [],
      })))
    }
    return checks.length
  }

  it("runs on its own within the approved ceiling and alerts when answers stop naming the business", async () => {
    const a = await agency(), other = await agency()
    const businessId = await client(a.session)
    const set = (await ok<{ set: { id: string; questions: unknown[] } }>(call("POST", `${base(businessId)}/question-sets`, a.session, setBody2()))).set
    const approve = (calls: number, headers: Record<string, string> = {}) => call("PUT", `${base(businessId)}/schedule`, a.session, { setId: set.id, cadence: "WEEKLY", samples: 4, acknowledgedMaxProviderCalls: calls }, headers)
    const ceiling = runCeiling(2, 4)
    expect((await approve(ceiling - 1)).status).toBe(409)
    expect((await approve(ceiling, { origin: "https://evil.example" })).status).toBe(403)
    expect((await call("GET", `${base(businessId)}/schedule`, other.session)).status).toBe(404)
    const approved = await ok<{ schedule: { maxProviderCalls: number; estimatedMaxCostUsd: number; enabled: boolean } }>(approve(ceiling))
    expect(approved.schedule).toMatchObject({ maxProviderCalls: 32, estimatedMaxCostUsd: 0.32, enabled: true })

    // First run: the server starts it, and nothing new starts while it is still collecting.
    await run(runScheduledTracking)
    const first = (await pool.query("SELECT last_batch_id FROM acq_schedules WHERE business_id = $1", [businessId])).rows[0].last_batch_id as string
    expect(first).toBeTruthy()
    await pool.query("UPDATE acq_schedules SET next_run_at = now() WHERE business_id = $1", [businessId])
    await run(runScheduledTracking)
    expect((await pool.query("SELECT count(*)::int AS n FROM acq_batches WHERE business_id = $1", [businessId])).rows[0].n).toBe(1)
    expect(await answerAll(businessId, first, "Supportly is the best TEST support agent for small teams.")).toBe(8)

    // Second run: answers no longer name the business.
    await pool.query("UPDATE acq_schedules SET next_run_at = now() WHERE business_id = $1", [businessId])
    await run(runScheduledTracking)
    const second = (await pool.query("SELECT last_batch_id FROM acq_schedules WHERE business_id = $1", [businessId])).rows[0].last_batch_id as string
    expect(second).not.toBe(first)
    await answerAll(businessId, second, "HelpHub is the best TEST support agent for small teams.")
    await run(runScheduledTracking)
    const view = await ok<{ alerts: Array<{ kind: string; before: { n: number; d: number }; after: { n: number; d: number }; investigationId: string | null }> }>(call("GET", `${base(businessId)}/schedule`, a.session))
    expect(view.alerts).toEqual([expect.objectContaining({ kind: "BRAND_MENTIONS_DROPPED", before: { n: 8, d: 8 }, after: { n: 0, d: 8 }, investigationId: null })])
    // Comparing again never repeats the alert.
    await run(runScheduledTracking)
    expect((await ok<{ alerts: unknown[] }>(call("GET", `${base(businessId)}/schedule`, a.session))).alerts).toHaveLength(1)

    // A ceiling that no longer matches the set pauses the schedule instead of spending.
    await pool.query("UPDATE acq_schedules SET max_provider_calls = 7, next_run_at = now() WHERE business_id = $1", [businessId])
    await run(runScheduledTracking)
    const paused = (await pool.query("SELECT enabled, paused_reason FROM acq_schedules WHERE business_id = $1", [businessId])).rows[0]
    expect(paused.enabled).toBe(false)
    expect(paused.paused_reason).toBeTruthy()
    expect((await call("POST", `${base(businessId)}/schedule/enabled`, a.session, { enabled: true })).status).toBe(409)
  })
})
