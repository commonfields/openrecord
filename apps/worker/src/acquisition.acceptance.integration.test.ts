// OPENRECORD_AI_ACQUISITION_PILOT_V1 acceptance, end to end through the real
// CheckRunner and the real Gemini grounding adapter, against a local HTTP
// server that plays Gemini with SYNTHETIC responses. No live provider call is
// made. Every agency, brand, reviewer and answer here is a labelled TEST
// fixture. Requires TEST_DATABASE_URL (CI provides postgres; skipped otherwise).
import { randomUUID } from "node:crypto"
import { createServer, type Server } from "node:http"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Effect, Layer, ManagedRuntime, Redacted, Schedule } from "effect"
import { PgClient } from "@effect/sql-pg"
import { NodeHttpClient } from "@effect/platform-node"
import pg from "pg"
import {
  ACQ_MAX_ATTEMPTS_PER_CHECK, AcquisitionRepository, AcquisitionRepositoryLive, CheckRunRepositoryLive, ObservationRepositoryLive,
  ProviderAttemptEvidenceRepositoryLive, QuestionRepositoryLive, RecordRepository, RecordRepositoryLive, acquisitionReport, acquisitionView, type Session,
} from "@openrecord/db"
import { GeminiSettings } from "@openrecord/config"
import { GeminiProviderLive, MockProviderLive, NineRouterProvider, ProviderRegistryLive, ProviderUnsupported } from "@openrecord/providers"
import { CheckRunner, MAX_PROVIDER_ATTEMPTS, makeCheckRunnerLive } from "./check-runner.js"

const url = process.env["TEST_DATABASE_URL"] ?? ""
const suite = url ? describe : describe.skip
const MODEL = "gemini-3.5-flash-lite"
const REDIRECT = "https://vertexaisearch.cloud.google.com/grounding-api-redirect/"

type Reply = { status: number; body: string }
const grounded = (text: string, titles: string[]): Reply => ({ status: 200, body: JSON.stringify({
  candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP", groundingMetadata: {
    webSearchQueries: ["TEST best support agents"], groundingChunks: titles.map((title, i) => ({ web: { uri: `${REDIRECT}TEST-${i}`, title } })),
    groundingSupports: [{ groundingChunkIndices: [0] }] } }],
  modelVersion: MODEL, responseId: `fixture-${randomUUID()}`,
}) })
const ungrounded = (text: string): Reply => ({ status: 200, body: JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }], modelVersion: MODEL }) })
const outage: Reply = { status: 503, body: "{}" }

it("the acquisition spend ceiling uses the worker's real attempt ceiling", () => {
  expect(ACQ_MAX_ATTEMPTS_PER_CHECK).toBe(MAX_PROVIDER_ATTEMPTS)
})

suite("AI acquisition acceptance (TEST agency, TEST brand, TEST reviewer)", () => {
  let pool: pg.Pool
  let server: Server
  const script = new Map<string, Reply[]>()
  const requests: string[] = []
  let runtime: ManagedRuntime.ManagedRuntime<AcquisitionRepository | RecordRepository | CheckRunner, unknown>

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url })
    server = createServer((req, res) => {
      let body = ""
      req.on("data", c => { body += c.toString() })
      req.on("end", () => {
        const parsed = JSON.parse(body) as { contents: Array<{ parts: Array<{ text: string }> }>; tools?: unknown[] }
        const prompt = parsed.contents[0]!.parts[0]!.text
        requests.push(`${prompt}|tools=${JSON.stringify(parsed.tools)}`)
        const reply = script.get(prompt)?.shift() ?? { status: 500, body: "{}" }
        res.writeHead(reply.status, { "content-type": "application/json" })
        res.end(reply.body)
      })
    })
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
    const port = (server.address() as { port: number }).port
    const PgLive = PgClient.layer({ url: Redacted.make(url) })
    const Repos = Layer.mergeAll(AcquisitionRepositoryLive, RecordRepositoryLive, CheckRunRepositoryLive, QuestionRepositoryLive, ObservationRepositoryLive,
      ProviderAttemptEvidenceRepositoryLive).pipe(Layer.provide(PgLive))
    const Gemini = GeminiProviderLive.pipe(Layer.provide(NodeHttpClient.layer), Layer.provide(Layer.succeed(GeminiSettings, {
      baseUrl: Redacted.make(`http://127.0.0.1:${port}/v1beta`), apiKey: Redacted.make("TEST-fixture-gemini-key"), model: MODEL, timeoutMs: 5000, responseMaxBytes: 1 << 20,
    })))
    const Providers = ProviderRegistryLive.pipe(Layer.provide(Layer.mergeAll(MockProviderLive, Gemini,
      Layer.succeed(NineRouterProvider, { observe: () => Effect.fail(new ProviderUnsupported({})) }))))
    const Runner = makeCheckRunnerLive(Schedule.recurs(0)).pipe(Layer.provide(Repos), Layer.provide(Providers))
    runtime = ManagedRuntime.make(Layer.mergeAll(Repos, Runner))
  })
  afterAll(async () => {
    await runtime.dispose(); await pool.end()
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
  })

  const acq = <A, E>(fn: (r: AcquisitionRepository["Type"]) => Effect.Effect<A, E>) => runtime.runPromise(Effect.flatMap(AcquisitionRepository, fn))
  const drain = async (businessId: string) => {
    for (let i = 0; i < 30; i++) if (!await runtime.runPromise(Effect.flatMap(CheckRunner, r => r.runOnce({ businessId })))) return
    throw new Error("TEST queue did not drain")
  }

  it("collects, preserves, reviews and reports one smoke batch through the existing worker", async () => {
    const accountId = (await pool.query("INSERT INTO accounts (name) VALUES ('TEST Agency') RETURNING id")).rows[0].id as string
    const userId = (await pool.query("INSERT INTO users (email, password_hash) VALUES ($1, 'TEST-only') RETURNING id", [`acq-acc-${randomUUID()}@example.test`])).rows[0].id as string
    await pool.query("INSERT INTO account_users (account_id, user_id) VALUES ($1, $2)", [accountId, userId])
    const session: Session = { accountId, userId }
    const { businessId } = await runtime.runPromise(Effect.flatMap(RecordRepository, r => r.createClient(session, { name: "TEST Supportly", websiteUrl: "https://supportly.test/", engagement: "FIXTURE" })))
    const tag = randomUUID().slice(0, 8)
    const q = (s: string) => `${s} (TEST ${tag})`
    const set = await acq(r => r.createQuestionSet(session, businessId, {
      basis: "FIXTURE", category: "TEST customer support agents",
      target: { name: "Supportly", aliases: [], domains: ["supportly.test"], matchCase: false, ambiguity: null },
      competitors: [{ name: "HelpHub", aliases: [], domains: ["helphub.test"], matchCase: false, ambiguity: null }],
      questions: [
        { group: "CATEGORY_DISCOVERY", prompt: q("What are the best AI support agents for a small online store?") },
        { group: "ALTERNATIVES", prompt: q("What should I use instead of HelpHub?") },
      ],
    }))
    const [cd, al] = set.questions
    script.set(cd!.prompt, [
      grounded("1. **Supportly** answers email and chat for small stores.\n2. HelpHub is popular with larger teams.", ["supportly.test", "helphub.test"]),
      ungrounded("Supportly is not suitable when you need phone support."),
    ])
    script.set(al!.prompt, [grounded("Consider Desko or Nimbus instead of HelpHub.", ["reviews.test"]), outage])

    const batch = await acq(r => r.startBatch(session, businessId, { setId: set.id, scope: "SMOKE", questionKeys: [cd!.key, al!.key], samples: 2,
      provider: "gemini", requestedModel: MODEL, acknowledgedMaxProviderCalls: 2 * 2 * ACQ_MAX_ATTEMPTS_PER_CHECK }))
    await drain(businessId)

    // Every request asked the frozen prompt with Google Search grounding.
    const mine = requests.filter(r => r.includes(tag))
    expect(mine).toHaveLength(4)
    expect(mine.every(r => r.endsWith(`tools=[{"google_search":{}}]`))).toBe(true)

    let view = acquisitionView((await acq(r => r.snapshot(businessId)))!)
    const checks = view.checks.filter(c => c.batchId === batch.id)
    expect(checks.map(c => [c.questionKey, c.sample, c.status])).toEqual([[cd!.key, 1, "SUCCEEDED"], [cd!.key, 2, "SUCCEEDED"], [al!.key, 1, "SUCCEEDED"], [al!.key, 2, "FAILED"]])
    const failed = checks.find(c => c.status === "FAILED")!
    expect(failed).toMatchObject({ failureClass: "PROVIDER_UNAVAILABLE", observation: null, attempts: 1 })

    const first = checks[0]!.observation!
    expect(first).toMatchObject({ provider: "gemini", requestedModel: MODEL, observedModel: MODEL, retrievalRequested: true, retrievalObserved: true,
      retrievalTool: "google_search", synthetic: false, searchQueries: ["TEST best support agents"] })
    expect(first.answerText).toContain("**Supportly** answers email")
    expect(first.rawDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(first.citations.map(c => [c.domain, c.domainBasis, c.owner, c.support])).toEqual([
      ["supportly.test", "PROVIDER_TITLE", "OWNED", "NOT_VERIFIED"], ["helphub.test", "PROVIDER_TITLE", "COMPETITOR", "NOT_VERIFIED"]])
    // Requested retrieval is not observed retrieval.
    expect(checks[1]!.observation).toMatchObject({ retrievalRequested: true, retrievalObserved: false })
    expect(checks[0]!.candidates.find(m => m.role === "TARGET")!.hints).toContain("LIST")
    expect(checks[1]!.candidates.find(m => m.role === "TARGET")!.hints).toContain("NEGATIVE_CUE")
    expect(checks[2]!.candidates.filter(m => m.role === "TARGET")).toEqual([])

    // Before review: candidates exist, confirmed counts are zero.
    let m = view.batches.find(b => b.id === batch.id)!.metrics
    expect(m).toMatchObject({ planned: 4, succeeded: 3, failed: 1, eligible: 3, providerAttempts: 4 })
    expect(m.candidateSamples).toEqual({ n: 2, d: 3 })
    expect(m.mentionRate).toEqual({ n: 0, d: 3 })
    expect(m.recommendationRate).toEqual({ n: 0, d: 0 })

    // Human review, one decision per answer.
    const decide = (i: number, mention: "MENTIONED" | "NOT_MENTIONED", recommendation: "RECOMMENDED" | "ADVISED_AGAINST" | null) =>
      acq(r => r.judge(session, businessId, { observationId: checks[i]!.observation!.id, mention, recommendation, note: null }))
    await decide(0, "MENTIONED", "RECOMMENDED")
    await decide(1, "MENTIONED", "ADVISED_AGAINST")
    await decide(2, "NOT_MENTIONED", null)

    view = acquisitionView((await acq(r => r.snapshot(businessId)))!)
    m = view.batches.find(b => b.id === batch.id)!.metrics
    expect(m.mentionRate).toEqual({ n: 2, d: 3 })
    expect(m.recommendationRate).toEqual({ n: 1, d: 3 })
    expect(m.ownedCitationRate).toEqual({ n: 1, d: 3 })
    expect(m.groundingObserved).toEqual({ n: 2, d: 3 })
    expect(m.competitors).toEqual([{ name: "HelpHub", samples: { n: 2, d: 3 } }])
    expect(m.questions.map(x => x.statement)).toEqual(["Recommended in 1 of 2 reviewed samples", "Recommended in 0 of 1 reviewed sample (1 failed)"])

    const report = acquisitionReport((await acq(r => r.snapshot(businessId)))!)
    expect(report.periods).toHaveLength(1)
    expect(report.periods[0]!.surface).toBe(`Gemini API with Google Search grounding (${MODEL})`)
    expect(report.periods[0]!.representative.map(x => x.recommendation)).toEqual(["RECOMMENDED", "ADVISED_AGAINST", null])
    expect(report.referrals.provided).toBe(false)
    expect(report.limitations.join(" ")).toMatch(/1 of 4 planned samples failed/)
  })
})
