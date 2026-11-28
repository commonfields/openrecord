import { HttpApp, HttpServerRequest, HttpServerResponse } from "@effect/platform"
import { Config, Effect } from "effect"
import { parseCookies, SESSION_COOKIE } from "./auth.js"

const appOrigin = Config.string("APP_BASE_URL").pipe(Config.withDefault("http://localhost:3000"))

// Match the Client Record write boundary, including hostile same-site frames.
export const agentOriginAllowed = Effect.gen(function*() {
  const request = yield* HttpServerRequest.HttpServerRequest
  const origin = request.headers["origin"]
  if (origin === undefined) return !["cross-site", "same-site"].includes(request.headers["sec-fetch-site"] ?? "")
  const app = yield* appOrigin
  try { return origin === new URL(app).origin } catch { return false }
})

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"])

/**
 * Whether a state-changing request that carries the session cookie may run.
 *
 * Allowed: the app's own origin (APP_BASE_URL), the API's own origin (its
 * published pages post back to it), and clients that send no Origin and no
 * cross-site Fetch Metadata, which is how the desktop app, the bridge and
 * scripts call. Refused: any other origin, and browser requests marked
 * same-site or cross-site, so a sibling subdomain cannot ride the cookie
 * (SameSite=Lax alone lets same-site requests through).
 */
export const writeOriginAllowed = (request: HttpServerRequest.HttpServerRequest, app: string): boolean => {
  const origin = request.headers["origin"]
  const site = request.headers["sec-fetch-site"] ?? ""
  // "null" is what sandboxed frames and some redirects send: never trusted.
  if (origin === "null") return false
  if (origin === undefined) return site !== "cross-site" && site !== "same-site"
  try {
    const parsed = new URL(origin)
    if (parsed.origin === new URL(app).origin) return true
    return site === "same-origin" || parsed.host === request.headers["host"]
  } catch {
    return false
  }
}

/**
 * One cross-site request check in front of every route. Only requests that
 * carry the session cookie are checked: bearer-token routes (bridge, MCP,
 * traffic feeds) and public forms hold no ambient credential to abuse.
 */
export const withOriginGuard = <E, R>(app: HttpApp.Default<E, R>) =>
  Effect.gen(function*() {
    const request = yield* HttpServerRequest.HttpServerRequest
    if (SAFE_METHODS.has(request.method)) return yield* app
    if (!(SESSION_COOKIE in parseCookies(request.headers["cookie"] ?? null))) return yield* app
    if (!writeOriginAllowed(request, yield* Effect.orDie(appOrigin))) {
      return yield* HttpServerResponse.json({ _tag: "OriginRefused" }, { status: 403 })
    }
    return yield* app
  })
