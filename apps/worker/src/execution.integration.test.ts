// W7 connected execution, worker side: the runner against a fixture GitHub (an
// in-memory stand-in) and a stub live-site transport. Passing here is
// MOCK_ADAPTER_PASS: it shows the modeled provider behavior, not a live
// provider. TEST fixtures only; no network.
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Context, Effect, Exit, Layer, Redacted, Scope } from "effect"
import { PgClient } from "@effect/sql-pg"
import pg from "pg"
import { executionFacts, type ExecutionOperation, type GrowthMetricDefinitionInput } from "@openrecord/contracts"
import {
  GrowthExecutionRepository, GrowthRepositoriesLive, GrowthRepository, GrowthEvaluationRepository, GrowthReportRepository, executionRequestFingerprint,
  RecordRepository, RecordRepositoryLive, type PreparedExecution, type Session,
} from "@openrecord/db"
import {
  GitHubExecution, executionPatchSha256, fixtureGitHub, fixtureGitHubLayer, gitBlobSha, inspectPage, removeNoindexFromHtml, sha256Text,
} from "@openrecord/site-operator"
import { diffLines, unifiedDiff } from "@openrecord/contracts"
import type { HttpTransport } from "@openrecord/representation"
import { ExecutionRunner, executionBackoffSeconds, makeExecutionRunnerLive } from "./execution-runner.js"

const url = process.env["TEST_DATABASE_URL"] ?? ""
const metric: GrowthMetricDefinitionInput = { conversionKind: "BOOKING", label: "Bookings", sourceKind: "OPERATOR_AGGREGATE_EXPORT", sourceIdentity: "TEST booking system", eventName: null, countingSemantics: "EVENT_COUNT", unit: "COUNT", currency: null, reportingTimeZone: "UTC", propertyRef: null }
const details = { category: "TEST services", audience: "TEST locals", valueProposition: "TEST positioning", goalStatement: "Increase bookings", metric }
const PAGE = "pricing.html"
const LIVE = "https://salon.test/pricing.html"
const BEFORE = '<!doctype html>\n<html>\n<head>\n<title>Pricing</title>\n<meta name="robots" content="noindex">\n</head>\n<body>Pricing</body>\n</html>\n'
const AFTER = removeNoindexFromHtml(BEFORE)!
const enc = new TextEncoder()
const liveSite = (html: string | null, status = 200): HttpTransport => ({
  lookup: async () => ["93.184.216.34"],
  fetch: async () => {
    if (html === null) throw new Error("connection refused")
    return { status, headers: { "content-type": "text/html" }, body: enc.encode(html), peerIp: "93.184.216.34" }
  },
})

const suite = url ? describe : describe.skip
suite("connected execution runner against a fixture provider (MOCK_ADAPTER_PASS, TEST fixtures)", () => {
  type Repos = GrowthRepository | GrowthExecutionRepository | GrowthEvaluationRepository | GrowthReportRepository | RecordRepository
  let pool: pg.Pool, scope: Scope.CloseableScope, ctx: Context.Context<Repos>
  const PgLive = () => PgClient.layer({ url: Redacted.make(url) })
  const run = async <A, E>(fx: Effect.Effect<A, E, Repos>): Promise<A> => {
    const r = await Effect.runPromise(Effect.either(Effect.provide(fx, ctx)))
    if (r._tag === "Left") throw r.left
    return r.right
  }
  const exec = <A>(f: (r: Context.Tag.Service<GrowthExecutionRepository>) => Effect.Effect<A, any, never>) => run(Effect.flatMap(GrowthExecutionRepository, r => f(r) as Effect.Effect<A, unknown, never>))
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url }); scope = await Effect.runPromise(Scope.make())
    ctx = await Effect.runPromise(Layer.buildWithScope(Layer.mergeAll(GrowthRepositoriesLive, RecordRepositoryLive).pipe(Layer.provide(PgLive())), scope)) as unknown as Context.Context<Repos>
  })
  afterAll(async () => { await Effect.runPromise(Scope.close(scope, Exit.void)); await pool.end() })

  const fixture = async () => {
    const accountId = String((await pool.query("INSERT INTO accounts(name) VALUES('TEST exec worker') RETURNING id")).rows[0].id)
    const userId = String((await pool.query("INSERT INTO users(email,password_hash) VALUES($1,'TEST-only') RETURNING id", [`exec-${randomUUID()}@example.test`])).rows[0].id)
    await pool.query("INSERT INTO account_users(account_id,user_id) VALUES($1,$2)", [accountId, userId])
    const session: Session = { accountId, userId }
    const profile = await run(Effect.flatMap(GrowthRepository, r => r.registerProduct(session, { name: "TEST Salon", websiteUrl: "https://salon.test", engagement: "CLIENT", ...details, idempotencyKey: randomUUID() })))
    const siteId = String((await pool.query("INSERT INTO site_targets(business_id,root_url,canonical_origin,path_prefix) VALUES($1,'https://salon.test/','https://salon.test','/') RETURNING id", [profile.businessId])).rows[0].id)
    const owner = `salon-${randomUUID().slice(0, 8)}`, repo = "salon-site"
    const gh = fixtureGitHub({ owner, repo, branch: "main", files: { [PAGE]: BEFORE, "about.html": "<html><body>About</body></html>\n" } })
    const target = await exec(r => r.connectTarget(session, profile.businessId, { owner, repository: repo, baseBranch: "main", siteTargetId: siteId, allowedPaths: ["pricing.html", "pages/"], idempotencyKey: randomUUID() }))
    return { session, accountId, businessId: profile.businessId, goalId: profile.primaryGoal.id, siteId, owner, repo, gh, target }
  }
  type F = Awaited<ReturnType<typeof fixture>>
  const opportunity = async (f: F) => {
    const o = await run(Effect.flatMap(GrowthRepository, r => r.create(f.session, f.businessId, "OPERATOR", { goalId: f.goalId, title: "TEST remove accidental noindex", problemStatement: "TEST pricing page is hidden from search",
      audience: "TEST locals", buyerIntent: "Find prices", targetUrl: LIVE, source: "TEST", proposedChange: "Remove the noindex directive", expectedMechanism: "Let the page be indexed",
      assumptions: "TEST", uncertainty: "TEST", baselineAvailability: "UNKNOWN", ownerUserId: f.session.userId, initialStatus: "PROPOSED", idempotencyKey: randomUUID(), evidence: [{ type: "OPERATOR_HYPOTHESIS", note: "TEST" }] })))
    await run(Effect.flatMap(GrowthRepository, r => r.decide(f.session, f.businessId, o.id, "APPROVED", { expectedStatus: "PROPOSED", expectedRevision: 1, idempotencyKey: randomUUID(), reason: "TEST approve" })))
    return o.id
  }
  /** What the API's prepare does: read the provider, apply the deterministic transform, bind the exact change. */
  const plan = async (f: F, over: Partial<PreparedExecution> = {}): Promise<PreparedExecution> => {
    const baseCommitSha = (await f.gh.transport.branchHead(f.owner, f.repo, "main"))!
    const diff = unifiedDiff(PAGE, diffLines(BEFORE, AFTER))
    return { targetId: f.target.id, actionKind: "REMOVE_NOINDEX_META", actionValue: null, filePath: PAGE, liveUrl: LIVE, siteFindingId: null, baseBranch: "main", baseCommitSha, baseBlobSha: gitBlobSha(BEFORE), afterBlobSha: gitBlobSha(AFTER),
      beforeSha256: sha256Text(BEFORE), afterSha256: sha256Text(AFTER),
      patchSha256: executionPatchSha256({ actionKind: "REMOVE_NOINDEX_META", owner: f.owner, repository: f.repo, baseBranch: "main", baseCommitSha, filePath: PAGE, liveUrl: LIVE, beforeSha256: sha256Text(BEFORE), afterSha256: sha256Text(AFTER) }),
      afterContent: AFTER, diff, rationale: "TEST remove an accidental noindex", idempotencyKey: randomUUID(), ...over }
  }
  const authorized = async (f: F, oid?: string, over: Partial<PreparedExecution> = {}) => {
    const id = oid ?? await opportunity(f)
    const p = await plan(f, over)
    const fp = executionRequestFingerprint({ opportunityId: id, targetId: p.targetId, actionKind: p.actionKind, filePath: p.filePath, liveUrl: p.liveUrl, rationale: p.rationale, siteFindingId: p.siteFindingId })
    let op = await exec(r => r.prepare(f.session, f.businessId, id, fp, p))
    op = await exec(r => r.authorize(f.session, f.businessId, op.id, { reviewedPatchSha256: op.patchSha256, expectedRevision: op.revision, reason: "TEST reviewed the diff", idempotencyKey: randomUUID() }))
    return { oid: id, op }
  }
  const dispatched = async (f: F, over: Partial<PreparedExecution> = {}) => {
    const a = await authorized(f, undefined, over)
    const op = await exec(r => r.dispatch(f.session, f.businessId, a.op.id, { expectedRevision: a.op.revision, idempotencyKey: randomUUID() }))
    return { oid: a.oid, op }
  }
  const runnerFor = async (f: F, ids: string[], opts: { live?: HttpTransport; maxAttempts?: number; workerId?: string; allowed?: boolean; now?: () => number } = {}) => {
    const allowed = opts.allowed ?? true
    const live = makeExecutionRunnerLive({ ...(opts.live ? { transport: opts.live } : {}), operationIds: ids, workerId: opts.workerId ?? `w-${randomUUID().slice(0, 6)}`, maxAttempts: opts.maxAttempts ?? 3,
      reconcilePollSeconds: 0, liveCheckDelaySeconds: 0, leaseSeconds: 60, ...(opts.now ? { now: opts.now } : {}) })
    const execRepo = (await Effect.runPromise(Effect.provide(GrowthExecutionRepository, ctx)))
    const built = await Effect.runPromise(Layer.buildWithScope(live.pipe(Layer.provide(Layer.mergeAll(Layer.succeed(GrowthExecutionRepository, execRepo), fixtureGitHubLayer(f.gh, (o, r, a) => allowed && o === f.owner && r === f.repo && a === f.accountId)))), scope))
    const runner = Context.get(built, ExecutionRunner)
    return { once: () => Effect.runPromise(runner.runOnce()), steps: async (n: number) => { for (let i = 0; i < n; i++) await Effect.runPromise(runner.runOnce()) } }
  }
  const get = (f: F, op: ExecutionOperation) => exec(r => r.get(f.accountId, f.businessId, op.id))
  const settle = async (f: F, op: ExecutionOperation, runner: Awaited<ReturnType<typeof runnerFor>>, until: (o: ExecutionOperation) => boolean, max = 12) => {
    let cur = await get(f, op)
    for (let i = 0; i < max && !until(cur); i++) { await runner.once(); cur = await get(f, op) }
    return cur
  }
  const receipts = async (op: ExecutionOperation) => Number((await pool.query("SELECT count(*) FROM interventions WHERE verification_id=$1", [op.id])).rows[0].count)

  it("Scenario A: one authorized change becomes one pull request, one verified merge and one linked receipt; the live site is a separate fact", async () => {
    const f = await fixture()
    // Detect the issue with the real page classifier. The finding row is a labelled fixture: the shared site-inspection
    // runner claims any queued run in a shared database, so it is not driven from here.
    const classified = inspectPage({ url: LIVE, finalUrl: LIVE, status: 200, contentType: "text/html", redirectChain: [LIVE], headers: {}, html: BEFORE, failure: null })
    const derived = classified.findings.find(x => x.findingKind === "BLOCKED_BY_META")
    expect(derived, "the inspector finds the noindex").toBeTruthy()
    const runId = String((await pool.query("INSERT INTO site_inspection_runs(business_id,site_target_id,state,completed_at) VALUES($1,$2,'SUCCEEDED',now()) RETURNING id", [f.businessId, f.siteId])).rows[0].id)
    const finding = (await pool.query(`INSERT INTO site_findings(business_id,site_target_id,run_id,url,canonical_url,finding_kind,severity,category,evidence,diagnosis,recommended_action,confidence,identity_key)
      VALUES($1,$2,$3,$4,$4,'BLOCKED_BY_META',$5,$6,$7::jsonb,$8,$9,$10,$11) RETURNING id,url`, [f.businessId, f.siteId, runId, derived!.url, derived!.severity, derived!.category, JSON.stringify(derived!.evidence), derived!.diagnosis, derived!.recommendedAction, derived!.confidence, randomUUID()])).rows[0]
    const oid = await opportunity(f)
    const p = await plan(f, { siteFindingId: finding.id as string, liveUrl: String(finding.url) })
    const fp = executionRequestFingerprint({ opportunityId: oid, targetId: p.targetId, actionKind: p.actionKind, filePath: p.filePath, liveUrl: p.liveUrl, rationale: p.rationale, siteFindingId: p.siteFindingId })
    let op = await exec(r => r.prepare(f.session, f.businessId, oid, fp, p))
    expect(op.siteFindingId).toBe(finding.id)
    op = await exec(r => r.authorize(f.session, f.businessId, op.id, { reviewedPatchSha256: op.patchSha256, expectedRevision: op.revision, reason: "TEST reviewed", idempotencyKey: randomUUID() }))
    op = await exec(r => r.dispatch(f.session, f.businessId, op.id, { expectedRevision: op.revision, idempotencyKey: randomUUID() }))
    const runner = await runnerFor(f, [op.id], { live: liveSite(BEFORE) })
    // 1. dispatch opens exactly one pull request carrying exactly the authorized bytes
    await runner.once()
    op = await get(f, op)
    expect(op.state).toBe("AWAITING_MERGE")
    expect(f.gh.prs).toHaveLength(1)
    expect(f.gh.writes).toEqual([`branch:openrecord/exec-${op.id}`, `commit:openrecord/exec-${op.id}:${PAGE}`, "pr:1"])
    expect(f.gh.branches.get(`openrecord/exec-${op.id}`)!.files.get(PAGE)).toBe(AFTER)
    expect(f.gh.branches.get("main")!.files.get(PAGE)).toBe(BEFORE)                 // OpenRecord never touches the base branch
    expect(f.gh.prs[0]!.body).toContain(op.patchSha256)
    expect(executionFacts(op)).toEqual({ request: "ACCEPTED_BY_PROVIDER", providerAction: "NOT_VERIFIED", liveChange: "NOT_CHECKED" })
    // 2. open and unmerged: nothing is verified, however often it is polled
    await runner.steps(3)
    op = await get(f, op)
    expect(op.state).toBe("AWAITING_MERGE")
    expect(await receipts(op)).toBe(0)
    expect((await run(Effect.flatMap(GrowthRepository, r => r.get(f.accountId, f.businessId, oid)))).executionCount).toBe(0)
    // 3. the maintainer merges; reconciliation confirms it from provider evidence
    f.gh.merge(1, { mergedAt: "2026-10-20T09:30:00.000Z" })
    op = await settle(f, op, runner, o => o.state === "VERIFIED")
    expect(op.state).toBe("VERIFIED")
    expect(await receipts(op)).toBe(1)
    expect(op.receipt).toMatchObject({ claim: "PR_MERGED", pullRequestUrl: `https://github.com/${f.owner}/${f.repo}/pull/1` })
    expect(Date.parse(op.receipt!.mergedAt)).toBe(Date.parse("2026-10-20T09:30:00.000Z"))
    expect(op.evidence.map(e => e.kind)).toEqual(expect.arrayContaining(["BRANCH_READY", "COMMIT_CREATED", "PR_OPENED", "PR_MERGE_CONFIRMED"]))
    // Polling again changes nothing: one receipt.
    await runner.steps(3)
    expect(await receipts(op)).toBe(1)
    // 4. the initiative's ledger shows exactly the verified claim, and the initiative's human lifecycle is untouched
    const initiative = await run(Effect.flatMap(GrowthRepository, r => r.get(f.accountId, f.businessId, oid)))
    expect(initiative.status).toBe("APPROVED")
    expect(initiative.executions).toHaveLength(1)
    expect(initiative.executions[0]).toMatchObject({ assurance: "SYSTEM_VERIFIED", type: "SOURCE_UPDATED", channel: "WEBSITE", verification: { kind: "GROWTH_DELIVERY", claim: "PR_MERGED" } })
    expect(initiative.executions[0]!.type).not.toBe("SOURCE_PUBLISHED")
    // 5. the live site is checked separately: still noindex means "not observed", and the verified merge stands
    op = await settle(f, op, runner, o => o.liveChecks.length >= 1)
    expect(op.liveChecks[0]).toMatchObject({ result: "CHANGE_NOT_OBSERVED", url: LIVE })
    expect(executionFacts(op)).toEqual({ request: "ACCEPTED_BY_PROVIDER", providerAction: "VERIFIED", liveChange: "NOT_OBSERVED" })
    expect(op.state).toBe("VERIFIED")
    // Later, the deployment goes out: a new observation says observed; history keeps both.
    const deployed = await runnerFor(f, [op.id], { live: liveSite(AFTER) })
    await exec(r => r.requestLiveCheck(f.session, f.businessId, op.id, { idempotencyKey: randomUUID() }))
    op = await settle(f, op, deployed, o => o.liveChecks.length >= 2)
    expect(op.liveChecks.map(c => c.result)).toEqual(["CHANGE_OBSERVED", "CHANGE_NOT_OBSERVED"])
    expect(executionFacts(op).liveChange).toBe("OBSERVED")
    // A broken or unreachable site is inconclusive, never a success.
    const down = await runnerFor(f, [op.id], { live: liveSite(null) })
    await exec(r => r.requestLiveCheck(f.session, f.businessId, op.id, { idempotencyKey: randomUUID() }))
    op = await settle(f, op, down, o => o.liveChecks.length >= 3)
    expect(op.liveChecks[0]!.result).toBe("INCONCLUSIVE")
    expect(executionFacts(op).liveChange).toBe("INCONCLUSIVE")
    const notFound = await runnerFor(f, [op.id], { live: liveSite("<html>gone</html>", 404) })
    await exec(r => r.requestLiveCheck(f.session, f.businessId, op.id, { idempotencyKey: randomUUID() }))
    op = await settle(f, op, notFound, o => o.liveChecks.length >= 4)
    expect(op.liveChecks[0]).toMatchObject({ result: "INCONCLUSIVE", httpStatus: 404 })
    // 6. W4 and W5 carry the distinction: a verified merge, never a publication or an outcome.
    const evaluation = await run(Effect.flatMap(GrowthEvaluationRepository, r => r.evaluate(f.accountId, f.businessId, oid)))
    const action = evaluation.actions.find(a => a.assurance === "SYSTEM_VERIFIED")
    expect(action).toMatchObject({ type: "SOURCE_UPDATED", channel: "WEBSITE", association: "THIS_INITIATIVE", verification: { kind: "GROWTH_DELIVERY", claim: "PR_MERGED" } })
    expect(JSON.stringify(evaluation)).not.toMatch(/live change observed|is live|SOURCE_PUBLISHED/i)
    const preview = await run(Effect.flatMap(GrowthReportRepository, r => r.preview(f.accountId, f.businessId, oid)))
    expect(preview.snapshot.evaluation.actions.some(a => a.assurance === "SYSTEM_VERIFIED")).toBe(true)
  })

  it("Scenario B: a timeout after the pull request was created is reconciled, not repeated", async () => {
    const f = await fixture(), { op: queued } = await dispatched(f)
    const runner = await runnerFor(f, [queued.id])
    f.gh.failNext("createPullRequest", "TIMEOUT", { after: true })           // the provider created it, the response was lost
    await runner.once()
    let op = await get(f, queued)
    expect(op.state).toBe("UNKNOWN")
    expect(op.evidence.some(e => e.kind === "DISPATCH_UNCERTAIN")).toBe(true)
    expect(executionFacts(op).providerAction).toBe("NOT_VERIFIED")
    await runner.once()                                                       // reconcile finds the existing pull request
    op = await get(f, queued)
    expect(op.state).toBe("AWAITING_MERGE")
    expect(f.gh.prs).toHaveLength(1)
    expect(f.gh.writes.filter(w => w.startsWith("pr:"))).toHaveLength(1)
    expect(op.evidence.filter(e => e.kind === "PR_OPENED")).toHaveLength(1)
  })

  it("Scenario B: a timeout after the commit, before the pull request, resumes without a second commit", async () => {
    const f = await fixture(), { op: queued } = await dispatched(f)
    const runner = await runnerFor(f, [queued.id])
    f.gh.failNext("putFile", "TIMEOUT", { after: true })
    await runner.once()
    expect((await get(f, queued)).state).toBe("UNKNOWN")
    await runner.once()                                                       // nothing opened: safe to dispatch again
    expect((await get(f, queued)).state).toBe("DISPATCHING")
    await runner.once()
    const op = await get(f, queued)
    expect(op.state).toBe("AWAITING_MERGE")
    expect(f.gh.writes.filter(w => w.startsWith("commit:"))).toHaveLength(1)
    expect(f.gh.writes.filter(w => w.startsWith("pr:"))).toHaveLength(1)
    expect(f.gh.writes.filter(w => w.startsWith("branch:openrecord"))).toHaveLength(1)
  })

  it("Scenario B: a stuck outcome stops honestly after bounded reconciliation", async () => {
    const f = await fixture(), { op: queued } = await dispatched(f)
    const runner = await runnerFor(f, [queued.id])
    for (let i = 0; i < 3; i++) { f.gh.failNext("createBranch", "TIMEOUT", { after: true }); await runner.steps(3) }
    const op = await get(f, queued)
    expect(["BLOCKED", "UNKNOWN", "DISPATCHING", "AWAITING_MERGE"]).toContain(op.state)
    expect(op.state === "BLOCKED" ? op.events.at(-1)!.detail["code"] : "RETRIES_EXHAUSTED").toBe("RETRIES_EXHAUSTED")
    expect(f.gh.prs.length).toBeLessThanOrEqual(1)
  })

  it("Scenario B: provider refusals are permanent, rate limits and outages back off and recover", async () => {
    // 401: permanent
    let f = await fixture(); let d = await dispatched(f); let runner = await runnerFor(f, [d.op.id])
    f.gh.failNext("branchHead", "AUTH"); await runner.once()
    let op = await get(f, d.op)
    expect(op).toMatchObject({ state: "FAILED" }); expect(op.events.at(-1)!.detail["code"]).toBe("PROVIDER_AUTH")
    expect(f.gh.writes).toEqual([])
    // 404: permanent
    f = await fixture(); d = await dispatched(f); runner = await runnerFor(f, [d.op.id])
    f.gh.failNext("branchHead", "NOT_FOUND"); await runner.once()
    op = await get(f, d.op); expect(op.state).toBe("FAILED"); expect(op.events.at(-1)!.detail["code"]).toBe("PROVIDER_NOT_FOUND")
    // rate limit: stays dispatching, the job is delayed by the provider's hint, then proceeds
    f = await fixture(); d = await dispatched(f); runner = await runnerFor(f, [d.op.id])
    f.gh.failNext("branchHead", "RATE_LIMITED", { retryAfter: 90 }); await runner.once()
    op = await get(f, d.op); expect(op.state).toBe("DISPATCHING")
    const job = (await pool.query("SELECT status,not_before>now()+interval '60 seconds' AS later,last_error,attempt_count FROM growth_execution_jobs WHERE operation_id=$1 AND kind='DISPATCH'", [d.op.id])).rows[0]
    expect(job).toMatchObject({ status: "QUEUED", later: true, last_error: "RATE_LIMITED", attempt_count: 1 })
    expect(await runner.once()).toBe(false)                                  // not due yet
    await pool.query("UPDATE growth_execution_jobs SET not_before=now() WHERE operation_id=$1", [d.op.id])
    await runner.once(); expect((await get(f, d.op)).state).toBe("AWAITING_MERGE")
    // 5xx on a read: transient, then recovers; exhaustion without any write fails closed and says nothing was written
    f = await fixture(); d = await dispatched(f); runner = await runnerFor(f, [d.op.id], { maxAttempts: 2 })
    for (let i = 0; i < 2; i++) { f.gh.failNext("branchHead", "UNAVAILABLE"); await runner.once(); await pool.query("UPDATE growth_execution_jobs SET not_before=now() WHERE operation_id=$1 AND status='QUEUED'", [d.op.id]) }
    op = await get(f, d.op); expect(op.state).toBe("FAILED"); expect(op.events.at(-1)!.detail["code"]).toBe("RETRIES_EXHAUSTED")
    expect(f.gh.writes).toEqual([])
    expect(executionBackoffSeconds(1, null)).toBe(15); expect(executionBackoffSeconds(20, null)).toBe(600)
  })

  it("Scenario B: closed, edited, wrong-target and over-broad pull requests never satisfy the authorization", async () => {
    // closed without merge
    let f = await fixture(); let d = await dispatched(f); let runner = await runnerFor(f, [d.op.id])
    await runner.once(); f.gh.close(1)
    let op = await settle(f, d.op, runner, o => o.state === "FAILED")
    expect(op.events.at(-1)!.detail["code"]).toBe("PR_CLOSED_WITHOUT_MERGE"); expect(await receipts(op)).toBe(0)
    expect(op.evidence.some(e => e.kind === "PR_CLOSED_UNMERGED")).toBe(true)
    // changed after it was opened, still open
    f = await fixture(); d = await dispatched(f); runner = await runnerFor(f, [d.op.id])
    await runner.once(); f.gh.editPrBranch(1, PAGE, AFTER + "<!-- sneaky -->")
    op = await settle(f, d.op, runner, o => o.state === "BLOCKED")
    expect(op.events.at(-1)!.detail["code"]).toBe("PR_CONTENT_CHANGED"); expect(await receipts(op)).toBe(0)
    // changed, then merged: the merge is real but it is not the approved change
    f = await fixture(); d = await dispatched(f); runner = await runnerFor(f, [d.op.id])
    await runner.once(); f.gh.editPrBranch(1, PAGE, AFTER + "<!-- sneaky -->"); f.gh.merge(1)
    op = await settle(f, d.op, runner, o => o.state === "BLOCKED")
    expect(op.events.at(-1)!.detail["code"]).toBe("MERGED_CONTENT_DIFFERS"); expect(await receipts(op)).toBe(0)
    expect(executionFacts(op).providerAction).toBe("NOT_VERIFIED")
    // an extra file rides along
    f = await fixture(); d = await dispatched(f); runner = await runnerFor(f, [d.op.id])
    await runner.once(); f.gh.editPrBranch(1, "about.html", "<html>changed</html>"); f.gh.merge(1)
    op = await settle(f, d.op, runner, o => o.state === "BLOCKED")
    expect(op.events.at(-1)!.detail["code"]).toBe("MERGED_CONTENT_DIFFERS")
    expect(await receipts(op)).toBe(0)
    // targets another repository
    f = await fixture(); d = await dispatched(f); runner = await runnerFor(f, [d.op.id])
    await runner.once(); f.gh.setBaseRepository(1, "someone-else/salon-site"); f.gh.merge(1)
    op = await settle(f, d.op, runner, o => o.state === "BLOCKED")
    expect(op.events.at(-1)!.detail["code"]).toBe("PR_WRONG_TARGET"); expect(await receipts(op)).toBe(0)
    // a merge that reports no commit cannot verify
    f = await fixture(); d = await dispatched(f); runner = await runnerFor(f, [d.op.id])
    await runner.once(); f.gh.merge(1); f.gh.prs[0]!.mergeCommitSha = null
    op = await settle(f, d.op, runner, o => o.state === "BLOCKED")
    expect(op.events.at(-1)!.detail["code"]).toBe("MERGED_CONTENT_DIFFERS"); expect(await receipts(op)).toBe(0)
  })

  it("stops following a pull request nobody merges, so the initiative is not held forever", async () => {
    const f = await fixture(), d = await dispatched(f)
    await (await runnerFor(f, [d.op.id])).once()
    expect((await get(f, d.op)).state).toBe("AWAITING_MERGE")
    const runner = await runnerFor(f, [d.op.id], { now: () => Date.now() + 31 * 86_400_000 })   // a month later
    const op = await settle(f, d.op, runner, o => o.state === "BLOCKED")
    expect(op.events.at(-1)!.detail["code"]).toBe("MERGE_WINDOW_EXPIRED")
    expect(await receipts(op)).toBe(0)
    const decided = await run(Effect.flatMap(GrowthRepository, r => r.decide(f.session, f.businessId, d.oid, "CANCELLED", { expectedStatus: "APPROVED", expectedRevision: 2, idempotencyKey: randomUUID(), reason: "TEST cancel" })))
    expect(decided.status).toBe("CANCELLED")
  })

  it("Scenario C: a changed source, an expired authorization, a disallowed repository and a cancelled initiative stop the write", async () => {
    // the source moved after review
    let f = await fixture(); let d = await dispatched(f); let runner = await runnerFor(f, [d.op.id])
    f.gh.editBase(PAGE, BEFORE + "<!-- edited elsewhere -->")
    await runner.once()
    let op = await get(f, d.op)
    expect(op.state).toBe("BLOCKED"); expect(op.events.at(-1)!.detail["code"]).toBe("SOURCE_CHANGED"); expect(f.gh.writes).toEqual([])
    // an unrelated file moved the base branch: the approved page is intact, so the approved change proceeds from the approved base
    f = await fixture(); d = await dispatched(f); runner = await runnerFor(f, [d.op.id])
    f.gh.editBase("about.html", "<html>new about</html>")
    await runner.once(); op = await get(f, d.op)
    expect(op.state).toBe("AWAITING_MERGE")
    // the repository was removed from the allowlist after approval
    f = await fixture(); d = await dispatched(f); runner = await runnerFor(f, [d.op.id], { allowed: false })
    await runner.once(); op = await get(f, d.op)
    expect(op.state).toBe("BLOCKED"); expect(op.events.at(-1)!.detail["code"]).toBe("REPOSITORY_NOT_PERMITTED"); expect(f.gh.writes).toEqual([])
    // the authorization expired between dispatch and the worker
    f = await fixture(); const oid = await opportunity(f); const p = await plan(f)
    const fp = executionRequestFingerprint({ opportunityId: oid, targetId: p.targetId, actionKind: p.actionKind, filePath: p.filePath, liveUrl: p.liveUrl, rationale: p.rationale, siteFindingId: null })
    let prepared = await exec(r => r.prepare(f.session, f.businessId, oid, fp, p))
    await pool.query("INSERT INTO growth_execution_events(operation_id,business_id,revision,state,actor,user_id,reason,detail) VALUES($1,$2,2,'AUTHORIZED','OPERATOR',$3,'x',$4::jsonb)",
      [prepared.id, f.businessId, f.session.userId, JSON.stringify({ approvedPatchSha256: prepared.patchSha256, expiresAt: new Date(Date.now() + 1_500).toISOString() })])
    prepared = await exec(r => r.dispatch(f.session, f.businessId, prepared.id, { expectedRevision: 2, idempotencyKey: randomUUID() }))
    await new Promise(r => setTimeout(r, 1_800))
    runner = await runnerFor(f, [prepared.id]); await runner.once()
    op = await get(f, prepared)
    expect(op.state).toBe("BLOCKED"); expect(op.events.at(-1)!.detail["code"]).toBe("AUTHORIZATION_EXPIRED"); expect(f.gh.writes).toEqual([])
    // the provider is not configured at all: the operation is refused, never simulated
    f = await fixture(); d = await dispatched(f)
    const bare = makeExecutionRunnerLive({ operationIds: [d.op.id], reconcilePollSeconds: 0 })
    const execRepo = await Effect.runPromise(Effect.provide(GrowthExecutionRepository, ctx))
    const bareRunner = Context.get(await Effect.runPromise(Layer.buildWithScope(bare.pipe(Layer.provide(Layer.mergeAll(Layer.succeed(GrowthExecutionRepository, execRepo), Layer.succeed(GitHubExecution, { transport: null, allowed: () => true })))), scope)), ExecutionRunner)
    await Effect.runPromise(bareRunner.runOnce()); op = await get(f, d.op)
    expect(op.state).toBe("BLOCKED"); expect(op.events.at(-1)!.detail["code"]).toBe("NOT_CONFIGURED")
  })

  it("Scenario C: two workers racing on one operation write once", async () => {
    const f = await fixture(), { op: queued } = await dispatched(f)
    const a = await runnerFor(f, [queued.id], { workerId: "worker-a" }), b = await runnerFor(f, [queued.id], { workerId: "worker-b" })
    const [x, y] = await Promise.all([a.once(), b.once()])
    expect([x, y].filter(Boolean)).toHaveLength(1)
    const op = await get(f, queued)
    expect(op.state).toBe("AWAITING_MERGE")
    expect(f.gh.writes).toEqual([`branch:openrecord/exec-${op.id}`, `commit:openrecord/exec-${op.id}:${PAGE}`, "pr:1"])
  })

  it("Scenario B: a worker that dies mid-write is replaced without duplicate writes, even after the provider merged", async () => {
    const f = await fixture(), { op: queued } = await dispatched(f)
    // The first worker claims, creates the branch and the commit, then dies: its lease is never renewed.
    const dead = await exec(r => r.claimJob("dead-worker", 60, [queued.id]))
    expect(dead?.kind).toBe("DISPATCH")
    const branch = `openrecord/exec-${queued.id}`, head = (await f.gh.transport.branchHead(f.owner, f.repo, "main"))!
    await f.gh.transport.createBranch(f.owner, f.repo, branch, head)
    await f.gh.transport.putFile(f.owner, f.repo, { path: PAGE, branch, content: AFTER, expectedBlobSha: gitBlobSha(BEFORE), message: "x" })
    const live = await runnerFor(f, [queued.id])
    expect(await live.once()).toBe(false)                                     // the dead worker's lease still holds the job
    await pool.query("UPDATE growth_execution_jobs SET lease_expires_at=now()-interval '1 second' WHERE operation_id=$1", [queued.id])
    await live.once()
    let op = await get(f, queued)
    expect(op.state).toBe("AWAITING_MERGE")
    expect(f.gh.writes.filter(w => w.startsWith("commit:"))).toHaveLength(1)
    expect(f.gh.writes.filter(w => w.startsWith("pr:"))).toHaveLength(1)
    // Now the provider merges while the reconciler dies after observing the merge, before the ledger update.
    f.gh.merge(1)
    await exec(r => r.claimJob("dead-reconciler", 60, [queued.id]))
    await exec(r => r.transition(queued.id, f.businessId, "RECONCILING", "Merge observed", { mergeObserved: true }))
    await pool.query("UPDATE growth_execution_jobs SET lease_expires_at=now()-interval '1 second' WHERE operation_id=$1 AND status='CLAIMED'", [queued.id])
    op = await settle(f, queued, live, o => o.state === "VERIFIED")
    expect(op.state).toBe("VERIFIED"); expect(await receipts(op)).toBe(1)
    // A worker that dies after the receipt was written but before it closed the job changes nothing on replay.
    await pool.query("UPDATE growth_execution_jobs SET status='QUEUED',claimed_by=NULL,lease_expires_at=NULL WHERE id IN (SELECT id FROM growth_execution_jobs WHERE operation_id=$1 AND kind='RECONCILE' ORDER BY created_at DESC LIMIT 1) AND status<>'DONE'", [queued.id])
    await live.steps(3)
    expect(await receipts(op)).toBe(1)
    expect((await get(f, op)).state).toBe("VERIFIED")
  })

  it("repairs an operation that lost its job to a crash between a state change and the next enqueue", async () => {
    const f = await fixture(), { op: queued } = await dispatched(f)
    const runner = await runnerFor(f, [queued.id])
    await runner.once()
    expect((await get(f, queued)).state).toBe("AWAITING_MERGE")
    // The worker died after moving to AWAITING_MERGE but before the reconcile job existed: close every open job.
    await pool.query("UPDATE growth_execution_jobs SET status='DONE',claimed_by=NULL,lease_expires_at=NULL WHERE operation_id=$1 AND status<>'DONE'", [queued.id])
    expect(await runner.once()).toBe(false)                                  // nothing to claim: the operation would be silently stuck
    const queuedBefore = Number((await pool.query("SELECT count(*) FROM growth_execution_jobs WHERE operation_id=$1 AND status='QUEUED'", [queued.id])).rows[0].count)
    expect(queuedBefore).toBe(0)
    expect(await exec(r => r.repairJobs())).toBeGreaterThanOrEqual(1)
    expect(Number((await pool.query("SELECT count(*) FROM growth_execution_jobs WHERE operation_id=$1 AND status='QUEUED' AND kind='RECONCILE'", [queued.id])).rows[0].count)).toBe(1)
    expect(await exec(r => r.repairJobs())).toBe(0)                           // idempotent: no duplicate
    f.gh.merge(1)
    const op = await settle(f, queued, runner, o => o.state === "VERIFIED")
    expect(op.state).toBe("VERIFIED"); expect(await receipts(op)).toBe(1)
  })

  it("Scenario C: a final initiative decision waits for an unresolved execution and then preserves the truth", async () => {
    const f = await fixture(), d = await dispatched(f), runner = await runnerFor(f, [d.op.id])
    await runner.once()
    const decide = (status: "REVIEWED" | "CANCELLED") => run(Effect.flatMap(GrowthRepository, r => status === "REVIEWED"
      ? r.review(f.session, f.businessId, d.oid, { expectedStatus: "APPROVED", expectedRevision: 2, idempotencyKey: randomUUID(), reason: "TEST decide", conclusion: "KEEP" })
      : r.decide(f.session, f.businessId, d.oid, "CANCELLED", { expectedStatus: "APPROVED", expectedRevision: 2, idempotencyKey: randomUUID(), reason: "TEST cancel" })))
    await expect(decide("CANCELLED")).rejects.toMatchObject({ reason: "ExecutionUnresolved" })
    await expect(decide("REVIEWED")).rejects.toMatchObject({ reason: "ExecutionUnresolved" })
    f.gh.merge(1)
    const op = await settle(f, d.op, runner, o => o.state === "VERIFIED")
    expect(op.state).toBe("VERIFIED")
    // The merge happened despite the pending cancellation request, and the record says so: the initiative can now be reviewed with the receipt in place.
    const reviewed = await decide("REVIEWED")
    expect(reviewed.status).toBe("REVIEWED")
    expect(reviewed.executions.some(e => e.assurance === "SYSTEM_VERIFIED")).toBe(true)
  })

  it("a published report does not change when execution evidence is reconciled later", async () => {
    const f = await fixture(), d = await dispatched(f), runner = await runnerFor(f, [d.op.id])
    await runner.once()
    const before = await run(Effect.flatMap(GrowthReportRepository, r => r.preview(f.accountId, f.businessId, d.oid)))
    await pool.query("INSERT INTO growth_measurement_plans(opportunity_id,business_id,metric_definition_id,baseline_start,baseline_end,observation_start,observation_end,declared_by_user_id,request_key,declared_at) SELECT $1,$2,g.metric_definition_id,'2026-09-01','2026-09-07','2026-09-09','2026-09-15',$3,$4,'2026-08-25T00:00:00Z' FROM growth_goals g WHERE g.id=$5",
      [d.oid, f.businessId, f.session.userId, randomUUID(), f.goalId])
    const preview = await run(Effect.flatMap(GrowthReportRepository, r => r.preview(f.accountId, f.businessId, d.oid)))
    const published = await run(Effect.flatMap(GrowthReportRepository, r => r.publish(f.session, f.businessId, d.oid, { idempotencyKey: randomUUID(), expectedLatestVersion: preview.latestVersion, evidenceDigest: preview.evidenceDigest, nextSteps: null })))
    const frozen = await pool.query("SELECT snapshot_text FROM growth_reports WHERE id=$1", [published.report.id])
    expect(before.snapshot.evaluation.actions.some(a => a.assurance === "SYSTEM_VERIFIED")).toBe(false)
    f.gh.merge(1)
    await settle(f, d.op, runner, o => o.state === "VERIFIED")
    const again = await pool.query("SELECT snapshot_text FROM growth_reports WHERE id=$1", [published.report.id])
    expect(again.rows[0].snapshot_text).toBe(frozen.rows[0].snapshot_text)
    expect(again.rows[0].snapshot_text).not.toContain("SYSTEM_VERIFIED")
    // A newer report is a new version that does include the verified merge, and says nothing about the live site.
    const next = await run(Effect.flatMap(GrowthReportRepository, r => r.preview(f.accountId, f.businessId, d.oid)))
    expect(next.latestVersion).toBe(1)
    expect(next.snapshot.evaluation.actions.some(a => a.assurance === "SYSTEM_VERIFIED")).toBe(true)
    expect(JSON.stringify(next.snapshot)).not.toMatch(/liveCheck|CHANGE_OBSERVED/)
  })

  it("never leaks credentials into stored evidence or events", async () => {
    const f = await fixture(), d = await dispatched(f), runner = await runnerFor(f, [d.op.id])
    f.gh.failNext("createBranch", "AUTH")
    await runner.once()
    const op = await get(f, d.op)
    const text = JSON.stringify([op.events, op.evidence])
    expect(text).not.toMatch(/bearer|ghp_|github_pat|authorization|token/i)
  })
})
