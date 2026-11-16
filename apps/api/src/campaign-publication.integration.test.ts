import { randomUUID } from "node:crypto"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { HttpApp, HttpRouter } from "@effect/platform"
import { PgClient } from "@effect/sql-pg"
import { Effect, Layer, Redacted, Schema } from "effect"
import pg from "pg"
import { AuthRepositoryLive, BusinessRepositoryLive } from "@openrecord/db"
import { campaignPublicationApi, bindCampaignArtifact, prepareCampaignPublication, campaignDeliveryProgress, dispatchCampaignPublication, pendingCampaignPublications } from "./campaign-publication.js"
import { createArtifact, dispatchArtifact, reviseArtifact } from "./artifacts.js"
import { draftMarketingCampaign } from "./campaign-agent.js"
import { requireSession } from "./router.js"
import { campaignResults, campaignResultsApi, dispatchCampaignResults, pendingCampaignReviews } from "./campaign-results.js"
import { channelsApi, createCampaignLink } from "./campaign-channels.js"
import { runConversation } from "./agent.js"
import { memoryJournal } from "./agent-run.js"

const url = process.env["TEST_DATABASE_URL"] ?? ""
const suite = url ? describe : describe.skip
const PAGE = '<!doctype html><html><head><style>h1{color:navy}</style></head><body><h1>Wedding cakes in Bandung</h1><p>Tell us about your wedding.</p><script>fetch("/api/auth/me")</script><form action="https://evil.test">Bad form</form></body></html>'
// The same page without its own form: scripts are only a warning, so this one can be approved.
const CLEAN = PAGE.replace('<form action="https://evil.test">Bad form</form>', "")
const EMAIL_TASK = "7d9b6a3e-5c1f-4a2b-9e8d-1f2a3b4c5d6e"
suite("marketing P0: exact campaign artifact, prelaunch conversion, approval and live inquiry", () => {
  const layer = Layer.mergeAll(AuthRepositoryLive, BusinessRepositoryLive).pipe(Layer.provideMerge(PgClient.layer({ url: Redacted.make(url) })))
  const withSession = <A, E, R>(run: (s: import("@openrecord/db").Session) => Effect.Effect<A, E, R>) => Effect.flatMap(requireSession, ({ session }) => run(session))
  const web = HttpApp.toWebHandlerLayer(HttpRouter.concat(campaignPublicationApi(withSession), HttpRouter.concat(campaignResultsApi(withSession), channelsApi(withSession))), layer)
  let pool: pg.Pool
  beforeAll(() => { pool = new pg.Pool({ connectionString: url }) })
  afterAll(async () => { await web.dispose(); await pool.end() })
  afterEach(() => vi.unstubAllEnvs())
  const run = <A, E>(effect: Effect.Effect<A, E, import("@effect/sql").SqlClient.SqlClient | import("@openrecord/db").BusinessRepository>) => Effect.runPromise(effect.pipe(Effect.provide(layer)))
  const fixture = async (content = CLEAN) => {
    vi.stubEnv("GA4_TOKEN_ENCRYPTION_KEYS", `k1:${Buffer.alloc(32, 7).toString("base64")}`)
    vi.stubEnv("CAMPAIGN_PUBLIC_BASE_URL", "http://localhost:3001")
    const accountId = String((await pool.query("INSERT INTO accounts(name) VALUES('TEST P0') RETURNING id")).rows[0].id)
    const userId = String((await pool.query("INSERT INTO users(email,password_hash) VALUES($1,'TEST') RETURNING id", [`p0-${randomUUID()}@example.test`])).rows[0].id)
    await pool.query("INSERT INTO account_users(account_id,user_id) VALUES($1,$2)", [accountId, userId])
    const businessId = String((await pool.query("INSERT INTO businesses(account_id,name) VALUES($1,'TEST Wedding Cakes') RETURNING id", [accountId])).rows[0].id)
    const sid = String((await pool.query("INSERT INTO sessions(account_id,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour') RETURNING id", [accountId,userId])).rows[0].id)
    const ctx = { accountId, userId, businessId }
    const call = (method: string, path: string, body?: unknown, headers: Record<string,string> = {}) => web.handler(new Request(`http://localhost${path}`, { method, headers: { cookie: `or_session=${sid}`, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }))
    const draft = await run(draftMarketingCampaign(ctx, { title: "Wedding inquiries", goal: "More wedding cake inquiries", audience: "Couples planning a wedding", offer: "Wedding cake consultation", message: "A cake designed for your wedding", hypothesis: "Specific wedding information may increase inquiries", deliverables: [{ title: "Wedding landing page", channel: "WEBSITE", content: "A proposed draft, not delivery" }] }))
    const campaign = Schema.decodeUnknownSync(Schema.Struct({ campaignId: Schema.UUID, revision: Schema.Number, tasks: Schema.Array(Schema.Struct({ id: Schema.UUID })) }))(draft.data)
    const { artifact } = await run(createArtifact(ctx, { kind: "LANDING_PAGE", format: "HTML", title: "Wedding cakes", content }, "ASSISTANT"))
    const bind = () => run(bindCampaignArtifact(ctx, { campaignId: campaign.campaignId, campaignRevision: campaign.revision, taskId: campaign.tasks[0]!.id, artifactId: artifact.id, artifactVersion: artifact.version }))
    const binding = await bind()
    const publication = await run(prepareCampaignPublication(ctx, { bindingId: binding.bindingId, ctaLabel: "Ask about wedding cakes", privacyNotice: "The bakery uses your email to respond to this inquiry. Details are retained for 30 days." }))
    const row = (await pool.query("SELECT p.*,b.content_digest,b.artifact_version FROM campaign_publications p JOIN campaign_artifact_bindings b ON b.id=p.binding_id WHERE p.id=$1", [publication.publicationId])).rows[0]
    const base = `/api/businesses/${businessId}/campaign-publications/${publication.publicationId}`
    const approval = { artifactVersion: row.artifact_version, contentDigest: row.content_digest, destination: row.destination }
    const test = async () => {
      const r = await call("POST", `${base}/test`, {})
      expect(r.status).toBe(200)
      const data = Schema.decodeUnknownSync(Schema.Struct({ testUrl: Schema.String }))(await r.json())
      const u = new URL(data.testUrl)
      const response = await web.handler(new Request(`http://localhost${u.pathname}${u.search}`))
      expect(response.status).toBe(200)
      return { response, ticket: u.searchParams.get("test")! }
    }
    const submit = (ticket: string, email = "test@example.test") => web.handler(new Request(`http://localhost/p/${row.page_token}/inquiries`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ ticket, email, message: "A wedding cake for June", consent: "yes" }) }))
    return { ctx, campaign, artifact, bind, binding, publication, row, base, call, approval, test, submit }
  }
  it("requires an actual test submission, publishes only the reviewed revision and records private production inquiries once", async () => {
    const f = await fixture()
    expect((await web.handler(new Request(`http://localhost/p/${f.row.page_token}`))).status).toBe(404)
    expect((await f.call("POST", `${f.base}/approve`, f.approval)).status).toBe(409)
    const test = await f.test()
    const shell = await test.response.text()
    expect(shell).toContain('iframe sandbox')
    expect(shell).toContain('name="consent"')
    expect(shell).not.toContain('<script>')
    const frame = await web.handler(new Request(`http://localhost/p/${f.row.page_token}/content?test=${test.ticket}`))
    expect(frame.headers.get("content-security-policy")).toContain("sandbox;")
    expect(frame.headers.get("content-security-policy")).toContain("form-action 'none'")
    expect(await frame.text()).toContain("Wedding cakes in Bandung")
    expect((await f.submit(test.ticket)).status).toBe(200)
    expect((await f.submit(test.ticket)).status).toBe(200)
    expect((await f.call("POST", `${f.base}/approve`, { ...f.approval, contentDigest: "0".repeat(64) })).status).toBe(409)
    const approved = await Promise.all([f.call("POST", `${f.base}/approve`, f.approval), f.call("POST", `${f.base}/approve`, f.approval)])
    expect(approved.every(r => r.status === 200)).toBe(true)
    const live = await web.handler(new Request(`http://localhost/p/${f.row.page_token}`))
    expect(live.status).toBe(200)
    const ticket = (await live.text()).match(/name="ticket" value="([^"]+)"/)![1]!
    const posts = await Promise.all([f.submit(ticket, "couple@example.test"), f.submit(ticket, "couple@example.test")])
    expect(posts.every(r => r.status === 200)).toBe(true)
    const progress = await run(campaignDeliveryProgress(f.ctx, f.campaign.campaignId))
    expect(progress.deliverables[0]).toMatchObject({ state: "LIVE", inquiries: 1, trackingTested: true, liveUrl: f.row.destination })
    expect(JSON.stringify(progress)).not.toContain("couple@example.test")
    const stored = (await pool.query("SELECT purpose,contact_ciphertext FROM campaign_inquiries WHERE publication_id=$1 ORDER BY purpose", [f.publication.publicationId])).rows
    expect(stored).toHaveLength(2)
    expect(stored.find(r => r.purpose === "TEST").contact_ciphertext).toBeNull()
    expect(stored.find(r => r.purpose === "PRODUCTION").contact_ciphertext).not.toContain("couple@example.test")
    const contacts = await f.call("GET", `${f.base}/inquiries`)
    expect(await contacts.text()).toContain("couple@example.test")
    await pool.query("UPDATE campaign_inquiries SET expires_at=now()-interval '1 second' WHERE publication_id=$1", [f.publication.publicationId])
    expect(await (await f.call("GET", `${f.base}/inquiries`)).text()).not.toContain("couple@example.test")
    expect((await run(campaignDeliveryProgress(f.ctx, f.campaign.campaignId))).deliverables[0]?.inquiries).toBe(1)
    expect((await f.call("POST", `${f.base}/withdraw`, {})).status).toBe(200)
    expect((await web.handler(new Request(`http://localhost/p/${f.row.page_token}`))).status).toBe(404)
    expect((await f.call("POST", `${f.base}/approve`, f.approval)).status).toBe(409)
  })
  it("refuses stale artifacts, cross-tenant controls, forged tickets and origin attacks", async () => {
    const f = await fixture(), other = await fixture()
    expect((await other.call("POST", `${f.base}/test`, {})).status).toBe(404)
    expect((await f.call("POST", `${f.base}/approve`, f.approval, { origin: "https://evil.test" })).status).toBe(403)
    expect((await f.submit("x".repeat(43))).status).toBe(409)
    const t = await f.test(); await f.submit(t.ticket)
    await run(reviseArtifact(f.ctx, { artifactId: f.artifact.id, content: PAGE.replace("Bandung", "Jakarta") }, "OPERATOR"))
    expect((await f.call("POST", `${f.base}/approve`, f.approval)).status).toBe(409)
    expect((await run(campaignDeliveryProgress(f.ctx, f.campaign.campaignId))).deliverables[0]?.state).toBe("NEEDS_REVISION")
    const before = (await pool.query("SELECT count(*) FROM campaign_publications WHERE business_id=$1", [f.ctx.businessId])).rows[0].count
    expect(await run(Effect.flip(prepareCampaignPublication(f.ctx, { bindingId: f.binding.bindingId, ctaLabel: "Publish", privacyNotice: "Reply to inquiries" })))).toMatchObject({ reason: "StaleBinding" })
    expect((await pool.query("SELECT count(*) FROM campaign_publications WHERE business_id=$1", [f.ctx.businessId])).rows[0].count).toBe(before)
    await expect(pool.query("UPDATE campaign_artifact_bindings SET content_digest=$2 WHERE id=$1", [f.binding.bindingId, "0".repeat(64)])).rejects.toThrow(/append-only/)
  })
  it("blocks approval when the pre-launch checks find a form that cannot submit, and shows warnings", async () => {
    const f = await fixture(PAGE)
    const decisions = await run(pendingCampaignPublications(f.ctx.accountId, f.ctx.businessId))
    const mine = decisions.find(d => d["id"] === f.publication.publicationId)!
    expect(mine["blocking"]).toBe(1)
    expect(JSON.stringify(mine["checks"])).toContain("FORM_CANNOT_SUBMIT")
    expect(JSON.stringify(mine["checks"])).toContain("SCRIPT_WILL_NOT_RUN")
    const t = await f.test(); await f.submit(t.ticket)
    const refused = await f.call("POST", `${f.base}/approve`, f.approval)
    expect(refused.status).toBe(409)
    expect(await refused.json()).toMatchObject({ reason: "ChecksBlocking" })
    expect((await run(campaignDeliveryProgress(f.ctx, f.campaign.campaignId))).deliverables[0]).toMatchObject({ state: "NEEDS_FIXES" })
  })
  it("reads live results honestly and only lets a review judge once the evidence is enough", async () => {
    const f = await fixture()
    const t = await f.test(); await f.submit(t.ticket)
    expect((await f.call("POST", `${f.base}/approve`, f.approval)).status).toBe(200)
    // Test views never count; live views do.
    await web.handler(new Request(`http://localhost/p/${f.row.page_token}?test=${t.ticket}`))
    for (let i = 0; i < 3; i++) await web.handler(new Request(`http://localhost/p/${f.row.page_token}`))
    const live = await (await web.handler(new Request(`http://localhost/p/${f.row.page_token}`))).text()
    await f.submit(live.match(/name="ticket" value="([^"]+)"/)![1]!, "lead@example.test")
    const early = await run(campaignResults(f.ctx, f.campaign.campaignId))
    expect(early.totals).toEqual({ views: 4, inquiries: 1 })
    expect(early.pages[0]).toMatchObject({ daysLive: 1, inquiryRate: 0.25, last7: { views: 4, inquiries: 1 } })
    expect(early.sufficiency.sufficient).toBe(false)
    expect(JSON.stringify(early)).not.toContain("lead@example.test")
    const review = (verdict: string) => run(Effect.either(dispatchCampaignResults(f.ctx, "propose_campaign_review", { campaignId: f.campaign.campaignId, verdict, summary: "One inquiry in a day.", nextExperiment: { hypothesis: "A shorter page converts more visitors", change: "Cut the comparison table" } })))
    const tooSoon = await review("KEEP")
    expect(tooSoon._tag === "Left" && (tooSoon.left as { reason?: string }).reason).toBe("EvidenceInsufficient")
    const honest = await review("INCONCLUSIVE")
    expect(honest._tag).toBe("Right")
    const waiting = await run(pendingCampaignReviews(f.ctx.accountId, f.ctx.businessId))
    expect(waiting).toHaveLength(1)
    expect(waiting[0]).toMatchObject({ verdict: "INCONCLUSIVE", evidenceSufficient: false })
    // The stored evidence is the server's reading, not the agent's summary.
    expect((waiting[0]!["evidence"] as { totals: unknown }).totals).toEqual({ views: 4, inquiries: 1 })
    const second = await review("INCONCLUSIVE")
    expect(second._tag === "Right" && (second.right.data as { reused: boolean }).reused).toBe(true)
    const id = String(waiting[0]!["id"])
    expect((await f.call("POST", `/api/businesses/${f.ctx.businessId}/campaign-reviews/${id}/approve`, {}, { origin: "https://evil.test" })).status).toBe(403)
    expect((await (await fixture()).call("POST", `/api/businesses/${f.ctx.businessId}/campaign-reviews/${id}/approve`, {})).status).toBe(404)
    expect((await f.call("POST", `/api/businesses/${f.ctx.businessId}/campaign-reviews/${id}/approve`, {})).status).toBe(200)
    expect((await f.call("POST", `/api/businesses/${f.ctx.businessId}/campaign-reviews/${id}/approve`, {})).status).toBe(409)
    // A week later with real traffic, a verdict can be proposed; the campaign's live page is not made stale by a review.
    // Published pages are immutable by trigger; backdate this one on a single connection with triggers off.
    const client = await pool.connect()
    try {
      await client.query("SET session_replication_role = replica")
      await client.query("UPDATE campaign_publications SET published_at=now()-interval '9 days' WHERE id=$1", [f.publication.publicationId])
    } finally { await client.query("RESET session_replication_role"); client.release() }
    await pool.query("INSERT INTO campaign_page_days(publication_id,day,views) VALUES($1,current_date-5,200)", [f.publication.publicationId])
    const later = await run(campaignResults(f.ctx, f.campaign.campaignId))
    expect(later.sufficiency.sufficient).toBe(true)
    expect(later.latestReview).toMatchObject({ verdict: "INCONCLUSIVE", status: "APPROVED" })
    expect((await review("CHANGE"))._tag).toBe("Right")
    expect((await run(campaignDeliveryProgress(f.ctx, f.campaign.campaignId))).deliverables[0]?.state).toBe("LIVE")
  })
  it("traces an email the owner sends to the page's views and inquiries, and records the owner's report", async () => {
    const f = await fixture()
    // The same campaign gets an email deliverable next to its page.
    await pool.query(`UPDATE marketing_campaigns SET brief=jsonb_set(brief,'{tasks}', brief->'tasks' || jsonb_build_array(jsonb_build_object('id',$2::text,'title','Outreach email','channel','EMAIL','owner','','due','','status','TODO','note',''))) WHERE id=$1`, [f.campaign.campaignId, EMAIL_TASK])
    expect(await run(Effect.flip(createCampaignLink(f.ctx, { publicationId: f.publication.publicationId, taskId: f.campaign.tasks[0]!.id })))).toMatchObject({ reason: "NotASendableDeliverable" })
    const link = await run(createCampaignLink(f.ctx, { publicationId: f.publication.publicationId, taskId: EMAIL_TASK }))
    expect(link.url).toMatch(/\?s=[A-Za-z0-9]{10}$/)
    expect((await run(createCampaignLink(f.ctx, { publicationId: f.publication.publicationId, taskId: EMAIL_TASK }))).url).toBe(link.url)
    const t = await f.test(); await f.submit(t.ticket)
    expect((await f.call("POST", `${f.base}/approve`, f.approval)).status).toBe(200)
    const path = new URL(link.url).pathname + new URL(link.url).search
    await web.handler(new Request(`http://localhost${path}`))
    const viaEmail = await (await web.handler(new Request(`http://localhost${path}`))).text()
    await f.submit(viaEmail.match(/name="ticket" value="([^"]+)"/)![1]!, "from-email@example.test")
    const direct = await (await web.handler(new Request(`http://localhost/p/${f.row.page_token}`))).text()
    await f.submit(direct.match(/name="ticket" value="([^"]+)"/)![1]!, "direct@example.test")
    // A made-up source code counts as an ordinary visit.
    await web.handler(new Request(`http://localhost/p/${f.row.page_token}?s=AAAAAAAAAA`))
    const results = await run(campaignResults(f.ctx, f.campaign.campaignId))
    expect(results.pages[0]!.sources).toEqual([
      { label: "Outreach email", views: 2, inquiries: 1 },
      { label: "Other visits (no tracked link)", views: 2, inquiries: 1 },
    ])
    // The owner reports it sent; the agent has no tool for that.
    const report = await f.call("POST", `/api/businesses/${f.ctx.businessId}/campaign-handoffs`, { campaignId: f.campaign.campaignId, taskId: EMAIL_TASK, status: "SENT" })
    expect(report.status).toBe(200)
    expect((await report.json() as { handoff: { reportedBy: string } }).handoff.reportedBy).toBe("OWNER")
    expect((await f.call("POST", `/api/businesses/${f.ctx.businessId}/campaign-handoffs`, { campaignId: f.campaign.campaignId, taskId: f.campaign.tasks[0]!.id, status: "SENT" })).status).toBe(409)
    expect((await (await fixture()).call("POST", `/api/businesses/${f.ctx.businessId}/campaign-handoffs`, { campaignId: f.campaign.campaignId, taskId: EMAIL_TASK, status: "SENT" })).status).toBe(404)
    const { AGENT_TOOL_SPECS } = await import("./agent-registry.js")
    expect(AGENT_TOOL_SPECS.map(x => x.declaration.name).filter(n => /handoff|mark_sent|send_/.test(n))).toEqual([])
  })
  it("hands an email deliverable to the owner instead of offering it as a hosted page", async () => {
    const f = await fixture()
    const draft = await run(draftMarketingCampaign(f.ctx, { title: "Wedding email", goal: "More wedding cake inquiries", deliverables: [{ title: "Email to past couples", channel: "EMAIL", content: "Draft pending" }] }))
    const campaign = Schema.decodeUnknownSync(Schema.Struct({ campaignId: Schema.UUID, revision: Schema.Number, tasks: Schema.Array(Schema.Struct({ id: Schema.UUID })) }))(draft.data)
    const { artifact } = await run(createArtifact(f.ctx, { kind: "EMAIL", format: "MARKDOWN", title: "Past couples email", content: "Hello again. Planning another celebration?" }, "ASSISTANT"))
    const binding = await run(bindCampaignArtifact(f.ctx, { campaignId: campaign.campaignId, campaignRevision: campaign.revision, taskId: campaign.tasks[0]!.id, artifactId: artifact.id, artifactVersion: artifact.version }))
    expect((await run(campaignDeliveryProgress(f.ctx, campaign.campaignId))).deliverables[0]).toMatchObject({ state: "DRAFT_READY", channel: "EMAIL", nextAction: "Ready for the owner to send or post; give it a tracked link to the campaign page first (create_campaign_link)" })
    expect(await run(Effect.flip(prepareCampaignPublication(f.ctx, { bindingId: binding.bindingId, ctaLabel: "Reply", privacyNotice: "Used to reply" })))).toMatchObject({ reason: "NotAWebsiteDeliverable" })
  })
  it("a normal conversation saves usable campaign work and binds the artifact without a repository", async () => {
    const f = await fixture()
    let step = 0
    let campaign: { campaignId: string; revision: number; tasks: readonly { id: string }[] } | undefined
    let artifact: { artifactId: string } | undefined
    const { journal } = memoryJournal()
    const reply = await Effect.runPromise(runConversation({
      message: "Our site is https://bakery.example.test. Get more wedding inquiries. Prepare the campaign and page.", history: [], journal,
      model: () => {
        const calls = [
          { name: "record_campaign_draft", args: { title: "Wedding consultation campaign", goal: "More wedding inquiries", deliverables: [{ title: "Consultation page", channel: "WEBSITE", content: "Draft pending" }] } },
          { name: "create_artifact", args: { kind: "LANDING_PAGE", format: "HTML", title: "Wedding consultation", content: PAGE.replace("Wedding cakes in Bandung", "Plan your wedding cake") } },
          { name: "bind_campaign_artifact", args: { campaignId: campaign?.campaignId, campaignRevision: campaign?.revision, taskId: campaign?.tasks[0]?.id, artifactId: artifact?.artifactId, artifactVersion: 1 } },
        ]
        const next = calls[step++]
        return Effect.succeed({ candidates: [{ finishReason: "STOP", content: { role: "model" as const, parts: next ? [{ functionCall: next }] : [{ text: "Saved your campaign and wedding consultation page. Review the copy; nothing is published." }] } }] })
      },
      dispatch: (name, args) => Effect.gen(function*() {
        if (name === "record_campaign_draft") {
          const result = yield* draftMarketingCampaign(f.ctx, args)
          campaign = yield* Schema.decodeUnknown(Schema.Struct({ campaignId: Schema.String, revision: Schema.Number, tasks: Schema.Array(Schema.Struct({ id: Schema.String })) }))(result.data)
          return result
        }
        if (name === "create_artifact") {
          const result = yield* dispatchArtifact(f.ctx, name, args)
          artifact = yield* Schema.decodeUnknown(Schema.Struct({ artifactId: Schema.String }))(result.data)
          return result
        }
        return yield* dispatchCampaignPublication(f.ctx, name, args)
      }).pipe(Effect.provide(layer)),
    }))
    expect(reply.artifacts).toHaveLength(1)
    expect(reply.reply).toContain("nothing is published")
    expect(campaign).toBeDefined()
    const progress = await run(campaignDeliveryProgress(f.ctx, campaign!.campaignId))
    expect(progress.deliverables[0]).toMatchObject({ state: "DRAFT_READY", artifactId: artifact!.artifactId, channel: "WEBSITE", nextAction: "Prepare the linked artifact for publication" })
    expect((await pool.query("SELECT count(*) FROM campaign_publications WHERE business_id=$1 AND status='PUBLISHED'", [f.ctx.businessId])).rows[0].count).toBe("0")
  })
})
