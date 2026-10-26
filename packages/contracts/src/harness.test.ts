import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import { HarnessJobResult, HarnessSelection } from "./harness.js"

describe("harness wire boundaries", () => {
  const instanceId = "00000000-0000-4000-8000-000000000001"
  it("preserves provider model identifiers without permitting CLI flags or control characters", () => {
    expect(Schema.decodeUnknownSync(HarnessSelection)({ instanceId, model: "provider/model:free" }).model).toBe(
      "provider/model:free"
    )
    for (const model of ["", "--unsafe", "model\nflag", "model\u0000", "x".repeat(201)])
      expect(() => Schema.decodeUnknownSync(HarnessSelection)({ instanceId, model })).toThrow()
  })
  it("requires a lease and a normalized terminal result", () => {
    expect(
      Schema.decodeUnknownSync(HarnessJobResult)({ lease: instanceId, kind: "failed", reason: "RATE_LIMITED" })
    ).toMatchObject({ reason: "RATE_LIMITED" })
    for (const value of [
      { kind: "failed", reason: "TIMEOUT" },
      { lease: instanceId, kind: "failed", reason: "raw private error" }
    ])
      expect(() => Schema.decodeUnknownSync(HarnessJobResult)(value)).toThrow()
  })
  it("accepts only declared reasoning-level values", () => {
    for (const reasoningEffort of ["high", "max", "thinking"]) {
      expect(Schema.decodeUnknownSync(HarnessSelection)({ instanceId, model: "fixture", reasoningEffort }).reasoningEffort).toBe(reasoningEffort)
    }
    for (const reasoningEffort of ["--unsafe", "high\nflag", "invented", 42]) {
      expect(() => Schema.decodeUnknownSync(HarnessSelection)({ instanceId, model: "fixture", reasoningEffort })).toThrow()
    }
  })
})
