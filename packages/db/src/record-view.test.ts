// Pure record derivation: comparison rules, sample counts, findings, run
// status, judgment heads and the public allowlist. Rows are hand-built TEST
// fixtures.
import { describe, expect, it } from "vitest"
import { hostedMeasurementContext } from "./evidence.js"
import {
  compareSlot, countSamples, currentJudgment, findingFor, publicRecord, runStatus, sampleStatement, type SlotEvidence,
} from "./record-view.js"
import type { RecordCheck, RecordItem, RecordJudgment, RecordObservation, RecordSnapshot } from "./record.js"

const BIZ = "00000000-0000-4000-8000-000000000001"
const item = (over: Partial<RecordItem> = {}): RecordItem => ({
  id: "00000000-0000-4000-8000-0000000000a1", slot: 1, supersedesId: null, superseded: false, createdAt: "2026-10-01T00:00:00.000Z",
  sourceUrl: "https://client.test/rooms", approval: { approvedAt: "2026-10-01T00:00:00.000Z", approvedByUserId: "00000000-0000-4000-8000-0000000000u1" },
  fact: { id: "00000000-0000-4000-8000-0000000000f1", subject: "TEST Hotel", predicate: "Breakfast included", valueText: "Yes", valueType: "TEXT",
    version: 1, status: "ACTIVE", validFrom: "2026-01-01T00:00:00.000Z", validUntil: null },
  question: { id: "00000000-0000-4000-8000-0000000000q1", prompt: "Is breakfast included at TEST Hotel?" },
  ...over,
})
let seq = 0
const observation = (at: string, over: Partial<RecordObservation> = {}, model = "gemini-2.5-flash"): RecordObservation => ({
  id: `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`, provider: "gemini", requestedModel: "gemini-2.5-flash", observedModel: model,
  modelVersion: model, collectedAt: at, answerText: "Breakfast costs €20.", retrievalMode: "PROVIDER_GROUNDING", retrievalTool: "google_search",
  requestParameters: { model: "gemini-2.5-flash", tools: ["google_search"] }, rawDigest: "a".repeat(64), synthetic: false,
  measurementContext: hostedMeasurementContext({ businessId: BIZ, questionId: item().question.id, checkRunId: `run-${seq}`, prompt: item().question.prompt,
    provider: "gemini", requestedModel: "gemini-2.5-flash", observedModel: model, observedAt: at }),
  providerMetadata: { responseId: "internal-response-id" }, citations: [{ uri: "https://source.test/a", title: "source.test", position: 1 }],
  ...over,
})
const judgment = (decision: RecordJudgment["decision"], over: Partial<RecordJudgment> = {}): RecordJudgment => ({
  id: `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`, decision, note: "TEST internal note", supersedesId: null,
  claimId: null, factId: item().fact.id, factVersion: 1,
  reviewedByUserId: "00000000-0000-4000-8000-0000000000u1", reviewedAt: "2026-10-02T00:00:00.000Z", ...over,
})
const check = (obs: RecordObservation | null, status: RecordCheck["status"] = obs ? "SUCCEEDED" : "FAILED", judgments: RecordJudgment[] = [], over: Partial<RecordCheck> = {}): RecordCheck => ({
  id: `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`, runId: "r", itemId: item().id, sample: 1, questionId: item().question.id, status,
  failureClass: status === "FAILED" ? "PROVIDER_UNAVAILABLE" : null, failureDetailSafe: status === "FAILED" ? "provider unavailable" : null,
  queuedAt: "2026-10-01T00:00:00.000Z", completedAt: "2026-10-01T00:00:00.000Z", observation: obs, claims: [], judgments, ...over,
})
const ev = (c: RecordCheck, it: RecordItem = item()): SlotEvidence => ({ check: c, item: it, judgment: currentJudgment(c.judgments), runComplete: true })
const T1 = "2026-10-01T10:00:00.000Z"
const T2 = "2026-10-08T10:00:00.000Z"
const pair = (b: RecordJudgment["decision"], a: RecordJudgment["decision"], actionRecorded = true) =>
  compareSlot([ev(check(observation(T1), "SUCCEEDED", [judgment(b)]))], [ev(check(observation(T2), "SUCCEEDED", [judgment(a)]))], actionRecorded)

describe("record comparison rules", () => {
  it("derives the outcomes from reviewed judgments", () => {
    expect(pair("CONTRADICTS", "MATCHES")).toEqual({ state: "DERIVED", outcome: "OBSERVED_CORRECTED", reason: null })
    expect(pair("CONTRADICTS", "CONTRADICTS")).toEqual({ state: "DERIVED", outcome: "NO_OBSERVED_CHANGE", reason: null })
    expect(pair("MATCHES", "MATCHES")).toMatchObject({ outcome: "INDETERMINATE", reason: "BASELINE_MATCHED" })
    expect(pair("CONTRADICTS", "UNKNOWN")).toMatchObject({ outcome: "INDETERMINATE", reason: "AFTER_UNKNOWN" })
    expect(pair("UNKNOWN", "MATCHES")).toMatchObject({ outcome: "INDETERMINATE", reason: "BEFORE_UNKNOWN" })
    // A regression is not "no change" and not a correction.
    expect(pair("MATCHES", "CONTRADICTS")).toMatchObject({ outcome: "INDETERMINATE", reason: "ANSWER_NO_LONGER_MATCHES" })
  })
  it("takes no credit when a contradiction disappears without a recorded action", () => {
    expect(pair("CONTRADICTS", "MATCHES", false)).toEqual({ state: "DERIVED", outcome: "RESOLVED_EXTERNALLY", reason: null })
    expect(pair("CONTRADICTS", "MATCHES", true)).toEqual({ state: "DERIVED", outcome: "OBSERVED_CORRECTED", reason: null })
  })
  it("aggregates multi-sample runs: one reviewed contradiction dominates", () => {
    const before = (decisions: RecordJudgment["decision"][]) =>
      decisions.map((d, i) => ev(check(observation(T1), "SUCCEEDED", [judgment(d)], { sample: i + 1 })))
    const after = (decisions: RecordJudgment["decision"][]) =>
      decisions.map((d, i) => ev(check(observation(T2), "SUCCEEDED", [judgment(d)], { sample: i + 1 })))
    // 4 of 5 contradict before; unanimous matches after: corrected.
    expect(compareSlot(before(["CONTRADICTS", "CONTRADICTS", "CONTRADICTS", "CONTRADICTS", "MATCHES"]),
      after(["MATCHES", "MATCHES", "MATCHES", "MATCHES", "MATCHES"]), true))
      .toEqual({ state: "DERIVED", outcome: "OBSERVED_CORRECTED", reason: null })
    // Contradiction persists in one sample: no observed change.
    expect(compareSlot(before(["CONTRADICTS", "CONTRADICTS", "CONTRADICTS", "CONTRADICTS", "CONTRADICTS"]),
      after(["MATCHES", "MATCHES", "MATCHES", "MATCHES", "CONTRADICTS"]), true))
      .toEqual({ state: "DERIVED", outcome: "NO_OBSERVED_CHANGE", reason: null })
    // One ambiguous follow-up sample keeps the outcome indeterminate — never optimistic.
    expect(compareSlot(before(["CONTRADICTS", "CONTRADICTS"]), after(["MATCHES", "UNKNOWN"]), true))
      .toMatchObject({ outcome: "INDETERMINATE", reason: "AFTER_UNKNOWN" })
    // Ambiguity never becomes certainty in either direction.
    expect(compareSlot(before(["UNKNOWN", "UNKNOWN"]), after(["MATCHES", "MATCHES"]), true))
      .toMatchObject({ outcome: "INDETERMINATE", reason: "BEFORE_UNKNOWN" })
  })
  it("never derives an outcome from unfinished or unreviewed work", () => {
    const reviewed = [ev(check(observation(T1), "SUCCEEDED", [judgment("CONTRADICTS")]))]
    expect(compareSlot(reviewed, [ev(check(null, "RUNNING"))], true)).toEqual({ state: "PENDING_CHECK" })
    expect(compareSlot(reviewed, [ev(check(null, "QUEUED"))], true)).toEqual({ state: "PENDING_CHECK" })
    expect(compareSlot(reviewed, [], true)).toEqual({ state: "PENDING_CHECK" })
    expect(compareSlot(reviewed, [ev(check(observation(T2)))], true)).toEqual({ state: "AWAITING_REVIEW" })
    expect(compareSlot([ev(check(observation(T1)))], [ev(check(observation(T2), "SUCCEEDED", [judgment("MATCHES")]))], true)).toEqual({ state: "AWAITING_REVIEW" })
    expect(compareSlot(reviewed, [{ ...ev(check(observation(T2), "SUCCEEDED", [judgment("MATCHES")])), runComplete: false }], true)).toMatchObject({ outcome: "INDETERMINATE", reason: "PARTIAL_RUN" })
  })
  it("names why a comparison is INDETERMINATE", () => {
    const before = (o = observation(T1), j = [judgment("CONTRADICTS")]) => [ev(check(o, "SUCCEEDED", j))]
    const after = (o = observation(T2), j = [judgment("MATCHES")], it = item()) => [ev(check(o, "SUCCEEDED", j), it)]
    const reason = (b: SlotEvidence[] | null, a: SlotEvidence[]) => { const r = compareSlot(b, a, true); return r.state === "DERIVED" ? r.reason : r.state }
    expect(reason(null, after())).toBe("NO_BASELINE")
    expect(reason([], after())).toBe("NO_BASELINE")
    expect(reason([ev(check(null, "FAILED"))], after())).toBe("BEFORE_CHECK_FAILED")
    expect(reason(before(), [ev(check(null, "FAILED"))])).toBe("AFTER_CHECK_FAILED")
    expect(reason(before(), after(undefined, undefined, item({ fact: { ...item().fact, id: "00000000-0000-4000-8000-0000000000f2" } })))).toBe("FACT_CHANGED")
    expect(reason(before(), [ev(check(observation(T2), "SUCCEEDED", [judgment("MATCHES")], { questionId: "00000000-0000-4000-8000-0000000000q2" }))])).toBe("QUESTION_CHANGED")
    expect(reason(before(observation(T1, { synthetic: true })), after())).toBe("SYNTHETIC_EVIDENCE")
    expect(reason(before(observation(T1, { retrievalMode: "NONE" })), after())).toBe("BEFORE_NO_RETRIEVAL")
    expect(reason(before(), after(observation(T2, { retrievalMode: "NONE" })))).toBe("AFTER_NO_RETRIEVAL")
    expect(reason(before(), after(observation(T2, { retrievalMode: "unknown" })))).toBe("AFTER_NO_RETRIEVAL")
    expect(reason(before(), after(observation(T2, {}, "gemini-2.5-pro")))).toBe("SURFACE_CHANGED")
    expect(reason(before(observation(T1, { measurementContext: null })), after())).toBe("SURFACE_UNKNOWN")
    expect(reason(before(observation(T2)), after(observation(T1)))).toBe("OUT_OF_ORDER")
  })
  it("a forked or empty judgment chain has no current judgment", () => {
    const root = judgment("CONTRADICTS")
    expect(currentJudgment([])).toBeNull()
    expect(currentJudgment([root, judgment("MATCHES", { supersedesId: root.id })])!.decision).toBe("MATCHES")
    expect(currentJudgment([root, judgment("MATCHES", { supersedesId: root.id }), judgment("UNKNOWN", { supersedesId: root.id })])).toBeNull()
  })
  it("run status never turns partial evidence into success", () => {
    const ok = check(observation(T1))
    expect(runStatus([ok, ok])).toBe("SUCCEEDED")
    expect(runStatus([ok, check(null, "FAILED")])).toBe("PARTIALLY_SUCCEEDED")
    expect(runStatus([check(null, "FAILED")])).toBe("FAILED")
    expect(runStatus([ok, check(null, "RUNNING")])).toBe("RUNNING")
    expect(runStatus([check(null, "QUEUED")])).toBe("QUEUED")
    expect(runStatus([])).toBe("FAILED")
  })
})

describe("sample counts and findings", () => {
  it("counts reviewed samples from stored evidence", () => {
    const evidence = [
      ev(check(observation(T1), "SUCCEEDED", [judgment("CONTRADICTS")])),
      ev(check(observation(T1), "SUCCEEDED", [judgment("CONTRADICTS")])),
      ev(check(observation(T1), "SUCCEEDED", [judgment("MATCHES")])),
      ev(check(observation(T1), "SUCCEEDED", [judgment("UNKNOWN")])),
      ev(check(observation(T1))),
      ev(check(null, "FAILED")),
    ]
    expect(countSamples(evidence)).toEqual({ total: 5, reviewed: 4, contradict: 2, matches: 1, unknown: 1 })
    expect(sampleStatement(countSamples(evidence))).toBe(
      "2 of 4 reviewed observations contradicted this fact; 1 matched; 1 could not be determined.")
    expect(sampleStatement({ total: 5, reviewed: 5, contradict: 4, matches: 1, unknown: 0 })).toBe(
      "4 of 5 reviewed observations contradicted this fact; 1 matched.")
    expect(sampleStatement({ total: 0, reviewed: 0, contradict: 0, matches: 0, unknown: 0 })).toBe("No reviewed observations.")
  })
  it("derives the finding state without overstating it", () => {
    const current = [ev(check(observation(T1), "SUCCEEDED", [judgment("CONTRADICTS")]))]
    expect(findingFor({ current, comparison: null, followUpPending: false, actionRecorded: false }))
      .toMatchObject({ kind: "CONTRADICTION", state: "OPEN" })
    expect(findingFor({ current, comparison: null, followUpPending: false, actionRecorded: true }))
      .toMatchObject({ kind: "CONTRADICTION", state: "ACTION_RECORDED" })
    expect(findingFor({ current, comparison: null, followUpPending: true, actionRecorded: true }))
      .toMatchObject({ state: "FOLLOW_UP_PENDING" })
    expect(findingFor({ current: [], comparison: null, followUpPending: false, actionRecorded: false }))
      .toMatchObject({ kind: "UNREVIEWED", state: "NEEDS_REVIEW" })
    const agreed = [ev(check(observation(T1), "SUCCEEDED", [judgment("MATCHES")]))]
    expect(findingFor({ current: agreed, comparison: null, followUpPending: false, actionRecorded: false }))
      .toMatchObject({ kind: "AGREEMENT", state: "AGREEMENT" })
    // Agreement never manufactures an issue: no OPEN, no outcome.
    expect(findingFor({ current: agreed, comparison: null, followUpPending: false, actionRecorded: false }).state).not.toBe("OPEN")
    const derived = findingFor({ current, comparison: { state: "DERIVED", outcome: "OBSERVED_CORRECTED", reason: null }, followUpPending: false, actionRecorded: true })
    expect(derived).toMatchObject({ kind: "CONTRADICTION", state: "OBSERVED_CORRECTED" })
  })
})

describe("public projection allowlist", () => {
  const snapshot = (checks: RecordCheck[]): RecordSnapshot => ({
    profile: { businessId: BIZ, name: "TEST Hotel", websiteUrl: "https://client.test/", engagement: "CLIENT", createdAt: T1 },
    items: [item()], runs: [{ id: "r", kind: "INITIAL", baselineRunId: null, provider: "gemini", requestedModel: "gemini-2.5-flash", retrievalRequired: true, sampleCount: 1, createdAt: T1 }],
    checks, actions: [{ id: "00000000-0000-4000-8000-0000000000c1", slot: null, type: "SOURCE_UPDATED", note: "Updated /rooms", links: ["javascript:alert(1)", "https://client.test/rooms"],
      performedAt: T2, actorId: "00000000-0000-4000-8000-0000000000u1", createdAt: T2 }],
    share: { id: "00000000-0000-4000-8000-0000000000s1", publicId: "x".repeat(43), status: "ACTIVE", createdAt: T1, revokedAt: null },
  })
  it("keeps drafts private and drops unsafe links, ids, notes and provider internals", () => {
    expect(publicRecord(snapshot([check(observation(T1))])).facts[0]!.samples).toEqual([])
    const o = observation(T1, { citations: [{ uri: "javascript:alert(1)", title: "evil" }, { uri: "data:text/html,x", title: null }, { uri: "https://ok.test/", title: "ok" }].map((c, i) => ({ ...c, position: i })) })
    const page = publicRecord(snapshot([check(o, "SUCCEEDED", [judgment("CONTRADICTS")])]))
    const samples = page.facts[0]!.samples
    expect(samples).toHaveLength(1)
    expect(samples[0]!.status === "ANSWERED" && samples[0]!.citations).toEqual([{ url: null, title: "evil" }, { url: "https://ok.test/", title: "ok" }])
    expect(page.facts[0]!.summary).toMatchObject({ total: 1, reviewed: 1, contradict: 1 })
    expect(page.facts[0]!.summary.statement).toContain("1 of 1 reviewed observation contradicted this fact")
    expect(page.facts[0]!.pendingActions).toEqual([{ performedAt: T2, note: "Updated /rooms", links: ["https://client.test/rooms"] }])
    const text = JSON.stringify(page)
    for (const hidden of [BIZ, "TEST internal note", "internal-response-id", "x".repeat(43), o.id, item().id, item().fact.id, "00000000-0000-4000-8000-0000000000u1", "javascript:"]) {
      expect(text).not.toContain(hidden)
    }
  })
  it("does not attach a historical judgment to a newly approved question", () => {
    const earlier = item({ superseded: true })
    const current = item({ id: "new-item", supersedesId: earlier.id, question: { id: "new-question", prompt: "Is breakfast free for every guest?" } })
    const s = snapshot([check(observation(T1), "SUCCEEDED", [judgment("MATCHES")])])
    const page = publicRecord({ ...s, items: [earlier, current] })
    expect(page.facts[0]!.question).toBe(current.question.prompt)
    expect(page.facts[0]!.samples).toEqual([])
    expect(page.facts[0]!.comparison).toBeNull()
  })
  it("keeps the exact historical question and fact with each answer", () => {
    const page = publicRecord(snapshot([check(observation(T1), "SUCCEEDED", [judgment("CONTRADICTS")])]))
    expect(page.facts[0]!.samples[0]).toMatchObject({ question: item().question.prompt, fact: { label: "Breakfast included", value: "Yes" } })
  })
  it("strips credentials from provider citation links", () => {
    const o = observation(T1, { citations: [{ uri: "https://secret:credential@source.test/page", title: "source", position: 1 }] })
    const text = JSON.stringify(publicRecord(snapshot([check(o, "SUCCEEDED", [judgment("MATCHES")])])))
    expect(text).not.toContain("secret")
    expect(text).not.toContain("credential")
  })
  it("keeps the last check date visible when the provider fails", () => {
    const page = publicRecord(snapshot([check(null, "FAILED", [], { completedAt: T2 })]))
    expect(page.lastCheckedAt).toBe(T2)
    expect(page.surface).toBeNull()
    expect(page.facts[0]!.samples).toMatchObject([{ status: "CHECK_FAILED", checkedAt: T2 }])
  })
  it("does not present retired facts as current approved information", () => {
    const s = snapshot([check(observation(T1), "SUCCEEDED", [judgment("MATCHES")])])
    expect(publicRecord({ ...s, items: [item({ fact: { ...item().fact, status: "RETIRED" } })] }).facts).toEqual([])
  })
})
