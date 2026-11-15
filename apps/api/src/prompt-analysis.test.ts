import { describe, expect, it } from "vitest"
import type { AcquisitionView } from "@openrecord/db"
import { analysePrompts, stageOf, wantOf } from "./prompt-analysis.js"

const brand = (name: string) => ({ name, aliases: [], domains: [], matchCase: false, ambiguity: null })
const q = (key: string, prompt: string, group: string) => ({ id: `q-${key}`, key, group, position: 0, buyerQuestionId: `b-${key}`, prompt, createdAt: "2026-11-01T00:00:00Z" })
const check = (questionId: string, brands: string[], mention?: "MENTIONED" | "NOT_MENTIONED") => ({ batchId: "batch-1", questionId, eligible: true,
  candidates: brands.map(b => ({ role: b === "Northstar" ? "TARGET" : "COMPETITOR", brand: b, alias: b, start: 0, end: 0 })),
  judgment: mention ? { mention, recommendation: null } : null })
const view = (questions: ReturnType<typeof q>[], checks: ReturnType<typeof check>[], batch = true) => ({
  sets: [{ id: "set-1", version: 3, target: brand("Northstar"), competitors: [brand("Acme"), brand("Zenith")], questions }],
  batches: batch ? [{ id: "batch-1", setId: "set-1", status: "COMPLETE", surface: "Gemini with search", collectedFrom: "2026-11-10", collectedTo: "2026-11-10" }] : [],
  checks,
}) as unknown as AcquisitionView

describe("what a tracked question asks for (rules, no model)", () => {
  it("names what the asker wants", () => {
    expect(wantOf("What are the best analytics tools for agencies?")).toBe("RECOMMENDATION")
    expect(wantOf("Which platforms provide automated moderation APIs?")).toBe("RECOMMENDATION")
    expect(wantOf("Where can I find and book a DJ for a wedding?")).toBe("RECOMMENDATION")
    expect(wantOf("Acme vs Zenith for small teams")).toBe("COMPARISON")
    expect(wantOf("What are the top alternatives to Acme?")).toBe("COMPARISON")
    expect(wantOf("How much does it cost to hire a DJ for four hours?")).toBe("PRICE_CHECK")
    expect(wantOf("Which software offers a free tier?")).toBe("PRICE_CHECK")
    expect(wantOf("How do I filter hate speech from my app?")).toBe("HOW_TO")
    expect(wantOf("Does Northstar integrate with Google Analytics?")).toBe("FEATURE_CHECK")
    expect(wantOf("Which booking platform offers cancellation protection?")).toBe("FEATURE_CHECK")
    expect(wantOf("What happens if a DJ cancels at the last minute?")).toBe("INFORMATION")
    // "or" in a question is not a comparison by itself.
    expect(wantOf("How do I book a club or wedding DJ online?")).toBe("HOW_TO")
  })

  it("places the asker in a buying stage, words first, then the question's intent group", () => {
    expect(stageOf("How much does Northstar cost?", "BRANDED", "PURCHASE_EVALUATION")).toBe("PURCHASE")
    expect(stageOf("How do I cancel my Northstar subscription?", "BRANDED", null)).toBe("SUPPORT")
    expect(stageOf("What are the top alternatives to Acme?", "COMPETITOR_BRANDED", "ALTERNATIVES")).toBe("CONSIDERATION")
    expect(stageOf("What are the best tools to track AI answers?", "UNBRANDED", "CATEGORY_DISCOVERY")).toBe("DISCOVERY")
    expect(stageOf("What should a small team look at first?", "UNBRANDED", "PURCHASE_EVALUATION")).toBe("PURCHASE")
  })
})

describe("Prompt Analysis of a question set", () => {
  const questions = [
    q("CD-01", "What are the best tools to track how AI describes a company?", "CATEGORY_DISCOVERY"),
    q("AL-01", "What are the top alternatives to Acme?", "ALTERNATIVES"),
    q("PE-01", "How much does Northstar cost?", "PURCHASE_EVALUATION"),
    q("CD-02", "Which platforms monitor brand mentions in AI search?", "CATEGORY_DISCOVERY"),
  ]

  it("counts stage, want and branding, and finds the unbranded questions whose answers never name the business", () => {
    const a = analysePrompts(view(questions, [
      check("q-CD-01", ["Acme", "Zenith"], "NOT_MENTIONED"), check("q-CD-01", ["Acme"]),
      check("q-CD-02", ["Northstar", "Acme"], "MENTIONED"),
      check("q-AL-01", ["Zenith"]),
    ]))!
    expect(a.questions).toBe(4)
    expect(a.byBranding).toEqual({ BRANDED: 1, COMPETITOR_BRANDED: 1, UNBRANDED: 2 })
    expect(a.byStage).toMatchObject({ DISCOVERY: 2, CONSIDERATION: 1, PURCHASE: 1, SUPPORT: 0 })
    expect(a.rows.find(r => r.key === "CD-01")).toMatchObject({ answers: 2, namedInAnswers: { Acme: 2, Zenith: 1 }, reviewed: { n: 1, mentioned: 0 } })
    expect(a.rows.find(r => r.key === "AL-01")!.namedInPrompt).toEqual(["Acme"])
    expect(a.open.questions.map(o => o.key)).toEqual(["CD-01"])
    expect(a.open.othersNamed).toEqual({ Acme: 2, Zenith: 1 })
    expect(a.thinStages).toEqual(["CONSIDERATION", "PURCHASE", "SUPPORT"])
    expect(a.patterns.find(p => p.stage === "DISCOVERY" && p.want === "RECOMMENDATION")).toMatchObject({ questions: 2, unbranded: 2 })
  })

  it("never presents counts as demand, and says when no answers have been read", () => {
    const a = analysePrompts(view(questions, [], false))!
    expect(a.batch).toBeNull()
    expect(a.open.questions).toEqual([])
    expect(a.limitations.join(" ")).toContain("not how often people ask them")
    expect(a.limitations.join(" ")).toContain("No finished batch yet")
  })

  it("is null before a business has a question set", () => {
    expect(analysePrompts({ sets: [], batches: [], checks: [] } as unknown as AcquisitionView)).toBeNull()
  })
})
