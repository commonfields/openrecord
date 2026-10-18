import { HttpServerRequest } from "@effect/platform"
import { Config, Effect } from "effect"
// Match the Client Record write boundary, including hostile same-site frames.
export const agentOriginAllowed = Effect.gen(function*() {
  const request = yield* HttpServerRequest.HttpServerRequest
  const origin = request.headers["origin"]
  if (origin === undefined) return !["cross-site", "same-site"].includes(request.headers["sec-fetch-site"] ?? "")
  const app = yield* Config.string("APP_BASE_URL").pipe(Config.withDefault("http://localhost:3000"))
  try { return origin === new URL(app).origin } catch { return false }
})
