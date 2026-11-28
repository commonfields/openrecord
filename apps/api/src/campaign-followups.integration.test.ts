// Campaign follow-ups against a disposable database: a milestone wakes the
// agent once, only under the person's follow-up permission, within the shared
// daily budget, and turning follow-ups off cancels a running wake.
import { randomUUID } from "node:crypto"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { HttpApp } from "@effect/platform"
import { Effect, Layer, ManagedRuntime, Redacted, Schema } from "effect"
import { PgClient } from "@effect/sql-pg"
import pg from "pg"
import { AuthRepositoryLive, BusinessRepositoryLive } from "@openrecord/db"
import { requireSession } from "./router.js"
import { followupPolicyApi } from "./agent-followup-policy.js"
import { claimFollowup } from "./agent-followups.js"
import { AUTOMATIC_MODEL, ensureAutomaticFollowups } from "./automatic-followups.js"
import { campaignFollowupToolSpecs, claimCampaignFollowup, deliverCampaignFollowup, milestoneMessage } from "./campaign-followups.js"
import { draftMarketingCampaign } from "./campaign-agent.js"
import { createArtifact } from "./artifacts.js"
import { bindCampaignArtifact, prepareCampaignPublication } from "./campaign-publication.js"
import type { Responder } from "./agent-conversations.js"

describe("campaign follow-up authority", () => {
  it("reads stored campaign records only, never prepares, publishes or tests", () => {
    const names = campaignFollowupToolSpecs().map(t => t.declaration.name)
    expect(campaignFollowupToolSpecs().every(t => t.effect === "read")).toBe(true)
    for (const name of ["read_campaign_delivery", "read_marketing_campaigns", "read_campaign_outcome"]) expect(names).toContain(name)
    for (const name of ["prepare_campaign_publication", "open_campaign_prelaunch_test", "bind_campaign_artifact", "create_artifact", "read_web_page", "prepare_wordpress_change"]) expect(names).not.toContain(name)
  })
  it("names the milestone and asks for a report only, in plain sentences", () => {
    const text = milestoneMessage({ milestone: "REVIEW_DUE", campaign_id: randomUUID(), campaign_title: "Migration", milestone_key: "2026-12-21" })
    expect(text).toContain("review date (2026-12-21) was reached")
    expect(text).toContain("do not prepare, publish or approve")
    expect(text).not.toContain("·")
  })
})

const url = process.env["TEST_DATABASE_URL"] ?? ""
const suite = url ? describe : describe.skip
suite("campaign follow-ups (disposable PostgreSQL)", () => {
  let pool: pg.Pool
  const repos = Layer.mergeAll(AuthRepositoryLive, BusinessRepositoryLive).pipe(Layer.provideMerge(PgClient.layer({ url: Redacted.make(url) })))
  const runtime = ManagedRuntime.make(repos)
  const web = HttpApp.toWebHandlerLayer(followupPolicyApi(r => Effect.flatMap(requireSession, ({ session }) => r(session))), repos)
  beforeAll(() => { pool = new pg.Pool({ connectionString: url }) })
  afterAll(async () => { await web.dispose(); await runtime.dispose(); await pool.end() })
  afterEach(() => vi.unstubAllEnvs())

  const fixture = async () => {
    const accountId = String((await pool.query("INSERT INTO accounts(name) VALUES('TEST campaign wakes') RETURNING id")).rows[0].id)
    const userId = String((await pool.query("INSERT INTO users(email,password_hash) VALUES($1,'TEST') RETURNING id", [`wake-${randomUUID()}@example.test`])).rows[0].id)
    await pool.query("INSERT INTO account_users(account_id,user_id) VALUES($1,$2)", [accountId, userId])
    const businessId = String((await pool.query("INSERT INTO businesses(account_id,name) VALUES($1,'TEST Moderation') RETURNING id", [accountId])).rows[0].id)
    const cookie = String((await pool.query("INSERT INTO sessions(id,account_id,user_id,expires_at,token_digest) SELECT u,$1::uuid,$2::uuid,now()+interval '1 hour',encode(sha256(convert_to(u::text,'UTF8')),'hex') FROM gen_random_uuid() u RETURNING id", [accountId, userId])).rows[0].id)
    const conversationId = String((await pool.query("INSERT INTO agent_conversations(account_id,user_id,business_id) VALUES($1,$2,$3) RETURNING id", [accountId, userId, businessId])).rows[0].id)
    const ctx = { accountId, userId, businessId }
    const draft = await runtime.runPromise(draftMarketingCampaign(ctx, { title: "Migration campaign", goal: "More demo requests", deliverables: [{ title: "Migration page", channel: "WEBSITE", content: "Draft pending" }] }))
    const campaign = Schema.decodeUnknownSync(Schema.Struct({ campaignId: Schema.UUID, revision: Schema.Number, tasks: Schema.Array(Schema.Struct({ id: Schema.UUID })) }))(draft.data)
    const grant = (enabled = true) => pool.query(`INSERT INTO growth_investigation_wake_policies(account_id,user_id,business_id,conversation_id,grant_id,enabled,provider,model)
      VALUES($1,$2,$3,$4,$5,$6,'gemini','fixture') RETURNING id, grant_id`, [accountId, userId, businessId, conversationId, randomUUID(), enabled]).then(r => r.rows[0] as { id: string; grant_id: string })
    const mine = async () => {
      // Other suites share the database: claim until this business's wake comes up or nothing is due.
      for (let i = 0; i < 20; i++) {
        const w = await runtime.runPromise(claimCampaignFollowup)
        if (!w || w.business_id === businessId) return w
      }
      return null
    }
    const ageWakes = () => pool.query("UPDATE campaign_wakes SET started_at=started_at - interval '25 hours', status='COMPLETED', finished_at=now() WHERE business_id=$1", [businessId])
    return { accountId, userId, businessId, cookie, conversationId, ctx, campaign, grant, mine, ageWakes }
  }

  it("wakes once per milestone under the granted permission, within the shared daily budget", async () => {
    const f = await fixture()
    await pool.query("UPDATE marketing_campaigns SET brief=jsonb_set(brief,'{reviewDate}',to_jsonb((current_date - 1)::text)) WHERE id=$1", [f.campaign.campaignId])
    // No permission, no wake.
    expect(await f.mine()).toBeNull()
    const policy = await f.grant()
    const wake = await f.mine()
    expect(wake).toMatchObject({ milestone: "REVIEW_DUE", campaign_id: f.campaign.campaignId, grant_id: policy.grant_id, conversation_id: f.conversationId })
    // One wake per day across campaigns and investigations: nothing else is claimed while it counts.
    expect(await f.mine()).toBeNull()
    expect((await runtime.runPromise(claimFollowup))?.policy_id).not.toBe(policy.id)

    // The milestone does not fire again the next day, but a new one does: the page went live.
    await f.ageWakes()
    expect(await f.mine()).toBeNull()
    vi.stubEnv("GA4_TOKEN_ENCRYPTION_KEYS", `k1:${Buffer.alloc(32, 7).toString("base64")}`)
    vi.stubEnv("CAMPAIGN_PUBLIC_BASE_URL", "http://localhost:3001")
    const { artifact } = await runtime.runPromise(createArtifact(f.ctx, { kind: "LANDING_PAGE", format: "HTML", title: "Migration", content: "<h1>Switch in one endpoint</h1>" }, "ASSISTANT"))
    const binding = await runtime.runPromise(bindCampaignArtifact(f.ctx, { campaignId: f.campaign.campaignId, campaignRevision: f.campaign.revision, taskId: f.campaign.tasks[0]!.id, artifactId: artifact.id, artifactVersion: artifact.version }))
    const prepared = await runtime.runPromise(prepareCampaignPublication(f.ctx, { bindingId: binding.bindingId, ctaLabel: "Request a demo", privacyNotice: "Used to reply to your request." }))
    const ticket = randomUUID().replaceAll("-", "").repeat(2)
    await pool.query("INSERT INTO campaign_form_tickets(token_digest,publication_id,purpose,consumed_at) VALUES($1,$2,'TEST',now())", [ticket, prepared.publicationId])
    await pool.query("INSERT INTO campaign_inquiries(publication_id,ticket_digest,purpose) VALUES($1,$2,'TEST')", [prepared.publicationId, ticket])
    await pool.query("UPDATE campaign_publications SET status='PUBLISHED',published_at=now(),decided_at=now(),decided_by_user_id=$2 WHERE id=$1", [prepared.publicationId, f.userId])
    const live = await f.mine()
    expect(live).toMatchObject({ milestone: "PAGE_LIVE", milestone_key: prepared.publicationId })

    // Delivered into the granted conversation as an automatic follow-up, then recorded as done.
    const responder: Responder<never> = () => Effect.succeed({ reply: "The page is live. The email and posts are still yours to send.", citations: [], toolCalls: [], usage: [], provider: "gemini", requestedModel: "fixture" })
    expect(await runtime.runPromise(deliverCampaignFollowup(live!, responder) as Effect.Effect<string, never, never>)).toBe("Success")
    expect((await pool.query("SELECT status FROM campaign_wakes WHERE id=$1", [live!.id])).rows[0].status).toBe("COMPLETED")
    expect(JSON.stringify((await pool.query("SELECT messages FROM agent_conversations WHERE id=$1", [f.conversationId])).rows[0].messages)).toContain("The page is live")
  })

  it("turns follow-ups on by itself for a business in use, delivers on the working model, and keeps a pause", async () => {
    const f = await fixture(), idle = await fixture(), demo = await fixture()
    await pool.query("UPDATE marketing_campaigns SET brief=jsonb_set(brief,'{reviewDate}',to_jsonb((current_date - 1)::text)) WHERE id=$1", [f.campaign.campaignId])
    // Someone used the business: they sent the agent a request there. The demo business is sample data.
    const used = (g: typeof f) => pool.query("INSERT INTO agent_request_jobs(request_id,account_id,user_id,business_id,conversation_id,payload,digest,status) VALUES($1,$2,$3,$4,$5,'{}','TEST','COMPLETED')",
      [randomUUID(), g.accountId, g.userId, g.businessId, g.conversationId])
    await used(f); await used(demo)
    vi.stubEnv("OPENRECORD_DEMO_BUSINESSES", demo.businessId)
    const policyOf = (businessId: string) => pool.query("SELECT id, enabled, automatic, provider, conversation_id FROM growth_investigation_wake_policies WHERE business_id=$1", [businessId]).then(r => r.rows)
    // Other suites share the database: a pass covers at most twenty businesses.
    for (let i = 0; i < 10 && !(await policyOf(f.businessId)).length; i++) await runtime.runPromise(ensureAutomaticFollowups)
    const [policy] = await policyOf(f.businessId)
    expect(policy).toMatchObject({ enabled: true, automatic: true, provider: AUTOMATIC_MODEL })
    expect(policy.conversation_id).not.toBe(f.conversationId)
    expect(await policyOf(idle.businessId)).toEqual([])
    expect(await policyOf(demo.businessId)).toEqual([])
    // Running again never adds a second policy.
    await runtime.runPromise(ensureAutomaticFollowups)
    expect(await policyOf(f.businessId)).toHaveLength(1)

    const wake = await f.mine()
    expect(wake).toMatchObject({ milestone: "REVIEW_DUE", automatic: true, conversation_id: policy.conversation_id })
    // No pinned model: the reply commits on whichever model answered.
    const responder: Responder<never> = () => Effect.succeed({ reply: "The review date passed; nothing is recorded yet.", citations: [], toolCalls: [], usage: [], provider: "claude", requestedModel: "sonnet" })
    expect(await runtime.runPromise(deliverCampaignFollowup(wake!, responder) as Effect.Effect<string, never, never>)).toBe("Success")
    expect(JSON.stringify((await pool.query("SELECT messages FROM agent_conversations WHERE id=$1", [policy.conversation_id])).rows[0].messages)).toContain("nothing is recorded yet")

    // Off is off for the business, and stays off after its chat (and with it the policy) is gone.
    const off = await web.handler(new Request(`http://localhost/api/businesses/${f.businessId}/agent/follow-ups`, { method: "PUT", headers: { "content-type": "application/json", cookie: `or_session=${f.cookie}` }, body: JSON.stringify({ enabled: false }) }))
    expect(off.status).toBe(200)
    expect((await policyOf(f.businessId))[0]).toMatchObject({ enabled: false })
    await pool.query("DELETE FROM agent_conversations WHERE id=$1", [policy.conversation_id])
    expect(await policyOf(f.businessId)).toEqual([])
    await runtime.runPromise(ensureAutomaticFollowups)
    expect(await policyOf(f.businessId)).toEqual([])
  })
  it("stops when the person turns follow-ups off, and never wakes another account's conversation", async () => {
    const f = await fixture(), other = await fixture()
    await pool.query("UPDATE marketing_campaigns SET brief=jsonb_set(brief,'{reviewDate}',to_jsonb((current_date - 1)::text)) WHERE id=$1", [f.campaign.campaignId])
    await other.grant()
    expect((await other.mine())?.business_id).not.toBe(f.businessId)
    await f.grant()
    const wake = await f.mine()
    expect(wake?.conversation_id).toBe(f.conversationId)
    const off = await web.handler(new Request(`http://localhost/api/businesses/${f.businessId}/agent/follow-ups`, { method: "PUT", headers: { "content-type": "application/json", cookie: `or_session=${f.cookie}` }, body: JSON.stringify({ enabled: false }) }))
    expect(off.status).toBe(200)
    expect((await pool.query("SELECT status FROM campaign_wakes WHERE id=$1", [wake!.id])).rows[0].status).toBe("CANCELLED")
    // A wake that lost its permission does not deliver.
    const responder: Responder<never> = () => Effect.succeed({ reply: "This must not commit", citations: [], toolCalls: [], usage: [], provider: "gemini", requestedModel: "fixture" })
    expect(await runtime.runPromise(deliverCampaignFollowup(wake!, responder) as Effect.Effect<string, never, never>)).toBe("Failure")
    expect(JSON.stringify((await pool.query("SELECT messages FROM agent_conversations WHERE id=$1", [f.conversationId])).rows[0].messages)).not.toContain("This must not commit")
  })
})
