// The migration runner replays every file on every run (scripts/dev-up.sh
// migrates at each start), so an earlier migration that redefines a check
// must not narrow it again once rows rely on a later, wider one. Each case
// stores a row only the newest check allows, then migrates again.
import { randomUUID } from "node:crypto"
import pg from "pg"
import { describe, expect, it } from "vitest"
import { migrate } from "./migrate.js"

const testUrl = process.env["TEST_DATABASE_URL"]
const suite = testUrl ? describe : describe.skip

suite("migration replay over rows that need the newest checks (new disposable database)", () => {
  it("replays with LinkedIn connections, bindings and posts, and with every decision feedback kind", async () => {
    const url = new URL(testUrl ?? "")
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new Error("TEST requires loopback PostgreSQL")
    const name = `replay_${randomUUID().replaceAll("-", "")}`
    const admin = new pg.Client({ connectionString: url.toString() })
    await admin.connect()
    await admin.query(`CREATE DATABASE ${name}`)
    url.pathname = `/${name}`
    const client = new pg.Client({ connectionString: url.toString() })
    try {
      await migrate(url.toString())
      await client.connect()
      const one = async (sql: string, args: unknown[] = []) => String((await client.query(sql, args)).rows[0]!.id)
      const account = await one("INSERT INTO accounts(name) VALUES('TEST replay') RETURNING id")
      const user = await one("INSERT INTO users(email,password_hash) VALUES($1,'TEST') RETURNING id", [`replay-${randomUUID()}@example.test`])
      await client.query("INSERT INTO account_users(account_id,user_id) VALUES($1,$2)", [account, user])
      const business = await one("INSERT INTO businesses(account_id,name) VALUES($1,'TEST replay') RETURNING id", [account])

      // LinkedIn: an alphanumeric member id, an author URN binding, a post action.
      const connection = await one(`INSERT INTO ad_connections(account_id,provider,subject,display_name,granted_scopes,connected_by_user_id)
        VALUES($1,'linkedin','aB3_x-9','TEST member',ARRAY['openid','profile','w_member_social'],$2) RETURNING id`, [account, user])
      await client.query("INSERT INTO ad_oauth_states(state_sha256,account_id,user_id,business_id,provider,verifier_ciphertext,expires_at) VALUES($1,$2,$3,$4,'linkedin','x',now()+interval '1 minute')",
        ["a".repeat(64), account, user, business])
      const binding = await one(`INSERT INTO ad_account_bindings(account_id,business_id,connection_id,provider,external_id,name,bound_by_user_id)
        VALUES($1,$2,$3,'linkedin','urn:li:person:aB3_x-9','TEST profile',$4) RETURNING id`, [account, business, connection, user])
      await client.query(`INSERT INTO account_actions(business_id,account_id,binding_id,provider,kind,target,before_values,after_values,rationale,status,proposed_by,created_by_user_id,request_key)
        VALUES($1,$2,$3,'linkedin','PUBLISH_POST','{}','{}','{"text":"TEST"}','TEST','PROPOSED','OPERATOR',$4,$5)`, [business, account, binding, user, "b".repeat(64)])

      // Every kind decision feedback allows today, each added by a later migration than the first.
      for (const kind of ["CAMPAIGN_PUBLICATION", "CAMPAIGN_REVIEW", "MARKETING_STRATEGY", "WEBFLOW_CHANGE", "GITHUB_CHANGE", "ACCOUNT_ACTION"]) {
        await client.query("INSERT INTO decision_feedback(account_id,business_id,kind,item_id,verdict,title) VALUES($1,$2,$3,$4,'APPROVED','TEST')", [account, business, kind, randomUUID()])
      }

      await expect(migrate(url.toString())).resolves.toBeUndefined()
      // The newest checks are still the ones in force.
      const defs = (await client.query("SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = ANY($1)",
        [["ad_connections_provider_check", "ad_account_bindings_external_id_check", "decision_feedback_kind_check"]])).rows as Array<{ conname: string; def: string }>
      expect(defs.find(d => d.conname === "ad_connections_provider_check")!.def).toContain("linkedin")
      expect(defs.find(d => d.conname === "ad_account_bindings_external_id_check")!.def).toContain("urn:li")
      expect(defs.find(d => d.conname === "decision_feedback_kind_check")!.def).toContain("GITHUB_CHANGE")
    } finally {
      await client.end().catch(() => undefined)
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
      await admin.end()
    }
  }, 120_000)
})
