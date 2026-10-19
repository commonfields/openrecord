import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { HttpApp, HttpRouter } from "@effect/platform"
import { Context, Effect, Exit, Layer, Redacted, Scope } from "effect"
import { PgClient } from "@effect/sql-pg"
import pg from "pg"
import { AcquisitionRepositoryLive, AuthRepositoryLive, RecordRepositoryLive, type Session } from "@openrecord/db"
import type { GrowthDelivery, GrowthOpportunity, GrowthProfile } from "@openrecord/contracts"
import { growthApi } from "./growth-routes.js"
import { growthDeliveryApi } from "./growth-delivery-routes.js"
import { requireSession, RepoLayers } from "./router.js"
import { dispatchAgentTool } from "./agent.js"
import type { AgentToolDeps } from "./agent-tools.js"
import { GitHubDelivery, fixtureGitHub, type GitHubTransport } from "./github-delivery.js"

// P2 acceptance on a disposable database with a fixture GitHub transport.
// No request leaves the process: every GitHub write is recorded by the fixture.

const url = process.env["TEST_DATABASE_URL"] ?? ""
const HOME = "---\ntitle: Fixture Notes\n---\n\n# Notes for teams\n\nWrite notes together.\n\n[Start free](/signup)\n"
const product = { name: "TEST Delivery product", websiteUrl: "https://delivery.test", engagement: "DOGFOOD", category: "TEST SaaS", audience: "TEST operators",
  valueProposition: "TEST positioning",
  primaryGoal: { kind: "TRIAL_SIGNUPS", analyticsSource: "GA4_AGGREGATE_EXPORT", eventName: "trial_signup", countingSemantics: "EVENT_COUNT", reportingTimeZone: "UTC", propertyRef: null } }

const suite = url ? describe : describe.skip
suite("growth delivery through a fixture GitHub transport (no external writes)", () => {
  let pool: pg.Pool, scope: Scope.CloseableScope, ctx: Context.Context<AgentToolDeps>
  // Each test swaps in its own fixture repository, allowlist and token state.
  // A repository belongs to one account, so every fixture uses its own.
  let repo = "site"
  let gh = fixtureGitHub({ owner: "acme", repo, branch: "main", files: {} })
  let allowed: (owner: string, repo: string, accountId: string) => boolean = () => false
  let configured = true
  const delegating = new Proxy({} as GitHubTransport, { get: (_, key: keyof GitHubTransport) => (...args: unknown[]) => (gh.transport[key] as (...a: unknown[]) => unknown)(...args) })
  const githubLayer = Layer.succeed(GitHubDelivery, { get transport() { return configured ? delegating : null }, allowed: (o: string, r: string, a: string) => allowed(o, r, a) })
  const repos = Layer.mergeAll(
    AuthRepositoryLive, RecordRepositoryLive, AcquisitionRepositoryLive, githubLayer,
    RepoLayers.GrowthRepositoryLive, RepoLayers.GrowthDeliveryRepositoryLive, RepoLayers.AgentProposalRepositoryLive, RepoLayers.BusinessRepositoryLive,
    RepoLayers.DiscoveryScopeRepositoryLive, RepoLayers.FactRepositoryLive, RepoLayers.ProductReadRepositoryLive, RepoLayers.QuestionRepositoryLive,
  ).pipe(Layer.provideMerge(PgClient.layer({ url: Redacted.make(url) })))
  const withSession = <A, E, R>(run: (s: Session) => Effect.Effect<A, E, R>) => Effect.flatMap(requireSession, ({ session }) => run(session))
  const web = HttpApp.toWebHandlerLayer(HttpRouter.concat(growthApi(withSession), growthDeliveryApi(withSession)), repos)
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: url }); scope = await Effect.runPromise(Scope.make())
    ctx = await Effect.runPromise(Layer.buildWithScope(repos, scope))
  })
  afterAll(async () => { await web.dispose(); await Effect.runPromise(Scope.close(scope, Exit.void)); await pool.end() })

  const call = (method: string, path: string, cookie?: string, body?: unknown, headers = {}) => web.handler(new Request(`http://localhost${path}`, {
    method, headers: { "content-type": "application/json", ...(cookie ? { cookie: `or_session=${cookie}` } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }))
  const json = async <T>(r: Response | Promise<Response>, status = 200): Promise<T> => {
    const res = await r
    const text = await res.text()
    if (res.status !== status) throw new Error(`Expected ${status}, got ${res.status}: ${text}`)
    return JSON.parse(text) as T
  }
  const fixture = async (files: Record<string, string> = { "content/home.md": HOME }) => {
    const accountId = String((await pool.query("INSERT INTO accounts(name) VALUES('TEST Delivery') RETURNING id")).rows[0].id)
    const userId = String((await pool.query("INSERT INTO users(email,password_hash) VALUES($1,'TEST-only') RETURNING id", [`delivery-${randomUUID()}@example.test`])).rows[0].id)
    await pool.query("INSERT INTO account_users(account_id,user_id) VALUES($1,$2)", [accountId, userId])
    const cookie = String((await pool.query("INSERT INTO sessions(account_id,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour') RETURNING id", [accountId, userId])).rows[0].id)
    const { profile } = await json<{ profile: GrowthProfile }>(call("POST", "/api/growth/products", cookie, { ...product, idempotencyKey: randomUUID() }))
    repo = `site-${randomUUID().slice(0, 8)}`
    gh = fixtureGitHub({ owner: "acme", repo, branch: "main", files })
    allowed = (o, r, a) => o === "acme" && r === repo && a === accountId
    configured = true
    return { session: { accountId, userId } satisfies Session, cookie, profile, path: `/api/growth/clients/${profile.businessId}` }
  }
  type F = Awaited<ReturnType<typeof fixture>>
  const approvedOpportunity = async (f: F, title = "TEST headline names the outcome") => {
    const { opportunity } = await json<{ opportunity: GrowthOpportunity }>(call("POST", `${f.path}/opportunities`, f.cookie, {
      goalId: f.profile.primaryGoal.id, title, problemStatement: "Headline describes the editor, not the outcome", audience: "TEST operators",
      buyerIntent: "Stop losing action items", targetUrl: "https://delivery.test/", source: "TEST operator review", proposedChange: "Rewrite the hero headline",
      expectedMechanism: "Visitors recognise the problem faster", assumptions: "Visitors read the hero", uncertainty: "No baseline yet", baselineAvailability: "UNKNOWN",
      initialStatus: "PROPOSED", ownerUserId: f.session.userId, idempotencyKey: randomUUID(), evidence: [{ type: "OPERATOR_HYPOTHESIS", note: "TEST hypothesis" }],
    }))
    const { opportunity: approved } = await json<{ opportunity: GrowthOpportunity }>(call("POST", `${f.path}/opportunities/${opportunity.id}/approve`, f.cookie,
      { expectedStatus: "PROPOSED", expectedRevision: 1, idempotencyKey: randomUUID(), reason: "TEST approve" }))
    return approved
  }
  const connect = (f: F, extra: Record<string, unknown> = {}) => call("POST", `${f.path}/delivery-targets`, f.cookie,
    { owner: "acme", repository: repo, baseBranch: "main", allowedPaths: ["content/"], idempotencyKey: randomUUID(), ...extra })
  const prepare = (f: F, opportunityId: string, targetId: string, extra: Record<string, unknown> = {}) => call("POST", `${f.path}/opportunities/${opportunityId}/deliveries`, f.cookie, {
    targetId, filePath: "content/home.md", edits: [{ find: "# Notes for teams", replace: "# Meetings that turn into tasks" }],
    rationale: "Lead with the outcome buyers want", assumptions: "Trial signups are tracked as trial_signup", idempotencyKey: randomUUID(), ...extra,
  })
  const approve = (f: F, d: GrowthDelivery, approve = true, patch = d.patchSha256) => call("POST", `${f.path}/deliveries/${d.id}/decision`, f.cookie,
    { approve, reviewedPatchSha256: patch, expectedRevision: d.revision, reason: approve ? "TEST reviewed diff" : "TEST not this wording", idempotencyKey: randomUUID() })
  const openPr = (f: F, d: GrowthDelivery, key = randomUUID()) => call("POST", `${f.path}/deliveries/${d.id}/pull-request`, f.cookie, { idempotencyKey: key })
  const opportunityOf = async (f: F, id: string) => (await json<{ opportunity: GrowthOpportunity }>(call("GET", `${f.path}/opportunities/${id}`, f.cookie))).opportunity
  const ready = async (f: F) => {
    const o = await approvedOpportunity(f)
    const { target } = await json<{ target: { id: string } }>(connect(f))
    const { delivery } = await json<{ delivery: GrowthDelivery }>(prepare(f, o.id, target.id))
    const { delivery: approved } = await json<{ delivery: GrowthDelivery }>(approve(f, delivery))
    return { o, target, delivery: approved }
  }

  it("connects only an allowlisted repository for this account, never without a configured token", async () => {
    const f = await fixture()
    allowed = () => false
    expect(await json(connect(f), 403)).toMatchObject({ reason: "RepositoryNotAuthorized" })
    allowed = (o, r, a) => o === "acme" && r === repo && a === f.session.accountId
    configured = false
    expect(await json(connect(f), 503)).toMatchObject({ reason: "DeliveryNotConfigured" })
    configured = true
    expect(await json(connect(f, { repository: "missing" }), 403)).toMatchObject({ reason: "RepositoryNotAuthorized" })
    expect(await json(connect(f, { baseBranch: "release" }), 422)).toMatchObject({ reason: "BaseBranchNotFound" })
    for (const allowedPaths of [["/"], [".github/workflows/"], ["package.json"], ["../"]]) expect((await connect(f, { allowedPaths })).status).toBe(422)
    const key = randomUUID()
    const first = await json<{ target: { id: string } }>(connect(f, { idempotencyKey: key }))
    expect((await json<{ target: { id: string } }>(connect(f, { idempotencyKey: key }))).target.id).toBe(first.target.id)
    // Another account cannot use the same repository, even when allowlisted for it.
    const taken = repo
    const other = await fixture()
    allowed = () => true
    gh = fixtureGitHub({ owner: "acme", repo: taken, branch: "main", files: { "content/home.md": HOME } })
    expect(await json(connect(other, { repository: taken }), 403)).toMatchObject({ reason: "RepositoryInAnotherAccount" })
    expect(gh.writes).toEqual([])
  })

  it("prepares an exact reviewable change only for approved opportunities and allowed content files", async () => {
    const f = await fixture({ "content/home.md": HOME, "package.json": "{}", "content/../secret.md": "x" })
    const o = await approvedOpportunity(f)
    const { target } = await json<{ target: { id: string } }>(connect(f))
    for (const filePath of ["package.json", "../content/home.md", ".github/workflows/x.md", "content/../secret.md"]) {
      expect((await prepare(f, o.id, target.id, { filePath })).status).toBe(422)
    }
    expect(await json(prepare(f, o.id, target.id, { filePath: "README.md" }), 422)).toMatchObject({ reason: "PathNotAllowed" })
    expect(await json(prepare(f, o.id, target.id, { filePath: "content/missing.md" }), 422)).toMatchObject({ reason: "SourceNotFound" })
    expect(await json(prepare(f, o.id, target.id, { edits: [{ find: "Pricing", replace: "x" }] }), 422)).toMatchObject({ reason: "EditNotFound" })
    expect(await json(prepare(f, o.id, target.id, { edits: [{ find: "e", replace: "x" }] }), 422)).toMatchObject({ reason: "EditAmbiguous" })
    const key = randomUUID()
    const { delivery } = await json<{ delivery: GrowthDelivery }>(prepare(f, o.id, target.id, { idempotencyKey: key }))
    expect(delivery).toMatchObject({ state: "DRAFTED", proposedBy: "OPERATOR", filePath: "content/home.md", revision: 1 })
    expect(delivery.diff).toContain("-# Notes for teams")
    expect(delivery.diff).toContain("+# Meetings that turn into tasks")
    expect(delivery.diff).not.toContain("Start free")
    // Replay reads nothing from GitHub and returns the same draft.
    gh.editBase("content/home.md", "changed")
    expect((await json<{ delivery: GrowthDelivery }>(prepare(f, o.id, target.id, { idempotencyKey: key }))).delivery.id).toBe(delivery.id)
    // A proposed opportunity cannot be delivered.
    const { opportunity: proposed } = await json<{ opportunity: GrowthOpportunity }>(call("POST", `${f.path}/opportunities`, f.cookie, {
      goalId: f.profile.primaryGoal.id, title: "TEST unapproved", problemStatement: "x", audience: "x", buyerIntent: "x", targetUrl: "https://delivery.test/",
      source: "x", proposedChange: "x", expectedMechanism: "x", assumptions: "x", uncertainty: "x", baselineAvailability: "UNKNOWN",
      initialStatus: "PROPOSED", ownerUserId: f.session.userId, idempotencyKey: randomUUID(), evidence: [{ type: "OPERATOR_HYPOTHESIS", note: "x" }] }))
    expect(await json(prepare(f, proposed.id, target.id), 409)).toMatchObject({ reason: "OpportunityNotApproved" })
    expect(gh.writes).toEqual([])
  })

  it("rejects one proposal with no external write, approves only the reviewed patch, and opens exactly one pull request", async () => {
    const f = await fixture()
    const o = await approvedOpportunity(f)
    const { target } = await json<{ target: { id: string } }>(connect(f))
    const { delivery: first } = await json<{ delivery: GrowthDelivery }>(prepare(f, o.id, target.id))
    const { delivery: rejected } = await json<{ delivery: GrowthDelivery }>(approve(f, first, false))
    expect(rejected.state).toBe("REJECTED")
    expect(await json(openPr(f, rejected), 409)).toMatchObject({ reason: "NotApprovedForPullRequest" })
    expect(gh.writes).toEqual([])

    const { delivery: second } = await json<{ delivery: GrowthDelivery }>(prepare(f, o.id, target.id, { edits: [{ find: "[Start free](/signup)", replace: "[Start your free trial](/signup)" }] }))
    expect(await json(approve(f, second, true, "0".repeat(64)), 409)).toMatchObject({ reason: "ReviewedPatchMismatch" })
    expect(await json(openPr(f, second), 409)).toMatchObject({ reason: "NotApprovedForPullRequest" })
    const { delivery: approved } = await json<{ delivery: GrowthDelivery }>(approve(f, second))
    expect(approved.state).toBe("APPROVED_FOR_PR")
    expect(gh.writes).toEqual([])

    const key = randomUUID()
    const opened = await json<{ delivery: GrowthDelivery; outcome: string }>(openPr(f, approved, key))
    expect(opened.outcome).toBe("OPENED")
    expect(opened.delivery.state).toBe("PR_OPENED")
    expect(gh.writes).toEqual([`branch:openrecord/growth-${approved.id}`, `commit:openrecord/growth-${approved.id}:content/home.md`, "pr:1"])
    expect(gh.branches.get(`openrecord/growth-${approved.id}`)!.files.get("content/home.md")).toBe(HOME.replace("[Start free](/signup)", "[Start your free trial](/signup)"))
    expect(gh.prs[0]!.body).toContain("OpenRecord does not merge or deploy it")
    expect((await opportunityOf(f, o.id)).status).toBe("IN_DELIVERY")
    // Replays, with the same key or a new one, never write again.
    expect((await json<{ outcome: string }>(openPr(f, approved, key))).outcome).toBe("REPLAYED")
    expect((await json<{ outcome: string }>(openPr(f, approved))).outcome).toBe("REPLAYED")
    expect(gh.writes).toHaveLength(3)
    expect(gh.prs).toHaveLength(1)
  })

  it("detects a stale base revision and writes nothing", async () => {
    const f = await fixture()
    const { o, delivery } = await ready(f)
    gh.editBase("content/home.md", HOME.replace("Write notes together.", "Someone else edited this."))
    const result = await json<{ delivery: GrowthDelivery; outcome: string }>(openPr(f, delivery), 409)
    expect(result.outcome).toBe("STALE")
    expect(result.delivery.state).toBe("STALE")
    expect(result.delivery.attempts[0]).toMatchObject({ state: "FAILED", failureCode: "STALE_BASE" })
    expect(gh.writes).toEqual([])
    expect(await json(openPr(f, result.delivery), 409)).toMatchObject({ reason: "StaleBase" })
    expect((await opportunityOf(f, o.id)).status).toBe("APPROVED")
  })

  it("reconciles an unconfirmed outcome against GitHub instead of opening a second pull request", async () => {
    const f = await fixture()
    const { delivery } = await ready(f)
    // GitHub created the pull request, but the response never arrived.
    gh.failNext("createPullRequest", "TIMEOUT", true)
    const unknown = await json<{ delivery: GrowthDelivery; outcome: string }>(openPr(f, delivery), 502)
    expect(unknown.outcome).toBe("UNKNOWN")
    expect(unknown.delivery.state).toBe("APPROVED_FOR_PR")
    expect(unknown.delivery.attempts[0]!.state).toBe("UNKNOWN")
    const reconciled = await json<{ delivery: GrowthDelivery; outcome: string }>(openPr(f, delivery))
    expect(reconciled.outcome).toBe("OPENED")
    expect(gh.prs).toHaveLength(1)
    expect(reconciled.delivery.attempts).toHaveLength(1)
    expect(reconciled.delivery.attempts[0]).toMatchObject({ state: "SUCCEEDED", prNumber: 1 })
  })

  it("finishes a commit an interrupted attempt already made, without committing twice", async () => {
    const f = await fixture()
    const { delivery } = await ready(f)
    gh.failNext("putFile", "UNAVAILABLE", true)
    expect((await json<{ outcome: string }>(openPr(f, delivery), 502)).outcome).toBe("UNKNOWN")
    const done = await json<{ delivery: GrowthDelivery; outcome: string }>(openPr(f, delivery))
    expect(done.outcome).toBe("OPENED")
    expect(gh.writes.filter(w => w.startsWith("commit:"))).toHaveLength(1)
    expect(gh.prs).toHaveLength(1)
  })

  it("records merge state from GitHub, keeps deployment unknown until attested, and labels the attestation", async () => {
    const f = await fixture()
    const { o, delivery } = await ready(f)
    const { delivery: opened } = await json<{ delivery: GrowthDelivery }>(openPr(f, delivery))
    const still = await json<{ delivery: GrowthDelivery }>(call("POST", `${f.path}/deliveries/${delivery.id}/refresh`, f.cookie, {}))
    expect(still.delivery.state).toBe("PR_OPENED")
    const deployEarly = await call("POST", `${f.path}/deliveries/${delivery.id}/deployment`, f.cookie,
      { url: "https://delivery.test/", observedAt: new Date().toISOString(), note: "TEST seen live", expectedRevision: opened.revision, idempotencyKey: randomUUID() })
    expect(deployEarly.status).toBe(409)

    gh.merge(1)
    const { delivery: merged } = await json<{ delivery: GrowthDelivery }>(call("POST", `${f.path}/deliveries/${delivery.id}/refresh`, f.cookie, {}))
    expect(merged.state).toBe("PR_MERGED")
    expect(merged.events.at(-1)).toMatchObject({ actor: "DELIVERY_SYSTEM", detail: { mergeCommitSha: gh.prs[0]!.mergeCommitSha } })
    const afterMerge = await opportunityOf(f, o.id)
    expect(afterMerge.status).toBe("IN_DELIVERY")
    expect(afterMerge.evidence.filter(e => e.type === "VERIFIED_ACTION")).toHaveLength(1)
    expect((await json<{ delivery: GrowthDelivery }>(call("POST", `${f.path}/deliveries/${delivery.id}/refresh`, f.cookie, {}))).delivery.revision).toBe(merged.revision)
    expect((await opportunityOf(f, o.id)).evidence.filter(e => e.type === "VERIFIED_ACTION")).toHaveLength(1)

    const key = randomUUID()
    const attest = { url: "https://delivery.test/", observedAt: "2026-10-20T09:00:00.000Z", note: "TEST saw the new headline live", expectedRevision: merged.revision, idempotencyKey: key }
    const { delivery: deployed } = await json<{ delivery: GrowthDelivery }>(call("POST", `${f.path}/deliveries/${delivery.id}/deployment`, f.cookie, attest))
    expect(deployed.state).toBe("DEPLOYMENT_VERIFIED")
    expect(deployed.events.at(-1)).toMatchObject({ actor: "OPERATOR", detail: { provenance: "OPERATOR_ATTESTED", url: "https://delivery.test/" } })
    expect((await opportunityOf(f, o.id)).status).toBe("DELIVERED")
    expect((await json<{ delivery: GrowthDelivery }>(call("POST", `${f.path}/deliveries/${delivery.id}/deployment`, f.cookie, attest))).delivery.revision).toBe(deployed.revision)
  })

  it("returns the opportunity to APPROVED when the pull request closes unmerged", async () => {
    const f = await fixture()
    const { o, delivery } = await ready(f)
    await json(openPr(f, delivery))
    gh.close(1)
    const { delivery: closed } = await json<{ delivery: GrowthDelivery }>(call("POST", `${f.path}/deliveries/${delivery.id}/refresh`, f.cookie, {}))
    expect(closed.state).toBe("CLOSED_WITHOUT_DELIVERY")
    const after = await opportunityOf(f, o.id)
    expect(after.status).toBe("APPROVED")
    expect(after.evidence.some(e => e.type === "VERIFIED_ACTION")).toBe(false)
  })

  it("refuses foreign accounts and sibling origins without disclosure", async () => {
    const f = await fixture()
    const { delivery } = await ready(f)
    const other = await fixture()
    allowed = () => true
    for (const [method, path, body] of [["GET", `${f.path}/deliveries/${delivery.id}`, undefined], ["POST", `${f.path}/deliveries/${delivery.id}/pull-request`, { idempotencyKey: randomUUID() }],
      ["GET", `${other.path}/deliveries/${delivery.id}`, undefined], ["POST", `${other.path}/deliveries/${delivery.id}/pull-request`, { idempotencyKey: randomUUID() }]] as const) {
      const r = await call(method, path, other.cookie, body)
      expect(r.status).toBe(404)
      expect(await r.text()).not.toContain(delivery.patchSha256)
    }
    expect((await call("POST", `${f.path}/deliveries/${delivery.id}/pull-request`, f.cookie, { idempotencyKey: randomUUID() }, { origin: "https://hostile.test" })).status).toBe(403)
    expect(gh.prs).toHaveLength(0)
  })

  it("lets the agent draft and read, but not approve, open, merge or attest", async () => {
    const f = await fixture()
    const o = await approvedOpportunity(f)
    const { target } = await json<{ target: { id: string } }>(connect(f))
    const run = <A, E>(fx: Effect.Effect<A, E, AgentToolDeps>) => Effect.runPromise(Effect.either(Effect.provide(fx, ctx)))
    const drafted = await run(dispatchAgentTool(f.session.accountId, f.session.userId, f.profile.businessId, "propose_marketing_change", {
      opportunityId: o.id, targetId: target.id, filePath: "content/home.md", edits: [{ find: "Write notes together.", replace: "Turn meeting notes into assigned tasks." }],
      rationale: "TEST agent rationale", assumptions: "TEST agent assumptions", idempotencyKey: randomUUID() }))
    expect(drafted._tag).toBe("Right")
    const { deliveries } = await json<{ deliveries: GrowthDelivery[] }>(call("GET", `${f.path}/deliveries`, f.cookie))
    expect(deliveries).toHaveLength(1)
    expect(deliveries[0]).toMatchObject({ state: "DRAFTED", proposedBy: "ASSISTANT" })
    const status = await run(dispatchAgentTool(f.session.accountId, f.session.userId, f.profile.businessId, "read_delivery_status", {}))
    expect(status).toMatchObject({ _tag: "Right", right: { data: { deliveries: [{ state: "DRAFTED", deployment: "NOT_VERIFIED", pullRequest: null }] } } })
    for (const tool of ["approve_delivery", "open_pull_request", "record_deployment", "merge_pull_request"]) {
      expect((await run(dispatchAgentTool(f.session.accountId, f.session.userId, f.profile.businessId, tool, {})))._tag).toBe("Left")
    }
    expect(gh.writes).toEqual([])
  })
})
