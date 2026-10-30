// The agent's draft of the setup brief: parsed from the reply's JSON and
// trimmed to the schema; started once, only after the website was read and
// before the brief is confirmed; written in its own chat; a bad reply fails.
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Effect, ManagedRuntime, Redacted } from "effect"
import { PgClient } from "@effect/sql-pg"
import pg from "pg"
import type { BriefSender } from "./growth-brief.js"
import { DRAFT_PROMPT, parseDraft, setupDraft } from "./setup-draft.js"

const reply = (extra: Record<string, unknown> = {}) => `Here it is:\n\`\`\`json\n${JSON.stringify({
  businessName: "Northstar Dental", category: "Family dentistry", audience: "Families   within 10 miles", valueProposition: "Same-week appointments and gentle care.",
  goalStatement: "More booked appointments", conversionKind: "booking", metricLabel: "Booked appointments",
  competitors: [{ name: "Bright Smiles", website: "https://brightsmiles.test" }, { name: "Downtown Dental", website: "not a url" }, { name: "" }], ...extra })}\n\`\`\``

describe("setup draft parsing", () => {
  it("reads the first JSON object, tidies whitespace and case, and drops bad competitors", () => {
    expect(parseDraft(reply())).toEqual({
      businessName: "Northstar Dental", category: "Family dentistry", audience: "Families within 10 miles", valueProposition: "Same-week appointments and gentle care.",
      goalStatement: "More booked appointments", conversionKind: "BOOKING", metricLabel: "Booked appointments",
      competitors: [{ name: "Bright Smiles", website: "https://brightsmiles.test" }, { name: "Downtown Dental" }],
    })
  })
  it("refuses replies without the required fields or with an unknown conversion", () => {
    expect(parseDraft("I couldn't read the site.")).toBeNull()
    expect(parseDraft(reply({ conversionKind: "CALLS" }))).toBeNull()
    expect(parseDraft(reply({ category: "" }))).toBeNull()
  })
})

const url = process.env["TEST_DATABASE_URL"] ?? ""
const suite = url ? describe : describe.skip
suite("setup draft (disposable PostgreSQL, fixture model)", () => {
  const runtime = ManagedRuntime.make(PgClient.layer({ url: Redacted.make(url) }))
  const run = <A, E>(fx: Effect.Effect<A, E, import("@effect/sql").SqlClient.SqlClient>) => runtime.runPromise(fx)
  let pool: pg.Pool
  beforeAll(() => { pool = new pg.Pool({ connectionString: url }) })
  afterAll(async () => { await runtime.dispose(); await pool.end() })

  const setup = async (discovery: "DONE" | "QUEUED") => {
    const accountId = String((await pool.query("INSERT INTO accounts(name) VALUES('TEST draft') RETURNING id")).rows[0].id)
    const userId = String((await pool.query("INSERT INTO users(email,password_hash) VALUES($1,'TEST') RETURNING id", [`draft-${randomUUID()}@example.test`])).rows[0].id)
    await pool.query("INSERT INTO account_users(account_id,user_id) VALUES($1,$2)", [accountId, userId])
    const businessId = String((await pool.query("INSERT INTO businesses(account_id,name) VALUES($1,'northstar.test') RETURNING id", [accountId])).rows[0].id)
    const setupId = String((await pool.query(`INSERT INTO business_setups(account_id,business_id,website_url,website_host,started_by_user_id,discovery_status,discovery,discovered_at)
      VALUES($1,$2,'https://northstar.test','northstar.test',$3,$4,$5::jsonb,$6) RETURNING id`,
      [accountId, businessId, userId, discovery, discovery === "DONE" ? "{}" : null, discovery === "DONE" ? new Date() : null])).rows[0].id)
    return { scope: { accountId, userId, businessId }, setupId }
  }
  const settle = async (setupId: string) => {
    for (let i = 0; i < 100; i++) {
      const r = (await pool.query("SELECT draft_status, draft, draft_conversation_id FROM business_setups WHERE id=$1", [setupId])).rows[0]
      if (r.draft_status !== "RUNNING") return r
      await new Promise(res => setTimeout(res, 50))
    }
    throw new Error("draft never finished")
  }

  it("waits for the website, starts once, and stores the draft written in its own chat", async () => {
    const pending = await setup("QUEUED")
    const calls: string[] = []
    const sender: BriefSender<never> = (_s, body) => Effect.sync(() => { calls.push(body.message); return { reply: reply() } })
    expect(await run(setupDraft(pending.scope, pending.setupId, sender))).toBeUndefined()

    const ready = await setup("DONE")
    expect(await run(setupDraft(ready.scope, ready.setupId, sender))).toEqual({ status: "RUNNING" })
    const done = await settle(ready.setupId)
    expect(done.draft_status).toBe("READY")
    expect(done.draft.goalStatement).toBe("More booked appointments")
    expect(await run(setupDraft(ready.scope, ready.setupId, sender))).toMatchObject({ status: "READY", value: { conversionKind: "BOOKING" } })
    expect(calls).toEqual([DRAFT_PROMPT("https://northstar.test")])
    const chat = (await pool.query("SELECT archived_at, last_reply->>'title' AS title FROM agent_conversations WHERE id=$1", [done.draft_conversation_id])).rows[0]
    expect(chat).toMatchObject({ title: "Setting up northstar.test" })
    expect(chat.archived_at).not.toBeNull()
  })

  it("marks a reply it can't read as failed and doesn't start again", async () => {
    const s = await setup("DONE")
    let n = 0
    const sender: BriefSender<never> = () => Effect.sync(() => { n++; return { reply: "Sorry, the site was down." } })
    await run(setupDraft(s.scope, s.setupId, sender))
    expect((await settle(s.setupId)).draft_status).toBe("FAILED")
    expect(await run(setupDraft(s.scope, s.setupId, sender))).toEqual({ status: "FAILED" })
    expect(n).toBe(1)
  })

  it("settles an abandoned draft without restarting it or accepting a late result", async () => {
    const s = await setup("DONE")
    let release!: (value: { reply: string }) => void
    let started!: () => void
    const running = new Promise<void>(resolve => { started = resolve })
    const answer = new Promise<{ reply: string }>(resolve => { release = resolve })
    let calls = 0
    const sender: BriefSender<never> = () => Effect.promise(() => { calls++; started(); return answer })
    expect(await run(setupDraft(s.scope, s.setupId, sender))).toEqual({ status: "RUNNING" })
    await running
    await pool.query("UPDATE business_setups SET draft_started_at = now() - interval '26 minutes' WHERE id=$1", [s.setupId])
    expect(await run(setupDraft(s.scope, s.setupId, sender))).toEqual({ status: "FAILED" })
    release({ reply: reply() })
    await new Promise(resolve => setTimeout(resolve, 100))
    const row = (await pool.query("SELECT draft_status, draft FROM business_setups WHERE id=$1", [s.setupId])).rows[0]
    expect(row).toMatchObject({ draft_status: "FAILED", draft: null })
    expect(calls).toBe(1)
  })
})
