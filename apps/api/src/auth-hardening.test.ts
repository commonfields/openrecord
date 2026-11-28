import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import { HttpServerResponse } from "@effect/platform"
import { hashPassword, hashPasswordEffect, verifyPasswordEffect } from "./auth.js"
import { Throttle } from "./auth-throttle.js"
import { writeOriginAllowed } from "./agent-origin.js"
import { failureResponse } from "./http-failure.js"

const APP = "https://app.example.test"
const req = (headers: Record<string, string>) => ({ headers: { host: "api.example.test", ...headers } }) as never

describe("password hashing off the event loop", () => {
  it("verifies hashes from either path and refuses a missing account", async () => {
    const asyncHash = await Effect.runPromise(hashPasswordEffect("password123"))
    const syncHash = hashPassword("password123")
    for (const h of [asyncHash, syncHash]) {
      expect(await Effect.runPromise(verifyPasswordEffect("password123", h))).toBe(true)
      expect(await Effect.runPromise(verifyPasswordEffect("wrong-password", h))).toBe(false)
    }
    expect(await Effect.runPromise(verifyPasswordEffect("password123", null))).toBe(false)
    expect(await Effect.runPromise(verifyPasswordEffect("password123", "not-a-hash"))).toBe(false)
  })

  it("refuses a short password with a typed failure", async () => {
    const exit = await Effect.runPromise(Effect.either(hashPasswordEffect("short")))
    expect(exit._tag).toBe("Left")
  })
})

describe("throttle", () => {
  it("blocks at the limit and opens again when the window ends", () => {
    let now = 0
    const t = new Throttle(() => now)
    const limit = { max: 3, windowMs: 1000 }
    for (let i = 0; i < 3; i++) {
      expect(t.blockedFor("k", limit)).toBe(0)
      t.hit("k", limit)
    }
    expect(t.blockedFor("k", limit)).toBe(1000)
    expect(t.blockedFor("other", limit)).toBe(0)
    now = 400
    expect(t.blockedFor("k", limit)).toBe(600)
    now = 1000
    expect(t.blockedFor("k", limit)).toBe(0)
  })

  it("clears a key on success", () => {
    const t = new Throttle(() => 0)
    const limit = { max: 1, windowMs: 1000 }
    t.hit("k", limit)
    expect(t.blockedFor("k", limit)).toBeGreaterThan(0)
    t.clear("k")
    expect(t.blockedFor("k", limit)).toBe(0)
  })
})

describe("write origin check", () => {
  it("allows the app, the API itself, and clients without browser metadata", () => {
    expect(writeOriginAllowed(req({ origin: APP }), APP)).toBe(true)
    expect(writeOriginAllowed(req({ origin: "https://api.example.test" }), APP)).toBe(true)
    expect(writeOriginAllowed(req({ origin: "https://x.test", "sec-fetch-site": "same-origin" }), APP)).toBe(true)
    expect(writeOriginAllowed(req({}), APP)).toBe(true)
    expect(writeOriginAllowed(req({ "sec-fetch-site": "none" }), APP)).toBe(true)
  })

  it("refuses other origins, opaque origins and cross-site or same-site browser requests", () => {
    expect(writeOriginAllowed(req({ origin: "https://evil.test" }), APP)).toBe(false)
    expect(writeOriginAllowed(req({ origin: "https://sub.example.test", "sec-fetch-site": "same-site" }), APP)).toBe(false)
    expect(writeOriginAllowed(req({ origin: "null" }), APP)).toBe(false)
    expect(writeOriginAllowed(req({ origin: "not a url" }), APP)).toBe(false)
    expect(writeOriginAllowed(req({ "sec-fetch-site": "cross-site" }), APP)).toBe(false)
    expect(writeOriginAllowed(req({ "sec-fetch-site": "same-site" }), APP)).toBe(false)
  })
})

describe("failure responses", () => {
  const body = async (e: unknown) => {
    const res = await Effect.runPromise(failureResponse(e) as Effect.Effect<HttpServerResponse.HttpServerResponse>)
    return { status: res.status, json: JSON.parse(new TextDecoder().decode((res.body as { body: Uint8Array }).body)) }
  }

  it("never sends error internals to the client", async () => {
    const sqlLike = Object.assign(new Error('duplicate key value violates unique constraint "users_email_key"'), { _tag: "SqlError" })
    expect(await body(sqlLike)).toEqual({ status: 500, json: { _tag: "InternalError" } })
    expect(await body({ _tag: "Weird tag; DROP", detail: "secret" })).toEqual({ status: 500, json: { _tag: "InternalError" } })
    expect(await body("boom")).toEqual({ status: 500, json: { _tag: "InternalError" } })
  })

  it("keeps a plain tag and maps NotAuthenticated to 401", async () => {
    expect(await body({ _tag: "NotAuthenticated" })).toEqual({ status: 401, json: { _tag: "NotAuthenticated" } })
    expect(await body({ _tag: "BusinessNotFound", query: "SELECT secret" })).toEqual({ status: 500, json: { _tag: "BusinessNotFound" } })
  })
})
