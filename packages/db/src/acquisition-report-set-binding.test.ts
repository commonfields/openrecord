// Report consistency: the agency report header and basis disclosures must
// describe the question set that was actually measured, not merely the newest
// set. A newer, not-yet-run set must not replace the measured set's basis,
// digest, owned domains or competitors, and must not drop the public-research
// disclosure for periods measured under a PUBLIC_RESEARCH set.
// Every row is a TEST fixture; no database.
import { describe, expect, it } from "vitest"
import type { AcqBatch, AcqCheck, AcqQuestionSet, AcqSnapshot } from "./acquisition.js"
import { acquisitionReport } from "./acquisition-view.js"

const question = (id: string) => ({ id, key: "CD-01", group: "CATEGORY_DISCOVERY" as const, position: 1, buyerQuestionId: `b-${id}`,
  prompt: "What are good TEST support tools?", createdAt: "" })
const V1: AcqQuestionSet = {
  id: "00000000-0000-4000-8000-0000000000a1", version: 1, basis: "PUBLIC_RESEARCH", category: "TEST support software", specDigest: "1".repeat(64),
  createdAt: "2026-10-01T00:00:00.000Z",
  target: { name: "Supportly", aliases: [], domains: ["supportly.test"], matchCase: false, ambiguity: null },
  competitors: [{ name: "HelpHub", aliases: [], domains: ["helphub.test"], matchCase: false, ambiguity: null }],
  questions: [question("q1")],
}
// Created after the v1 batch completed; never measured.
const V2: AcqQuestionSet = {
  ...V1, id: "00000000-0000-4000-8000-0000000000a2", version: 2, basis: "AUTHORIZED_CLIENT", specDigest: "2".repeat(64),
  createdAt: "2026-10-05T00:00:00.000Z",
  target: { ...V1.target, domains: ["supportly-new.test"] },
  competitors: [{ name: "DeskPal", aliases: [], domains: ["deskpal.test"], matchCase: false, ambiguity: null }],
  questions: [question("q2")],
}
const BATCH: AcqBatch = { id: "batch-v1", setId: V1.id, scope: "SMOKE", questionCount: 1, sampleCount: 1, provider: "gemini",
  requestedModel: "gemini-3.5-flash-lite", retrievalRequested: true, maxProviderCalls: 4, createdAt: "2026-10-02T00:00:00.000Z" }
const CHECK: AcqCheck = {
  id: "c1", batchId: BATCH.id, questionId: "q1", sample: 1, status: "SUCCEEDED", failureClass: null, failureDetailSafe: null, attempts: 1,
  queuedAt: "2026-10-02T00:00:00.000Z", completedAt: "2026-10-02T00:01:00.000Z",
  observation: {
    id: "o1", provider: "gemini", requestedModel: "gemini-3.5-flash-lite", observedModel: "gemini-3.5-flash-lite", collectedAt: "2026-10-02T00:01:00.000Z",
    answerText: "Supportly is a good choice.", retrievalMode: "PROVIDER_GROUNDING", retrievalTool: "google_search", requestParameters: { tools: ["google_search"] },
    rawDigest: "d".repeat(64), synthetic: false, providerMetadata: {}, citations: [],
  },
  judgments: [{ id: "j1", mention: "MENTIONED", recommendation: "RECOMMENDED", detectorVersion: "acq-exact-alias-v1", candidateCount: 1, note: null,
    supersedesId: null, reviewedByUserId: "u1", reviewedAt: "2026-10-03T00:00:00.000Z" }],
}
const SNAPSHOT: AcqSnapshot = {
  profile: { businessId: "00000000-0000-4000-8000-0000000000b1", name: "TEST Supportly", websiteUrl: "https://supportly.test", engagement: "PILOT" },
  sets: [V1, V2], batches: [BATCH], checks: [CHECK], imports: [],
}

describe("agency report set binding", () => {
  const report = acquisitionReport(SNAPSHOT)

  it("measured one period, under set v1", () => {
    expect(report.periods.map(p => p.setVersion)).toEqual([1])
  })
  it("keeps the public-research disclosure for a period measured under a PUBLIC_RESEARCH set", () => {
    expect(report.limitations.some(l => l.startsWith("Public research pilot:"))).toBe(true)
  })
  it("describes the measured set in the header, not a newer unmeasured set", () => {
    expect(report.basis).toBe("PUBLIC_RESEARCH")
    expect(report.questionSet?.version).toBe(1)
    expect(report.questionSet?.specDigest).toBe(V1.specDigest)
    expect(report.ownedDomains).toEqual(["supportly.test"])
    expect(report.competitors).toEqual(["HelpHub"])
  })
  it("ignores a queued period when selecting the header", () => {
    const batch = { ...BATCH, id: "queued-v2", setId: V2.id }
    const queued: AcqCheck = { ...CHECK, id: "queued", batchId: batch.id, questionId: "q2", status: "QUEUED", observation: null, judgments: [] }
    const result = acquisitionReport({ ...SNAPSHOT, batches: [BATCH, batch], checks: [CHECK, queued] })
    expect(result.periods).toHaveLength(1)
    expect(result.questionSet?.specDigest).toBe(V1.specDigest)
  })
  it("keeps disclosures for older periods when the latest period has a different basis", () => {
    const fixture = { ...V2, basis: "FIXTURE" as const }
    const batch = { ...BATCH, id: "batch-v2", setId: V2.id }
    const check = { ...CHECK, id: "c2", batchId: batch.id, questionId: "q2" }
    const result = acquisitionReport({ ...SNAPSHOT, sets: [V1, fixture], batches: [BATCH, batch], checks: [CHECK, check] })
    expect(result.questionSet?.specDigest).toBe(V2.specDigest)
    expect(result.limitations.some(l => l.startsWith("Public research pilot:"))).toBe(true)
    expect(result.limitations).toContain("Fixture periods contain test fixtures.")
    expect(result.limitations).not.toContain("Fixture pilot: every figure comes from test fixtures.")
  })
  it("uses the latest completed batch even when it remeasures an older set", () => {
    const batch = { ...BATCH, id: "batch-v2", setId: V2.id }
    const check = { ...CHECK, id: "c2", batchId: batch.id, questionId: "q2" }
    const rerun = { ...BATCH, id: "rerun-v1" }
    const result = acquisitionReport({ ...SNAPSHOT, batches: [BATCH, batch, rerun], checks: [CHECK, check, { ...CHECK, id: "c3", batchId: rerun.id }] })
    expect(result.questionSet?.specDigest).toBe(V1.specDigest)
    expect(result.periods.map(p => p.setVersion)).toEqual([1, 2, 1])
  })
  it("preserves the latest configured set before any period completes", () => {
    const result = acquisitionReport({ ...SNAPSHOT, batches: [], checks: [] })
    expect(result.questionSet?.specDigest).toBe(V2.specDigest)
    expect(result.periods).toEqual([])
    expect(acquisitionReport({ ...SNAPSHOT, sets: [], batches: [], checks: [] }).questionSet).toBeNull()
  })
})
