import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import { canTransitionGrowth, GrowthEvidenceInput, GrowthMetricDefinitionInput, GrowthExecutionAssurance, GrowthProfileUpdate, GrowthStatus, GrowthReview } from "./growth.js"

const metric = { conversionKind: "SIGNUP", label: "Trial signups", sourceKind: "GA4_AGGREGATE_EXPORT", sourceIdentity: "TEST GA4", eventName: "trial_signup", countingSemantics: "EVENT_COUNT", unit: "COUNT", currency: null, reportingTimeZone: "Asia/Makassar", propertyRef: "TEST property" }
const valid = (value: unknown) => Schema.decodeUnknownEither(GrowthMetricDefinitionInput, { onExcessProperty: "error" })(value)._tag

describe("channel-neutral growth contract", () => {
  it("permits only declared decision transitions; systems never decide", () => {
    for (const from of [null, ...GrowthStatus.literals]) for (const to of GrowthStatus.literals) for (const actor of ["OPERATOR", "ASSISTANT", "DELIVERY_SYSTEM", "MEASUREMENT_SYSTEM"]) {
      const creation = from === null && (to === "DISCOVERED" || to === "PROPOSED")
      const proposal = from === "DISCOVERED" && to === "PROPOSED"
      const human = (from === "PROPOSED" && to === "APPROVED") || (from === "APPROVED" && to === "REVIEWED") || (["DISCOVERED", "PROPOSED", "APPROVED"].some(s => s === from) && to === "CANCELLED")
      expect(canTransitionGrowth(from, to, actor)).toBe(actor === "OPERATOR" ? creation || proposal || human : actor === "ASSISTANT" && (creation || proposal))
    }
    for (const old of ["IN_DELIVERY", "DELIVERED", "MEASURING"]) expect(Schema.decodeUnknownEither(GrowthStatus)(old)._tag).toBe("Left")
  })
  it("supports software, commerce and services using exact source and unit semantics", () => {
    for (const conversionKind of ["LEAD", "SIGNUP", "PURCHASE", "BOOKING"]) {
      expect(valid({ ...metric, conversionKind })).toBe("Right")
      expect(valid({ ...metric, conversionKind, sourceKind: "OPERATOR_AGGREGATE_EXPORT", eventName: null, propertyRef: null })).toBe("Right")
    }
    expect(valid({ ...metric, sourceKind: "OPERATOR_AGGREGATE_EXPORT", eventName: null, unit: "CURRENCY_MINOR", countingSemantics: "SUM", currency: "USD" })).toBe("Right")
    for (const bad of [{ countingSemantics: "DISTINCT_USERS" }, { eventName: "bad event" }, { reportingTimeZone: "+08:00" }, { reportingTimeZone: "Not/AZone" }, { currency: "USD" }, { sourceIdentity: " " }, { propertyRef: null }, { unit: "CURRENCY_MINOR" }, { sourceKind: "GEMINI" }]) expect(valid({ ...metric, ...bad })).toBe("Left")
    const money = { ...metric, sourceKind: "OPERATOR_AGGREGATE_EXPORT", eventName: null, unit: "CURRENCY_MINOR", countingSemantics: "SUM", currency: "USD" }
    for (const bad of [{ currency: null }, { currency: "usd" }, { countingSemantics: "EVENT_COUNT" }, { eventName: "purchase" }]) expect(valid({ ...money, ...bad })).toBe("Left")
  })
  it("requires a bounded review conclusion and rejects execution evidence as rationale", () => {
    const base = { expectedStatus: "APPROVED", expectedRevision: 2, idempotencyKey: "00000000-0000-4000-8000-000000000001", reason: "TEST reviewed" }
    expect(Schema.decodeUnknownEither(GrowthReview)({ ...base, conclusion: "EXTEND" })._tag).toBe("Right")
    expect(Schema.decodeUnknownEither(GrowthReview)(base)._tag).toBe("Left")
    for (const type of ["VERIFIED_ACTION", "MEASURED_OUTCOME"]) expect(Schema.decodeUnknownEither(GrowthEvidenceInput)({ type, note: "unverified" })._tag).toBe("Left")
  })
  it("names a system-verified merge precisely and cannot call an attestation verified", () => {
    const id = "00000000-0000-4000-8000-000000000001"
    const decode = (v: unknown) => Schema.decodeUnknownEither(GrowthExecutionAssurance)(v)._tag
    const merge = { assurance: "SYSTEM_VERIFIED", actor: "SYSTEM", actorId: null, verification: { kind: "GROWTH_DELIVERY", id, claim: "PR_MERGED" } }
    expect(decode(merge)).toBe("Right")
    expect(decode({ ...merge, verification: { ...merge.verification, claim: "DEPLOYED" } })).toBe("Left")
    expect(decode({ assurance: "OPERATOR_ATTESTED", actor: "HUMAN", actorId: id, verification: null })).toBe("Right")
    expect(decode({ ...merge, assurance: "OPERATOR_ATTESTED", actor: "HUMAN", actorId: id })).toBe("Left")
  })
  it("requires a request identity for profile updates and rejects excess fields", () => {
    const key = "00000000-0000-4000-8000-000000000001"
    const profile = { category: "TEST Software", audience: "TEST operators", valueProposition: "TEST positioning", goalStatement: "Increase trial signups", metric }
    const decode = (v: unknown) => Schema.decodeUnknownEither(GrowthProfileUpdate, { onExcessProperty: "error" })(v)._tag
    expect(decode({ ...profile, idempotencyKey: key })).toBe("Right")
    expect(decode(profile)).toBe("Left")
    expect(decode({ ...profile, idempotencyKey: "not-a-uuid" })).toBe("Left")
    expect(decode({ ...profile, idempotencyKey: key, ignored: true })).toBe("Left")
  })
})
