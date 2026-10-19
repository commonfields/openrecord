import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import { canTransitionGrowth, GrowthChannel, GrowthEvidenceInput, GrowthExecutionRecord, GrowthExecutionType, GrowthMetricDefinitionInput, GrowthExecutionAssurance, GrowthProfileUpdate, GrowthStatus, GrowthReview, growthChannelsForExecution } from "./growth.js"

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
  it("accepts every compatible execution action and channel but never an assurance, actor or verification field", () => {
    const key = "00000000-0000-4000-8000-000000000001"
    const record = { type: "SOURCE_PUBLISHED", channel: "WEBSITE", target: "https://product.test/pricing", description: "TEST published the revised pricing explainer", performedAt: "2026-10-19T10:00:00.000Z", idempotencyKey: key }
    const decode = (v: unknown) => Schema.decodeUnknownEither(GrowthExecutionRecord, { onExcessProperty: "error" })(v)._tag
    expect(decode(record)).toBe("Right")
    // Python-style matrix without Python: each declared type is accepted on
    // exactly the channels the contract calls compatible, and refused outside it.
    for (const type of GrowthExecutionType.literals) for (const channel of GrowthChannel.literals)
      expect(decode({ ...record, type, channel }), `${type}/${channel}`).toBe(growthChannelsForExecution(type).includes(channel) ? "Right" : "Left")
    for (const [type, channel] of [["CAMPAIGN_SENT", "WEBSITE"], ["CAMPAIGN_SENT", "THIRD_PARTY_PROFILE"],
      ["LISTING_UPDATED", "EMAIL"], ["LISTING_UPDATED", "PAID"], ["THIRD_PARTY_CORRECTION_REQUESTED", "WEBSITE"]] as const)
      expect(decode({ ...record, type, channel }), `${type}/${channel}`).toBe("Left")
    for (const bad of [{ type: "DELIVERED" }, { type: "VERIFIED_ACTION" }, { channel: "GITHUB" }, { target: "   " }, { description: "" },
      { performedAt: "soon" }, { performedAt: "2026-10-19" }, { performedAt: "2026-10-19T10:00Z" }, { performedAt: "2026-10-19T10:00" },
      { performedAt: "2026-13-40T10:00:00Z" }, { performedAt: "2026-02-30T10:00:00Z" }, { performedAt: "2026-10-19T24:00:00Z" },
      { performedAt: "2026-10-19T10:00:00+24:00" }, { idempotencyKey: "not-a-uuid" }]) expect(decode({ ...record, ...bad })).toBe("Left")
    expect(decode({ ...record, performedAt: "2026-10-19T10:00:00+07:00" })).toBe("Right")
    expect(decode({ ...record, performedAt: "2024-02-29T10:00:00.123456789Z" })).toBe("Right")
    expect(decode({ ...record, performedAt: "2025-02-29T10:00:00Z" })).toBe("Left")
    expect(decode({ ...record, idempotencyKey: undefined })).toBe("Left")
    // A reference may be a page, listing, campaign, profile or artifact. A
    // URI-looking value must be an absolute, credential-free http(s) URL; the
    // repository never fetches it to accept the attestation.
    for (const target of ["TEST pricing page", "https://product.test/pricing", "http://product.test/pricing?x=1"])
      expect(decode({ ...record, target })).toBe("Right")
    for (const target of ["javascript:alert(1)", "file:///etc/passwd", "ftp://product.test/file", "https://user:pass@product.test/pricing", "https://product.test/a b"])
      expect(decode({ ...record, target })).toBe("Left")
    // A client or agent cannot manufacture the stronger claim: the request has
    // no assurance, actor, verification or tenancy field at all.
    for (const forged of [{ assurance: "SYSTEM_VERIFIED" }, { actor: "SYSTEM" }, { actorId: record.idempotencyKey },
      { verification: { kind: "GROWTH_DELIVERY", id: key, claim: "PR_MERGED" } }, { businessId: key }, { opportunityId: key }, { channel: "WEBSITE", type: "SOURCE_UPDATED", state: "EXECUTED" }])
      expect(decode({ ...record, ...forged })).toBe("Left")
  })
})
