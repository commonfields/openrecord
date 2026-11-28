// The last-resort mapping from a handler's failure to a response.
//
// A failure that reaches here is unexpected: the handler did not turn it into
// a typed 4xx. Its details (SQL text, constraint names, stack traces,
// upstream bodies) go to the server log, never to the client. A plain tagged
// value such as `{ _tag: "BusinessNotFound" }` keeps its tag, which names the
// failure without describing internals; anything thrown or built from Error
// becomes `InternalError`.
import { HttpServerResponse } from "@effect/platform"
import { Cause, Effect } from "effect"

const publicTag = (e: unknown): string => {
  if (e instanceof Error || typeof e !== "object" || e === null) return "InternalError"
  const tag = (e as { _tag?: unknown })._tag
  return typeof tag === "string" && /^[A-Za-z]{1,64}$/.test(tag) ? tag : "InternalError"
}

export const failureResponse = (e: unknown) => {
  const tag = publicTag(e)
  if (tag === "NotAuthenticated") return HttpServerResponse.json({ _tag: tag }, { status: 401 })
  return Effect.logError("request failed", Cause.fail(e)).pipe(
    Effect.zipRight(HttpServerResponse.json({ _tag: tag }, { status: 500 })),
  )
}
