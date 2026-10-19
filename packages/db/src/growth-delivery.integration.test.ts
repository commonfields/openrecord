import { createHash, randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Context, Effect, Exit, Layer, Redacted, Scope } from "effect"
import { PgClient } from "@effect/sql-pg"
import pg from "pg"
import { canTransitionDelivery, DeliveryState, type DeliveryActor, type GrowthMetric } from "@openrecord/contracts"
import { GrowthRepository, GrowthRepositoryLive } from "./growth.js"
import { GrowthDeliveryRepository, GrowthDeliveryRepositoryLive, type DeliveryDraft } from "./growth-delivery.js"
import { RecordRepository, RecordRepositoryLive } from "./record.js"
import { migrate } from "./migrate.js"
import type { Session } from "./auth.js"

// The 0031 guards hold even for direct SQL: what the API checks is also the
// database's rule, so a bypass of the service cannot invent delivery.

const url = process.env["TEST_DATABASE_URL"] ?? ""
const metric: GrowthMetric = { kind: "TRIAL_SIGNUPS", analyticsSource: "GA4_AGGREGATE_EXPORT", eventName: "trial_signup", countingSemantics: "EVENT_COUNT", reportingTimeZone: "UTC", propertyRef: null }
const hex = (s: string, n: number) => createHash("sha256").update(s).digest("hex").slice(0, n)
const suite = url ? describe : describe.skip
suite("growth delivery guards (disposable TEST fixtures)", () => {
  type Repos = GrowthRepository | GrowthDeliveryRepository | RecordRepository
  let pool: pg.Pool, scope: Scope.CloseableScope, ctx: Context.Context<Repos>
  const run = async <A, E>(fx: Effect.Effect<A, E, Repos>): Promise<A> => {
    const result = await Effect.runPromise(Effect.either(Effect.provide(fx, ctx)))
    if (result._tag === "Left") throw result.left
    return result.right
  }
  beforeAll(async () => {
    await migrate(url); pool = new pg.Pool({ connectionString: url }); scope = await Effect.runPromise(Scope.make())
    ctx = await Effect.runPromise(Layer.buildWithScope(Layer.mergeAll(GrowthRepositoryLive, GrowthDeliveryRepositoryLive, RecordRepositoryLive).pipe(Layer.provide(PgClient.layer({ url: Redacted.make(url) }))), scope))
  })
  afterAll(async () => { await Effect.runPromise(Scope.close(scope, Exit.void)); await pool.end() })

  const fixture = async () => {
    const accountId = String((await pool.query("INSERT INTO accounts(name) VALUES('TEST delivery guard') RETURNING id")).rows[0].id)
    const userId = String((await pool.query("INSERT INTO users(email,password_hash) VALUES($1,'TEST-only') RETURNING id", [`delivery-guard-${randomUUID()}@example.test`])).rows[0].id)
    await pool.query("INSERT INTO account_users(account_id,user_id) VALUES($1,$2)", [accountId, userId])
    const session: Session = { accountId, userId }
    const profile = await run(Effect.flatMap(GrowthRepository, r => r.registerProduct(session, { name: "TEST Product", websiteUrl: "https://product.test", engagement: "DOGFOOD",
      category: "TEST", audience: "TEST", valueProposition: "TEST", primaryGoal: metric, idempotencyKey: randomUUID() })))
    const opportunity = await run(Effect.flatMap(GrowthRepository, r => r.create(session, profile.businessId, "OPERATOR", {
      goalId: profile.primaryGoal.id, title: "TEST", problemStatement: "TEST", audience: "TEST", buyerIntent: "TEST", targetUrl: "https://product.test/", source: "TEST",
      proposedChange: "TEST", expectedMechanism: "TEST", assumptions: "TEST", uncertainty: "TEST", baselineAvailability: "UNKNOWN", ownerUserId: userId,
      initialStatus: "PROPOSED", idempotencyKey: randomUUID(), evidence: [{ type: "OPERATOR_HYPOTHESIS", note: "TEST" }] })))
    const repo = `site-${randomUUID().slice(0, 8)}`
    const target = await run(Effect.flatMap(GrowthDeliveryRepository, r => r.connect(session, profile.businessId,
      { owner: "acme", repository: repo, baseBranch: "main", allowedPaths: ["content/"], idempotencyKey: randomUUID() })))
    return { session, businessId: profile.businessId, opportunity, target, repo }
  }
  type F = Awaited<ReturnType<typeof fixture>>
  const approveOpportunity = (f: F) => run(Effect.flatMap(GrowthRepository, r => r.decide(f.session, f.businessId, f.opportunity.id, "APPROVED",
    { expectedStatus: "PROPOSED", expectedRevision: 1, idempotencyKey: randomUUID(), reason: "TEST" })))
  const draftOf = (f: F, extra: Partial<DeliveryDraft> = {}): DeliveryDraft => ({
    targetId: f.target.id, filePath: "content/home.md", baseBranch: "main", baseCommitSha: hex("c", 40), baseBlobSha: hex("b", 40), afterBlobSha: hex("a", 40),
    beforeSha256: hex("before", 64), afterSha256: hex("after", 64), patchSha256: hex(randomUUID(), 64), edits: [{ find: "x", replace: "y" }],
    afterContent: "y", diff: "--- a\n+++ b", rationale: "TEST", assumptions: "TEST", idempotencyKey: randomUUID(), ...extra,
  })
  const draft = (f: F, extra: Partial<DeliveryDraft> = {}) => run(Effect.flatMap(GrowthDeliveryRepository, r => r.draft(f.session, f.businessId, f.opportunity.id, "OPERATOR", draftOf(f, extra))))
  const probe = async (sql: string, params: unknown[]) => {
    const client = await pool.connect()
    try { await client.query("BEGIN"); await client.query(sql, params); return true } catch { return false } finally { await client.query("ROLLBACK"); client.release() }
  }

  it("delivers only approved opportunities and only allowed content paths", async () => {
    const f = await fixture()
    await expect(draft(f)).rejects.toMatchObject({ reason: "OpportunityNotApproved" })
    await approveOpportunity(f)
    for (const filePath of ["docs/home.md", "content/.github/x.md", "content/home.tsx", "../content/home.md"]) await expect(draft(f, { filePath })).rejects.toBeDefined()
    const d = await draft(f)
    expect(d).toMatchObject({ state: "DRAFTED", revision: 1, filePath: "content/home.md" })
    await expect(pool.query("UPDATE growth_deliveries SET after_content='z' WHERE id=$1", [d.id])).rejects.toThrow("append-only")
    await expect(pool.query("DELETE FROM growth_delivery_events WHERE delivery_id=$1", [d.id])).rejects.toThrow("append-only")
  })

  it("matches the pure delivery table for every state reachable without GitHub records", async () => {
    const f = await fixture(); await approveOpportunity(f)
    const actors: DeliveryActor[] = ["OPERATOR", "ASSISTANT", "DELIVERY_SYSTEM"]
    for (const from of ["DRAFTED", "APPROVED_FOR_PR", "REJECTED"] as const) {
      const d = await draft(f)
      if (from !== "DRAFTED") await run(Effect.flatMap(GrowthDeliveryRepository, r => r.decide(f.session, f.businessId, d.id,
        { approve: from === "APPROVED_FOR_PR", reviewedPatchSha256: d.patchSha256, expectedRevision: 1, reason: "TEST", idempotencyKey: randomUUID() })))
      const revision = from === "DRAFTED" ? 2 : 3
      for (const to of DeliveryState.literals) for (const actor of actors) {
        // Give each state the detail it requires where no external record is needed.
        const detail = to === "APPROVED_FOR_PR" ? { approvedPatchSha256: d.patchSha256 } : {}
        const accepted = await probe("INSERT INTO growth_delivery_events(delivery_id,business_id,revision,state,actor,user_id,reason,detail,request_key) VALUES($1,$2,$3,$4,$5,$6,'TEST probe',$7,$8)",
          [d.id, f.businessId, revision, to, actor, f.session.userId, JSON.stringify(detail), randomUUID()])
        // PR_OPENED needs a confirmed attempt: refused without one, shown accepted by the API tests.
        expect(accepted, `${from} -> ${to} by ${actor}`).toBe(canTransitionDelivery(from, to, actor) && to !== "PR_OPENED")
      }
    }
  })

  it("refuses unsupported claims: opened without a confirmed attempt, merged without a commit, deployed without labelled evidence", async () => {
    const f = await fixture(); await approveOpportunity(f)
    const d = await draft(f)
    await expect(run(Effect.flatMap(GrowthDeliveryRepository, r => r.decide(f.session, f.businessId, d.id,
      { approve: true, reviewedPatchSha256: "0".repeat(64), expectedRevision: 1, reason: "TEST", idempotencyKey: randomUUID() })))).rejects.toMatchObject({ reason: "ReviewedPatchMismatch" })
    expect(await probe("INSERT INTO growth_delivery_events(delivery_id,business_id,revision,state,actor,user_id,reason,detail,request_key) VALUES($1,$2,2,'APPROVED_FOR_PR','OPERATOR',$3,'x',$4,$5)",
      [d.id, f.businessId, f.session.userId, JSON.stringify({ approvedPatchSha256: "0".repeat(64) }), randomUUID()])).toBe(false)
    await run(Effect.flatMap(GrowthDeliveryRepository, r => r.decide(f.session, f.businessId, d.id,
      { approve: true, reviewedPatchSha256: d.patchSha256, expectedRevision: 1, reason: "TEST", idempotencyKey: randomUUID() })))
    expect(await probe("INSERT INTO growth_delivery_events(delivery_id,business_id,revision,state,actor,user_id,reason,detail,request_key) VALUES($1,$2,3,'PR_OPENED','DELIVERY_SYSTEM',$3,'x',$4,$5)",
      [d.id, f.businessId, f.session.userId, JSON.stringify({ prNumber: 1, prUrl: "https://github.com/acme/x/pull/1", commitSha: "a".repeat(40) }), randomUUID()])).toBe(false)
    // The opportunity cannot enter delivery without a delivery that opened a pull request.
    expect(await probe("INSERT INTO growth_opportunity_events(opportunity_id,business_id,revision,status,actor,user_id,reason,request_key) VALUES($1,$2,3,'IN_DELIVERY','DELIVERY_SYSTEM',$3,'x',$4)",
      [f.opportunity.id, f.businessId, f.session.userId, randomUUID()])).toBe(false)
    expect(await probe("INSERT INTO growth_opportunity_events(opportunity_id,business_id,revision,status,actor,user_id,reason,request_key,delivery_id) VALUES($1,$2,3,'IN_DELIVERY','DELIVERY_SYSTEM',$3,'x',$4,$5)",
      [f.opportunity.id, f.businessId, f.session.userId, randomUUID(), d.id])).toBe(false)
    // Verified action needs a merge GitHub confirmed; measured outcomes stay closed.
    expect(await probe("INSERT INTO growth_opportunity_evidence(opportunity_id,business_id,type,reference_kind,reference_id,note) VALUES($1,$2,'VERIFIED_ACTION','GROWTH_DELIVERY',$3,'x')",
      [f.opportunity.id, f.businessId, d.id])).toBe(false)
    expect(await probe("INSERT INTO growth_opportunity_evidence(opportunity_id,business_id,type,reference_kind,reference_id,note) VALUES($1,$2,'MEASURED_OUTCOME','GROWTH_DELIVERY',$3,'x')",
      [f.opportunity.id, f.businessId, d.id])).toBe(false)

    // With a confirmed attempt the same chain is accepted, then merge needs GitHub's commit and deployment needs labelled evidence.
    const claim = await run(Effect.flatMap(GrowthDeliveryRepository, r => r.claimAttempt(f.session, f.businessId, d.id, randomUUID())))
    expect(claim.kind).toBe("claimed")
    const second = await probe("INSERT INTO growth_delivery_attempts(delivery_id,business_id,request_key,state,head_branch,requested_by_user_id) VALUES($1,$2,$3,'CLAIMED',$4,$5)",
      [d.id, f.businessId, randomUUID(), `openrecord/growth-${d.id}`, f.session.userId])
    expect(second).toBe(false)
    if (claim.kind !== "claimed") return
    const opened = await run(Effect.flatMap(GrowthDeliveryRepository, r => r.completeAttempt(f.session, f.businessId, d.id, claim.attempt.id,
      { state: "SUCCEEDED", commitSha: "c".repeat(40), prNumber: 7, prUrl: `https://github.com/acme/${f.repo}/pull/7` })))
    expect(opened.state).toBe("PR_OPENED")
    await expect(pool.query("UPDATE growth_delivery_attempts SET state='CLAIMED' WHERE id=$1", [claim.attempt.id])).rejects.toThrow("cannot become")
    await expect(pool.query("DELETE FROM growth_delivery_attempts WHERE id=$1", [claim.attempt.id])).rejects.toThrow("keep their history")
    expect(await probe("INSERT INTO growth_delivery_events(delivery_id,business_id,revision,state,actor,user_id,reason,detail,request_key) VALUES($1,$2,$3,'PR_MERGED','DELIVERY_SYSTEM',$4,'x','{}',$5)",
      [d.id, f.businessId, opened.revision + 1, f.session.userId, randomUUID()])).toBe(false)
    const merged = await run(Effect.flatMap(GrowthDeliveryRepository, r => r.recordPullRequest(f.session, f.businessId, d.id, { state: "MERGED", mergeCommitSha: "d".repeat(40), mergedAt: null })))
    expect(merged.state).toBe("PR_MERGED")
    for (const detail of [{}, { provenance: "AGENT_SAID", url: "https://product.test/", observedAt: "2026-10-19T00:00:00Z" }, { provenance: "OPERATOR_ATTESTED", url: "ftp://x", observedAt: "2026-10-19T00:00:00Z" }]) {
      expect(await probe("INSERT INTO growth_delivery_events(delivery_id,business_id,revision,state,actor,user_id,reason,detail,request_key) VALUES($1,$2,$3,'DEPLOYMENT_VERIFIED','OPERATOR',$4,'x',$5,$6)",
        [d.id, f.businessId, merged.revision + 1, f.session.userId, JSON.stringify(detail), randomUUID()])).toBe(false)
    }
    // An agent cannot attest deployment even with labelled evidence.
    expect(await probe("INSERT INTO growth_delivery_events(delivery_id,business_id,revision,state,actor,user_id,reason,detail,request_key) VALUES($1,$2,$3,'DEPLOYMENT_VERIFIED','ASSISTANT',$4,'x',$5,$6)",
      [d.id, f.businessId, merged.revision + 1, f.session.userId, JSON.stringify({ provenance: "OPERATOR_ATTESTED", url: "https://product.test/", observedAt: "2026-10-19T00:00:00Z" }), randomUUID()])).toBe(false)
  })

  it("keeps a repository with one account and stays readable after migration replay", async () => {
    const f = await fixture(), other = await fixture()
    await expect(pool.query("INSERT INTO growth_delivery_targets(business_id,provider,owner,repository,base_branch,allowed_paths,created_by_user_id,request_key) VALUES($1,'GITHUB','acme',$2,'main',ARRAY['content/'],$3,$4)",
      [other.businessId, f.repo, other.session.userId, randomUUID()])).rejects.toThrow("another account")
    await expect(pool.query("INSERT INTO growth_delivery_targets(business_id,provider,owner,repository,base_branch,allowed_paths,created_by_user_id,request_key) VALUES($1,'GITHUB','acme',$2,'main',ARRAY['/'],$3,$4)",
      [other.businessId, `x-${randomUUID().slice(0, 6)}`, other.session.userId, randomUUID()])).rejects.toThrow("content scope")
    await expect(run(Effect.flatMap(GrowthDeliveryRepository, r => r.connect(other.session, other.businessId,
      { owner: "ACME", repository: f.repo.toUpperCase(), baseBranch: "main", allowedPaths: ["content/"], idempotencyKey: randomUUID() })))).rejects.toMatchObject({ reason: "RepositoryInAnotherAccount" })
    await expect(run(Effect.flatMap(GrowthDeliveryRepository, r => r.get(other.session.accountId, f.businessId, randomUUID())))).rejects.toMatchObject({ reason: "GrowthNotFound" })
    await approveOpportunity(f)
    const d = await draft(f)
    await migrate(url)
    expect(await run(Effect.flatMap(GrowthDeliveryRepository, r => r.get(f.session.accountId, f.businessId, d.id)))).toEqual(d)
  })
})
