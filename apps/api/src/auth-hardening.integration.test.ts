// Sign-in throttling, the origin check in front of every route, and generic
// failure bodies, through the real router. Disposable PostgreSQL fixtures.
import { createHash, randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { HttpApp } from "@effect/platform"
import { Layer, Redacted } from "effect"
import { PgClient } from "@effect/sql-pg"
import { AuthRepositoryLive } from "@openrecord/db"
import pg from "pg"
import { makeRouter, RepoLayers } from "./router.js"
import { LIMITS } from "./auth-throttle.js"

const url = process.env["TEST_DATABASE_URL"] ?? ""
const suite = url ? describe : describe.skip

suite("auth hardening (TEST fixtures)", () => {
  let pool: pg.Pool
  const layer = Layer.mergeAll(AuthRepositoryLive, RepoLayers.BusinessRepositoryLive).pipe(Layer.provideMerge(PgClient.layer({ url: Redacted.make(url) })))
  const web = HttpApp.toWebHandlerLayer(makeRouter(), layer as never)
  beforeAll(() => { pool = new pg.Pool({ connectionString: url }) })
  afterAll(async () => { await web.dispose(); await pool.end() })

  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await web.handler(new Request(`http://localhost${path}`, {
      method, headers: { "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }))
    return { status: res.status, json: await res.json().catch(() => null) as Record<string, unknown> | null, headers: res.headers }
  }
  const signup = async () => {
    const email = `hardening-${randomUUID()}@example.test`
    const res = await call("POST", "/api/auth/signup", { email, password: "password123" })
    expect(res.status).toBe(200)
    const cookie = /or_session=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")![1]!
    return { email, cookie }
  }

  it("signs in with the right password and refuses a wrong one or an unknown email alike", async () => {
    const { email } = await signup()
    expect((await call("POST", "/api/auth/signin", { email, password: "password123" })).status).toBe(200)
    const wrong = await call("POST", "/api/auth/signin", { email, password: "wrong-password" })
    const unknown = await call("POST", "/api/auth/signin", { email: `nobody-${randomUUID()}@example.test`, password: "password123" })
    expect(wrong).toMatchObject({ status: 401, json: { _tag: "NotAuthenticated" } })
    expect(unknown).toMatchObject({ status: 401, json: { _tag: "NotAuthenticated" } })
  })

  it("locks an email after repeated failures, even against the right password", async () => {
    const { email } = await signup()
    for (let i = 0; i < LIMITS.failuresPerEmail.max; i++) {
      expect((await call("POST", "/api/auth/signin", { email, password: `wrong-${i}-password` })).status).toBe(401)
    }
    const locked = await call("POST", "/api/auth/signin", { email, password: "password123" })
    expect(locked.status).toBe(429)
    expect(locked.json).toEqual({ _tag: "TooManyAttempts" })
    expect(Number(locked.headers.get("retry-after"))).toBeGreaterThan(0)
  })

  it("refuses cookie-carrying writes from other origins and same-site frames", async () => {
    const { cookie } = await signup()
    const withCookie = (extra: Record<string, string>) => ({ cookie: `or_session=${cookie}`, ...extra })
    expect(await call("POST", "/api/businesses", { name: "TEST evil" }, withCookie({ origin: "https://evil.test" }))).toMatchObject({ status: 403, json: { _tag: "OriginRefused" } })
    expect((await call("POST", "/api/businesses", { name: "TEST sibling" }, withCookie({ "sec-fetch-site": "same-site" }))).status).toBe(403)
    // The web app's own origin, and the desktop app (no Origin header).
    expect((await call("POST", "/api/businesses", { name: "TEST web" }, withCookie({ origin: "http://localhost:3000" }))).status).toBe(200)
    expect((await call("POST", "/api/businesses", { name: "TEST desktop" }, withCookie({}))).status).toBe(200)
    // Reads are never refused, and a request without the cookie has nothing to forge.
    expect((await call("GET", "/api/businesses", undefined, withCookie({ origin: "https://evil.test" }))).status).toBe(200)
    expect((await call("POST", "/api/businesses", { name: "TEST" }, { origin: "https://evil.test" })).status).toBe(401)
  })
  it("stores only a digest of the session token, and sign-out removes it", async () => {
    const { email, cookie } = await signup()
    expect(cookie).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const rows = (await pool.query("SELECT s.id::text, s.token_digest FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.email = $1", [email])).rows
    expect(rows).toHaveLength(1)
    expect(rows[0].token_digest).toBe(createHash("sha256").update(cookie).digest("hex"))
    expect(JSON.stringify(rows)).not.toContain(cookie)
    // The row id is not a credential.
    expect((await call("GET", "/api/businesses", undefined, { cookie: `or_session=${rows[0].id}` })).status).toBe(401)
    // The digest is not a credential either.
    expect((await call("GET", "/api/businesses", undefined, { cookie: `or_session=${rows[0].token_digest}` })).status).toBe(401)
    expect((await call("GET", "/api/businesses", undefined, { cookie: `or_session=${cookie}` })).status).toBe(200)
    expect((await call("POST", "/api/auth/signout", undefined, { cookie: `or_session=${cookie}` })).status).toBe(200)
    expect((await pool.query("SELECT 1 FROM sessions WHERE token_digest = $1", [rows[0].token_digest])).rows).toHaveLength(0)
    expect((await call("GET", "/api/businesses", undefined, { cookie: `or_session=${cookie}` })).status).toBe(401)
  })

  it("keeps sessions issued before digests working until they expire", async () => {
    const { email } = await signup()
    const user = (await pool.query("SELECT u.id, au.account_id FROM users u JOIN account_users au ON au.user_id = u.id WHERE u.email = $1", [email])).rows[0]
    // Shape the migration gives an old session: the cookie was the row id.
    const legacy = String((await pool.query("INSERT INTO sessions(id,account_id,user_id,expires_at,token_digest) SELECT u,$1::uuid,$2::uuid,now()+interval '1 day',encode(sha256(convert_to(u::text,'UTF8')),'hex') FROM gen_random_uuid() u RETURNING id", [user.account_id, user.id])).rows[0].id)
    expect((await call("GET", "/api/businesses", undefined, { cookie: `or_session=${legacy}` })).status).toBe(200)
  })
})
