// AI Acquisition detection (no database). Every brand here is a fictional
// TEST fixture. Detection proposes candidates and hints; it never decides.
import { describe, expect, it } from "vitest"
import { DETECTOR_VERSION, classifyCitation, citationDomain, detectMentions, domainMatches, normalizeDomain, type BrandSpec } from "./acquisition-detect.js"

const brand = (name: string, extra: Partial<BrandSpec> = {}): BrandSpec => ({ name, aliases: [], domains: [], matchCase: false, ambiguity: null, ...extra })
const TARGET = brand("Supportly", { aliases: ["Supportly AI", "supportly.test"], domains: ["supportly.test"] })
const COMPETITORS = [
  brand("HelpHub", { aliases: ["HelpHub Agent"], domains: ["helphub.test"] }),
  brand("Desko", { domains: ["desko.test"] }),
  brand("Ada", { matchCase: true, ambiguity: "Also the name of a programming language and the Americans with Disabilities Act." }),
]
const detect = (text: string) => detectMentions(text, TARGET, COMPETITORS)

describe("candidate brand mentions", () => {
  it("finds exact names and approved aliases between word boundaries", () => {
    const found = detect("Try Supportly AI or supportly for small teams.")
    expect(found.map(m => [m.role, m.brand, m.matched])).toEqual([["TARGET", "Supportly", "Supportly AI"], ["TARGET", "Supportly", "supportly"]])
    expect(DETECTOR_VERSION).toBe("acq-exact-alias-v1")
  })
  it("does not match inside other words", () => {
    expect(detect("Supportlyish tools and MySupportly and Supportly_bot are different.")).toEqual([])
    expect(detect("HelpHubs are popular")).toEqual([])
  })
  it("treats a list of alternatives as a candidate with a LIST hint, never as a recommendation", () => {
    const found = detect("You can consider HelpHub, Desko, and Supportly.")
    const target = found.find(m => m.role === "TARGET")!
    expect(target.hints).toContain("LIST")
    expect(target).not.toHaveProperty("recommended")
    expect(found.filter(m => m.role === "COMPETITOR").map(m => m.brand)).toEqual(["HelpHub", "Desko"])
  })
  it("flags a negative sentence with a NEGATIVE_CUE hint", () => {
    const [m] = detect("Supportly is not suitable for this requirement.")
    expect(m!.hints).toContain("NEGATIVE_CUE")
  })
  it("flags comparisons", () => {
    const target = detect("Supportly versus HelpHub: both handle email.").find(m => m.role === "TARGET")!
    expect(target.hints).toContain("COMPARISON")
  })
  it("keeps each hint scoped to its own sentence", () => {
    const found = detect("HelpHub is not cheap. Supportly is a good fit.")
    expect(found.find(m => m.brand === "Supportly")!.hints).toEqual([])
    expect(found.find(m => m.brand === "HelpHub")!.hints).toContain("NEGATIVE_CUE")
  })
  it("respects case-sensitive brands and carries the operator's ambiguity note", () => {
    const found = detect("ADA compliance matters. Ada is an AI agent vendor. The ada language is old.")
    const ada = found.filter(m => m.brand === "Ada")
    expect(ada).toHaveLength(1)
    expect(ada[0]!.matched).toBe("Ada")
    expect(ada[0]!.ambiguity).toMatch(/programming language/)
  })
  it("resolves overlapping aliases to the longest span", () => {
    const found = detect("We recommend HelpHub Agent for chat.")
    expect(found).toHaveLength(1)
    expect(found[0]!.matched).toBe("HelpHub Agent")
  })
  it("marks an identical span claimed by two brands as a collision", () => {
    const shared = detectMentions("Nimbus is great.", brand("Nimbus"), [brand("Nimbus Corp", { aliases: ["Nimbus"] })])
    expect(shared).toHaveLength(2)
    expect(shared.every(m => m.collision)).toBe(true)
  })
  it("reports exact offsets into the answer", () => {
    const text = "Pick Supportly."
    const [m] = detect(text)
    expect(text.slice(m!.start, m!.end)).toBe("Supportly")
  })
  it("returns nothing for an answer without the brand", () => {
    expect(detect("Consider a shared inbox and a knowledge base.")).toEqual([])
  })
})

describe("cited source classification", () => {
  const redirect = "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AbC123"
  it("uses the provider-reported title for grounding redirects and never the redirect host", () => {
    expect(citationDomain({ uri: redirect, title: "supportly.test" })).toEqual({ domain: "supportly.test", basis: "PROVIDER_TITLE" })
    expect(citationDomain({ uri: redirect, title: "Supportly pricing page" })).toEqual({ domain: null, basis: "UNRESOLVED" })
    expect(citationDomain({ uri: "https://www.helphub.test/pricing", title: "x" })).toEqual({ domain: "helphub.test", basis: "URI_HOST" })
  })
  it("matches owned domains and subdomains only, never lookalikes", () => {
    expect(domainMatches("docs.supportly.test", ["supportly.test"])).toBe(true)
    expect(domainMatches("notsupportly.test", ["supportly.test"])).toBe(false)
    expect(domainMatches("supportly.test.evil.example", ["supportly.test"])).toBe(false)
  })
  it("classifies owned, competitor, other and unresolved sources; support is never assumed", () => {
    const c = (uri: string | null, title: string | null) => classifyCitation({ uri, title, position: 1 }, TARGET.domains, COMPETITORS)
    expect(c(redirect, "supportly.test")).toMatchObject({ owner: "OWNED", domainBasis: "PROVIDER_TITLE", support: "NOT_VERIFIED" })
    expect(c("https://helphub.test/a", null)).toMatchObject({ owner: "COMPETITOR", competitor: "HelpHub" })
    expect(c("https://reviews.example/a", null)).toMatchObject({ owner: "OTHER", competitor: null })
    expect(c(null, null)).toMatchObject({ owner: "UNRESOLVED", domain: null })
    expect(c("https://user:pw@supportly.test/", null)).toMatchObject({ owner: "UNRESOLVED" })
  })
  it("normalizes domains strictly", () => {
    expect(normalizeDomain("https://WWW.Supportly.Test/path?q=1")).toBe("supportly.test")
    expect(normalizeDomain("not a domain")).toBeNull()
    expect(normalizeDomain("localhost")).toBeNull()
  })
})
