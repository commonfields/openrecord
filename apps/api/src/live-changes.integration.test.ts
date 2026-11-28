// When site changes went live, for the Analytics chart marks (disposable PostgreSQL).
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Effect, Redacted } from "effect"
import { PgClient } from "@effect/sql-pg"
import pg from "pg"
import { liveChanges } from "./live-changes.js"

const url = process.env["TEST_DATABASE_URL"] ?? ""
const suite = url ? describe : describe.skip

suite("live site changes (disposable PostgreSQL)", () => {
  let pool: pg.Pool
  beforeAll(() => { pool = new pg.Pool({ connectionString: url }) })
  afterAll(async () => { await pool.end() })
  const read = (businessId: string, days: number) => Effect.runPromise(liveChanges(businessId, days).pipe(Effect.provide(PgClient.layer({ url: Redacted.make(url) })), Effect.scoped))

  it("lists published and undone WordPress changes in the window, oldest first, and nothing proposed, failed or from another business", async () => {
    const accountId = String((await pool.query("INSERT INTO accounts(name) VALUES('TEST Live') RETURNING id")).rows[0].id)
    const userId = String((await pool.query("INSERT INTO users(email,password_hash) VALUES($1,'TEST-only') RETURNING id", [`live-${randomUUID()}@example.test`])).rows[0].id)
    const business = async () => String((await pool.query("INSERT INTO businesses(account_id,name) VALUES($1,'TEST Live') RETURNING id", [accountId])).rows[0].id)
    const mine = await business(), other = await business()
    const change = (businessId: string, title: string, status: string, daysAgo: number | null) => pool.query(
      `INSERT INTO wordpress_changes(business_id,account_id,kind,post_type,post_id,target_title,before_values,after_values,rationale,status,proposed_by,created_by_user_id,request_key,decided_at)
       VALUES($1,$2,'SET_SEO','pages',7,$3,'{}','{}','TEST',$4,'ASSISTANT',$5,$6,${daysAgo === null ? "NULL" : `now()-interval '${daysAgo} days'`})`,
      [businessId, accountId, title, status, userId, randomUUID().replace(/-/g, "").padEnd(64, "0")])
    await change(mine, "Pricing", "PUBLISHED", 2)
    await change(mine, "About", "UNDONE", 5)
    await change(mine, "Old page", "PUBLISHED", 400)
    await change(mine, "Draft", "PROPOSED", null)
    await change(mine, "Broken", "FAILED", 1)
    await change(other, "Elsewhere", "PUBLISHED", 1)
    const list = await read(mine, 366)
    expect(list.map(c => [c.title, c.source, c.undone])).toEqual([["About", "WORDPRESS", true], ["Pricing", "WORDPRESS", false]])
    expect(Date.parse(list[1]!.at)).toBeGreaterThan(Date.now() - 3 * 86_400_000)
    expect(await read(mine, 3)).toHaveLength(1)
  })
})
