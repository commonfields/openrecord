// System authorization for the desktop. A one-use ticket is bound to an
// existing OAuth state and live session. It authorizes exactly that callback;
// it never sets an application session cookie in the authorization browser.
import { createHash, randomBytes } from "node:crypto"
import { Headers, HttpRouter, HttpServerRequest, HttpServerResponse } from "@effect/platform"
import { SqlClient } from "@effect/sql"
import { Effect, Option, Schema } from "effect"
import { Ga4Provider, type TokenCipher } from "@openrecord/ga4"
import { AdsProvider } from "@openrecord/ads"
import { json } from "./record-routes.js"

const digest = (s: string) => createHash("sha256").update(s).digest("hex")
const COOKIE = "or_desktop_oauth"
const TOKEN = /^[A-Za-z0-9_-]{43}$/
const PRIVATE = { "cache-control": "no-store", "referrer-policy": "no-referrer", "x-robots-tag": "noindex, nofollow" }
/** Called only after the normal authenticated connect route creates its state. */
export const desktopAuthorization = (authorizationUrl: string, state: string, callbackPath: string, cipher: TokenCipher) => Effect.gen(function*() {
  const request = yield* HttpServerRequest.HttpServerRequest
  if (request.headers["x-openrecord-desktop"] !== "1") return yield* json(200, { authorizationUrl }, PRIVATE)
  const sid = request.cookies["or_session"] ?? ""
  if (!Schema.is(Schema.UUID)(sid)) return yield* json(401, { _tag: "NotAuthenticated" }, PRIVATE)
  const token = randomBytes(32).toString("base64url")
  const sql = yield* SqlClient.SqlClient
  yield* sql`DELETE FROM desktop_oauth_handoffs WHERE expires_at < now() - interval '1 day'`
  yield* sql`INSERT INTO desktop_oauth_handoffs(token_sha256, session_id, state_sha256, callback_path, authorization_ciphertext)
    VALUES (${digest(token)}, ${sid}, ${digest(state)}, ${callbackPath}, ${cipher.encrypt(authorizationUrl, `desktop-oauth:${digest(token)}`)})`
  const authorizationOrigin = new URL(new URL(authorizationUrl).searchParams.get("redirect_uri")!).origin
  return yield* json(200, { authorizationOrigin, desktopPath: `/api/desktop/oauth/start/${token}` }, PRIVATE)
})

export const desktopOAuthApi = () => HttpRouter.empty.pipe(
  HttpRouter.get("/api/desktop/oauth/start/:token", Effect.gen(function*() {
    const { params } = yield* HttpRouter.RouteContext
    const token = params["token"] ?? ""
    if (!TOKEN.test(token)) return yield* json(404, { _tag: "AuthorizationNotFound" }, PRIVATE)
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql`UPDATE desktop_oauth_handoffs h SET started_at = now() FROM sessions s
      WHERE h.token_sha256 = ${digest(token)} AND h.session_id = s.id AND s.expires_at > now()
        AND h.expires_at > now() AND h.started_at IS NULL AND h.consumed_at IS NULL RETURNING h.authorization_ciphertext, h.callback_path`
    if (!rows.length) return yield* json(404, { _tag: "AuthorizationNotFound" }, PRIVATE)
    const google = Option.getOrNull(yield* Effect.serviceOption(Ga4Provider))
    const ads = Option.getOrNull(yield* Effect.serviceOption(AdsProvider))
    const cipher = rows[0]!["callback_path"] === "/api/growth/ga4/oauth/callback" ? (google?.configured ? google.cipher : null) : ads?.cipher
    const authorizationUrl = cipher?.decrypt(String(rows[0]!["authorization_ciphertext"]), `desktop-oauth:${digest(token)}`)
    if (!authorizationUrl) return yield* json(503, { _tag: "AuthorizationUnavailable" }, PRIVATE)
    const secure = new URL(new URL(authorizationUrl).searchParams.get("redirect_uri")!).protocol === "https:"
    return HttpServerResponse.empty({ status: 303, headers: { ...PRIVATE, location: authorizationUrl,
      "set-cookie": `${COOKIE}=${token}; Path=/api/; HttpOnly; SameSite=Lax; Max-Age=600${secure ? "; Secure" : ""}` } })
  }).pipe(Effect.catchAll(() => json(503, { _tag: "AuthorizationUnavailable" }, PRIVATE)))),
)

/** Wrap only the two OAuth callbacks. The capability cannot access any other route. */
export const desktopOAuthCallback = <E, R>(callback: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) => Effect.gen(function*() {
  const request = yield* HttpServerRequest.HttpServerRequest
  const token = request.cookies[COOKIE]
  const finish = (ok: boolean) => HttpServerResponse.empty({ status: 303, headers: { ...PRIVATE,
    location: `openrecord://oauth-complete?status=${ok ? "connected" : "failed"}`,
    "set-cookie": `${COOKIE}=; Path=/api/; HttpOnly; SameSite=Lax; Max-Age=0` } })
  const url = new URL(request.url, "http://localhost")
  const state = url.searchParams.get("state") ?? ""
  if (!token) {
    if (!TOKEN.test(state)) return yield* callback
    const sql = yield* SqlClient.SqlClient
    const desktop = yield* sql`SELECT 1 FROM desktop_oauth_handoffs WHERE state_sha256 = ${digest(state)} AND callback_path = ${url.pathname}`
    // A missing callback cookie never turns a desktop flow into a web-app flow.
    return yield* (desktop.length ? Effect.succeed(finish(false)) : callback)
  }
  if (!TOKEN.test(token) || !TOKEN.test(state)) return finish(false)
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql`UPDATE desktop_oauth_handoffs h SET consumed_at = now() FROM sessions s
    WHERE h.token_sha256 = ${digest(token)} AND h.state_sha256 = ${digest(state)} AND h.callback_path = ${url.pathname}
      AND h.session_id = s.id AND s.expires_at > now() AND h.expires_at > now() AND h.started_at IS NOT NULL AND h.consumed_at IS NULL
    RETURNING h.session_id`
  if (!rows.length) return finish(false)
  // Use the ticket's original live session only for this callback invocation.
  // Existing account/state/PKCE checks still run inside the original callback.
  const scopedRequest = request.modify({ headers: Headers.set(request.headers, "cookie", `or_session=${String(rows[0]!["session_id"])}`) })
  const result = yield* callback.pipe(Effect.provideService(HttpServerRequest.HttpServerRequest, scopedRequest), Effect.either)
  if (result._tag === "Left") return finish(false)
  const location = result.right.headers["location"] ?? ""
  const status = new URL(location, "http://localhost").searchParams
  return finish(["connected", "reconnected"].includes(status.get("google") ?? status.get("ga4") ?? status.get("ads") ?? ""))
})
