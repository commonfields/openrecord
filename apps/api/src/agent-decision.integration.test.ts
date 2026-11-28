import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Effect, Layer, Redacted } from "effect"
import { PgClient } from "@effect/sql-pg"
import pg from "pg"
import { AdsProvider, adsConfigFromEnv } from "@openrecord/ads"
import { connectionGaps } from "./agent-decision.js"

const url = process.env["TEST_DATABASE_URL"] ?? ""
const suite = url ? describe : describe.skip
suite("tools withheld for what a business has not connected (disposable TEST fixtures)", () => {
  let pool: pg.Pool
  beforeAll(() => { pool = new pg.Pool({ connectionString: url }) })
  afterAll(async () => { await pool.end() })
  const run = <A>(effect: Effect.Effect<A, unknown, import("@effect/sql").SqlClient.SqlClient>) =>
    Effect.runPromise(effect.pipe(Effect.provide(Layer.mergeAll(PgClient.layer({ url: Redacted.make(url) }), Layer.succeed(AdsProvider, config)))))
  // A server with its encryption key set, so WordPress and Webflow can be connected at all.
  const config = adsConfigFromEnv({ ADS_PROVIDER_STAND_IN_URL: "http://127.0.0.1:9/", GA4_TOKEN_ENCRYPTION_KEYS: `k1:${Buffer.alloc(32, 7).toString("base64")}` })
  const fixture = async () => {
    const accountId = (await pool.query("INSERT INTO accounts(name) VALUES ('TEST gaps') RETURNING id")).rows[0].id as string
    const userId = (await pool.query("INSERT INTO users(email,password_hash) VALUES ($1,'TEST-only') RETURNING id", [`gaps-${randomUUID()}@example.test`])).rows[0].id as string
    await pool.query("INSERT INTO account_users(account_id,user_id) VALUES ($1,$2)", [accountId, userId])
    const businessId = (await pool.query("INSERT INTO businesses(account_id,name) VALUES ($1,'TEST Client') RETURNING id", [accountId])).rows[0].id as string
    return { accountId, userId, businessId }
  }

  it("withholds WordPress, Ads and account-action tools until those are connected, and says so", async () => {
    const f = await fixture()
    const none = await run(connectionGaps(f.accountId, f.businessId))
    expect([...none.withheld].sort()).toEqual(["prepare_account_action", "prepare_page_change", "prepare_webflow_change", "prepare_wordpress_change", "read_ad_campaigns", "read_linkedin_posts", "read_reviews", "read_webflow_content", "read_wordpress_content"])
    expect(none.note).toContain("WordPress")
    expect(none.note).toContain("Webflow")
    expect(none.note).toContain("Channels page")
    await pool.query(`INSERT INTO wordpress_connections(account_id,business_id,site_url,username,password_last4,seo_plugin,can_publish,can_add_scripts,site_name,status,connected_by_user_id,password_ciphertext)
      VALUES ($1,$2,'https://example.test','editor','abcd','NONE',false,false,'TEST site','ACTIVE',$3,'TEST-only-ciphertext')`, [f.accountId, f.businessId, f.userId])
    const wordpress = await run(connectionGaps(f.accountId, f.businessId))
    expect(wordpress.withheld.has("read_wordpress_content")).toBe(false)
    expect(wordpress.withheld.has("read_ad_campaigns")).toBe(true)
    expect(wordpress.note).not.toContain("WordPress")
  })

  it("counts only the business's own connections, never another business's", async () => {
    const f = await fixture()
    const other = (await pool.query("INSERT INTO businesses(account_id,name) VALUES ($1,'TEST Other') RETURNING id", [f.accountId])).rows[0].id as string
    await pool.query(`INSERT INTO wordpress_connections(account_id,business_id,site_url,username,password_last4,seo_plugin,can_publish,can_add_scripts,site_name,status,connected_by_user_id,password_ciphertext)
      VALUES ($1,$2,'https://other.example.test','editor','abcd','NONE',false,false,'TEST other','ACTIVE',$3,'TEST-only-ciphertext')`, [f.accountId, other, f.userId])
    expect((await run(connectionGaps(f.accountId, f.businessId))).withheld.has("read_wordpress_content")).toBe(true)
  })
})
