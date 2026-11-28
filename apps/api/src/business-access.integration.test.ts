// Every route the router registers under a business path refuses a session
// from another account, and anyone signed out, before its handler runs.
// The inventory comes from the router itself, so a route added later is
// covered without touching this file.
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { HttpApp } from "@effect/platform"
import { Chunk, Layer, Redacted } from "effect"
import { PgClient } from "@effect/sql-pg"
import { AuthRepositoryLive } from "@openrecord/db"
import pg from "pg"
import { makeRouter, makeRoutes, RepoLayers } from "./router.js"
import { businessRouteOf } from "./business-access.js"

const url = process.env["TEST_DATABASE_URL"] ?? ""
const suite = url ? describe : describe.skip

const routes = Chunk.toReadonlyArray(makeRoutes().routes)
  .map(r => ({ method: r.method, path: String(r.path) }))
  .filter(r => r.method !== "*" && businessRouteOf(r.path))

const fill = (pattern: string, business: string) =>
  pattern.split("/").map(seg => seg === ":id" ? business : seg.startsWith(":") ? randomUUID() : seg).join("/")

suite("business access (TEST fixtures)", () => {
  let pool: pg.Pool
  const layer = Layer.mergeAll(AuthRepositoryLive, RepoLayers.BusinessRepositoryLive).pipe(Layer.provideMerge(PgClient.layer({ url: Redacted.make(url) })))
  const web = HttpApp.toWebHandlerLayer(makeRouter(), layer as never)
  beforeAll(() => { pool = new pg.Pool({ connectionString: url }) })
  afterAll(async () => { await web.dispose(); await pool.end() })

  const account = async () => {
    const accountId = String((await pool.query("INSERT INTO accounts(name) VALUES('TEST business access') RETURNING id")).rows[0].id)
    const userId = String((await pool.query("INSERT INTO users(email,password_hash) VALUES($1,'TEST-only') RETURNING id", [`access-${randomUUID()}@example.test`])).rows[0].id)
    await pool.query("INSERT INTO account_users(account_id,user_id) VALUES($1,$2)", [accountId, userId])
    const session = String((await pool.query("INSERT INTO sessions(id,account_id,user_id,expires_at,token_digest) SELECT u,$1::uuid,$2::uuid,now()+interval '1 hour',encode(sha256(convert_to(u::text,'UTF8')),'hex') FROM gen_random_uuid() u RETURNING id", [accountId, userId])).rows[0].id)
    const business = String((await pool.query("INSERT INTO businesses(account_id,name) VALUES($1,'TEST owned business') RETURNING id", [accountId])).rows[0].id)
    return { session, business }
  }
  const call = (method: string, path: string, cookie?: string) => web.handler(new Request(`http://localhost${path}`, {
    method, headers: { "content-type": "application/json", ...(cookie ? { cookie: `or_session=${cookie}` } : {}) },
    ...(method === "GET" || method === "HEAD" ? {} : { body: "{}" }),
  }))

  it("finds the business routes", () => {
    // A sanity floor: the five business prefixes hold well over a hundred routes.
    expect(routes.length).toBeGreaterThan(100)
  })

  it("answers another account's business as missing, on every business route", async () => {
    const owner = await account()
    const stranger = await account()
    const leaked: string[] = []
    for (const r of routes) {
      const res = await call(r.method, fill(r.path, owner.business), stranger.session)
      const body = await res.json().catch(() => null) as { _tag?: string } | null
      if (res.status !== 404 || body?._tag !== businessRouteOf(r.path)!.notFound) leaked.push(`${r.method} ${r.path} -> ${res.status} ${body?._tag}`)
    }
    expect(leaked).toEqual([])
  })

  it("refuses anyone signed out, on every business route", async () => {
    const owner = await account()
    const open: string[] = []
    for (const r of routes) {
      const res = await call(r.method, fill(r.path, owner.business))
      if (res.status !== 401) open.push(`${r.method} ${r.path} -> ${res.status}`)
    }
    expect(open).toEqual([])
  })

  it("lets the owner through to the handler", async () => {
    const owner = await account()
    // The archive handler's own validation answers, so the check let it run.
    const res = await call("POST", `/api/businesses/${owner.business}/archive`, owner.session)
    expect(res.status).toBe(422)
  })
})
