// The campaign timeline against a disposable database, through its route: a
// deliverable's dates follow the saved revisions, and another account sees nothing.
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { HttpApp } from "@effect/platform"
import { Effect, Layer, Redacted } from "effect"
import { PgClient } from "@effect/sql-pg"
import { AuthRepositoryLive, BusinessRepositoryLive } from "@openrecord/db"
import pg from "pg"
import { campaignsApi } from "./campaigns.js"
import { requireSession } from "./router.js"

const url = process.env["TEST_DATABASE_URL"] ?? ""
const suite = url ? describe : describe.skip
suite("campaign timeline (disposable PostgreSQL)", () => {
  const pool = new pg.Pool({ connectionString: url })
  const repos = Layer.mergeAll(AuthRepositoryLive, BusinessRepositoryLive).pipe(Layer.provideMerge(PgClient.layer({ url: Redacted.make(url) })))
  const web = HttpApp.toWebHandlerLayer(campaignsApi(run => Effect.flatMap(requireSession, ({ session }) => run(session))), repos)
  const people: Array<{ userId: string; businessId: string; cookie: string }> = []
  const id = randomUUID(), task = randomUUID()
  const call = (method: string, path: string, who: number | null, body?: unknown) => web.handler(new Request(`http://localhost/api/businesses/${people[0]!.businessId}/${path}`, {
    method, headers: { "content-type": "application/json", ...(who === null ? {} : { cookie: `or_session=${people[who]!.cookie}` }) }, ...(body ? { body: JSON.stringify(body) } : {}) }))
  const save = async (revision: number, status: string) => {
    const brief = { title: "TEST Timeline", goal: "", audience: "", offer: "", message: "", hypothesis: "", metric: "", baseline: "", target: "", owner: "", launchDate: "", reviewDate: "", status: "DRAFT",
      tasks: [{ id: task, title: "Page", owner: "Maya", due: "2026-11-20", channel: "WEBSITE", status, note: "" }], result: "", decision: "UNDECIDED", learning: "", nextMove: "" }
    const res = await call("POST", "campaigns", 0, { id, revision, brief })
    expect(res.status, await res.clone().text()).toBe(200)
  }
  const read = async () => (await (await call("GET", `campaigns/${id}/timeline`, 0)).json()) as { tasks: Array<Record<string, string | null>>; days: Array<unknown> }

  beforeAll(async () => {
    for (let i = 0; i < 2; i++) {
      const a = (await pool.query("INSERT INTO accounts(name) VALUES('TEST timeline') RETURNING id")).rows[0].id
      const userId = (await pool.query("INSERT INTO users(email,password_hash) VALUES($1,'TEST') RETURNING id", [`timeline-${randomUUID()}@example.test`])).rows[0].id
      await pool.query("INSERT INTO account_users(account_id,user_id) VALUES($1,$2)", [a, userId])
      const cookie = (await pool.query("INSERT INTO sessions(id,account_id,user_id,expires_at,token_digest) SELECT u,$1::uuid,$2::uuid,now()+interval '1 hour',encode(sha256(convert_to(u::text,'UTF8')),'hex') FROM gen_random_uuid() u RETURNING id", [a, userId])).rows[0].id
      const businessId = (await pool.query("INSERT INTO businesses(account_id,name) VALUES($1,'TEST timeline') RETURNING id", [a])).rows[0].id
      people.push({ userId, businessId, cookie })
    }
  })
  afterAll(async () => { await web.dispose(); await pool.end() })

  it("follows a deliverable from added to finished, and reopened", async () => {
    await save(0, "TODO")
    expect((await read()).tasks[0]).toMatchObject({ taskId: task, started: null, finished: null, added: expect.any(String) })
    await save(1, "IN_PROGRESS")
    const running = (await read()).tasks[0]!
    expect(running).toMatchObject({ started: expect.any(String), finished: null })
    await save(2, "DONE")
    const done = (await read()).tasks[0]!
    expect(done["started"]).toBe(running["started"])
    expect(done["finished"]! > done["started"]!).toBe(true)
    await save(3, "IN_PROGRESS")
    expect((await read()).tasks[0]!["finished"]).toBeNull()
    await save(4, "TODO")
    expect((await read()).days).toEqual([])
  })
  it("takes the owner's sent report as the finish", async () => {
    await pool.query("INSERT INTO campaign_handoffs(business_id,campaign_id,task_id,status,reported_by_user_id,reported_at) VALUES($1,$2,$3,'SENT',$4,'2027-01-02T03:04:05Z')", [people[0]!.businessId, id, task, people[0]!.userId])
    expect((await read()).tasks[0]!["finished"]).toBe("2027-01-02T03:04:05.000Z")
  })
  it("answers only the campaign's own account", async () => {
    expect((await call("GET", `campaigns/${id}/timeline`, 1)).status).toBe(404)
    expect((await call("GET", `campaigns/${id}/timeline`, null)).status).toBe(401)
    expect((await call("GET", `campaigns/${randomUUID()}/timeline`, 0)).status).toBe(404)
    expect((await call("GET", "campaigns/nonsense/timeline", 0)).status).toBe(422)
  })
})
