import { randomUUID } from "node:crypto"
import { readFileSync, readdirSync } from "node:fs"
import pg from "pg"
import { describe, expect, it } from "vitest"
import { migrate } from "./migrate.js"

const testUrl = process.env["TEST_DATABASE_URL"]
const suite = testUrl ? describe : describe.skip
suite("harness migration rehearsal (new disposable databases only)", () => {
  for (const mode of ["fresh", "populated upgrade"] as const) {
    it(`preserves data through ${mode} and replay`, async () => {
      const url = new URL(testUrl ?? "")
      if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
        throw new Error("TEST requires loopback PostgreSQL")
      const name = `harness_rehearsal_${randomUUID().replaceAll("-", "")}`
      const admin = new pg.Client({ connectionString: url.toString() })
      await admin.connect()
      let created = false
      let client: pg.Client | undefined
      const fingerprint = async () => {
        if (!client) throw new Error("TEST database missing")
        const tables = await client.query<{ tablename: string }>(
          "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename"
        )
        const result: Record<string, string> = {}
        for (const { tablename } of tables.rows) {
          const identifier = tablename.replaceAll('"', '""')
          const digest = await client.query<{ digest: string }>(
            `SELECT md5(coalesce(string_agg((to_jsonb(item)-'last_request_digest')::text,'|' ORDER BY (to_jsonb(item)-'last_request_digest')::text),'')) AS digest FROM "${identifier}" item`
          )
          result[tablename] = digest.rows[0]?.digest ?? ""
        }
        return result
      }
      try {
        await admin.query(`CREATE DATABASE "${name}"`)
        created = true
        url.pathname = `/${name}`
        client = new pg.Client({ connectionString: url.toString() })
        await client.connect()
        if (mode === "populated upgrade") {
          const directory = new URL("../migrations/", import.meta.url)
          for (const file of readdirSync(directory)
            .filter((file) => file.endsWith(".sql") && file < "0037")
            .sort())
            await client.query(
              readFileSync(new URL(file, directory), "utf8").replace("email CITEXT UNIQUE", "email TEXT UNIQUE")
            )
          const accountId = randomUUID(),
            userId = randomUUID(),
            businessId = randomUUID()
          await client.query("INSERT INTO accounts(id,name) VALUES($1,'TEST migration')", [accountId])
          await client.query("INSERT INTO users(id,email,password_hash) VALUES($1,$2,'TEST')", [
            userId,
            `${userId}@example.test`
          ])
          await client.query("INSERT INTO account_users(account_id,user_id) VALUES($1,$2)", [accountId, userId])
          await client.query("INSERT INTO businesses(id,account_id,name) VALUES($1,$2,'TEST migration')", [
            businessId,
            accountId
          ])
          await client.query(
            "INSERT INTO agent_conversations(account_id,user_id,business_id,messages,revision) VALUES($1,$2,$3,$4::jsonb,1)",
            [
              accountId,
              userId,
              businessId,
              JSON.stringify([
                { role: "user", text: "TEST previous question" },
                { role: "agent", text: "TEST previous answer" }
              ])
            ]
          )
          const before = await fingerprint()
          await migrate(url.toString())
          const after = await fingerprint()
          for (const [table, digest] of Object.entries(before)) expect(after[table], table).toBe(digest)
        } else await migrate(url.toString())
        const tables = await client.query(
          "SELECT count(*)::int AS count FROM pg_tables WHERE schemaname='public' AND tablename IN ('agent_bridges','agent_harness_instances','agent_harness_jobs')"
        )
        expect(tables.rows[0]?.count).toBe(3)
        const beforeReplay = await fingerprint()
        await migrate(url.toString())
        expect(await fingerprint()).toEqual(beforeReplay)
      } finally {
        await client?.end()
        if (created) await admin.query(`DROP DATABASE "${name}"`)
        await admin.end()
      }
    }, 120000)
  }
})
