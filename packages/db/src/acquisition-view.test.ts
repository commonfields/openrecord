// AI Acquisition read model (no database): denominators, failures, synthetic
// exclusion, review attribution, repeatability, configuration changes,
// referral separation and report wording. Every row is a TEST fixture.
import { describe, expect, it } from "vitest"
import type { AcqBatch, AcqCheck, AcqJudgment, AcqQuestionSet, AcqReferralImport, AcqSnapshot } from "./acquisition.js"
import {
  SIGNUPS_NOT_MEASURED, acquisitionReport, acquisitionView, batchMetrics, citationSources, configurationDifferences, currentAcqJudgment, deriveCheck, referralSummary, repeatabilityStatement,
} from "./acquisition-view.js"

const SET: AcqQuestionSet = {
  id: "00000000-0000-4000-8000-000000000001", version: 1, basis: "FIXTURE", category: "TEST support software", specDigest: "a".repeat(64),
  createdAt: "2026-10-01T00:00:00.000Z",
  target: { name: "Supportly", aliases: [], domains: ["supportly.test"], matchCase: false, ambiguity: null },
  competitors: [{ name: "HelpHub", aliases: [], domains: ["helphub.test"], matchCase: false, ambiguity: null }],
  questions: [
    { id: "q1", key: "CD-01", group: "CATEGORY_DISCOVERY", position: 1, buyerQuestionId: "b1", prompt: "What are good TEST support tools?", createdAt: "" },
    { id: "q2", key: "AL-01", group: "ALTERNATIVES", position: 2, buyerQuestionId: "b2", prompt: "What are alternatives to Supportly?", createdAt: "" },
  ],
}
const BATCH: AcqBatch = { id: "batch-1", setId: SET.id, scope: "FULL", questionCount: 2, sampleCount: 3, provider: "gemini", requestedModel: "gemini-3.5-flash-lite",
  retrievalRequested: true, maxProviderCalls: 24, createdAt: "2026-10-02T00:00:00.000Z" }
const REDIRECT = "https://vertexaisearch.cloud.google.com/grounding-api-redirect/x"

let n = 0
const judgment = (over: Partial<AcqJudgment> = {}): AcqJudgment => ({ id: `j${++n}`, mention: "MENTIONED", recommendation: "RECOMMENDED", detectorVersion: "acq-exact-alias-v1",
  candidateCount: 1, note: null, supersedesId: null, reviewedByUserId: "u1", reviewedAt: "2026-10-03T00:00:00.000Z", ...over })
const check = (questionId: string, sample: number, over: Partial<AcqCheck> & { answer?: string; synthetic?: boolean; owned?: boolean; grounded?: boolean } = {}): AcqCheck => {
  const { answer = "Supportly and HelpHub both work.", synthetic = false, owned = false, grounded = true, ...rest } = over
  return {
    id: `c-${questionId}-${sample}`, batchId: BATCH.id, questionId, sample, status: "SUCCEEDED", failureClass: null, failureDetailSafe: null, attempts: 1,
    queuedAt: "2026-10-02T00:00:00.000Z", completedAt: "2026-10-02T00:01:00.000Z", judgments: [],
    observation: {
      id: `o-${questionId}-${sample}`, provider: "gemini", requestedModel: "gemini-3.5-flash-lite", observedModel: "gemini-3.5-flash-lite",
      collectedAt: `2026-10-02T00:0${sample}:00.000Z`, answerText: answer, retrievalMode: grounded ? "PROVIDER_GROUNDING" : "NONE", retrievalTool: "google_search",
      requestParameters: { tools: ["google_search"] }, rawDigest: "d".repeat(64), synthetic, providerMetadata: { webSearchQueries: ["TEST query"] },
      citations: owned ? [{ uri: REDIRECT, title: "supportly.test", position: 1, attributed: true }] : [{ uri: REDIRECT, title: "reviews.test", position: 1, attributed: false }],
    },
    ...rest,
  }
}
const failed = (questionId: string, sample: number): AcqCheck => ({ ...check(questionId, sample), status: "FAILED", failureClass: "PROVIDER_UNAVAILABLE",
  failureDetailSafe: "provider unavailable", attempts: 4, observation: null })

describe("batch metrics", () => {
  const checks: AcqCheck[] = [
    { ...check("q1", 1, { owned: true }), judgments: [judgment()] },
    { ...check("q1", 2), judgments: [judgment({ recommendation: "MENTIONED_NOT_RECOMMENDED" })] },
    check("q1", 3), // eligible, unreviewed
    { ...check("q2", 1, { answer: "Use HelpHub." }), judgments: [judgment({ mention: "NOT_MENTIONED", recommendation: null, candidateCount: 0 })] },
    { ...check("q2", 2, { synthetic: true }), judgments: [] },
    failed("q2", 3),
  ]
  const derived = checks.map(c => deriveCheck(c, SET))
  const m = batchMetrics(BATCH, SET, derived)

  it("keeps failures in the attempt counts and synthetic answers out of eligible samples", () => {
    expect(m).toMatchObject({ planned: 6, succeeded: 5, failed: 1, pending: 0, eligible: 4, syntheticExcluded: 1, providerAttempts: 9 })
    expect(m.failures).toEqual([{ failureClass: "PROVIDER_UNAVAILABLE", count: 1 }])
  })
  it("derives every rate from its own numerator and denominator", () => {
    expect(m.reviewed).toEqual({ n: 3, d: 4 })
    expect(m.candidateSamples).toEqual({ n: 3, d: 4 })
    expect(m.mentionRate).toEqual({ n: 2, d: 3 })
    expect(m.recommendationRate).toEqual({ n: 1, d: 3 })
    expect(m.ownedCitationRate).toEqual({ n: 1, d: 4 })
    expect(m.groundingObserved).toEqual({ n: 4, d: 4 })
    expect(m.competitors).toEqual([{ name: "HelpHub", samples: { n: 4, d: 4 } }])
    expect(m.breakdown).toEqual({ recommended: 1, mentionedNotRecommended: 1, advisedAgainst: 0, recommendationUnclear: 0, notMentioned: 1, mentionUnclear: 0 })
  })
  it("never counts an unreviewed candidate as confirmed", () => {
    const none = batchMetrics(BATCH, SET, [check("q1", 1), check("q1", 2)].map(c => deriveCheck(c, SET)))
    expect(none.candidateSamples).toEqual({ n: 2, d: 2 })
    expect(none.mentionRate).toEqual({ n: 0, d: 0 })
    expect(none.recommendationRate).toEqual({ n: 0, d: 0 })
  })
  it("excludes unclear mention judgments from the confirmed mention denominator", () => {
    const unclear = { ...check("q1", 1), judgments: [judgment({ mention: "UNCLEAR", recommendation: "UNCLEAR" })] }
    expect(batchMetrics(BATCH, SET, [deriveCheck(unclear, SET)]).mentionRate).toEqual({ n: 0, d: 0 })
  })
  it("reports repeatability per question as counts, with unreviewed and failed samples named", () => {
    expect(m.questions.map(q => [q.key, q.statement])).toEqual([
      ["CD-01", "Recommended in 1 of 2 reviewed samples (1 unreviewed)"],
      ["AL-01", "Recommended in 0 of 1 reviewed sample (1 failed)"],
    ])
    expect(m.questionsRecommended).toEqual({ n: 1, d: 2 })
    expect(repeatabilityStatement({ planned: 5, failed: 5, eligible: 0, reviewed: 0, recommended: 0 })).toBe("No answer collected (5 of 5 failed)")
  })
})

describe("review attribution", () => {
  it("uses the head of the append-only correction chain", () => {
    const first = judgment({ recommendation: "UNCLEAR" })
    const correction = judgment({ recommendation: "RECOMMENDED", supersedesId: first.id })
    expect(currentAcqJudgment([first, correction])).toBe(correction)
    expect(currentAcqJudgment([])).toBeNull()
  })
})

describe("citation sources", () => {
  it("counts each source once per real answer and does not treat redirects as page URLs", () => {
    const first = check("q1", 1)
    const source = { uri: "https://supportly.test/guide", title: "Guide", position: 1, attributed: true }
    const withSources: AcqCheck = { ...first, observation: { ...first.observation!, citations: [source, source,
      { uri: REDIRECT, title: "helphub.test", position: 2, attributed: false },
      { uri: REDIRECT, title: "Unknown source", position: 3, attributed: false }] } }
    const synthetic = check("q1", 2, { synthetic: true, owned: true })
    const summary = citationSources([withSources, synthetic, failed("q2", 1)].map(c => deriveCheck(c, SET)))
    expect(summary).toMatchObject({ eligibleAnswers: 1, answersWithSources: 1, unresolvedAnswers: 1, groundingObserved: 1 })
    expect(summary.domains).toEqual([
      { domain: "helphub.test", owner: "COMPETITOR", competitor: "HelpHub", basis: "PROVIDER_TITLE", answers: 1 },
      { domain: "supportly.test", owner: "OWNED", competitor: null, basis: "URI_HOST", answers: 1 },
    ])
    expect(summary.pages).toEqual([{ url: "https://supportly.test/guide", domain: "supportly.test", owner: "OWNED", competitor: null, answers: 1 }])
  })
  it("reports no observed sources separately from answers that were not grounded", () => {
    const c = check("q1", 1, { grounded: false })
    const empty: AcqCheck = { ...c, observation: { ...c.observation!, citations: [] } }
    expect(citationSources([deriveCheck(empty, SET)])).toMatchObject({ eligibleAnswers: 1, answersWithSources: 0, groundingObserved: 0, domains: [], pages: [] })
  })
})

describe("periods", () => {
  it("lists every configuration change between batches", () => {
    const derived = [check("q1", 1), { ...check("q1", 1), id: "c2", batchId: "batch-2" }].map(c => deriveCheck(c, SET))
    const other: AcqBatch = { ...BATCH, id: "batch-2", requestedModel: "gemini-other", sampleCount: 5 }
    expect(configurationDifferences(BATCH, other, derived)).toEqual(["provider or model", "samples per question"])
    expect(configurationDifferences(BATCH, { ...BATCH, id: "batch-2" }, derived)).toEqual([])
  })
})

describe("referral evidence", () => {
  const imp = (over: Partial<AcqReferralImport> = {}): AcqReferralImport => ({ id: "i1", dataOrigin: "GA4_EXPORT", propertyRef: "TEST-property", dateStart: "2026-09-01",
    dateEnd: "2026-09-30", timeZone: "UTC", attributionBasis: "SESSION_SOURCE_MEDIUM", conversionEvent: null, rawDigest: "e".repeat(64), rowCount: 3,
    importedAt: "2026-10-01T00:00:00.000Z",
    rows: [
      { day: "2026-09-01", sessionSource: "chatgpt.com", sessionMedium: "referral", sessions: 5, conversions: null },
      { day: "2026-09-02", sessionSource: "chat.openai.com", sessionMedium: "referral", sessions: 1, conversions: null },
      { day: "2026-09-02", sessionSource: "google", sessionMedium: "organic", sessions: 40, conversions: null },
    ], ...over })
  it("never infers signups from sessions", () => {
    const s = referralSummary(imp())
    expect(s).toMatchObject({ totalSessions: 46, aiSessions: 6, signups: SIGNUPS_NOT_MEASURED, synthetic: false })
    expect(s.bySource).toEqual([{ assistant: "ChatGPT", sources: ["chat.openai.com / referral", "chatgpt.com / referral"], sessions: 6, conversions: null }])
  })
  it("counts conversions only for a stated conversion event", () => {
    const s = referralSummary(imp({ conversionEvent: "sign_up", rows: [{ day: "2026-09-01", sessionSource: "perplexity.ai", sessionMedium: "referral", sessions: 3, conversions: 1 }] }))
    expect(s.signups).toBe(1)
  })
})

describe("agency report", () => {
  const snapshot = (over: Partial<AcqSnapshot> = {}): AcqSnapshot => ({
    profile: { businessId: "b", name: "TEST Supportly", websiteUrl: "https://supportly.test/", engagement: "FIXTURE" },
    sets: [{ ...SET, basis: "PUBLIC_RESEARCH" }], batches: [BATCH],
    checks: [{ ...check("q1", 1), judgments: [judgment()] }, check("q1", 2), failed("q2", 1)],
    imports: [{ id: "i1", dataOrigin: "SYNTHETIC_FIXTURE", propertyRef: "TEST", dateStart: "2026-09-01", dateEnd: "2026-09-30", timeZone: "UTC",
      attributionBasis: "SESSION_SOURCE_MEDIUM", conversionEvent: null, rawDigest: "f".repeat(64), rowCount: 1, importedAt: "2026-10-01T00:00:00.000Z",
      rows: [{ day: "2026-09-01", sessionSource: "chatgpt.com", sessionMedium: "referral", sessions: 999, conversions: null }] }],
    ...over,
  })
  it("names the measured surface, excludes synthetic referrals and discloses review coverage", () => {
    const r = acquisitionReport(snapshot())
    expect(r.question).toBe("How often did the measured AI surface mention or recommend this business?")
    expect(r.periods[0]!.surface).toBe("Gemini API with Google Search grounding (gemini-3.5-flash-lite)")
    expect(r.referrals).toEqual({ provided: false, imports: [], syntheticExcluded: 1 })
    expect(JSON.stringify(r)).not.toContain("999")
    const text = r.limitations.join("\n")
    expect(text).toMatch(/do not measure ChatGPT, Claude, Perplexity/)
    expect(text).toMatch(/1 successful sample is not reviewed and not counted/)
    expect(text).toMatch(/1 of 3 planned samples failed/)
    expect(text).toMatch(/Public research pilot: TEST Supportly is not an OpenRecord customer/)
    expect(text).toMatch(/No GA4 export was provided/)
    expect(r.periods[0]!.representative.map(x => x.recommendation)).toEqual(["RECOMMENDED"])
  })
  it("never claims improvement, causality or ROI", () => {
    const r = acquisitionReport(snapshot())
    const banned = /caused|because of|thanks to|led to|resulted in|improv(ed|ement)|uplift|increase in|ROI\b|market share is|probability that/i
    const copy = [...r.limitations].filter(l => !/not compared|not market share|not the probability|does not claim/.test(l))
    for (const line of copy) expect(line).not.toMatch(banned)
  })
  it("shows changed configurations separately without comparing them", () => {
    const b2: AcqBatch = { ...BATCH, id: "batch-2", requestedModel: "gemini-other" }
    const r = acquisitionReport(snapshot({ batches: [BATCH, b2], checks: [check("q1", 1), { ...check("q1", 1), id: "x", batchId: "batch-2" }] }))
    expect(r.periods).toHaveLength(2)
    expect(r.configurationChanged).toEqual(["provider or model"])
    expect(r.limitations.join(" ")).toMatch(/configuration changed between periods \(provider or model\)/)
    expect(r).not.toHaveProperty("change")
  })
  it("flags questions that name the target brand", () => {
    expect(acquisitionView(snapshot()).sets[0]!.questionsNamingTarget).toEqual(["AL-01"])
  })
})
