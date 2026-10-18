// Agency Operator referral interpretation (no database). Every row is a TEST
// fixture. Asserts: synthetic exclusion, unknown signups never become zero,
// totals equal the acquisition read model, surfaces stay separate, period
// comparisons refuse mismatches, and report sections are distinct.
import { describe, expect, it } from "vitest"
import type { AcqBatch, AcqCheck, AcqQuestionSet, AcqReferralImport, AcqSnapshot } from "./acquisition.js"
import { SIGNUPS_NOT_MEASURED, acquisitionReport, acquisitionView, referralSummary } from "./acquisition-view.js"
import {
  REFERRAL_DATA_UNAVAILABLE, REFERRAL_REPORT_SECTIONS, agentReferralEvidence, agentReferralRead, buildAgentReportSupplement, compareReferralEvidence, isSignupEvent,
} from "./agent-referrals.js"

const SET: AcqQuestionSet = {
  id: "00000000-0000-4000-8000-000000000001", version: 1, basis: "FIXTURE", category: "TEST support software", specDigest: "a".repeat(64), createdAt: "2026-10-01T00:00:00.000Z",
  target: { name: "Supportly", aliases: [], domains: ["supportly.test"], matchCase: false, ambiguity: null },
  competitors: [],
  questions: [{ id: "q1", key: "CD-01", group: "CATEGORY_DISCOVERY", position: 1, buyerQuestionId: "b1", prompt: "What are good TEST support tools?", createdAt: "" }],
}
const BATCH: AcqBatch = { id: "00000000-0000-4000-8000-0000000000b1", setId: SET.id, scope: "FULL", questionCount: 1, sampleCount: 2, provider: "gemini", requestedModel: "gemini-fixture",
  retrievalRequested: true, maxProviderCalls: 8, createdAt: "2026-10-05T00:00:00.000Z" }
const check = (sample: number, recommendation: "RECOMMENDED" | "MENTIONED_NOT_RECOMMENDED"): AcqCheck => ({
  id: `00000000-0000-4000-8000-0000000000c${sample}`, batchId: BATCH.id, questionId: "q1", sample, status: "SUCCEEDED", failureClass: null, failureDetailSafe: null, attempts: 1,
  queuedAt: BATCH.createdAt, completedAt: BATCH.createdAt,
  observation: { id: `00000000-0000-4000-8000-0000000000d${sample}`, provider: "gemini", requestedModel: "gemini-fixture", observedModel: "gemini-fixture", collectedAt: BATCH.createdAt,
    answerText: "TEST Supportly is a good choice.", retrievalMode: "PROVIDER_GROUNDING", retrievalTool: "google_search", requestParameters: { tools: ["google_search"] },
    rawDigest: "d".repeat(64), synthetic: false, providerMetadata: null, citations: [{ uri: "https://supportly.test/docs", title: "TEST citation", position: 1, attributed: true }] },
  judgments: [{ id: `00000000-0000-4000-8000-0000000000e${sample}`, mention: "MENTIONED", recommendation, detectorVersion: "acq-exact-alias-v1", candidateCount: 1, note: "PRIVATE_NOTE",
    supersedesId: null, reviewedByUserId: "u1", reviewedAt: BATCH.createdAt }],
})
const imp = (id: string, over: Partial<AcqReferralImport> = {}): AcqReferralImport => ({
  id, dataOrigin: "GA4_EXPORT", propertyRef: "TEST property", dateStart: "2026-10-01", dateEnd: "2026-10-07", timeZone: "UTC", attributionBasis: "SESSION_SOURCE_MEDIUM",
  conversionEvent: null, rawDigest: "e".repeat(64), rowCount: 4, importedAt: "2026-10-08T00:00:00.000Z",
  rows: [
    { day: "2026-10-01", sessionSource: "chatgpt.com", sessionMedium: "referral", sessions: 12, conversions: null },
    { day: "2026-10-02", sessionSource: "claude.ai", sessionMedium: "referral", sessions: 4, conversions: null },
    { day: "2026-10-03", sessionSource: "gemini.google.com", sessionMedium: "referral", sessions: 3, conversions: null },
    { day: "2026-10-03", sessionSource: "google", sessionMedium: "organic", sessions: 200, conversions: null },
  ], ...over })
const withEvent = (rows: AcqReferralImport["rows"], event: string) => ({ conversionEvent: event, rows: rows.map((r, i) => ({ ...r, conversions: [2, 1, 0, 9][i] ?? 0 })) })
const ID = (n: number) => `00000000-0000-4000-8000-00000000000${n}`
const snapshot = (imports: AcqReferralImport[], over: Partial<AcqSnapshot> = {}): AcqSnapshot => ({
  profile: { businessId: "b", name: "TEST Supportly", websiteUrl: "https://supportly.test/", engagement: "FIXTURE" },
  sets: [SET], batches: [BATCH], checks: [check(1, "RECOMMENDED"), check(2, "MENTIONED_NOT_RECOMMENDED")], imports, ...over,
})
const synthetic = imp(ID(9), { dataOrigin: "SYNTHETIC_FIXTURE", rows: [{ day: "2026-10-01", sessionSource: "chatgpt.com", sessionMedium: "referral", sessions: 777, conversions: null }] })

describe("read_ai_referral_evidence contract", () => {
  it("returns REFERRAL_DATA_UNAVAILABLE with unknown signups when only synthetic or no imports exist", () => {
    for (const s of [null, snapshot([]), snapshot([synthetic])]) {
      const out = agentReferralRead(s, {})
      expect(out).toMatchObject({ state: REFERRAL_DATA_UNAVAILABLE, signups: SIGNUPS_NOT_MEASURED, configuredConversions: { availability: "UNKNOWN", total: null }, imports: [] })
      expect(JSON.stringify(out)).not.toContain("777")
    }
    expect(agentReferralRead(snapshot([synthetic]), {})).toMatchObject({ syntheticImportsExcluded: 1, realImports: 0 })
  })
  it("refuses synthetic, foreign or unknown import ids", () => {
    const s = snapshot([imp(ID(1)), synthetic])
    expect(agentReferralRead(s, { importId: ID(9) })).toBe("NOT_FOUND")
    expect(agentReferralRead(s, { importId: ID(7) })).toBe("NOT_FOUND")
    expect(agentReferralRead(s, { importId: ID(1), beforeImportId: ID(9) })).toBe("NOT_FOUND")
  })
  it("matches the acquisition read model totals exactly and excludes synthetic imports", () => {
    const real = imp(ID(1), withEvent(imp(ID(1)).rows, "sign_up"))
    const s = snapshot([synthetic, real])
    const out = agentReferralRead(s, {})
    if (out === "NOT_FOUND" || out.state !== "AVAILABLE") throw new Error("expected evidence")
    const model = acquisitionView(s).referrals.find(r => r.id === ID(1))!
    const report = acquisitionReport(s).referrals
    expect(report.imports.map(r => r.id)).toEqual([ID(1)])
    expect(out.evidence.sessions).toEqual({ aiAttributed: model.aiSessions, totalReported: model.totalSessions })
    expect(out.evidence.configuredConversions.total).toBe(model.signups)
    expect(out.evidence.signups).toBe(model.signups)
    expect(out.evidence.aiReferralSources.map(x => [x.assistant, x.sessions, x.configuredConversions])).toEqual(model.bySource.map(x => [x.assistant, x.sessions, x.conversions]))
    expect(out.evidence).toMatchObject({ importId: ID(1), dataOrigin: "GA4_EXPORT", propertyRef: "TEST property", attributionBasis: "SESSION_SOURCE_MEDIUM", importDigest: "e".repeat(64),
      period: { start: "2026-10-01", end: "2026-10-07", timeZone: "UTC", days: 7 }, sessions: { aiAttributed: 19, totalReported: 219 }, signups: 3 })
    expect(out).toMatchObject({ realImports: 1, syntheticImportsExcluded: 1 })
    expect(JSON.stringify(out)).not.toContain("777")
    // No row-level data or raw export reaches the model.
    expect(JSON.stringify(out)).not.toMatch(/"rows"|"day"|2026-10-02"|rawText/)
  })
  it("never converts an unconfigured signup event into zero, and keeps non-signup events distinct", () => {
    const none = agentReferralEvidence(referralSummary(imp(ID(1))))
    expect(none).toMatchObject({ signups: SIGNUPS_NOT_MEASURED, configuredConversions: { availability: "NOT_CONFIGURED", event: null, total: null } })
    expect(none.aiReferralSources.every(s => s.signups === SIGNUPS_NOT_MEASURED && s.configuredConversions === null)).toBe(true)
    expect(none.signupsBasis).toMatch(/unknown, not zero/)
    const purchase = agentReferralEvidence(referralSummary(imp(ID(2), withEvent(imp(ID(2)).rows, "purchase"))))
    expect(purchase).toMatchObject({ signups: SIGNUPS_NOT_MEASURED, configuredConversions: { availability: "CONFIGURED_EVENT", event: "purchase", total: 3 } })
    expect(purchase.signupsBasis).toMatch(/not a signup event/)
    const zero = agentReferralEvidence(referralSummary(imp(ID(3), { conversionEvent: "sign_up", rows: imp(ID(3)).rows.map(r => ({ ...r, conversions: 0 })) })))
    expect(zero).toMatchObject({ signups: 0, configuredConversions: { total: 0, leaders: [] } })
    expect(["sign_up", "signup", "Sign Up", "sign-up"].every(isSignupEvent)).toBe(true)
    expect(["purchase", "generate_lead", null].some(e => isSignupEvent(e))).toBe(false)
  })
  it("keeps measured Gemini recommendations, GA4 ChatGPT and Claude sessions and GA4 Gemini sessions separate", () => {
    const out = agentReferralRead(snapshot([imp(ID(1))]), {})
    if (out === "NOT_FOUND" || out.state !== "AVAILABLE") throw new Error("expected evidence")
    expect(out.surfaces.measuredRecommendationSurfaces).toEqual(["Gemini API with Google Search grounding (gemini-fixture)"])
    expect(out.surfaces.note).toMatch(/not measured recommendations/)
    expect(out.evidence.aiReferralSources.map(s => [s.assistant, s.sessions])).toEqual([["ChatGPT", 12], ["Claude", 4], ["Gemini", 3]])
    expect(out.evidence.sessionLeaders).toEqual([{ assistant: "ChatGPT", count: 12 }])
    expect(out.evidence.assistantsWithoutAttributedRows).toContain("Perplexity")
    expect(out.evidence.assistantsWithoutAttributedRows).not.toContain("Claude")
    // Recommendation counts never appear in referral evidence.
    expect(JSON.stringify(out)).not.toMatch(/recommendationRate|RECOMMENDED/)
  })
  it("compares only matching, ordered, non-overlapping full periods and never claims causality", () => {
    const a = agentReferralEvidence(referralSummary(imp(ID(1))))
    const b = agentReferralEvidence(referralSummary(imp(ID(2), { dateStart: "2026-10-08", dateEnd: "2026-10-21", rows: [{ day: "2026-10-09", sessionSource: "chatgpt.com", sessionMedium: "referral", sessions: 20, conversions: null }] })))
    const c = compareReferralEvidence(a, b)
    expect(c).toMatchObject({ state: "DESCRIPTIVE_PERIODS", reasons: [], aiAttributedSessionDelta: 1, configuredConversionDelta: null })
    expect(c.sessionDeltaByAssistant).toEqual([{ assistant: "ChatGPT", before: 12, after: 20, delta: 8 }, { assistant: "Claude", before: 4, after: 0, delta: -4 }, { assistant: "Gemini", before: 3, after: 0, delta: -3 }])
    expect(c.limitation).toMatch(/does not establish/)
    expect(compareReferralEvidence(b, a)).toMatchObject({ state: "NOT_COMPARABLE", reasons: ["periods overlap or are out of order"], aiAttributedSessionDelta: null, sessionDeltaByAssistant: [] })
    const other = agentReferralEvidence(referralSummary(imp(ID(3), { propertyRef: "TEST other", dateStart: "2026-10-08", dateEnd: "2026-10-09", ...withEvent([], "sign_up") })))
    expect(compareReferralEvidence(a, other).reasons).toEqual(["analytics property changed", "conversion event changed"])
  })
  it("bounds measured surfaces and the import index", () => {
    const many = Array.from({ length: 30 }, (_, i) => imp(`00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, { rawDigest: String(i).padStart(64, "0") }))
    const out = agentReferralRead(snapshot(many, { batches: Array.from({ length: 30 }, (_, i) => ({ ...BATCH, requestedModel: `model-${i}` })) }), {})
    if (out === "NOT_FOUND" || out.state !== "AVAILABLE") throw new Error("expected evidence")
    expect(out.imports).toHaveLength(20)
    expect(out.imports[0]!.importId).toBe(many.at(-1)!.id)
    expect(out.realImports).toBe(30)
    expect(out.surfaces.measuredRecommendationSurfaces).toHaveLength(20)
    expect(out.surfaces.measuredRecommendationSurfacesTotal).toBe(30)
  })
})

describe("private report sections", () => {
  const sectionBodies = (text: string) => {
    const parts = text.split("\n\n")
    const at = REFERRAL_REPORT_SECTIONS.map(h => parts.indexOf(h))
    return at.map((i, k) => parts.slice(i + 1, k + 1 < at.length ? at[k + 1] : undefined).join("\n"))
  }
  it("keeps recommendation, referral, conversion and limitation evidence in four distinct ordered sections", () => {
    const s = snapshot([synthetic, imp(ID(1), withEvent(imp(ID(1)).rows, "sign_up"))])
    const out = buildAgentReportSupplement(s, "2026-10-01T00:00:00.000Z", "2026-10-10T00:00:00.000Z")!
    const parts = out.text.split("\n\n")
    const at = REFERRAL_REPORT_SECTIONS.map(h => parts.indexOf(h))
    expect(at.every(i => i >= 0)).toBe(true)
    expect([...at].sort((x, y) => x - y)).toEqual(at)
    const [recommendation, website, conversion, limitations] = sectionBodies(out.text)
    expect(recommendation).toMatch(/Gemini API with Google Search grounding \(gemini-fixture\)/)
    expect(recommendation).toMatch(/Recommended in 1 of 2 reviewed answers/)
    expect(recommendation).toContain("2 planned samples, 0 pending, 2 provider attempts")
    expect(recommendation).toContain("https://supportly.test/docs (owned, support not_verified)")
    expect(out.evidence.batches[0]!.observations[0]!.citations[0]).toMatchObject({ owner: "OWNED", support: "NOT_VERIFIED" })
    expect(recommendation).not.toMatch(/sessions/)
    expect(website).toMatch(/19 AI-attributed sessions out of 219 reported sessions/)
    expect(website).toMatch(/ChatGPT: 12 sessions; Claude: 4 sessions; Gemini: 3 sessions/)
    expect(website).toMatch(/1 synthetic referral import is excluded/)
    expect(website).not.toMatch(/Recommended in|signup/i)
    expect(conversion).toMatch(/configured event "sign_up", 3 events/)
    expect(conversion).toMatch(/Signups: 3/)
    expect(conversion).not.toMatch(/AI-attributed sessions out of/)
    expect(limitations).toMatch(/does not claim that any answer produced a visit/)
    expect(out.text).not.toContain("777")
    expect(out.text).not.toContain("PRIVATE_NOTE")
    expect(out.text).not.toMatch(/score|caused|led to|resulted in|thanks to|uplift|ROI\b/i)
    expect(out.references.filter(r => r.kind === "referral_import").map(r => r.id)).toEqual([ID(1)])
    expect(out.references.filter(r => r.kind === "acquisition_batch")).toHaveLength(1)
  })
  it("states missing referral and conversion evidence instead of zero", () => {
    const out = buildAgentReportSupplement(snapshot([synthetic], { batches: [], checks: [] }), "2026-10-01T00:00:00.000Z", "2026-10-10T00:00:00.000Z")!
    const [recommendation, website, conversion] = sectionBodies(out.text)
    expect(recommendation).toMatch(/not measured for this period/)
    expect(website).toMatch(/Referral data unavailable/)
    expect(conversion).toMatch(/Conversions and signups are not measured/)
    expect(out.text).not.toMatch(/\b0 AI-attributed|Signups: 0/)
    expect(buildAgentReportSupplement(null, "2026-10-01T00:00:00.000Z", "2026-10-10T00:00:00.000Z")!.text).toMatch(/Referral data unavailable/)
  })
  it("includes only full exports overlapping the end-exclusive report window, never clipped", () => {
    const later = imp(ID(2), { dateStart: "2026-10-10", dateEnd: "2026-10-12", rows: [{ day: "2026-10-10", sessionSource: "claude.ai", sessionMedium: "referral", sessions: 5, conversions: null }] })
    const out = buildAgentReportSupplement(snapshot([imp(ID(1)), later]), "2026-10-05T00:00:00.000Z", "2026-10-10T00:00:00.000Z")!
    expect(out.references.filter(r => r.kind === "referral_import").map(r => r.id)).toEqual([ID(1)])
    expect(out.text).toMatch(/2026-10-01 to 2026-10-07 \(7 days, UTC\)/)
    expect(out.text).toMatch(/not clipped to this report window/)
  })
  it("refuses oversized selections rather than dropping evidence", () => {
    const many = Array.from({ length: 11 }, (_, i) => imp(`00000000-0000-4000-8000-${String(i).padStart(12, "0")}`))
    expect(buildAgentReportSupplement(snapshot(many), "2026-10-01T00:00:00.000Z", "2026-10-10T00:00:00.000Z")).toBeNull()
  })
})
