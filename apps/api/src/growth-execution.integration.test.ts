// W7 connected execution over HTTP (fixture provider, no network): destination
// safety, authorization, tenancy, exact-change preparation and idempotency.
// Passing here is MOCK_ADAPTER_PASS. The worker side (dispatch, reconcile,
// recovery) is covered by apps/worker/src/execution.integration.test.ts.
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { HttpApp, HttpRouter } from "@effect/platform"
import { Effect, Exit, Layer, Redacted, Scope } from "effect"
import { PgClient } from "@effect/sql-pg"
import pg from "pg"
import type { ExecutionOperation, ExecutionTarget, GrowthOpportunity } from "@openrecord/contracts"
import { AcquisitionRepositoryLive, AuthRepositoryLive, RecordRepositoryLive } from "@openrecord/db"
import { executionPatchSha256, fixtureGitHub, fixtureGitHubLayer, gitBlobSha, sha256Text, removeNoindexFromHtml } from "@openrecord/site-operator"
import { growthExecutionApi } from "./growth-execution-routes.js"
import { growthApi } from "./growth-routes.js"
import { requireSession, RepoLayers } from "./router.js"
import { GROWTH_AGENT_TOOLS, growthProposalDeclarations } from "./agent-growth-tools.js"
import { dispatchToolSpec } from "./agent-registry.js"

const url = process.env["TEST_DATABASE_URL"] ?? ""
const PAGE = "pricing.html"
const LIVE = "https://salon.test/pricing.html"
const BEFORE = '<!doctype html>\n<html>\n<head>\n<title>Pricing</title>\n<meta name="robots" content="noindex">\n</head>\n<body>Pricing</body>\n</html>\n'
const AFTER = removeNoindexFromHtml(BEFORE)!
const product = { name: "TEST Fixture Salon", websiteUrl: "https://salon.test", engagement: "CLIENT", category: "TEST services", audience: "TEST locals", valueProposition: "TEST positioning", goalStatement: "Increase bookings",
  metric: { conversionKind: "BOOKING", label: "Bookings", sourceKind: "OPERATOR_AGGREGATE_EXPORT", sourceIdentity: "TEST booking system", eventName: null, reportingTimeZone: "UTC", propertyRef: null, countingSemantics: "EVENT_COUNT", unit: "COUNT", currency: null } }

const suite = url ? describe : describe.skip
suite("connected execution over HTTP (authorization, tenancy, exact change; fixture provider)", () => {
  let pool: pg.Pool, scope: Scope.CloseableScope
  const repos = Layer.mergeAll(RepoLayers.GrowthRepositoriesLive, RepoLayers.BusinessRepositoryLive, AuthRepositoryLive, RecordRepositoryLive, AcquisitionRepositoryLive,
    RepoLayers.FactRepositoryLive, RepoLayers.QuestionRepositoryLive, RepoLayers.DiscoveryScopeRepositoryLive,
    RepoLayers.ProductReadRepositoryLive, RepoLayers.AgentProposalRepositoryLive, RepoLayers.SetupRepositoryLive,
  ).pipe(Layer.provideMerge(PgClient.layer({ url: Redacted.make(url) })))
  type Provider = ReturnType<typeof makeProvider>
  /** One handler per provider setup; the provider layer is what a deployment would configure. */
  const handlers: Array<{ dispose: () => Promise<void> }> = []
  const handlerFor = (provider: Layer.Layer<never> | Layer.Layer<import("@openrecord/site-operator").GitHubExecution>) => {
    const web = HttpApp.toWebHandlerLayer(HttpRouter.concat(
      growthApi(run => Effect.flatMap(requireSession, ({ session }) => run(session))),
      growthExecutionApi(run => Effect.flatMap(requireSession, ({ session }) => run(session)))), Layer.provideMerge(provider as Layer.Layer<import("@openrecord/site-operator").GitHubExecution>, repos))
    handlers.push(web)
    return web.handler
  }
  beforeAll(async () => { pool = new pg.Pool({ connectionString: url }); scope = await Effect.runPromise(Scope.make()); await Effect.runPromise(Layer.buildWithScope(repos, scope)) })
  afterAll(async () => { for (const h of handlers) await h.dispose(); await Effect.runPromise(Scope.close(scope, Exit.void)); await pool.end() })

  const account = async () => {
    const accountId = String((await pool.query("INSERT INTO accounts(name) VALUES('TEST Exec API') RETURNING id", [])).rows[0].id)
    const userId = String((await pool.query("INSERT INTO users(email,password_hash) VALUES($1,'TEST-only') RETURNING id", [`exec-${randomUUID()}@example.test`])).rows[0].id)
    await pool.query("INSERT INTO account_users(account_id,user_id) VALUES($1,$2)", [accountId, userId])
    const cookie = String((await pool.query("INSERT INTO sessions(account_id,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour') RETURNING id", [accountId, userId])).rows[0].id)
    return { accountId, userId, cookie }
  }
  type Acct = Awaited<ReturnType<typeof account>>
  const setup = async (provider: Provider, opts: { allow?: boolean; extra?: Array<[string, string]> } = {}) => {
    const a = await account(), b = await account()
    const allow = new Set<string>([...(opts.allow === false ? [] : [`${a.accountId}:${provider.owner}/${provider.repo}`]), ...(opts.extra ?? []).map(([o, r]) => `${a.accountId}:${o}/${r}`)])
    const handler = handlerFor(fixtureGitHubLayer(provider.fixture, (o, r, acc) => allow.has(`${acc}:${o}/${r}`)))
    const call = (acct: Acct | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => handler(new Request(`http://localhost${path}`, {
      method, headers: { "content-type": "application/json", ...(acct ? { cookie: `or_session=${acct.cookie}` } : {}), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }))
    const ok = async <T>(r: Promise<Response>): Promise<T> => { const x = await r; if (x.status !== 200) throw new Error(`Expected 200, got ${x.status}: ${await x.text()}`); return await x.json() as T }
    const refusal = async (r: Promise<Response>) => { const x = await r; const j = await x.json().catch(() => ({})) as { reason?: string; _tag?: string }; return { status: x.status, reason: j.reason ?? j._tag } }
    const { profile } = await ok<{ profile: { businessId: string; primaryGoal: { id: string } } }>(call(a, "POST", "/api/growth/products", { ...product, idempotencyKey: randomUUID() }))
    const siteId = String((await pool.query("INSERT INTO site_targets(business_id,root_url,canonical_origin,path_prefix) VALUES($1,'https://salon.test/','https://salon.test','/') RETURNING id", [profile.businessId])).rows[0].id)
    const base = `/api/growth/clients/${profile.businessId}`
    return { a, b, call, ok, refusal, businessId: profile.businessId, goalId: profile.primaryGoal.id, siteId, base, provider }
  }
  type S = Awaited<ReturnType<typeof setup>>
  const makeProvider = () => {
    const owner = `salon-${randomUUID().slice(0, 8)}`, repo = "salon-site"
    const fixture = fixtureGitHub({ owner, repo, branch: "main", files: { [PAGE]: BEFORE, "about.html": "<html><body>About</body></html>\n", "plain.html": "<html><head><title>x</title></head><body>no directive</body></html>\n" } })
    return { owner, repo, fixture }
  }
  const connect = (s: S, over: Record<string, unknown> = {}) => s.call(s.a, "POST", `${s.base}/execution-targets`, { owner: s.provider.owner, repository: s.provider.repo, baseBranch: "main", siteTargetId: s.siteId, allowedPaths: ["pricing.html", "plain.html", "pages/"], idempotencyKey: randomUUID(), ...over })
  const opportunity = async (s: S, approve = true) => {
    const { opportunity: o } = await s.ok<{ opportunity: GrowthOpportunity }>(s.call(s.a, "POST", `${s.base}/opportunities`, { goalId: s.goalId, title: "TEST remove accidental noindex", problemStatement: "TEST pricing hidden", audience: "TEST", buyerIntent: "TEST",
      targetUrl: null, source: "TEST", proposedChange: "TEST remove noindex", expectedMechanism: "TEST", assumptions: "TEST", uncertainty: "TEST", baselineAvailability: "UNKNOWN", ownerUserId: s.a.userId, initialStatus: "PROPOSED", idempotencyKey: randomUUID(), evidence: [{ type: "OPERATOR_HYPOTHESIS", note: "TEST" }] }))
    if (approve) await s.ok(s.call(s.a, "POST", `${s.base}/opportunities/${o.id}/approve`, { expectedStatus: "PROPOSED", expectedRevision: 1, idempotencyKey: randomUUID(), reason: "TEST approve" }))
    return o.id
  }
  const targetOf = async (s: S) => (await s.ok<{ target: ExecutionTarget }>(connect(s))).target
  const prepareBody = (t: ExecutionTarget, over: Record<string, unknown> = {}) => ({ targetId: t.id, actionKind: "REMOVE_NOINDEX_META", filePath: PAGE, liveUrl: LIVE, rationale: "TEST remove an accidental noindex", siteFindingId: null, idempotencyKey: randomUUID(), ...over })
  const prepare = (s: S, oid: string, body: unknown) => s.call(s.a, "POST", `${s.base}/opportunities/${oid}/connected-executions`, body)

  it("lets the agent prepare page edits it wrote, refusing values that do not fit and canonicals on another site", async () => {
    const s = await setup(makeProvider()), t = await targetOf(s), oid = await opportunity(s)
    const provider = fixtureGitHubLayer(s.provider.fixture, (owner, repo, account) => account === s.a.accountId && owner === s.provider.owner && repo === s.provider.repo)
    const layer = Layer.provideMerge(provider, repos)
    const ctx = { accountId: s.a.accountId, userId: s.a.userId, businessId: s.businessId }
    const run = (name: string, args: unknown) => Effect.runPromise(Effect.either(dispatchToolSpec(ctx, name, args).pipe(Effect.provide(layer))))
    const base = { opportunityId: oid, targetId: t.id, filePath: PAGE, liveUrl: LIVE, siteFindingId: null }
    const reason = (r: Awaited<ReturnType<typeof run>>) => r._tag === "Left" ? (r.left as { reason?: string }).reason : "accepted"
    expect(reason(await run("prepare_page_change", { ...base, actionKind: "SET_TITLE", value: { description: "wrong field" }, rationale: "TEST" }))).toBe("InvalidRequest")
    expect(reason(await run("prepare_page_change", { ...base, actionKind: "SET_CANONICAL", value: { canonicalUrl: "https://elsewhere.test/pricing.html" }, rationale: "TEST" }))).toBe("InvalidRequest")
    expect(reason(await run("prepare_page_change", { ...base, actionKind: "SET_TITLE", value: { title: "Pricing" }, rationale: "TEST same title" }))).toBe("NotApplicable")
    const title = await run("prepare_page_change", { ...base, actionKind: "SET_TITLE", value: { title: "Salon prices & packages | Salon" }, rationale: "TEST clearer title" })
    expect(title._tag).toBe("Right")
    if (title._tag !== "Right") throw new Error("Title preparation failed")
    const data = title.right.data as { operationId: string; actionKind: string; diff: string }
    expect(data.actionKind).toBe("SET_TITLE")
    expect(data.diff).toContain("+<title>Salon prices &amp; packages | Salon</title>")
    expect(data.diff).toContain("-<title>Pricing</title>")
    const operation = (await s.ok<{ operation: ExecutionOperation }>(s.call(s.a, "GET", `${s.base}/connected-executions/${data.operationId}`))).operation
    expect(operation).toMatchObject({ state: "PREPARED", actionKind: "SET_TITLE", actionValue: { title: "Salon prices & packages | Salon" } })
    expect(s.provider.fixture.writes).toEqual([])
  })

  it("lets the agent prepare and read a scoped change without approving or writing to GitHub", async () => {
    const s = await setup(makeProvider()), t = await targetOf(s), oid = await opportunity(s)
    const provider = fixtureGitHubLayer(s.provider.fixture, (owner, repo, account) => account === s.a.accountId && owner === s.provider.owner && repo === s.provider.repo)
    const layer = Layer.provideMerge(provider, repos)
    const ctx = { accountId: s.a.accountId, userId: s.a.userId, businessId: s.businessId }
    const run = (name: string, args: unknown, who = ctx) => Effect.runPromise(Effect.either(dispatchToolSpec(who, name, args).pipe(Effect.provide(layer))))
    const args = { opportunityId: oid, targetId: t.id, actionKind: "REMOVE_NOINDEX_META", filePath: PAGE, liveUrl: LIVE, rationale: "TEST accidental noindex", siteFindingId: null }
    const first = await run("prepare_page_change", args)
    expect(first._tag).toBe("Right")
    if (first._tag !== "Right") throw new Error("Agent preparation failed")
    const operationId = (first.right.data as { operationId: string }).operationId
    const replay = await run("prepare_page_change", args)
    expect(replay._tag === "Right" && (replay.right.data as { operationId: string }).operationId).toBe(operationId)
    const operation = (await s.ok<{ operation: ExecutionOperation }>(s.call(s.a, "GET", `${s.base}/connected-executions/${operationId}`))).operation
    expect(operation).toMatchObject({ state: "PREPARED", proposedBy: "ASSISTANT", createdByUserId: s.a.userId })
    expect(operation.events[0]).toMatchObject({ actor: "ASSISTANT", state: "PREPARED" })
    expect(s.provider.fixture.writes).toEqual([])
    expect((await run("read_connected_executions", { opportunityId: oid }))._tag).toBe("Right")
    expect((await run("read_connected_executions", { opportunityId: oid }, { ...ctx, accountId: s.b.accountId, userId: s.b.userId }))._tag).toBe("Left")
    expect((await run("prepare_page_change", args, { ...ctx, accountId: s.b.accountId, userId: s.b.userId }))._tag).toBe("Left")
    expect((await run("authorize_connected_execution", { operationId }))._tag).toBe("Left")
    const approved = await s.ok<{ operation: ExecutionOperation }>(s.call(s.a, "POST", `${s.base}/connected-executions/${operationId}/authorize`, {
      reviewedPatchSha256: operation.patchSha256, expectedRevision: operation.revision, reason: "TEST human reviewed exact change", idempotencyKey: randomUUID(),
    }))
    expect(approved.operation.state).toBe("AUTHORIZED")
    expect(s.provider.fixture.writes).toEqual([])
  })

  it("prepares exactly the deterministic change, binds it to a patch hash and never exposes file bytes or credentials", async () => {
    const s = await setup(makeProvider()), t = await targetOf(s), oid = await opportunity(s)
    const body = prepareBody(t)
    const res = await prepare(s, oid, body)
    expect(res.headers.get("cache-control")).toBe("no-store")
    const text = await res.text(); expect(res.status, text).toBe(200)
    const { operation: op } = JSON.parse(text) as { operation: ExecutionOperation }
    const head = (await s.provider.fixture.transport.branchHead(s.provider.owner, s.provider.repo, "main"))!
    expect(op).toMatchObject({ state: "PREPARED", revision: 1, filePath: PAGE, liveUrl: LIVE, baseBranch: "main", owner: s.provider.owner, repository: s.provider.repo, baseCommitSha: head,
      baseBlobSha: gitBlobSha(BEFORE), beforeSha256: sha256Text(BEFORE), afterSha256: sha256Text(AFTER) })
    expect(op.patchSha256).toBe(executionPatchSha256({ actionKind: "REMOVE_NOINDEX_META", owner: s.provider.owner, repository: s.provider.repo, baseBranch: "main", baseCommitSha: head, filePath: PAGE, liveUrl: LIVE, beforeSha256: sha256Text(BEFORE), afterSha256: sha256Text(AFTER) }))
    expect(op.diff).toContain('-<meta name="robots" content="noindex">')
    expect(op.diff).not.toContain("\n+<meta")
    expect(text).not.toMatch(/bearer|ghp_|github_pat|token/i)
    expect(text).not.toContain("afterContent")
    expect(s.provider.fixture.writes).toEqual([])                       // preparing never writes to the provider
    // Replays return the same operation; a different request under the same key is refused; concurrent identical requests make one.
    const results = await Promise.all(Array.from({ length: 5 }, () => prepare(s, oid, body)))
    const ids = new Set<string>()
    for (const r of results) { expect(r.status).toBe(200); ids.add(((await r.json()) as { operation: ExecutionOperation }).operation.id) }
    expect(ids.size).toBe(1)
    expect(await s.refusal(prepare(s, oid, { ...body, rationale: "TEST something else" }))).toEqual({ status: 409, reason: "IdempotencyConflict" })
    // The listing shows the same operation to the account only.
    const list = await s.ok<{ operations: ExecutionOperation[] }>(s.call(s.a, "GET", `${s.base}/opportunities/${oid}/connected-executions`))
    expect(list.operations.map(o => o.id)).toContain([...ids][0])
    expect((await s.refusal(s.call(s.b, "GET", `${s.base}/opportunities/${oid}/connected-executions`))).status).toBe(404)
  })

  it("refuses what it cannot change safely: no directive, odd shapes, other pages, missing pages and an unconfigured provider", async () => {
    const s = await setup(makeProvider()), t = await targetOf(s)
    const oid = await opportunity(s)
    expect(await s.refusal(prepare(s, oid, prepareBody(t, { filePath: "plain.html", liveUrl: "https://salon.test/plain.html" })))).toEqual({ status: 409, reason: "NotApplicable" })
    expect(await s.refusal(prepare(s, oid, prepareBody(t, { filePath: "pages/missing.html" })))).toEqual({ status: 404, reason: "PageNotFound" })
    expect(await s.refusal(prepare(s, oid, prepareBody(t, { filePath: "about.html", liveUrl: "https://salon.test/about.html" })))).toEqual({ status: 409, reason: "PathNotPermitted" })
    expect(await s.refusal(prepare(s, oid, prepareBody(t, { liveUrl: "https://evil.test/pricing.html" })))).toEqual({ status: 409, reason: "LivePageOutsideSite" })
    expect(await s.refusal(prepare(s, oid, prepareBody(t, { filePath: "../secret.html" })))).toEqual({ status: 422, reason: "InvalidRequest" })
    expect(await s.refusal(prepare(s, oid, prepareBody(t, { filePath: ".github/index.html" })))).toEqual({ status: 422, reason: "InvalidRequest" })
    expect(await s.refusal(prepare(s, oid, prepareBody(t, { actionKind: "REWRITE_COPY" })))).toEqual({ status: 422, reason: "InvalidRequest" })
    expect(await s.refusal(prepare(s, oid, { ...prepareBody(t), extra: "field" }))).toEqual({ status: 422, reason: "InvalidRequest" })
    expect(await s.refusal(prepare(s, await opportunity(s, false), prepareBody(t)))).toEqual({ status: 409, reason: "InitiativeNotApproved" })
    expect(s.provider.fixture.writes).toEqual([])
    // With no provider configured nothing is simulated.
    const none = handlerFor(Layer.empty as never)
    const bare = await none(new Request(`http://localhost${s.base}/opportunities/${oid}/connected-executions`, { method: "POST", headers: { "content-type": "application/json", cookie: `or_session=${s.a.cookie}` }, body: JSON.stringify(prepareBody(t)) }))
    expect(bare.status).toBe(409); expect(((await bare.json()) as { reason: string }).reason).toBe("RepositoryNotPermitted")
  })

  it("lets an agent or stranger do nothing: only a signed-in account member can reach an execution route", async () => {
    const s = await setup(makeProvider()), t = await targetOf(s), oid = await opportunity(s)
    const op = ((await s.ok<{ operation: ExecutionOperation }>(prepare(s, oid, prepareBody(t)))).operation)
    const k = () => randomUUID()
    const routes: Array<[string, string, unknown]> = [
      ["GET", `${s.base}/execution-targets`, undefined], ["POST", `${s.base}/execution-targets`, { owner: s.provider.owner, repository: s.provider.repo, baseBranch: "main", siteTargetId: s.siteId, allowedPaths: ["pricing.html"], idempotencyKey: k() }],
      ["GET", `${s.base}/opportunities/${oid}/connected-executions`, undefined], ["POST", `${s.base}/opportunities/${oid}/connected-executions`, prepareBody(t)],
      ["GET", `${s.base}/connected-executions/${op.id}`, undefined],
      ["POST", `${s.base}/connected-executions/${op.id}/authorize`, { reviewedPatchSha256: op.patchSha256, expectedRevision: 1, reason: "TEST", idempotencyKey: k() }],
      ["POST", `${s.base}/connected-executions/${op.id}/dispatch`, { expectedRevision: 1, idempotencyKey: k() }],
      ["POST", `${s.base}/connected-executions/${op.id}/cancel`, { expectedRevision: 1, reason: "TEST", idempotencyKey: k() }],
      ["POST", `${s.base}/connected-executions/${op.id}/check`, { idempotencyKey: k() }], ["POST", `${s.base}/connected-executions/${op.id}/live-check`, { idempotencyKey: k() }],
    ]
    for (const [method, path, body] of routes) {
      expect((await s.call(null, method, path, body)).status, `anonymous ${method} ${path}`).toBe(401)
      expect((await s.call(s.b, method, path, body)).status, `foreign ${method} ${path}`).toBe(404)
      if (method === "POST") expect((await s.call(s.a, method, path, body, { origin: "https://evil.example" })).status, `cross-origin ${path}`).toBe(403)
    }
    // Nothing above changed the operation.
    expect((await s.ok<{ operation: ExecutionOperation }>(s.call(s.a, "GET", `${s.base}/connected-executions/${op.id}`))).operation).toMatchObject({ state: "PREPARED", revision: 1 })
    // The assistant's tool surface has no way to authorize, dispatch, merge or publish.
    const names = [...GROWTH_AGENT_TOOLS.map(d => d.name), ...growthProposalDeclarations.map(d => d.name)].join(" ")
    expect(names).not.toMatch(/authorize|dispatch|execute|merge|publish|approve|credential/i)
  })

  it("keeps the destination operator-controlled: allowlist, OpenRecord's own repository, other accounts and a re-check at dispatch", async () => {
    const provider = makeProvider()
    const s = await setup(provider, { extra: [["commonfields", "openrecord"]] })
    // Not on the allowlist: refused, whatever the operator types.
    expect(await s.refusal(connect(s, { repository: "someone-elses-site" }))).toEqual({ status: 409, reason: "RepositoryNotPermitted" })
    // OpenRecord's own repository is never a target, even when an allowlist names it.
    for (const [owner, repository] of [["commonfields", "openrecord"], ["CommonFields", "OpenRecord"]]) {
      expect(await s.refusal(connect(s, { owner, repository }))).toEqual({ status: 409, reason: "RepositoryNotPermitted" })
    }
    // Another account cannot connect the repository this account owns, even if its own allowlist named it.
    const t = await targetOf(s)
    expect(t).toMatchObject({ owner: provider.owner, repository: provider.repo, baseBranch: "main", provider: "GITHUB" })
    const foreign = await s.call(s.b, "POST", `${s.base}/execution-targets`, { owner: provider.owner, repository: provider.repo, baseBranch: "main", siteTargetId: s.siteId, allowedPaths: ["pricing.html"], idempotencyKey: randomUUID() })
    expect(foreign.status).toBe(404)
    // Path hygiene on the connection itself.
    for (const bad of ["notes.md", "../x.html", ".env", "a/../b.html"]) expect((await connect(s, { repository: "x", allowedPaths: [bad] })).status).toBe(422)
    // A dispatch re-checks the allowlist at that moment: a repository removed after preparation cannot be written.
    const oid = await opportunity(s)
    let op = (await s.ok<{ operation: ExecutionOperation }>(prepare(s, oid, prepareBody(t)))).operation
    op = (await s.ok<{ operation: ExecutionOperation }>(s.call(s.a, "POST", `${s.base}/connected-executions/${op.id}/authorize`, { reviewedPatchSha256: op.patchSha256, expectedRevision: 1, reason: "TEST reviewed", idempotencyKey: randomUUID() }))).operation
    const revoked = handlerFor(fixtureGitHubLayer(provider.fixture, () => false))
    const res = await revoked(new Request(`http://localhost${s.base}/connected-executions/${op.id}/dispatch`, { method: "POST", headers: { "content-type": "application/json", cookie: `or_session=${s.a.cookie}` }, body: JSON.stringify({ expectedRevision: op.revision, idempotencyKey: randomUUID() }) }))
    expect(res.status).toBe(409); expect(((await res.json()) as { reason: string }).reason).toBe("RepositoryNotPermitted")
    expect((await s.ok<{ operation: ExecutionOperation }>(s.call(s.a, "GET", `${s.base}/connected-executions/${op.id}`))).operation.state).toBe("AUTHORIZED")
  })

  it("binds authorization to the reviewed patch: a changed source gives a different patch, so an old approval cannot apply", async () => {
    const s = await setup(makeProvider()), t = await targetOf(s), oid = await opportunity(s)
    const first = (await s.ok<{ operation: ExecutionOperation }>(prepare(s, oid, prepareBody(t)))).operation
    // Someone changes the page on the base branch after review, and the operation is prepared again.
    expect((await s.call(s.a, "POST", `${s.base}/connected-executions/${first.id}/cancel`, { expectedRevision: 1, reason: "TEST page moved", idempotencyKey: randomUUID() })).status).toBe(200)
    s.provider.fixture.editBase(PAGE, BEFORE.replace("Pricing</body>", "Prices</body>"))
    const second = (await s.ok<{ operation: ExecutionOperation }>(prepare(s, oid, prepareBody(t)))).operation
    expect(second.patchSha256).not.toBe(first.patchSha256)
    expect(second.baseCommitSha).not.toBe(first.baseCommitSha)
    const auth = (body: Record<string, unknown>) => s.call(s.a, "POST", `${s.base}/connected-executions/${second.id}/authorize`, { reviewedPatchSha256: second.patchSha256, expectedRevision: 1, reason: "TEST reviewed", idempotencyKey: randomUUID(), ...body })
    expect(await s.refusal(auth({ reviewedPatchSha256: first.patchSha256 }))).toEqual({ status: 409, reason: "PatchMismatch" })
    expect(await s.refusal(auth({ expectedRevision: 3 }))).toEqual({ status: 409, reason: "StaleExecution" })
    const authorized = (await s.ok<{ operation: ExecutionOperation }>(auth({}))).operation
    expect(authorized.state).toBe("AUTHORIZED")
    expect(authorized.events.at(-1)!.detail["approvedPatchSha256"]).toBe(second.patchSha256)
    // Dispatch is the human trigger; it queues one durable job and writes nothing to the provider itself.
    const dispatchKey = randomUUID()
    const sent = await Promise.all([1, 2, 3].map(() => s.call(s.a, "POST", `${s.base}/connected-executions/${second.id}/dispatch`, { expectedRevision: 2, idempotencyKey: dispatchKey })))
    expect(sent.map(r => r.status)).toEqual([200, 200, 200])
    expect(Number((await pool.query("SELECT count(*) FROM growth_execution_jobs WHERE operation_id=$1 AND kind='DISPATCH'", [second.id])).rows[0].count)).toBe(1)
    expect(s.provider.fixture.writes).toEqual([])
    // A live check is refused until a merge was verified, and a manual provider check is refused when nothing is in flight.
    expect(await s.refusal(s.call(s.a, "POST", `${s.base}/connected-executions/${second.id}/live-check`, { idempotencyKey: randomUUID() }))).toEqual({ status: 409, reason: "TransitionRefused" })
    // The initiative cannot be finalized while the dispatch is unresolved.
    expect(await s.refusal(s.call(s.a, "POST", `${s.base}/opportunities/${oid}/approve`, { expectedStatus: "APPROVED", expectedRevision: 2, idempotencyKey: randomUUID(), reason: "x" }))).toBeTruthy()
    const cancel = await s.refusal(s.call(s.a, "POST", `${s.base}/opportunities/${oid}/cancel`, { expectedStatus: "APPROVED", expectedRevision: 2, idempotencyKey: randomUUID(), reason: "TEST cancel" }))
    expect(cancel).toEqual({ status: 409, reason: "ExecutionUnresolved" })
  })
})
