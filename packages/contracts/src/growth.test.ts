import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import { canTransitionGrowth, GrowthEvidenceInput, GrowthMetric, GrowthStatus, type GrowthActor } from "./growth.js"

describe("growth authority and metric contract", () => {
  it("exhaustively refuses all undeclared transitions and authorities", () => {
    const actors: GrowthActor[] = ["OPERATOR", "ASSISTANT", "DELIVERY_SYSTEM", "MEASUREMENT_SYSTEM"]
    for (const from of [null, ...GrowthStatus.literals]) for (const to of GrowthStatus.literals) for (const actor of actors) {
      const creation = from === null && (to === "DISCOVERED" || to === "PROPOSED")
      const proposal = from === "DISCOVERED" && to === "PROPOSED"
      const approval = from === "PROPOSED" && to === "APPROVED"
      const cancellation = (from === "DISCOVERED" || from === "PROPOSED" || from === "APPROVED") && to === "CANCELLED"
      const expected = actor === "OPERATOR" ? creation || proposal || approval || cancellation : actor === "ASSISTANT" && (creation || proposal)
      expect(canTransitionGrowth(from, to, actor)).toBe(expected)
      if (actor === "ASSISTANT" && ["APPROVED", "CANCELLED"].includes(to)) expect(expected).toBe(false)
      if (["IN_DELIVERY", "DELIVERED", "MEASURING", "REVIEWED"].includes(to)) expect(expected).toBe(false)
    }
    expect(canTransitionGrowth("PROPOSED", "APPROVED", "OPERATOR")).toBe(true)
    expect(canTransitionGrowth("DISCOVERED", "APPROVED", "OPERATOR")).toBe(false)
    expect(canTransitionGrowth("CANCELLED", "PROPOSED", "OPERATOR")).toBe(false)
  })
  it("allows only configured aggregate event counts and IANA timezones", () => {
    const metric = { kind: "TRIAL_SIGNUPS", analyticsSource: "GA4_AGGREGATE_EXPORT", eventName: "trial_signup", countingSemantics: "EVENT_COUNT", reportingTimeZone: "Asia/Makassar", propertyRef: null }
    expect(Schema.decodeUnknownEither(GrowthMetric)(metric)._tag).toBe("Right")
    for (const bad of [{ countingSemantics: "DISTINCT_USERS" }, { analyticsSource: "GEMINI" }, { eventName: "bad event" }, { reportingTimeZone: "+08:00" }, { reportingTimeZone: "Not/AZone" }]) {
      expect(Schema.decodeUnknownEither(GrowthMetric)({ ...metric, ...bad })._tag).toBe("Left")
    }
  })
  it("has no public evidence constructor for delivery or measured outcome claims", () => {
    for (const type of ["VERIFIED_ACTION", "MEASURED_OUTCOME"]) expect(Schema.decodeUnknownEither(GrowthEvidenceInput)({ type, note: "unverified claim" })._tag).toBe("Left")
    expect(Schema.decodeUnknownEither(GrowthEvidenceInput)({ type: "OBSERVED", note: "Missing reference" })._tag).toBe("Left")
  })
})
