import { generateKeyPairSync, randomUUID } from "node:crypto"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { HttpApp, HttpRouter } from "@effect/platform"
import { PgClient } from "@effect/sql-pg"
import { Effect, Layer, Redacted, Schema } from "effect"
import pg from "pg"
import { AuthRepositoryLive } from "@openrecord/db"
import { AdsProvider, adsConfigFromEnv } from "@openrecord/ads"
import { GitHubExecution, GitHubInstallationExecutionLive, resolveGitHubTransport } from "@openrecord/site-operator"
import { githubInstallApi } from "./github-install.js"
import { desktopOAuthApi } from "./desktop-oauth.js"
import { RepoLayers, requireSession } from "./router.js"

const url = process.env["TEST_DATABASE_URL"] ?? ""
const suite = url ? describe : describe.skip
suite("GitHub installation (fixture HTTP, real database)", () => {
  const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString()
  const pgLayer = PgClient.layer({ url: Redacted.make(url) })
  const repos = Layer.mergeAll(RepoLayers.BusinessRepositoryLive, AuthRepositoryLive).pipe(Layer.provideMerge(pgLayer))
  const ads = adsConfigFromEnv({ GA4_TOKEN_ENCRYPTION_KEYS: `k1:${Buffer.alloc(32, 7).toString("base64")}` })
  const web = HttpApp.toWebHandlerLayer(HttpRouter.concat(desktopOAuthApi(), githubInstallApi(r => Effect.flatMap(requireSession, ({ session }) => r(session)))), Layer.mergeAll(repos, Layer.succeed(AdsProvider, ads)))
  let pool: pg.Pool
  let providerCalls: string[] = []
  let installation = Math.floor(Date.now() / 100) * 100 + Math.floor(Math.random() * 90)
  let admin = true
  let tokenRefused = false
  beforeAll(() => { pool = new pg.Pool({ connectionString: url }) })
  afterAll(async () => { await web.dispose(); await pool.end() })
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })
  const configure = () => {
    for (const [k, v] of Object.entries({ GITHUB_APP_ID: "7", GITHUB_APP_CLIENT_ID: "fixture-client", GITHUB_APP_CLIENT_SECRET: "fixture-secret", GITHUB_APP_SLUG: "fixture-app", GITHUB_APP_PRIVATE_KEY: privateKey, GITHUB_APP_CALLBACK_URL: "http://localhost:3001/api/github/callback" })) vi.stubEnv(k, v)
    providerCalls = []; admin = true; tokenRefused = false
    vi.stubGlobal("fetch", vi.fn(async (input: string, init: RequestInit) => {
      const u = new URL(input); providerCalls.push(u.pathname)
      const response = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } })
      expect(init.redirect).toBe("error")
      if (u.pathname === "/login/oauth/access_token") return response({ access_token: "fixture-user-token" })
      if (u.pathname === "/user/installations") return response({ installations: [{ id: installation, app_id: 7, account: { login: "fixture-org" }, suspended_at: null }] })
      if (u.pathname === `/user/installations/${installation}/repositories`) return response({ repositories: [{ id: installation + 1000, full_name: `fixture-org/site-${installation}`, permissions: { admin } }] })
      if (u.pathname === `/app/installations/${installation}/access_tokens`) {
        expect(JSON.parse(String(init.body))).toEqual({ repository_ids: [installation + 1000], permissions: { contents: "write", pull_requests: "write" } })
        return tokenRefused ? response({}, 403) : response({ token: "fixture-install-token", permissions: { contents: "write", pull_requests: "write" } })
      }
      throw new Error("Unexpected fixture request")
    }))
  }
  const fixture = async () => {
    const accountId = String((await pool.query("INSERT INTO accounts(name) VALUES('TEST GitHub') RETURNING id")).rows[0].id)
    const userId = String((await pool.query("INSERT INTO users(email,password_hash) VALUES($1,'TEST') RETURNING id", [`gh-${randomUUID()}@example.test`])).rows[0].id)
    await pool.query("INSERT INTO account_users(account_id,user_id) VALUES($1,$2)", [accountId, userId])
    const businessId = String((await pool.query("INSERT INTO businesses(account_id,name) VALUES($1,'TEST Site') RETURNING id", [accountId])).rows[0].id)
    const sid = String((await pool.query("INSERT INTO sessions(account_id,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour') RETURNING id", [accountId, userId])).rows[0].id)
    const call = (method: string, path: string, headers: Record<string, string> = {}) => web.handler(new Request(`http://localhost${path}`, { method, headers: { cookie: `or_session=${sid}`, ...headers } }))
    const start = async (headers: Record<string, string> = {}) => call("POST", `/api/businesses/${businessId}/github/connect`, headers)
    const state = async () => {
      const r = await start(); expect(r.status).toBe(200)
      const body = Schema.decodeUnknownSync(Schema.Struct({ authorizationUrl: Schema.String }))(await r.json()); return new URL(body.authorizationUrl).searchParams.get("state")!
    }
    const finish = (state: string) => call("GET", `/api/github/callback?state=${state}&code=fixture-code&installation_id=${installation}`)
    return { accountId, businessId, call, start, state, finish }
  }
  it("binds only verified installations, rejects replays and cross-tenant claims, resolves scoped tokens and disconnects", async () => {
    configure(); installation++
    const a = await fixture(), b = await fixture()
    const state = await a.state()
    expect((await b.finish(state)).headers.get("location")).toContain("github=failed")
    expect(providerCalls).toHaveLength(0)
    expect((await a.finish(state)).headers.get("location")).toContain("github=connected")
    const count = providerCalls.length
    expect((await a.finish(state)).headers.get("location")).toContain("github=failed")
    expect(providerCalls).toHaveLength(count)
    expect((await b.finish(await b.state())).headers.get("location")).toContain("github=failed")
    expect(await (await b.call("GET", "/api/github/installations")).json()).toEqual({ repositories: [] })
    const resolve = (accountId: string) => Effect.gen(function*() {
      const config = yield* GitHubExecution
      return yield* resolveGitHubTransport(config, "fixture-org", `site-${installation}`, accountId)
    }).pipe(Effect.provide(GitHubInstallationExecutionLive.pipe(Layer.provide(pgLayer))))
    expect(await Effect.runPromise(resolve(b.accountId))).toBeNull()
    expect(await Effect.runPromise(resolve(a.accountId))).not.toBeNull()
    tokenRefused = true
    expect((await Effect.runPromise(Effect.either(resolve(a.accountId))))._tag).toBe("Left")
    tokenRefused = false
    expect((await b.call("POST", `/api/github/installations/${installation}/disconnect`)).status).toBe(404)
    expect((await a.call("POST", `/api/github/installations/${installation}/disconnect`)).status).toBe(200)
    expect(await Effect.runPromise(resolve(a.accountId))).toBeNull()
  })
  it("requires authentication, origin, business ownership and repository administration", async () => {
    configure(); installation++
    const a = await fixture(), b = await fixture()
    expect((await web.handler(new Request(`http://localhost/api/businesses/${a.businessId}/github/connect`, { method: "POST" }))).status).toBe(401)
    expect((await a.start({ origin: "https://evil.test" })).status).toBe(403)
    expect((await b.call("POST", `/api/businesses/${a.businessId}/github/connect`)).status).toBe(404)
    admin = false
    expect((await a.finish(await a.state())).headers.get("location")).toContain("github=failed")
    expect(await (await a.call("GET", "/api/github/installations")).json()).toEqual({ repositories: [] })
  })
  it("supports the one-use desktop handoff without giving the browser a session", async () => {
    configure(); installation++
    const a = await fixture()
    const body = Schema.decodeUnknownSync(Schema.Struct({ authorizationOrigin: Schema.String, desktopPath: Schema.String }))(await (await a.start({ "x-openrecord-desktop": "1" })).json())
    expect(body.authorizationOrigin).toBe("http://localhost:3001")
    const start = await web.handler(new Request(`http://localhost${body.desktopPath}`))
    const location = start.headers.get("location")!
    expect(new URL(location).hostname).toBe("github.com")
    const cookie = start.headers.get("set-cookie")!.split(";")[0]!
    expect(cookie).not.toContain("or_session")
    expect((await web.handler(new Request(`http://localhost${body.desktopPath}`))).status).toBe(404)
    const state = new URL(location).searchParams.get("state")!
    const callback = `/api/github/callback?state=${state}&code=fixture-code&installation_id=${installation}`
    expect((await web.handler(new Request(`http://localhost${callback}`, { headers: { cookie } }))).headers.get("location")).toBe("openrecord://oauth-complete?status=connected")
    expect((await web.handler(new Request(`http://localhost${callback}`, { headers: { cookie } }))).headers.get("location")).toBe("openrecord://oauth-complete?status=failed")
  })
})
