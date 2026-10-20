import { describe, expect, it } from "vitest"
import { createHash } from "node:crypto"
import { canonicalJson, GrowthReportPublishInput, growthReportEvidenceView, publicGrowthReport, type GrowthReportSnapshot } from "./growth-report.js"
import type { GrowthOutcomeEvaluation } from "./growth-evaluation.js"
import { Schema } from "effect"

const user = "00000000-0000-4000-8000-000000000002"
const evaluation: GrowthOutcomeEvaluation = {
  businessId: "00000000-0000-4000-8000-000000000001", opportunityId: "00000000-0000-4000-8000-000000000030", evaluatedAt: "2026-10-01T00:00:00.000Z",
  interpretation: "DESCRIPTIVE_ONLY", status: "COMPARABLE", reasons: [], caveats: [],
  initiative: { id: "00000000-0000-4000-8000-000000000030", title: "TEST", status: "APPROVED", revision: 2, approvedAt: "2026-08-21T00:00:00.000Z",
    decisions: [{ id: "00000000-0000-4000-8000-000000000041", status: "APPROVED", revision: 2, actor: "OPERATOR", userId: user, reason: "TEST internal approval reason", conclusion: null, createdAt: "2026-08-21T00:00:00.000Z" }] },
  goal: { id: "00000000-0000-4000-8000-000000000010", version: 1, statement: "Increase bookings" },
  metric: { id: "00000000-0000-4000-8000-000000000020", version: 1, label: "Bookings", conversionKind: "BOOKING", sourceKind: "OPERATOR_AGGREGATE_EXPORT", sourceIdentity: "TEST booking system",
    eventName: null, propertyRef: null, countingSemantics: "EVENT_COUNT", unit: "COUNT", currency: null, timeZone: "UTC" },
  plan: null, baseline: null, observation: null, comparison: null,
  actions: [{ id: "00000000-0000-4000-8000-000000000060", type: "LISTING_UPDATED", channel: "THIRD_PARTY_PROFILE", performedAt: "2026-09-08T10:00:00.000Z", recordedAt: "2026-09-08T10:05:00.000Z",
    performedDay: "2026-09-08", phase: "UNPLANNED", assurance: "OPERATOR_ATTESTED", actor: "HUMAN", reference: "TEST listing", description: "TEST internal execution note",
    verification: null, association: "THIS_INITIATIVE", initiative: { id: "00000000-0000-4000-8000-000000000030", title: "TEST" } }],
  assumptions: [], limitations: ["TEST limitation"],
}
const snapshot = (overrides: Partial<GrowthReportSnapshot> = {}): GrowthReportSnapshot => ({
  schema: "openrecord.growth-report/v1", business: { id: evaluation.businessId, name: "TEST Salon", websiteUrl: "https://salon.test" },
  initiative: { id: evaluation.opportunityId, title: "TEST", problemStatement: "TEST problem", proposedChange: "TEST change", targetUrl: null, approvedAt: "2026-08-21T00:00:00.000Z", status: "APPROVED" },
  review: null, nextSteps: null, evaluation, sources: [], generatedAt: "2026-10-01T00:00:00.000Z", publication: null, ...overrides,
})

describe("growth report snapshot integrity", () => {
  it("the client page does not name the customer's repository for a verified merge, and still shows ordinary references", () => {
    const verified = { ...evaluation.actions[0]!, id: "00000000-0000-4000-8000-000000000061", type: "SOURCE_UPDATED" as const, channel: "WEBSITE", assurance: "SYSTEM_VERIFIED" as const, actor: "SYSTEM",
      reference: "https://github.com/acme/private-site/pull/7", verification: { kind: "GROWTH_DELIVERY", id: "00000000-0000-4000-8000-000000000062", claim: "PR_MERGED" } }
    const pub = publicGrowthReport({ id: null, snapshotDigest: null, superseded: false, snapshot: snapshot({ evaluation: { ...evaluation, actions: [evaluation.actions[0]!, verified] } }) })
    expect(JSON.stringify(pub)).not.toContain("private-site")
    expect(pub.actions[1]).toMatchObject({ assurance: "SYSTEM_VERIFIED", verification: { kind: "GROWTH_DELIVERY", claim: "PR_MERGED" } })
    expect(pub.actions[0]!.reference).toBe("TEST listing")
  })

  it("canonical JSON is independent of key order and digests deterministically", () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[2,{"y":2,"z":1}]},"b":1}')
    const a = canonicalJson(snapshot()), b = canonicalJson(JSON.parse(JSON.stringify(snapshot())) as unknown)
    expect(createHash("sha256").update(a).digest("hex")).toBe(createHash("sha256").update(b).digest("hex"))
  })
  it("the evidence view ignores read, publication and next-step times but not evidence", () => {
    const base = canonicalJson(growthReportEvidenceView(snapshot()))
    const later = snapshot({ generatedAt: "2026-10-02T00:00:00.000Z", nextSteps: "TEST", publication: { version: 1, publishedAt: "2026-10-02T00:00:00.000Z", supersedesReportId: null },
      evaluation: { ...evaluation, evaluatedAt: "2026-10-02T00:00:00.000Z" } })
    expect(canonicalJson(growthReportEvidenceView(later))).toBe(base)
    expect(canonicalJson(growthReportEvidenceView(snapshot({ evaluation: { ...evaluation, status: "INDETERMINATE" } })))).not.toBe(base)
  })
  it("the client projection drops user ids, internal notes and approval reasons and keeps identifiers in evidence", () => {
    const pub = publicGrowthReport({ id: "00000000-0000-4000-8000-000000000070", snapshotDigest: "a".repeat(64), superseded: false,
      snapshot: snapshot({ publication: { version: 1, publishedAt: "2026-10-01T00:00:00.000Z", supersedesReportId: null } }) })
    const text = JSON.stringify(pub)
    for (const hidden of [user, "TEST internal", "decisions", "actorId", "description"]) expect(text).not.toContain(hidden)
    expect(pub).toMatchObject({ version: 1, publishedAt: "2026-10-01T00:00:00.000Z", evidence: { reportId: "00000000-0000-4000-8000-000000000070", actionIds: ["00000000-0000-4000-8000-000000000060"] } })
    expect(pub.actions[0]).toMatchObject({ assurance: "OPERATOR_ATTESTED", initiativeTitle: "TEST" })
    const draft = publicGrowthReport({ id: null, snapshotDigest: null, superseded: false, snapshot: snapshot() })
    expect(draft).toMatchObject({ version: null, publishedAt: null, evidence: { reportId: null } })
  })
  it("publication input refuses extra fields, blank next steps and malformed digests", () => {
    const decode = Schema.decodeUnknownEither(GrowthReportPublishInput, { onExcessProperty: "error" })
    const ok = { idempotencyKey: "00000000-0000-4000-8000-000000000099", expectedLatestVersion: 0, evidenceDigest: "b".repeat(64), nextSteps: null }
    expect(decode(ok)._tag).toBe("Right")
    for (const bad of [{ ...ok, extra: 1 }, { ...ok, nextSteps: "   " }, { ...ok, evidenceDigest: "B".repeat(64) }, { ...ok, expectedLatestVersion: -1 }]) expect(decode(bad)._tag).toBe("Left")
  })
})
