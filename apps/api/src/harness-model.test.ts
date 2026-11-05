import { describe, expect, it } from "vitest"
import { harnessFailureReason } from "./harness-model.js"

describe("bridge failure classification", () => {
  it.each([
    ["CANCELLED", "CANCELLED"], ["UNAUTHENTICATED", "UNCONFIGURED"], ["MODEL_UNAVAILABLE", "UNCONFIGURED"],
    ["RATE_LIMITED", "RATE_LIMITED"], ["TIMEOUT", "TIMEOUT"], ["CONTEXT_LIMIT", "CONTEXT_LIMIT"],
    ["MALFORMED", "MALFORMED"], ["UNAVAILABLE", "UNAVAILABLE"],
  ])("preserves %s as %s instead of treating it as retryable downtime", (input, expected) => {
    expect(harnessFailureReason(input)).toBe(expected)
  })
})
