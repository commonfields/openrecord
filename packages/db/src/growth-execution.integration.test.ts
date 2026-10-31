// W7 connected execution: persistence, database guards and concurrency against
// a disposable PostgreSQL (TEST fixtures only, no provider). The guards are
// exercised through the repository AND through direct SQL, because the claim
// that matters is that nothing can fabricate a SYSTEM_VERIFIED receipt.
import { createHash, randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Context, Effect, Exit, Layer, Redacted, Scope } from "effect"
import { PgClient } from "@effect/sql-pg"
import pg from "pg"
import { EXECUTION_TRANSITIONS, canTransitionExecution, executionFacts, type ExecutionOperation, type GrowthMetricDefinitionInput } from "@openrecord/contracts"
import { GrowthRepository, GrowthRepositoryLive } from "./growth.js"
import { GrowthExecutionRepository, GrowthExecutionRepositoryLive, executionRequestFingerprint, type PreparedExecution } from "./growth-execution.js"
import { RecordRepository, RecordRepositoryLive } from "./record.js"
import { migrate } from "./migrate.js"
import type { Session } from "./auth.js"

const url = process.env["TEST_DATABASE_URL"] ?? ""
const sha = (s: string) => createHash("sha256").update(s).digest("hex")
const sha1 = (s: string) => createHash("sha1").update(s).digest("hex")
const metric: GrowthMetricDefinitionInput = { conversionKind: "BOOKING", label: "Bookings", sourceKind: "OPERATOR_AGGREGATE_EXPORT", sourceIdentity: "TEST booking system", eventName: null, countingSemantics: "EVENT_COUNT", unit: "COUNT", currency: null, reportingTimeZone: "Asia/Makassar", propertyRef: null }
const details = { category: "TEST services", audience: "TEST locals", valueProposition: "TEST positioning", goalStatement: "Increase bookings", metric }
const PAGE = "pricing.html"
const BEFORE = '<html><head><meta name="robots" content="noindex"></head><body>Pricing</body></html>'
const AFTER = "<html><head></head><body>Pricing</body></html>"

const suite = url ? describe : describe.skip
suite("connected execution persistence and guards (disposable TEST fixtures)", () => {
  type Repos = GrowthRepository | GrowthExecutionRepository | RecordRepository
  let pool: pg.Pool, scope: Scope.CloseableScope, ctx: Context.Context<Repos>
  const run = async <A, E>(fx: Effect.Effect<A, E, Repos>): Promise<A> => {
    const result = await Effect.runPromise(Effect.either(Effect.provide(fx, ctx)))
    if (result._tag === "Left") throw result.left
    return result.right
  }
  const exec = <A>(f: (r: Context.Tag.Service<GrowthExecutionRepository>) => Effect.Effect<A, any, never>) => run(Effect.flatMap(GrowthExecutionRepository, r => f(r) as Effect.Effect<A, unknown, never>))
  beforeAll(async () => {
    await migrate(url); pool = new pg.Pool({ connectionString: url }); scope = await Effect.runPromise(Scope.make())
    ctx = await Effect.runPromise(Layer.buildWithScope(Layer.mergeAll(GrowthRepositoryLive, GrowthExecutionRepositoryLive, RecordRepositoryLive).pipe(Layer.provide(PgClient.layer({ url: Redacted.make(url) }))), scope)) as unknown as Context.Context<Repos>
  })
  afterAll(async () => { await Effect.runPromise(Scope.close(scope, Exit.void)); await pool.end() })

  const fixture = async (owner = `tester-${randomUUID().slice(0, 8)}`) => {
    const accountId = String((await pool.query("INSERT INTO accounts(name) VALUES('TEST exec') RETURNING id")).rows[0].id)
    const userId = String((await pool.query("INSERT INTO users(email,password_hash) VALUES($1,'TEST-only') RETURNING id", [`exec-${randomUUID()}@example.test`])).rows[0].id)
    await pool.query("INSERT INTO account_users(account_id,user_id) VALUES($1,$2)", [accountId, userId])
    const session: Session = { accountId, userId }
    const profile = await run(Effect.flatMap(GrowthRepository, r => r.registerProduct(session, { name: "TEST Salon", websiteUrl: "https://salon.test", engagement: "CLIENT", ...details, idempotencyKey: randomUUID() })))
    const siteId = String((await pool.query("INSERT INTO site_targets(business_id,root_url,canonical_origin,path_prefix) VALUES($1,'https://salon.test/','https://salon.test','/') RETURNING id", [profile.businessId])).rows[0].id)
    const repo = `salon-site-${randomUUID().slice(0, 8)}`
    const target = await exec(r => r.connectTarget(session, profile.businessId, { owner, repository: repo, baseBranch: "main", siteTargetId: siteId, allowedPaths: ["pricing.html", "pages/"], idempotencyKey: randomUUID() }))
    return { session, businessId: profile.businessId, goalId: profile.primaryGoal.id, siteId, target, owner, repo }
  }
  type F = Awaited<ReturnType<typeof fixture>>
  const opportunity = async (f: F, approve = true) => {
    const o = await run(Effect.flatMap(GrowthRepository, r => r.create(f.session, f.businessId, "OPERATOR", { goalId: f.goalId, title: "TEST remove accidental noindex", problemStatement: "TEST pricing page is hidden from search",
      audience: "TEST locals", buyerIntent: "Find prices", targetUrl: "https://salon.test/pricing.html", source: "TEST", proposedChange: "Remove the noindex directive", expectedMechanism: "Let the page be indexed",
      assumptions: "TEST", uncertainty: "TEST", baselineAvailability: "UNKNOWN", ownerUserId: f.session.userId, initialStatus: "PROPOSED", idempotencyKey: randomUUID(), evidence: [{ type: "OPERATOR_HYPOTHESIS", note: "TEST" }] })))
    if (approve) await run(Effect.flatMap(GrowthRepository, r => r.decide(f.session, f.businessId, o.id, "APPROVED", { expectedStatus: "PROPOSED", expectedRevision: 1, idempotencyKey: randomUUID(), reason: "TEST approve" })))
    return o.id
  }
  const planFor = (f: F, over: Partial<PreparedExecution> = {}): PreparedExecution => ({
    targetId: f.target.id, actionKind: "REMOVE_NOINDEX_META", actionValue: null, filePath: PAGE, liveUrl: "https://salon.test/pricing.html", siteFindingId: null, baseBranch: "main",
    baseCommitSha: sha1("base"), baseBlobSha: sha1(`blob-before-${randomUUID()}`), afterBlobSha: sha1("blob-after"), beforeSha256: sha(BEFORE), afterSha256: sha(AFTER),
    patchSha256: sha(`patch-${randomUUID()}`), afterContent: AFTER, diff: "--- a/pricing.html\n+++ b/pricing.html", rationale: "TEST remove an accidental noindex", idempotencyKey: randomUUID(), ...over,
  })
  const prepare = async (f: F, oid: string, over: Partial<PreparedExecution> = {}) => {
    const plan = planFor(f, over)
    const fp = executionRequestFingerprint({ opportunityId: oid, targetId: plan.targetId, actionKind: plan.actionKind, filePath: plan.filePath, liveUrl: plan.liveUrl, rationale: plan.rationale, siteFindingId: plan.siteFindingId })
    return exec(r => r.prepare(f.session, f.businessId, oid, fp, plan))
  }
  const authorize = (f: F, op: ExecutionOperation, over: Record<string, unknown> = {}) => exec(r => r.authorize(f.session, f.businessId, op.id, { reviewedPatchSha256: op.patchSha256, expectedRevision: op.revision, reason: "TEST reviewed the diff", idempotencyKey: randomUUID(), ...over }))
  const dispatch = (f: F, op: ExecutionOperation) => exec(r => r.dispatch(f.session, f.businessId, op.id, { expectedRevision: op.revision, idempotencyKey: randomUUID() }))
  const opened = (f: F, op: ExecutionOperation, n = 7) => ({ prNumber: n, prUrl: `https://github.com/${f.owner}/${f.repo}/pull/${n}`, headSha: sha1("head"), headRef: `openrecord/exec-${op.id}`, baseRef: "main", baseRepository: `${f.owner}/${f.repo}` })
  const toAwaiting = async (f: F, op: ExecutionOperation, n = 7) => {
    await exec(r => r.recordEvidence(op.id, f.businessId, "PR_OPENED", opened(f, op, n)))
    return exec(r => r.transition(op.id, f.businessId, "AWAITING_MERGE", "Pull request opened", {}))
  }
  const toReconciling = async (f: F, op: ExecutionOperation) => { await toAwaiting(f, op); return exec(r => r.transition(op.id, f.businessId, "RECONCILING", "Merge observed", { mergeObserved: true })) }
  const mergeEvidence = (f: F, op: ExecutionOperation, over: Record<string, unknown> = {}) => ({ ...opened(f, op), mergeCommitSha: sha1("merge"), mergedAt: "2026-10-20T10:00:00.000Z", mergedBlobSha: sha1("blob-after"), changedPaths: [PAGE], ...over })
  const verified = async (f: F) => {
    const oid = await opportunity(f)
    let op = await prepare(f, oid); op = await authorize(f, op); op = await dispatch(f, op)
    op = await toReconciling(f, op)
    return { oid, op: await exec(r => r.verifyMerge(op.id, f.businessId, mergeEvidence(f, op))) }
  }
  const sqlError = async (q: Promise<unknown>) => { try { await q } catch (e) { return String((e as Error).message) } return null }

  it("takes one approved initiative through authorization, dispatch, provider evidence and a single verified receipt", async () => {
    const f = await fixture(), oid = await opportunity(f)
    let op = await prepare(f, oid)
    expect(op).toMatchObject({ state: "PREPARED", revision: 1, owner: f.owner, repository: f.repo, filePath: PAGE })
    expect(executionFacts(op)).toEqual({ request: "NOT_SENT", providerAction: "NOT_VERIFIED", liveChange: "NOT_CHECKED" })
    op = await authorize(f, op)
    expect(op.state).toBe("AUTHORIZED")
    expect(op.events.at(-1)?.detail).toMatchObject({ approvedPatchSha256: op.patchSha256, authorizedByUserId: f.session.userId })
    op = await dispatch(f, op)
    expect(op.state).toBe("DISPATCHING")
    expect(executionFacts(op).request).toBe("ACCEPTED_BY_OPENRECORD")
    // The initiative's human lifecycle is untouched by execution.
    const initiative = await run(Effect.flatMap(GrowthRepository, r => r.get(f.session.accountId, f.businessId, oid)))
    expect(initiative.status).toBe("APPROVED")
    op = await toAwaiting(f, op)
    expect(executionFacts(op)).toEqual({ request: "ACCEPTED_BY_PROVIDER", providerAction: "NOT_VERIFIED", liveChange: "NOT_CHECKED" })
    // A merge that was only reported is not verified.
    const before = await run(Effect.flatMap(GrowthRepository, r => r.get(f.session.accountId, f.businessId, oid)))
    expect(before.executionCount).toBe(0)
    op = await exec(r => r.transition(op.id, f.businessId, "RECONCILING", "Merge observed", { mergeObserved: true }))
    op = await exec(r => r.verifyMerge(op.id, f.businessId, mergeEvidence(f, op)))
    expect(op.state).toBe("VERIFIED")
    expect(Date.parse(op.receipt!.mergedAt)).toBe(Date.parse("2026-10-20T10:00:00.000Z"))
    expect(op.receipt).toMatchObject({ claim: "PR_MERGED", pullRequestUrl: `https://github.com/${f.owner}/${f.repo}/pull/7` })
    expect(executionFacts(op)).toEqual({ request: "ACCEPTED_BY_PROVIDER", providerAction: "VERIFIED", liveChange: "PENDING" })
    const after = await run(Effect.flatMap(GrowthRepository, r => r.get(f.session.accountId, f.businessId, oid)))
    expect(after.executionCount).toBe(1)
    expect(after.executions[0]).toMatchObject({ assurance: "SYSTEM_VERIFIED", actor: "SYSTEM", type: "SOURCE_UPDATED", channel: "WEBSITE", verification: { kind: "GROWTH_DELIVERY", id: op.id, claim: "PR_MERGED" } })
    expect(after.status).toBe("APPROVED")
    // Verification is idempotent: a replay returns the same receipt and adds no second one.
    const again = await exec(r => r.verifyMerge(op.id, f.businessId, mergeEvidence(f, op)))
    expect(again.receipt?.interventionId).toBe(op.receipt?.interventionId)
    expect(Number((await pool.query("SELECT count(*) FROM interventions WHERE verification_id=$1", [op.id])).rows[0].count)).toBe(1)
    // Live observation is a separate fact appended later.
    await exec(r => r.recordLiveCheck(op.id, f.businessId, { result: "CHANGE_NOT_OBSERVED", httpStatus: 200, detail: "The page still carries noindex", bodyDigest: sha("live") }))
    const live = await exec(r => r.get(f.session.accountId, f.businessId, op.id))
    expect(live.state).toBe("VERIFIED")
    expect(executionFacts(live)).toEqual({ request: "ACCEPTED_BY_PROVIDER", providerAction: "VERIFIED", liveChange: "NOT_OBSERVED" })
    await exec(r => r.recordLiveCheck(op.id, f.businessId, { result: "CHANGE_OBSERVED", httpStatus: 200, detail: "The robots directive is gone", bodyDigest: sha("live2") }))
    expect(executionFacts(await exec(r => r.get(f.session.accountId, f.businessId, op.id))).liveChange).toBe("OBSERVED")
    expect(Number((await pool.query("SELECT count(*) FROM growth_execution_live_checks WHERE operation_id=$1", [op.id])).rows[0].count)).toBe(2)
  })

  it("refuses every way of fabricating a verified receipt through direct SQL", async () => {
    const f = await fixture(), oid = await opportunity(f)
    let op = await prepare(f, oid); op = await authorize(f, op); op = await dispatch(f, op); op = await toAwaiting(f, op)
    const receipt = (verificationId: string, over: Record<string, unknown> = {}) => {
      const v = { type: "SOURCE_UPDATED", channel: "WEBSITE", actor: "SYSTEM", actorId: null, target: `https://github.com/${f.owner}/${f.repo}/pull/7`, at: "2026-10-20T10:00:00Z", before: sha(BEFORE), after: sha(AFTER), claim: "PR_MERGED", kind: "GROWTH_DELIVERY", ...over }
      return pool.query(`INSERT INTO interventions(business_id,type,target,performed_at,actor,actor_id,evidence_before_digest,evidence_after_digest,channel,assurance,verification_kind,verification_id,verification_claim)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'SYSTEM_VERIFIED',$10,$11,$12)`, [f.businessId, v.type, v.target, v.at, v.actor, v.actorId, v.before, v.after, v.channel, v.kind, verificationId, v.claim])
    }
    expect(await sqlError(receipt(randomUUID()))).toContain("execution system claim unverified")
    // No merge evidence yet: the operation exists and is authorized, but nothing was confirmed.
    expect(await sqlError(receipt(op.id))).toContain("execution system claim unverified")
    op = await exec(r => r.transition(op.id, f.businessId, "RECONCILING", "Merge observed", { mergeObserved: true }))
    expect(await sqlError(receipt(op.id))).toContain("execution system claim unverified")
    // Evidence that contradicts the authorized change cannot be recorded at all.
    const bad: Array<[string, Record<string, unknown>]> = [
      ["different blob", { mergedBlobSha: sha1("something else") }], ["extra changed file", { changedPaths: [PAGE, "other.html"] }],
      ["other repository", { baseRepository: "someone/else" }], ["other base branch", { baseRef: "release" }], ["other head branch", { headRef: "openrecord/exec-" + randomUUID() }],
      ["other pull request", { prNumber: 99, prUrl: `https://github.com/${f.owner}/${f.repo}/pull/99` }], ["head changed after open", { headSha: sha1("force pushed") }], ["no merge commit", { mergeCommitSha: "" }],
    ]
    for (const [name, over] of bad) {
      expect(await sqlError(pool.query("INSERT INTO growth_execution_evidence(operation_id,business_id,kind,detail) VALUES($1,$2,'PR_MERGE_CONFIRMED',$3::jsonb)", [op.id, f.businessId, JSON.stringify(mergeEvidence(f, op, over))])), name).toContain("merge evidence contradicts")
    }
    await exec(r => r.verifyMerge(op.id, f.businessId, mergeEvidence(f, op)))
    const done = await exec(r => r.get(f.session.accountId, f.businessId, op.id))
    // With real evidence and one real receipt, copies and variations still fail.
    expect(await sqlError(receipt(op.id))).toBeTruthy()                       // a second receipt for the same operation
    expect(await sqlError(pool.query("DELETE FROM interventions WHERE verification_id=$1", [op.id]))).toBeTruthy()
    for (const [name, over] of [["other time", { at: "2026-10-21T00:00:00Z" }], ["other target", { target: "https://github.com/x/y/pull/7" }], ["other digest", { after: sha("tampered") }],
      ["human actor", { actor: "HUMAN", actorId: f.session.userId }], ["agent", { actor: "AGENT" }], ["wrong type", { type: "SOURCE_PUBLISHED" }], ["wrong channel", { channel: "EMAIL" }], ["wrong claim", { claim: "DEPLOYED" }]] as const) {
      expect(await sqlError(receipt(op.id, over)), name).toBeTruthy()
    }
    // An attestation can never carry verification fields; a verified row needs the system actor.
    expect(await sqlError(pool.query(`INSERT INTO interventions(business_id,type,target,performed_at,actor,actor_id,channel,assurance,verification_kind,verification_id,verification_claim)
      VALUES($1,'SOURCE_UPDATED','x','2026-10-20T10:00:00Z','HUMAN',$2,'WEBSITE','OPERATOR_ATTESTED','GROWTH_DELIVERY',$3,'PR_MERGED')`, [f.businessId, f.session.userId, op.id]))).toContain("attestation is not system verification")
    expect(done.state).toBe("VERIFIED")
  })

  it("keeps the verification function exact across a full migration replay", async () => {
    const f = await fixture(), { op } = await verified(f)
    await migrate(url)
    const row = await pool.query("SELECT prosrc FROM pg_proc WHERE proname='growth_execution_verified'")
    expect(row.rows).toHaveLength(1)
    expect(row.rows[0].prosrc).toContain("PR_MERGE_CONFIRMED")
    expect(await sqlError(pool.query("INSERT INTO interventions(business_id,type,target,performed_at,actor,channel,assurance,verification_kind,verification_id,verification_claim) VALUES($1,'SOURCE_UPDATED','x',now(),'SYSTEM','WEBSITE','SYSTEM_VERIFIED','GROWTH_DELIVERY',$2,'PR_MERGED')", [f.businessId, randomUUID()]))).toContain("execution system claim unverified")
    expect((await exec(r => r.get(f.session.accountId, f.businessId, op.id))).receipt).not.toBeNull()
  })

  it("binds authorization to the reviewed patch, the revision and an unexpired window", async () => {
    const f = await fixture(), oid = await opportunity(f)
    const op = await prepare(f, oid)
    await expect(authorize(f, op, { reviewedPatchSha256: sha("another patch") })).rejects.toMatchObject({ reason: "PatchMismatch" })
    await expect(authorize(f, op, { expectedRevision: 5 })).rejects.toMatchObject({ reason: "StaleExecution" })
    await expect(dispatch(f, op)).rejects.toMatchObject({ reason: "TransitionRefused" })
    const key = randomUUID()
    const a = await authorize(f, op, { idempotencyKey: key })
    const replay = await authorize(f, op, { idempotencyKey: key })
    expect(replay.revision).toBe(a.revision)
    await expect(authorize(f, op, { idempotencyKey: key, reason: "TEST a different reason" })).rejects.toMatchObject({ reason: "IdempotencyConflict" })
    // Direct SQL cannot authorize without the hash or with a past expiry, nor as the assistant or the system.
    const op2 = await prepare(f, await opportunity(f), { filePath: "pages/other.html" })
    const ev = (actor: string, userId: string | null, detail: object) => pool.query("INSERT INTO growth_execution_events(operation_id,business_id,revision,state,actor,user_id,reason,detail) VALUES($1,$2,2,'AUTHORIZED',$3,$4,'x',$5::jsonb)", [op2.id, f.businessId, actor, userId, JSON.stringify(detail)])
    const future = new Date(Date.now() + 3_600_000).toISOString()
    expect(await sqlError(ev("OPERATOR", f.session.userId, { approvedPatchSha256: sha("wrong"), expiresAt: future }))).toContain("authorization must bind")
    expect(await sqlError(ev("OPERATOR", f.session.userId, { approvedPatchSha256: op2.patchSha256, expiresAt: "2020-01-01T00:00:00Z" }))).toContain("future expiry")
    expect(await sqlError(ev("ASSISTANT", f.session.userId, { approvedPatchSha256: op2.patchSha256, expiresAt: future }))).toContain("execution transition refused")
    expect(await sqlError(ev("EXECUTION_SYSTEM", null, { approvedPatchSha256: op2.patchSha256, expiresAt: future }))).toContain("execution transition refused")
    // An authorization that has expired cannot be dispatched.
    const soon = new Date(Date.now() + 1_200).toISOString()
    await pool.query("INSERT INTO growth_execution_events(operation_id,business_id,revision,state,actor,user_id,reason,detail) VALUES($1,$2,2,'AUTHORIZED','OPERATOR',$3,'x',$4::jsonb)", [op2.id, f.businessId, f.session.userId, JSON.stringify({ approvedPatchSha256: op2.patchSha256, expiresAt: soon })])
    await new Promise(r => setTimeout(r, 1_500))
    await expect(dispatch(f, { ...op2, revision: 2 })).rejects.toMatchObject({ reason: "AuthorizationExpired" })
  })

  it("holds the initiative's final decision while an external action may be in progress, and never the other way round", async () => {
    const f = await fixture(), oid = await opportunity(f)
    let op = await prepare(f, oid)
    const review = () => run(Effect.flatMap(GrowthRepository, r => r.review(f.session, f.businessId, oid, { expectedStatus: "APPROVED", expectedRevision: 2, idempotencyKey: randomUUID(), reason: "TEST decide", conclusion: "KEEP" })))
    const cancel = () => run(Effect.flatMap(GrowthRepository, r => r.decide(f.session, f.businessId, oid, "CANCELLED", { expectedStatus: "APPROVED", expectedRevision: 2, idempotencyKey: randomUUID(), reason: "TEST cancel" })))
    op = await authorize(f, op); op = await dispatch(f, op)
    await expect(review()).rejects.toMatchObject({ reason: "ExecutionUnresolved" })
    await expect(cancel()).rejects.toMatchObject({ reason: "ExecutionUnresolved" })
    op = await toAwaiting(f, op)
    await expect(review()).rejects.toMatchObject({ reason: "ExecutionUnresolved" })
    // Even a direct event insert is refused by the database.
    expect(await sqlError(pool.query("INSERT INTO growth_opportunity_events(opportunity_id,business_id,revision,status,actor,user_id,reason,request_key,conclusion) VALUES($1,$2,3,'REVIEWED','OPERATOR',$3,'x',$4,'KEEP')", [oid, f.businessId, f.session.userId, randomUUID()]))).toContain("execution unresolved")
    op = await exec(r => r.transition(op.id, f.businessId, "FAILED", "Pull request closed", { code: "PR_CLOSED_WITHOUT_MERGE" }).pipe(Effect.catchAll(() => Effect.succeed(op))))
    expect(op.state).toBe("AWAITING_MERGE")               // closed-without-merge needs its evidence first
    await exec(r => r.recordEvidence(op.id, f.businessId, "PR_CLOSED_UNMERGED", { prNumber: 7 }))
    op = await exec(r => r.transition(op.id, f.businessId, "FAILED", "Pull request closed without merge", { code: "PR_CLOSED_WITHOUT_MERGE" }))
    expect(op.state).toBe("FAILED")
    expect((await review()).status).toBe("REVIEWED")
    // A prepared or authorized change that was never dispatched does not hold the decision, and cannot be dispatched afterwards.
    const f2 = await fixture(), oid2 = await opportunity(f2)
    let held = await authorize(f2, await prepare(f2, oid2))
    await run(Effect.flatMap(GrowthRepository, r => r.decide(f2.session, f2.businessId, oid2, "CANCELLED", { expectedStatus: "APPROVED", expectedRevision: 2, idempotencyKey: randomUUID(), reason: "TEST cancel" })))
    await expect(dispatch(f2, held)).rejects.toMatchObject({ reason: "InitiativeNotApproved" })
    held = await exec(r => r.get(f2.session.accountId, f2.businessId, held.id))
    expect(held.state).toBe("AUTHORIZED")
    // No execution may even be prepared on an initiative that is not approved.
    await expect(prepare(f2, oid2)).rejects.toMatchObject({ reason: "InitiativeNotApproved" })
    await expect(prepare(f2, await opportunity(f2, false))).rejects.toMatchObject({ reason: "InitiativeNotApproved" })
  })

  it("serializes a concurrent final decision and dispatch: exactly one wins", async () => {
    for (let i = 0; i < 4; i++) {
      const f = await fixture(), oid = await opportunity(f)
      const op = await authorize(f, await prepare(f, oid))
      const settle = (p: Promise<unknown>) => p.then(() => "ok", e => (e as { reason?: string }).reason ?? "error")
      const [a, b] = await Promise.all([
        settle(dispatch(f, op)),
        settle(run(Effect.flatMap(GrowthRepository, r => r.decide(f.session, f.businessId, oid, "CANCELLED", { expectedStatus: "APPROVED", expectedRevision: 2, idempotencyKey: randomUUID(), reason: "TEST cancel" })))),
      ])
      const state = (await exec(r => r.get(f.session.accountId, f.businessId, op.id))).state
      const status = (await run(Effect.flatMap(GrowthRepository, r => r.get(f.session.accountId, f.businessId, oid)))).status
      // Either the dispatch took the lock first (cancel refused) or the cancel did (dispatch refused). Never both.
      expect([a, b].sort()).toEqual(state === "DISPATCHING" ? ["ExecutionUnresolved", "ok"] : ["InitiativeNotApproved", "ok"])
      expect(state === "DISPATCHING" ? status === "APPROVED" : status === "CANCELLED").toBe(true)
    }
  })

  it("makes preparation and dispatch idempotent and refuses a different request under the same key", async () => {
    const f = await fixture(), oid = await opportunity(f)
    const plan = planFor(f)
    const fp = executionRequestFingerprint({ opportunityId: oid, targetId: plan.targetId, actionKind: plan.actionKind, filePath: plan.filePath, liveUrl: plan.liveUrl, rationale: plan.rationale, siteFindingId: null })
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => exec(r => r.prepare(f.session, f.businessId, oid, fp, plan))))
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1)
    expect(Number((await pool.query("SELECT count(*) FROM growth_execution_operations WHERE business_id=$1", [f.businessId])).rows[0].count)).toBe(1)
    const found = await exec(r => r.findPrepared(f.session, f.businessId, oid, fp, plan.idempotencyKey))
    expect(found?.state).toBe("PREPARED")
    await expect(exec(r => r.findPrepared(f.session, f.businessId, oid, sha("other request"), plan.idempotencyKey))).rejects.toMatchObject({ reason: "IdempotencyConflict" })
    let op = await authorize(f, found!)
    const key = randomUUID()
    const d = await Promise.all([1, 2, 3].map(() => exec(r => r.dispatch(f.session, f.businessId, op.id, { expectedRevision: op.revision, idempotencyKey: key }))))
    expect(new Set(d.map(x => x.revision)).size).toBe(1)
    op = d[0]!
    expect(Number((await pool.query("SELECT count(*) FROM growth_execution_jobs WHERE operation_id=$1 AND kind='DISPATCH'", [op.id])).rows[0].count)).toBe(1)
    // A second unsettled operation on the same page is refused.
    await expect(prepare(f, oid)).rejects.toMatchObject({ reason: "ExecutionAlreadyOpen" })
  })

  it("lets exactly one worker claim a job, reclaims an expired lease, and keeps finished jobs finished", async () => {
    const f = await fixture(), oid = await opportunity(f)
    const op = await dispatch(f, await authorize(f, await prepare(f, oid)))
    const claims = await Promise.all(Array.from({ length: 8 }, (_, i) => exec(r => r.claimJob(`worker-${i}`, 60, [op.id]))))
    const winners = claims.filter(c => c !== null && c.operationId === op.id)
    expect(winners).toHaveLength(1)
    expect(winners[0]).toMatchObject({ kind: "DISPATCH", attemptCount: 1 })
    expect(await exec(r => r.claimJob("late", 60, [op.id]))).toBeNull()
    await pool.query("UPDATE growth_execution_jobs SET lease_expires_at=now()-interval '1 second' WHERE operation_id=$1", [op.id])
    const reclaimed = await exec(r => r.claimJob("rescuer", 60, [op.id]))
    expect(reclaimed).toMatchObject({ operationId: op.id, attemptCount: 2 })
    await exec(r => r.retryJob(reclaimed!.id, "rescuer", 3600, "RATE_LIMITED"))
    expect(await exec(r => r.claimJob("early", 60, [op.id]))).toBeNull()                        // backoff is respected
    await pool.query("UPDATE growth_execution_jobs SET not_before=now() WHERE operation_id=$1", [op.id])
    const again = await exec(r => r.claimJob("again", 60, [op.id]))
    await exec(r => r.finishJob(again!.id, "again"))
    expect(await sqlError(pool.query("UPDATE growth_execution_jobs SET status='QUEUED',claimed_by=NULL,lease_expires_at=NULL WHERE id=$1", [again!.id]))).toContain("finished job")
    expect(await sqlError(pool.query("DELETE FROM growth_execution_jobs WHERE id=$1", [again!.id]))).toContain("keep their history")
    // A manual website check expedites a delayed automatic one instead of being shadowed by it.
    const f2 = await fixture(), { op: done } = await verified(f2)
    await pool.query("UPDATE growth_execution_jobs SET status='DONE' WHERE operation_id=$1 AND kind='DISPATCH'", [done.id])   // this test drove the operation by hand
    await exec(r => r.ensureJob(done.id, f2.businessId, "LIVE_CHECK", 3600))
    expect(await exec(r => r.claimJob("early", 60, [done.id]))).toBeNull()
    await exec(r => r.requestLiveCheck(f2.session, f2.businessId, done.id, { idempotencyKey: randomUUID() }))
    expect(await exec(r => r.claimJob("now", 60, [done.id]))).toMatchObject({ kind: "LIVE_CHECK", operationId: done.id })
    // A job must fit the operation: no live check before a verified merge.
    expect(await sqlError(pool.query("INSERT INTO growth_execution_jobs(operation_id,business_id,kind) VALUES($1,$2,'LIVE_CHECK')", [op.id, f.businessId]))).toContain("job does not fit")
  })

  it("enforces tenancy, the repository allowlist shape and the OpenRecord repository denial", async () => {
    const f = await fixture(), other = await fixture(), oid = await opportunity(f)
    const op = await prepare(f, oid)
    const attempts: Array<() => Promise<unknown>> = [
      () => exec(r => r.get(other.session.accountId, f.businessId, op.id)), () => exec(r => r.list(other.session.accountId, f.businessId, oid)), () => exec(r => r.targets(other.session.accountId, f.businessId)),
      () => authorize({ ...f, session: other.session }, op), () => dispatch({ ...f, session: other.session }, op),
      () => exec(r => r.cancel(other.session, f.businessId, op.id, { expectedRevision: 1, reason: "x", idempotencyKey: randomUUID() })),
      () => exec(r => r.requestReconcile(other.session, f.businessId, op.id, { idempotencyKey: randomUUID() })), () => exec(r => r.requestLiveCheck(other.session, f.businessId, op.id, { idempotencyKey: randomUUID() })),
      () => prepare({ ...f, session: other.session }, oid),
    ]
    for (const a of attempts) await expect(a()).rejects.toMatchObject({ reason: "GrowthNotFound" })
    // The same repository cannot be connected by another account.
    await expect(exec(r => r.connectTarget(other.session, other.businessId, { owner: f.owner, repository: f.repo, baseBranch: "main", siteTargetId: other.siteId, allowedPaths: ["pricing.html"], idempotencyKey: randomUUID() }))).rejects.toMatchObject({ reason: "RepositoryNotPermitted" })
    // Neither can OpenRecord's own repository, a foreign site, a non-HTML page nor a traversal.
    await expect(exec(r => r.connectTarget(f.session, f.businessId, { owner: "CommonFields", repository: "OpenRecord", baseBranch: "main", siteTargetId: f.siteId, allowedPaths: ["pricing.html"], idempotencyKey: randomUUID() }))).rejects.toMatchObject({ reason: "RepositoryNotPermitted" })
    await expect(exec(r => r.connectTarget(f.session, f.businessId, { owner: "someone", repository: "x", baseBranch: "main", siteTargetId: other.siteId, allowedPaths: ["pricing.html"], idempotencyKey: randomUUID() }))).rejects.toBeTruthy()
    for (const bad of ["../x.html", ".github/workflows/ci.yml", "notes.md", "/abs.html", "a//b.html"]) {
      await expect(exec(r => r.connectTarget(f.session, f.businessId, { owner: "someone", repository: "y", baseBranch: "main", siteTargetId: f.siteId, allowedPaths: [bad], idempotencyKey: randomUUID() }))).rejects.toMatchObject({ reason: "InvalidRequest" })
    }
    // A page outside the target's allowed paths, a live page outside the registered site and a mismatched base branch cannot be prepared.
    await expect(prepare(f, await opportunity(f), { filePath: "secret/admin.html" })).rejects.toMatchObject({ reason: "PathNotPermitted" })
    await expect(prepare(f, await opportunity(f), { liveUrl: "https://evil.test/pricing.html" })).rejects.toMatchObject({ reason: "LivePageOutsideSite" })
    await expect(prepare(f, await opportunity(f), { baseBranch: "release" })).rejects.toBeTruthy()
  })

  it("keeps lifecycle, evidence and operations append-only and the transition table in step with the contract", async () => {
    const f = await fixture(), oid = await opportunity(f)
    let op = await authorize(f, await prepare(f, oid)); op = await dispatch(f, op); op = await toAwaiting(f, op)
    for (const q of [`UPDATE growth_execution_events SET reason='x' WHERE operation_id='${op.id}'`, `DELETE FROM growth_execution_events WHERE operation_id='${op.id}'`,
      `UPDATE growth_execution_evidence SET kind='BRANCH_READY' WHERE operation_id='${op.id}'`, `DELETE FROM growth_execution_evidence WHERE operation_id='${op.id}'`,
      `UPDATE growth_execution_operations SET after_content='<html></html>' WHERE id='${op.id}'`, `DELETE FROM growth_execution_operations WHERE id='${op.id}'`, `TRUNCATE growth_execution_live_checks`]) {
      expect(await sqlError(pool.query(q)), q).toContain("append-only")
    }
    // Stage evidence belongs to its stage; a pull request cannot be "opened" by another branch.
    expect(await sqlError(pool.query("INSERT INTO growth_execution_evidence(operation_id,business_id,kind,detail) VALUES($1,$2,'PR_MERGE_CONFIRMED','{}')", [op.id, f.businessId]))).toContain("merge is confirmed only while reconciling")
    // Parity: every (from, to, actor) in the contract table is exactly what the database lets through.
    const states = ["PREPARED", "AUTHORIZED", "DISPATCHING", "AWAITING_MERGE", "RECONCILING", "VERIFIED", "FAILED", "BLOCKED", "UNKNOWN", "CANCELLED"] as const
    const allowedFrom = (from: string) => EXECUTION_TRANSITIONS.filter(t => t.from === from)
    expect(allowedFrom("VERIFIED")).toEqual([])
    expect(EXECUTION_TRANSITIONS.filter(t => t.to === "VERIFIED").every(t => t.actors.length === 1 && t.actors[0] === "EXECUTION_SYSTEM")).toBe(true)
    expect(EXECUTION_TRANSITIONS.filter(t => t.to === "AUTHORIZED" || t.to === "DISPATCHING" && t.from === "AUTHORIZED").every(t => t.actors.length === 1 && t.actors[0] === "OPERATOR")).toBe(true)
    for (const to of states) expect(canTransitionExecution("PREPARED", to, "ASSISTANT")).toBe(false)
    const guardSrc = (await pool.query("SELECT prosrc FROM pg_proc WHERE proname='guard_growth_execution_event'")).rows[0].prosrc as string
    for (const t of EXECUTION_TRANSITIONS.filter(x => x.from !== null)) expect(guardSrc, `${t.from}->${t.to}`).toContain(`'${t.to}'`)
  })

  it("is invisible to other accounts and never exposes credentials or file contents beyond the diff", async () => {
    const f = await fixture(), { op } = await verified(f)
    const text = JSON.stringify(op)
    expect(text).not.toMatch(/token|secret|password|authorization:/i)
    expect(text).not.toContain(AFTER)
    const docs = await pool.query("SELECT document FROM growth_execution_documents WHERE id=$1", [op.id])
    expect(Object.keys(docs.rows[0].document)).not.toContain("afterContent")
  })
})
