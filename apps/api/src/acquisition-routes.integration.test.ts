// AI Discovery HTTP surface: session attribution, tenant isolation, origin
// checks, strict validation, fixture gating, and the absence of any public
// route. Every agency, brand and export is a TEST fixture; the worker is
// simulated by persisting a Gemini-shaped observation directly.
// Requires TEST_DATABASE_URL (CI provides postgres; skipped otherwise).
import { createHash, randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { HttpApp, HttpRouter } from "@effect/platform"
import { Chunk, Effect, Layer, Redacted } from "effect"
import { PgClient } from "@effect/sql-pg"
import pg from "pg"
import { AcquisitionRepositoryLive, AuthRepositoryLive, BusinessRepositoryLive, ObservationRepository, ObservationRepositoryLive, RecordRepositoryLive } from "@openrecord/db"
import { requireSession } from "./router.js"
import { acquisitionApi } from "./acquisition-routes.js"
import { recordApi } from "./record-routes.js"

const url = process.env["TEST_DATABASE_URL"] ?? ""
const suite = url ? describe : describe.skip
const MODEL = "gemini-2.5-flash"

suite("AI Discovery HTTP (TEST fixtures only)", () => {
  let pool: pg.Pool
  const repos = Layer.mergeAll(AuthRepositoryLive, BusinessRepositoryLive, RecordRepositoryLive, AcquisitionRepositoryLive, ObservationRepositoryLive)
    .pipe(Layer.provide(PgClient.layer({ url: Redacted.make(url) })))
  const withSession = <A, E, R>(run: (s: { accountId: string; userId: string }) => Effect.Effect<A, E, R>) => Effect.flatMap(requireSession, ({ session }) => run(session))
  const web = HttpApp.toWebHandlerLayer(HttpRouter.concat(recordApi(withSession), acquisitionApi(withSession)), repos)
  const observations = ObservationRepositoryLive.pipe(Layer.provide(PgClient.layer({ url: Redacted.make(url) })))
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
  const setBody = (basis = "FIXTURE") => ({
    basis, category: "TEST customer support agents",
    target: { name: "Supportly", aliases: ["Supportly AI"], domains: ["supportly.test"] },
    competitors: [{ name: "HelpHub", aliases: [], domains: ["helphub.test"] }],
    questions: [{ group: "CATEGORY_DISCOVERY", prompt: `What are good TEST AI support agents? ${randomUUID()}` }],
  })
  const client = async (session: string) => (await ok<{ client: { businessId: string } }>(call("POST", "/api/record/clients", session,
    { name: "TEST Supportly", websiteUrl: "https://supportly.test/", engagement: "FIXTURE" }))).client.businessId
  const base = (id: string) => `/api/acquisition/clients/${id}`
  type View = { view: { sets: Array<{ id: string; questions: Array<{ key: string }> }>; checks: Array<{ id: string; observation: { id: string } | null }>
    batches: Array<{ metrics: { recommendationRate: { n: number; d: number } } }>; referrals: Array<{ signups: unknown; synthetic: boolean }> }; maxAttemptsPerCheck: number }

  it("requires a session and scopes every client to the session's agency", async () => {
    const a = await agency()
    const b = await agency()
    const businessId = await client(a.session)
    expect((await call("GET", base(businessId))).status).toBe(401)
    expect((await call("GET", base(businessId), b.session)).status).toBe(404)
    expect((await call("POST", `${base(businessId)}/question-sets`, b.session, setBody())).status).toBe(404)
    expect((await call("GET", base("not-a-uuid"), a.session)).status).toBe(422)
  })
  it("refuses cross-origin writes", async () => {
    const a = await agency()
    const businessId = await client(a.session)
    expect((await call("POST", `${base(businessId)}/question-sets`, a.session, setBody(), { origin: "https://evil.example" })).status).toBe(403)
  })
  it("rejects unknown fields and identities in request bodies", async () => {
    const a = await agency()
    const businessId = await client(a.session)
    expect((await call("POST", `${base(businessId)}/question-sets`, a.session, { ...setBody(), createdByUserId: a.user })).status).toBe(422)
    expect((await call("POST", `${base(businessId)}/question-sets`, a.session, { ...setBody(), questions: [] })).status).toBe(422)
  })
  it("runs the operator workflow and reports reviewed counts only", async () => {
    const a = await agency()
    const businessId = await client(a.session)
    const { set } = await ok<{ set: { id: string; questions: Array<{ key: string }> } }>(call("POST", `${base(businessId)}/question-sets`, a.session, setBody()))
    let view = await ok<View>(call("GET", base(businessId), a.session))
    expect(view.maxAttemptsPerCheck).toBe(4)
    const refused = await call("POST", `${base(businessId)}/batches`, a.session, { setId: set.id, scope: "FULL", samples: 2, acknowledgedMaxProviderCalls: 2 })
    expect(refused.status).toBe(409)
    expect(await refused.json()).toMatchObject({ reason: "SpendPlanNotAcknowledged" })
    await ok(call("POST", `${base(businessId)}/batches`, a.session, { setId: set.id, scope: "FULL", samples: 2, acknowledgedMaxProviderCalls: 8 }))
    view = await ok<View>(call("GET", base(businessId), a.session))
    const [first] = view.view.checks
    // Simulated worker: persist one Gemini-shaped answer for the first check.
    await pool.query("UPDATE check_runs SET status='RUNNING', started_at=now(), heartbeat_at=now() WHERE id=$1", [first!.id])
    const raw = JSON.stringify({ candidates: [{ content: { parts: [{ text: "Supportly AI fits small teams." }] } }], nonce: randomUUID() })
    await Effect.runPromise(Effect.flatMap(ObservationRepository, o => o.create({
      businessId, checkRunId: first!.id, provider: "gemini", requestedModel: MODEL, observedModel: MODEL, collectedAt: new Date().toISOString(),
      answerText: "Supportly AI fits small teams.", retrievalMode: "PROVIDER_GROUNDING", modelVersion: MODEL, retrievalTool: "google_search",
      requestParameters: { model: MODEL, tools: ["google_search"] }, rawResponse: JSON.parse(raw), rawDigest: createHash("sha256").update(raw).digest("hex"),
      rawBytesHex: Buffer.from(raw).toString("hex"), rawContentType: "application/json", providerMetadata: {}, synthetic: false, completeRun: true, citations: [],
    })).pipe(Effect.provide(observations)))
    view = await ok<View>(call("GET", base(businessId), a.session))
    const observationId = view.view.checks.find(c => c.id === first!.id)!.observation!.id
    expect((await call("POST", `${base(businessId)}/judgments`, a.session, { observationId, mention: "MENTIONED", recommendation: "RECOMMENDED", reviewedBy: a.user })).status).toBe(422)
    await ok(call("POST", `${base(businessId)}/judgments`, a.session, { observationId, mention: "MENTIONED", recommendation: "RECOMMENDED" }))
    view = await ok<View>(call("GET", base(businessId), a.session))
    expect(view.view.batches[0]!.metrics.recommendationRate).toEqual({ n: 1, d: 1 })
    const reviewer = (await pool.query("SELECT reviewed_by_user_id FROM acq_judgments WHERE observation_id = $1", [observationId])).rows[0].reviewed_by_user_id
    expect(reviewer).toBe(a.user)

    const imported = await ok<{ duplicate: boolean }>(call("POST", `${base(businessId)}/referral-imports`, a.session, {
      dataOrigin: "SYNTHETIC_FIXTURE", propertyRef: "TEST-property", dateStart: "2026-09-01", dateEnd: "2026-09-30", timeZone: "UTC",
      attributionBasis: "SESSION_SOURCE_MEDIUM", conversionEvent: null, csv: "date,sessionSource,sessionMedium,sessions\n20260901,chatgpt.com,referral,7\n" }))
    expect(imported.duplicate).toBe(false)
    const bad = await call("POST", `${base(businessId)}/referral-imports`, a.session, {
      dataOrigin: "SYNTHETIC_FIXTURE", propertyRef: "TEST-property", dateStart: "2026-09-01", dateEnd: "2026-09-30", timeZone: "UTC",
      attributionBasis: "SESSION_SOURCE_MEDIUM", conversionEvent: null, csv: "date,sessionSource,sessionMedium,sessions,clientId\n20260901,a,b,1,123\n" })
    expect(bad.status).toBe(409)
    expect(await bad.json()).toEqual({ _tag: "AcquisitionRefused", reason: "UnexpectedColumn", line: 1 })

    const reportRes = await call("GET", `${base(businessId)}/report`, a.session)
    expect(reportRes.status).toBe(200)
    expect(reportRes.headers.get("cache-control")).toBe("no-store")
    const { report } = await reportRes.json() as { report: { referrals: { provided: boolean; syntheticExcluded: number }; periods: unknown[] } }
    expect(report.referrals).toMatchObject({ provided: false, syntheticExcluded: 1 })
  })
  it("disables fixture sets and synthetic exports outside test and demo mode", async () => {
    const a = await agency()
    const businessId = await client(a.session)
    const previous = process.env["NODE_ENV"]
    process.env["NODE_ENV"] = "production"
    try {
      expect((await call("POST", `${base(businessId)}/question-sets`, a.session, setBody("FIXTURE"))).status).toBe(422)
      expect((await call("POST", `${base(businessId)}/referral-imports`, a.session, { dataOrigin: "SYNTHETIC_FIXTURE", propertyRef: "TEST", dateStart: "2026-09-01",
        dateEnd: "2026-09-30", timeZone: "UTC", attributionBasis: "SESSION_SOURCE_MEDIUM", conversionEvent: null, csv: "date,sessionSource,sessionMedium,sessions\n" })).status).toBe(422)
      await ok(call("POST", `${base(businessId)}/question-sets`, a.session, setBody("PUBLIC_RESEARCH")))
    } finally { process.env["NODE_ENV"] = previous }
  })
  it("exposes no public acquisition route", async () => {
    expect((await call("GET", "/api/public/acquisition/anything")).status).toBe(404)
    const routes = Chunk.toReadonlyArray(acquisitionApi(withSession).routes).map(r => r.path)
    expect(routes.every(p => p.startsWith("/api/acquisition/clients/:id"))).toBe(true)
  })
})
