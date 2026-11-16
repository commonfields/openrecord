import { createHash, randomBytes } from "node:crypto"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "@effect/platform"
import { SqlClient } from "@effect/sql"
import { Effect, Schema } from "effect"
import { BusinessRepository } from "@openrecord/db"
import { decodeRouteId, executionRepositoryDenied } from "@openrecord/contracts"
import { appRequest, boundedJson, githubAppConfig, githubEffect } from "@openrecord/site-operator"
import { adsConfig } from "./ads.js"
import { desktopAuthorization, desktopOAuthCallback } from "./desktop-oauth.js"
import { json, operatorSessionFor, type WithSession } from "./record-routes.js"

const PRIVATE = { "cache-control": "no-store", "referrer-policy": "no-referrer" }
const hash = (value: string) => createHash("sha256").update(value).digest("hex")
const Id = Schema.String.pipe(Schema.pattern(/^[1-9][0-9]{0,15}$/))
const ProviderId = Schema.Number.pipe(Schema.int(), Schema.positive(), Schema.lessThanOrEqualTo(Number.MAX_SAFE_INTEGER))
const Installations = Schema.Struct({ installations: Schema.Array(Schema.Struct({ id: ProviderId, app_id: ProviderId, account: Schema.Struct({ login: Schema.NonEmptyString }), suspended_at: Schema.NullOr(Schema.String) })) })
const Repositories = Schema.Struct({ repositories: Schema.Array(Schema.Struct({ id: ProviderId, full_name: Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/)), permissions: Schema.Struct({ admin: Schema.Boolean }) })) })
const Token = Schema.Struct({ access_token: Schema.NonEmptyString })
const back = (status: string) => HttpServerResponse.empty({ status: 303, headers: { ...PRIVATE, location: `${process.env["APP_BASE_URL"] ?? "http://localhost:3000"}/?github=${status}` } })

export const githubInstallApi = (withSession: WithSession) => {
  const operator = operatorSessionFor(withSession)
  const failed = (error?: unknown) => typeof error === "object" && error !== null && "_tag" in error && error._tag === "NotAuthenticated"
    ? json(401, { _tag: "NotAuthenticated" }, PRIVATE)
    : json(503, { _tag: "GitHubConnectionUnavailable" }, PRIVATE)
  const callback = operator(session => Effect.gen(function*() {
    const request = yield* HttpServerRequest.HttpServerRequest
    const query = new URL(request.url, "http://localhost").searchParams
    const state = query.get("state") ?? "", code = query.get("code") ?? ""
    if (!/^[A-Za-z0-9_-]{43}$/.test(state) || !code || code.length > 1024) return back("failed")
    const config = githubAppConfig()
    if (!config) return back("unavailable")
    const sql = yield* SqlClient.SqlClient
    // Claim before contacting GitHub. Replays and a different live session cannot bind anything.
    const pending = yield* sql`UPDATE github_install_states SET consumed_at = now()
      WHERE state_sha256 = ${hash(state)} AND session_id = ${request.cookies["or_session"] ?? ""}::uuid
        AND account_id = ${session.accountId} AND expires_at > now() AND consumed_at IS NULL
        AND EXISTS (SELECT 1 FROM businesses b WHERE b.id = business_id AND b.account_id = ${session.accountId}) RETURNING business_id`
    if (!pending.length) return back("failed")
    const result = yield* githubEffect(async () => {
      const response = await fetch("https://github.com/login/oauth/access_token", { method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ client_id: config.clientId, client_secret: config.clientSecret, code, redirect_uri: config.callbackUrl }),
      })
      if (!response.ok) { await response.body?.cancel(); throw new Error("Token exchange refused") }
      const token = Schema.decodeUnknownSync(Token)(await boundedJson(response)).access_token
      // The user's token proves access; app credentials alone must never prove ownership.
      const installations = []
      for (let page = 1; page <= 10; page++) {
        const batch = Schema.decodeUnknownSync(Installations)(await appRequest(`/user/installations?per_page=100&page=${page}`, token)).installations
        installations.push(...batch)
        if (batch.length < 100) break
        if (page === 10) throw new Error("Too many installations")
      }
      const selected = query.get("installation_id")
      if (selected !== null && !Schema.is(Id)(selected)) throw new Error("Invalid installation")
      const candidates = installations.filter(i => i.app_id === Number(config.appId) && i.suspended_at === null && (selected === null || String(i.id) === selected))
      if (candidates.length > 10) throw new Error("Too many matching installations")
      const verified = []
      for (const installation of candidates) {
        const repositories = []
        for (let page = 1; page <= 10; page++) {
          const batch = Schema.decodeUnknownSync(Repositories)(await appRequest(`/user/installations/${installation.id}/repositories?per_page=100&page=${page}`, token)).repositories
          repositories.push(...batch.filter(r => r.permissions.admin && !executionRepositoryDenied(...splitName(r.full_name))))
          if (batch.length < 100) break
          if (page === 10) throw new Error("Too many repositories")
        }
        if (repositories.length) verified.push({ installation, repositories })
      }
      return verified
    }).pipe(Effect.either)
    if (result._tag === "Left" || !result.right.length) return back("failed")
    const saved = yield* sql.withTransaction(Effect.gen(function*() {
      const live = yield* sql`SELECT 1 FROM sessions s JOIN account_users u ON u.account_id = s.account_id AND u.user_id = s.user_id
        WHERE s.id = ${request.cookies["or_session"] ?? ""}::uuid AND s.account_id = ${session.accountId} AND s.expires_at > now()`
      if (!live.length) return 0
      let count = 0
      for (const { installation, repositories } of result.right) {
        // ON CONFLICT locks the installation; a concurrent tenant cannot steal it.
        const claimed = yield* sql`INSERT INTO github_installations(installation_id, account_id, login, connected_by_user_id)
          VALUES (${String(installation.id)}, ${session.accountId}, ${installation.account.login}, ${session.userId})
          ON CONFLICT (installation_id) DO UPDATE SET disconnected_at = NULL, connected_at = now(), connected_by_user_id = EXCLUDED.connected_by_user_id
          WHERE github_installations.account_id = EXCLUDED.account_id RETURNING installation_id`
        if (!claimed.length) continue
        yield* sql`DELETE FROM github_installation_repositories WHERE installation_id = ${String(installation.id)} AND account_id = ${session.accountId}`
        for (const repo of repositories) yield* sql`INSERT INTO github_installation_repositories(installation_id, account_id, repository_id, full_name)
          VALUES (${String(installation.id)}, ${session.accountId}, ${String(repo.id)}, ${repo.full_name})`
        count++
      }
      return count
    }))
    return back(saved ? "connected" : "failed")
  })).pipe(Effect.catchAll(() => Effect.succeed(back("failed"))))
  return HttpRouter.empty.pipe(
    HttpRouter.post("/api/businesses/:id/github/connect", operator(session => Effect.gen(function*() {
      const { params } = yield* HttpRouter.RouteContext
      const businessId = params["id"] ?? ""
      if (decodeRouteId(businessId)._tag === "Left") return yield* json(422, { _tag: "InvalidRequest" }, PRIVATE)
      if (!(yield* (yield* BusinessRepository).getScoped(session.accountId, businessId))) return yield* json(404, { _tag: "BusinessNotFound" }, PRIVATE)
      const config = githubAppConfig(), cipher = (yield* adsConfig).cipher
      if (!config || !cipher) return yield* failed()
      const request = yield* HttpServerRequest.HttpServerRequest
      const state = randomBytes(32).toString("base64url")
      const sql = yield* SqlClient.SqlClient
      yield* sql`DELETE FROM github_install_states WHERE expires_at < now() - interval '1 day'`
      yield* sql`INSERT INTO github_install_states(state_sha256, session_id, account_id, business_id)
        VALUES (${hash(state)}, ${request.cookies["or_session"] ?? ""}::uuid, ${session.accountId}, ${businessId})`
      const url = new URL(`https://github.com/apps/${config.slug}/installations/new`)
      url.searchParams.set("state", state)
      url.searchParams.set("redirect_uri", config.callbackUrl)
      return yield* desktopAuthorization(url.toString(), state, "/api/github/callback", cipher)
    })).pipe(Effect.catchAll(failed))),
    HttpRouter.get("/api/github/callback", desktopOAuthCallback(callback)),
    HttpRouter.get("/api/github/installations", operator(session => Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const repositories = yield* sql`SELECT r.installation_id AS "installationId", r.full_name AS "fullName" FROM github_installation_repositories r
        JOIN github_installations i USING (installation_id, account_id) WHERE r.account_id = ${session.accountId} AND i.disconnected_at IS NULL ORDER BY r.full_name`
      return yield* json(200, { repositories }, PRIVATE)
    })).pipe(Effect.catchAll(failed))),
    HttpRouter.post("/api/github/installations/:installationId/disconnect", operator(session => Effect.gen(function*() {
      const { params } = yield* HttpRouter.RouteContext
      const id = params["installationId"] ?? ""
      if (!Schema.is(Id)(id)) return yield* json(422, { _tag: "InvalidRequest" }, PRIVATE)
      const sql = yield* SqlClient.SqlClient
      const rows = yield* sql`UPDATE github_installations SET disconnected_at = now() WHERE installation_id = ${id} AND account_id = ${session.accountId} RETURNING installation_id`
      return yield* json(rows.length ? 200 : 404, { disconnected: rows.length > 0 }, PRIVATE)
    })).pipe(Effect.catchAll(failed))),
  )
}
const splitName = (name: string): [string, string] => { const [owner = "", repo = ""] = name.split("/"); return [owner, repo] }
