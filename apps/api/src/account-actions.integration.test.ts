// Account actions against a scripted Google Business Profile and Google Ads:
// prepared without changing anything (ad changes validated by Google first),
// carried out once on approval and read back, refused when the target changed
// since, undone in one click, limited (budget at most doubles, shared budgets
// and other sites refused, new ads paused), and scoped to the account.
// Passing here is a stand-in result, never a live platform result.
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { HttpApp, HttpRouter } from "@effect/platform"
import { Effect, Either, Exit, Layer, Redacted, Scope } from "effect"
import { PgClient } from "@effect/sql-pg"
import pg from "pg"
import { AuthRepositoryLive, RecordRepositoryLive } from "@openrecord/db"
import { AdsProvider, adsConfigFromEnv } from "@openrecord/ads"
import { accountActionsApi, dispatchAccountAction } from "./account-actions.js"
import { growthApi } from "./growth-routes.js"
import { requireSession, RepoLayers } from "./router.js"
import { decisionApi } from "./decision-routes.js"

const url = process.env["TEST_DATABASE_URL"] ?? ""
const product = {
  name: "TEST Actions Salon", websiteUrl: "https://www.northstar-salon.com", engagement: "CLIENT", category: "TEST services", audience: "TEST locals", valueProposition: "TEST positioning", goalStatement: "Increase bookings",
  metric: { conversionKind: "BOOKING", label: "Bookings", sourceKind: "GA4_AGGREGATE_EXPORT", sourceIdentity: "TEST GA4 property", eventName: "book_appointment", reportingTimeZone: "UTC", propertyRef: "properties/111111", countingSemantics: "EVENT_COUNT", unit: "COUNT", currency: null },
}

const suite = url ? describe : describe.skip
suite("approved account actions (scripted Google Business Profile and Google Ads)", () => {
  let pool: pg.Pool, scope: Scope.CloseableScope
  const repos = Layer.mergeAll(RepoLayers.GrowthRepositoriesLive, RepoLayers.BusinessRepositoryLive, RepoLayers.AgentProposalRepositoryLive, AuthRepositoryLive, RecordRepositoryLive).pipe(Layer.provideMerge(PgClient.layer({ url: Redacted.make(url) })))
  const handlers: Array<{ dispose: () => Promise<void> }> = []
  beforeAll(async () => { pool = new pg.Pool({ connectionString: url }); scope = await Effect.runPromise(Scope.make()); await Effect.runPromise(Layer.buildWithScope(repos, scope)) })
  afterAll(async () => { for (const h of handlers) await h.dispose(); await Effect.runPromise(Scope.close(scope, Exit.void)); await pool.end() })

  const account = async () => {
    const accountId = String((await pool.query("INSERT INTO accounts(name) VALUES('TEST Actions') RETURNING id")).rows[0].id)
    const userId = String((await pool.query("INSERT INTO users(email,password_hash) VALUES($1,'TEST-only') RETURNING id", [`actions-${randomUUID()}@example.test`])).rows[0].id)
    await pool.query("INSERT INTO account_users(account_id,user_id) VALUES($1,$2)", [accountId, userId])
    const cookie = String((await pool.query("INSERT INTO sessions(account_id,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour') RETURNING id", [accountId, userId])).rows[0].id)
    return { accountId, userId, cookie }
  }

  it("prepares, approves once, reads back, refuses stale targets, and undoes", async () => {
    // Scripted Google: platform state the writes change.
    const reviews: Record<string, { comment: string; reply: string | null }> = { r1: { comment: "Waited an hour past my booking", reply: null }, r2: { comment: "Lovely cut", reply: null } }
    const campaigns: Record<string, { status: string; budget: number; shared: boolean }> = { "7": { status: "ENABLED", budget: 20_000_000, shared: false }, "8": { status: "ENABLED", budget: 10_000_000, shared: true } }
    const ads = new Map<string, { status: string; headlines: string[]; descriptions: string[]; finalUrls: string[]; path1?: string; path2?: string }>()
    let corruptAd: "descriptions" | "url" | "path" | null = null
    const writes: string[] = []
    const google = async (input: string, init: RequestInit) => {
      const u = new URL(input), method = init.method ?? "GET"
      const body = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status })
      const review = /\/gbp\/reviews\/accounts\/555\/locations\/9001\/reviews\/(\w+)(\/reply)?$/.exec(u.pathname)
      if (u.pathname === "/gbp/reviews/accounts/555/locations/9001/reviews") return body({ reviews: Object.entries(reviews).map(([id, r]) => ({ reviewId: id, reviewer: { displayName: "Ana" }, starRating: "TWO", comment: r.comment, createTime: "2026-10-30T10:00:00Z", updateTime: "2026-10-30T10:00:00Z", ...(r.reply ? { reviewReply: { comment: r.reply, updateTime: "2026-11-02T10:00:00Z" } } : {}) })) })
      if (review && !review[2]) { const r = reviews[review[1]!]!; return body({ reviewId: review[1], reviewer: { displayName: "Ana" }, starRating: "TWO", comment: r.comment, createTime: "2026-10-30T10:00:00Z", updateTime: "2026-10-30T10:00:00Z", ...(r.reply ? { reviewReply: { comment: r.reply, updateTime: "2026-11-02T10:00:00Z" } } : {}) }) }
      if (review && review[2]) {
        writes.push(`${method} reply ${review[1]}`)
        reviews[review[1]!]!.reply = method === "DELETE" ? null : (JSON.parse(String(init.body)) as { comment: string }).comment
        return method === "DELETE" ? new Response("", { status: 200 }) : body({ comment: reviews[review[1]!]!.reply })
      }
      expect((init.headers as Record<string, string>)["developer-token"]).toBe("DEV-TOKEN")
      if (u.pathname === "/googleads/v21/customers/100/googleAds:search") {
        const q = String((JSON.parse(String(init.body)) as { query: string }).query)
        const one = /campaign\.id = (\d+)/.exec(q)?.[1]
        if (q.includes("FROM campaign ")) return body({ results: Object.entries(campaigns).filter(([id]) => !one || id === one).map(([id, c]) => ({ campaign: { id, name: `Campaign ${id}`, status: c.status, advertisingChannelType: "SEARCH" }, campaignBudget: { resourceName: `customers/100/campaignBudgets/5${id}`, amountMicros: String(c.budget), explicitlyShared: c.shared, period: "DAILY" } })) })
        if (q.includes("FROM ad_group ")) return body({ results: [{ adGroup: { id: "70", name: "Haircuts", status: "ENABLED", type: "SEARCH_STANDARD" } }] })
        if (q.includes("FROM ad_group_ad ")) { const id = /ad_group_ad\.ad\.id = (\d+)/.exec(q)![1]!; const ad = ads.get(id)
          return body({ results: ad ? [{ adGroupAd: { resourceName: `customers/100/adGroupAds/70~${id}`, status: ad.status, policySummary: { approvalStatus: "UNKNOWN" }, ad: { finalUrls: ad.finalUrls, responsiveSearchAd: { headlines: ad.headlines.map(text => ({ text })), descriptions: ad.descriptions.map(text => ({ text })), path1: ad.path1, path2: ad.path2 } } } }] : [] }) }
      }
      const mutate = /^\/googleads\/v21\/customers\/100\/(campaigns|campaignBudgets|adGroupAds):mutate$/.exec(u.pathname)
      if (mutate) {
        const req = JSON.parse(String(init.body)) as { operations: Array<Record<string, any>>; validateOnly?: boolean }
        writes.push(`${req.validateOnly ? "validate" : "mutate"} ${mutate[1]}`)
        if (req.validateOnly) return body({ results: [] })
        const op = req.operations[0]!
        if (mutate[1] === "campaigns") campaigns[op["update"].resourceName.split("/").pop()]!.status = op["update"].status
        if (mutate[1] === "campaignBudgets") campaigns[op["update"].resourceName.split("/").pop().slice(1)]!.budget = Number(op["update"].amountMicros)
        if (mutate[1] === "adGroupAds" && op["create"]) {
          const created = op["create"], rsa = created.ad.responsiveSearchAd
          ads.set("901", { status: created.status, headlines: rsa.headlines.map((h: { text: string }) => h.text),
            descriptions: corruptAd === "descriptions" ? ["Not the approved copy"] : rsa.descriptions.map((d: { text: string }) => d.text),
            finalUrls: corruptAd === "url" ? ["https://other-salon.com/"] : created.ad.finalUrls,
            path1: corruptAd === "path" ? "changed" : rsa.path1, path2: rsa.path2 })
          return body({ results: [{ resourceName: "customers/100/adGroupAds/70~901" }] })
        }
        if (mutate[1] === "adGroupAds" && op["remove"]) { ads.delete(op["remove"].split("~").pop()); return body({ results: [{ resourceName: op["remove"] }] }) }
        return body({ results: [{ resourceName: "ok" }] })
      }
      return body({ error: { status: "NOT_FOUND" } }, 404)
    }
    const config = adsConfigFromEnv({
      ADS_OAUTH_REDIRECT_URI: "https://api.example.test/api/ads/oauth/callback", APP_BASE_URL: "https://app.example.test", ADS_PROVIDER_STAND_IN_URL: "http://127.0.0.1:9/",
      GA4_TOKEN_ENCRYPTION_KEYS: `k1:${Buffer.alloc(32, 5).toString("base64")}`, GOOGLE_OAUTH_CLIENT_ID: "gclient", GOOGLE_OAUTH_CLIENT_SECRET: "GCLIENT-SECRET", GOOGLE_ADS_DEVELOPER_TOKEN: "DEV-TOKEN",
    }, google as typeof fetch)
    expect(config.googleAds.configured && config.googleBusiness.configured).toBe(true)
    const layer = Layer.provideMerge(Layer.succeed(AdsProvider, config), repos)
    const web = HttpApp.toWebHandlerLayer(HttpRouter.concat(decisionApi(r => Effect.flatMap(requireSession, ({ session }) => r(session))), HttpRouter.concat(growthApi(r => Effect.flatMap(requireSession, ({ session }) => r(session))),
      accountActionsApi(r => Effect.flatMap(requireSession, ({ session }) => r(session))))), layer)
    handlers.push(web)
    const seen: string[] = []
    type Acct = Awaited<ReturnType<typeof account>>
    const call = async (acct: Acct, method: string, path: string, body?: unknown) => {
      const r = await web.handler(new Request(`http://localhost${path}`, { method, headers: { "content-type": "application/json", cookie: `or_session=${acct.cookie}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }))
      seen.push(await r.clone().text())
      return r
    }
    const ok = async <T>(r: Promise<Response>): Promise<T> => { const x = await r; if (x.status !== 200) throw new Error(`Expected 200, got ${x.status}: ${await x.text()}`); return await x.json() as T }
    const a = await account(), other = await account()
    const biz = (await ok<{ profile: { businessId: string } }>(call(a, "POST", "/api/growth/products", { ...product, idempotencyKey: randomUUID() }))).profile.businessId

    // The business's own connections, tokens stored as ciphertext.
    const connect = async (provider: string, scopes: string[], externalId: string, extra: { parent?: string; currency?: string }) => {
      const id = String((await pool.query("INSERT INTO ad_connections(account_id, provider, subject, display_name, granted_scopes, connected_by_user_id) VALUES ($1,$2,'777','owner@salon.test',$3,$4) RETURNING id", [a.accountId, provider, scopes, a.userId])).rows[0].id)
      await pool.query("UPDATE ad_connections SET access_ciphertext=$1, access_expires_at=now()+interval '1 hour' WHERE id=$2", [config.cipher!.encrypt("ACCESS-SECRET", `ads:${id}:access`), id])
      await pool.query("INSERT INTO ad_account_bindings(account_id, business_id, connection_id, provider, external_id, name, currency, parent_id, bound_by_user_id) VALUES ($1,$2,$3,$4,$5,'Salon',$6,$7,$8)",
        [a.accountId, biz, id, provider, externalId, extra.currency ?? null, extra.parent ?? null, a.userId])
    }
    await connect("google_business", ["openid", "email", "https://www.googleapis.com/auth/business.manage"], "9001", { parent: "555" })
    await connect("google_ads", ["openid", "email", "https://www.googleapis.com/auth/adwords"], "100", { currency: "USD" })
    const ctx = { accountId: a.accountId, userId: a.userId, businessId: biz }
    const agent = (name: string, args: unknown) => Effect.runPromise(Effect.either(dispatchAccountAction(ctx, name, args)).pipe(Effect.provide(layer)))

    // Review reply: read, prepare (nothing written), approve once, read back, undo.
    const read = await agent("read_reviews", { unansweredOnly: true })
    expect(Either.getOrThrow(read).summary).toBe("2 Google reviews read")
    const prepared = Either.getOrThrow(await agent("prepare_account_action", { kind: "REPLY_TO_REVIEW", reviewId: "r1", reply: "Sorry for the wait, Ana. We now text when we run late; call us to rebook.", rationale: "Unanswered two-star review about waiting." }))
    const actionId = String((prepared.data as { accountActionId: string }).accountActionId)
    const objectiveOf = async () => (await pool.query("SELECT a.objective_goal_id, p.primary_goal_id FROM account_actions a JOIN growth_profiles p ON p.business_id=a.business_id WHERE a.id=$1", [actionId])).rows[0]
    const linked = await objectiveOf()
    expect(linked.objective_goal_id).toBe(linked.primary_goal_id)
    expect(writes).toEqual([])
    const inbox = await ok<{ items: Array<{ type: string; action?: { id: string } }> }>(call(a, "GET", "/api/decisions"))
    expect(inbox.items).toEqual(expect.arrayContaining([expect.objectContaining({ type: "ACCOUNT_ACTION", action: expect.objectContaining({ id: actionId }) })]))
    expect((await call(other, "GET", `/api/businesses/${biz}/account-actions/${actionId}`)).status).toBe(404)
    const approvalPath = `http://localhost/api/businesses/${biz}/account-actions/${actionId}/approve`
    expect((await web.handler(new Request(approvalPath, { method: "POST" }))).status).toBe(401)
    expect((await web.handler(new Request(approvalPath, { method: "POST", headers: { cookie: `or_session=${a.cookie}`, origin: "https://hostile.example", "content-type": "application/json" }, body: "{}" }))).status).toBe(403)
    const approvals = await Promise.all([0, 1].map(() => call(a, "POST", `/api/businesses/${biz}/account-actions/${actionId}/approve`)))
    expect(approvals.map(r => r.status).sort()).toEqual([200, 409])
    expect((await objectiveOf()).objective_goal_id).toBe(linked.primary_goal_id)
    const done = await approvals.find(r => r.status === 200)!.json()
    expect(done).toMatchObject({ action: { status: "DONE", result: { observed: { reply: "Sorry for the wait, Ana. We now text when we run late; call us to rebook." } } } })
    expect((await call(a, "POST", `/api/businesses/${biz}/account-actions/${actionId}/approve`)).status).toBe(409)
    expect(writes).toEqual(["PUT reply r1"])
    // Another account cannot see or undo it.
    expect((await call(other, "POST", `/api/businesses/${biz}/account-actions/${actionId}/undo`)).status).toBe(404)
    const undos = await Promise.all([0, 1].map(() => call(a, "POST", `/api/businesses/${biz}/account-actions/${actionId}/undo`)))
    expect(undos.map(r => r.status).sort()).toEqual([200, 409])
    expect(await undos.find(r => r.status === 200)!.json()).toMatchObject({ action: { status: "UNDONE" } })
    expect(writes).toEqual(["PUT reply r1", "DELETE reply r1"])
    expect(reviews["r1"]!.reply).toBeNull()

    // Answered by hand after it was prepared: refused, not overwritten.
    const stale = Either.getOrThrow(await agent("prepare_account_action", { kind: "REPLY_TO_REVIEW", reviewId: "r2", reply: "Thank you!", rationale: "Thank a happy customer." }))
    reviews["r2"]!.reply = "Thanks so much (from the owner)"
    const refused = await call(a, "POST", `/api/businesses/${biz}/account-actions/${(stale.data as { accountActionId: string }).accountActionId}/approve`)
    expect(refused.status).toBe(409)
    expect(await refused.json()).toMatchObject({ reason: "ChangedSincePrepared" })
    expect(reviews["r2"]!.reply).toBe("Thanks so much (from the owner)")

    // Campaigns: Google validates first; pause, then undo.
    writes.length = 0
    const pause = Either.getOrThrow(await agent("prepare_account_action", { kind: "PAUSE_CAMPAIGN", campaignId: "7", rationale: "No conversions in 30 days." }))
    expect(writes).toEqual(["validate campaigns"])
    expect(campaigns["7"]!.status).toBe("ENABLED")
    const pauseId = (pause.data as { accountActionId: string }).accountActionId
    expect((await ok<{ action: { status: string } }>(call(a, "POST", `/api/businesses/${biz}/account-actions/${pauseId}/approve`))).action.status).toBe("DONE")
    expect(campaigns["7"]!.status).toBe("PAUSED")
    await ok(call(a, "POST", `/api/businesses/${biz}/account-actions/${pauseId}/undo`))
    expect(campaigns["7"]!.status).toBe("ENABLED")

    // Budgets: at most double in one step, never a shared budget.
    const tooMuch = await agent("prepare_account_action", { kind: "SET_DAILY_BUDGET", campaignId: "7", dailyBudget: 50, rationale: "Scale." })
    expect(Either.isLeft(tooMuch) && tooMuch.left).toMatchObject({ reason: "BudgetIncreaseTooLarge" })
    const shared = await agent("prepare_account_action", { kind: "SET_DAILY_BUDGET", campaignId: "8", dailyBudget: 12, rationale: "Scale." })
    expect(Either.isLeft(shared) && shared.left).toMatchObject({ reason: "SharedBudget" })
    const budget = Either.getOrThrow(await agent("prepare_account_action", { kind: "SET_DAILY_BUDGET", campaignId: "7", dailyBudget: 30, rationale: "Cost per booking $18 against a $25 target." }))
    expect((budget.data as { before: { daily: number }; after: { daily: number } })).toMatchObject({ before: { daily: 20 }, after: { daily: 30 } })
    await ok(call(a, "POST", `/api/businesses/${biz}/account-actions/${(budget.data as { accountActionId: string }).accountActionId}/approve`))
    expect(campaigns["7"]!.budget).toBe(30_000_000)

    // A budget that became shared must not be written, even at the same amount.
    const staleBudget = Either.getOrThrow(await agent("prepare_account_action", { kind: "SET_DAILY_BUDGET", campaignId: "7", dailyBudget: 25, rationale: "Lower the budget." }))
    campaigns["7"]!.shared = true
    const beforeShared = writes.length
    expect((await call(a, "POST", `/api/businesses/${biz}/account-actions/${(staleBudget.data as { accountActionId: string }).accountActionId}/approve`)).status).toBe(409)
    expect(writes).toHaveLength(beforeShared)
    campaigns["7"]!.shared = false

    // Enabling approves the displayed existing budget, not a later changed one.
    campaigns["7"]!.status = "PAUSED"
    const enable = Either.getOrThrow(await agent("prepare_account_action", { kind: "ENABLE_CAMPAIGN", campaignId: "7", rationale: "Resume the approved experiment." }))
    expect((enable.data as { after: { budgetDailyMicros: number } }).after.budgetDailyMicros).toBe(30_000_000)
    campaigns["7"]!.budget = 40_000_000
    const beforeEnable = writes.length
    expect((await call(a, "POST", `/api/businesses/${biz}/account-actions/${(enable.data as { accountActionId: string }).accountActionId}/approve`)).status).toBe(409)
    expect(writes).toHaveLength(beforeEnable)
    campaigns["7"]!.budget = 30_000_000
    campaigns["7"]!.status = "ENABLED"

    // New search ad: own site only, created paused, removed on undo.
    const draft = { kind: "CREATE_SEARCH_AD", campaignId: "7", adGroupId: "70", headlines: ["Haircuts in Austin", "Book online in a minute", "Open late on Fridays"], descriptions: ["Same-week appointments with senior stylists.", "Book online and get a reminder text."], rationale: "Test a booking-led message." }
    const elsewhere = await agent("prepare_account_action", { ...draft, finalUrl: "https://other-salon.com/book" })
    expect(Either.isLeft(elsewhere) && elsewhere.left).toMatchObject({ reason: "FinalUrlNotOwnSite" })
    const ad = Either.getOrThrow(await agent("prepare_account_action", { ...draft, finalUrl: "https://www.northstar-salon.com/book" }))
    const created = await ok<{ action: { status: string; result: { resourceName: string; observed: { status: string } } } }>(call(a, "POST", `/api/businesses/${biz}/account-actions/${(ad.data as { accountActionId: string }).accountActionId}/approve`))
    expect(created.action).toMatchObject({ status: "DONE", result: { resourceName: "customers/100/adGroupAds/70~901", observed: { status: "PAUSED" } } })
    await ok(call(a, "POST", `/api/businesses/${biz}/account-actions/${(ad.data as { accountActionId: string }).accountActionId}/undo`))
    expect(ads.size).toBe(0)

    // Headlines alone never establish that the complete approved ad was stored.
    for (const field of ["descriptions", "url", "path"] as const) {
      corruptAd = field
      const mismatched = Either.getOrThrow(await agent("prepare_account_action", { ...draft, headlines: [`Haircuts ${field}`, ...draft.headlines.slice(1)], finalUrl: "https://www.northstar-salon.com/book", path1: "book", path2: "now" }))
      const response = await call(a, "POST", `/api/businesses/${biz}/account-actions/${(mismatched.data as { accountActionId: string }).accountActionId}/approve`)
      expect(response.status).toBe(409)
      expect(await response.json()).toMatchObject({ reason: "NotStoredAsApproved" })
    }

    const listed = await ok<{ actions: Array<{ status: string }> }>(call(a, "GET", `/api/businesses/${biz}/account-actions`))
    expect(listed.actions.map(x => x.status).sort()).toEqual(["DONE", "FAILED", "FAILED", "FAILED", "FAILED", "FAILED", "FAILED", "UNDONE", "UNDONE", "UNDONE"])
    for (const text of seen) expect(text).not.toMatch(/SECRET/)
  })
})
