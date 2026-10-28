import { describe, expect, it } from "vitest"
import type { DiscoverySignals, SetupBrief } from "@openrecord/contracts"
import { deriveChannelInventory, type ChannelFacts } from "./channels.js"
import { assessSetup, firstInitiative, setupStep } from "./setup-plan.js"

const signals = (checks: Partial<DiscoverySignals["checks"]> = {}, channels: DiscoverySignals["channels"] = []): DiscoverySignals => ({
  version: 1, requestedUrl: "https://acme.test/", finalUrl: "https://acme.test/", status: 200, bodyDigest: null, fetchedAt: "2026-10-25T00:00:00.000Z",
  siteName: "Acme", title: "Acme", description: "Plumbing", headings: [], pages: [], channels, organization: null,
  checks: { hasTitle: true, hasDescription: true, hasCanonical: true, hasOrganizationData: true, h1Count: 1, noindex: false, ...checks },
})
const brief: SetupBrief = { businessName: "Acme", category: "Plumbing", audience: "Homeowners", valueProposition: "Same-day repairs", goalStatement: "More calls",
  conversionKind: "LEAD", metricLabel: "Calls", reportingTimeZone: "UTC", factIds: [] }
const facts = (overrides: Partial<ChannelFacts> = {}): ChannelFacts => ({
  businessId: "b1", websiteUrl: "https://www.acme.test/", discovery: null, siteTargets: 0,
  ga4: { configured: false, connections: [], boundToBusiness: false }, github: { configured: false, targets: 0 }, searchConsole: { scopeGranted: false, site: null }, answerProviders: [], lastAnswerAt: null, ...overrides,
})

describe("setup step", () => {
  it("follows recorded state in order", () => {
    const base = { discoveryStatus: "DONE" as const, brief: null, channelsReviewedAt: null, opportunityId: null }
    expect(setupStep({ ...base, discoveryStatus: "FETCHING" })).toBe("DISCOVER")
    expect(setupStep({ ...base, discoveryStatus: "FAILED" })).toBe("CONFIRM")
    expect(setupStep({ ...base, brief: { ...brief, confirmedAt: "x" } })).toBe("CONNECT")
    expect(setupStep({ ...base, brief: { ...brief, confirmedAt: "x" }, channelsReviewedAt: "x" })).toBe("PROPOSE")
    expect(setupStep({ ...base, brief: { ...brief, confirmedAt: "x" }, channelsReviewedAt: "x", opportunityId: "o" })).toBe("DONE")
  })
})

describe("first initiative", () => {
  it("picks the most urgent bounded change from the homepage", () => {
    const pick = (s: DiscoverySignals | null) => firstInitiative({ goalId: "00000000-0000-4000-8000-000000000001", brief, websiteUrl: "https://acme.test/", signals: s, readOn: "2026-10-25" }).title
    expect(pick(signals({ noindex: true, hasOrganizationData: false }))).toBe("Let search engines index the homepage")
    expect(pick(signals({ hasOrganizationData: false }))).toBe("Identify the business in structured data on the homepage")
    expect(pick(signals({ hasDescription: false }))).toBe("Write a clear homepage title and description")
    expect(pick(signals())).toBe("Answer the questions buyers ask AI assistants")
    expect(pick(null)).toBe("Answer the questions buyers ask AI assistants")
  })

  it("states its uncertainty and never claims a baseline", () => {
    const o = firstInitiative({ goalId: "00000000-0000-4000-8000-000000000001", brief, websiteUrl: "https://acme.test/", signals: signals({ hasOrganizationData: false }), readOn: "2026-10-25" })
    expect(o.baselineAvailability).toBe("UNKNOWN")
    expect(o.uncertainty).toMatch(/unmeasured/)
    expect(o.source).toBe("OpenRecord setup: public homepage read on 2026-10-25")
  })
})

describe("channel inventory", () => {
  it("never treats a discovered profile or a ledger channel as connected", () => {
    const inv = deriveChannelInventory(facts({ discovery: signals({}, [{ kind: "FACEBOOK", url: "https://facebook.com/acme" }, { kind: "EMAIL", url: "mailto:hi@acme.test" }]) }))
    const byKey = Object.fromEntries(inv.channels.map(c => [c.key, c]))
    expect(byKey["profile:FACEBOOK"]).toMatchObject({ state: "DISCOVERED", active: ["DISCOVER"], offered: ["DISCOVER"], action: null })
    expect(byKey["profile:EMAIL"]).toMatchObject({ state: "DISCOVERED", identity: "hi@acme.test" })
    expect(byKey["ga4"]).toMatchObject({ state: "UNSUPPORTED", active: [], action: null })
    expect(byKey["github"]).toMatchObject({ state: "UNSUPPORTED", active: [] })
    expect(byKey["search-console"]).toMatchObject({ state: "UNSUPPORTED", active: [], action: null })
    expect(inv.channels.filter(c => c.state === "CONNECTED")).toEqual([])
  })

  it("reports each GA4 connection state and measures only when bound to the business", () => {
    const ga4 = (connections: ChannelFacts["ga4"]["connections"], boundToBusiness = false) =>
      deriveChannelInventory(facts({ ga4: { configured: true, connections, boundToBusiness } })).channels.find(c => c.key === "ga4")!
    expect(ga4([])).toMatchObject({ state: "PERMISSION_REQUIRED", action: { kind: "CONNECT_GA4" } })
    expect(ga4([{ status: "ACTIVE", statusReason: null, googleEmail: "a@acme.test" }])).toMatchObject({ state: "CONNECTED", active: ["READ"] })
    expect(ga4([{ status: "ACTIVE", statusReason: null, googleEmail: "a@acme.test" }], true)).toMatchObject({ state: "CONNECTED", active: ["READ", "MEASURE"] })
    expect(ga4([{ status: "REAUTHORIZATION_REQUIRED", statusReason: "AUTHORIZATION_REVOKED", googleEmail: "a@acme.test" }])).toMatchObject({ state: "REVOKED", active: [] })
    expect(ga4([{ status: "REAUTHORIZATION_REQUIRED", statusReason: "REFRESH_FAILED", googleEmail: "a@acme.test" }])).toMatchObject({ state: "UNHEALTHY" })
  })

  it("offers GitHub execution only for an allowed repository", () => {
    const sc = (searchConsole: ChannelFacts["searchConsole"]) => deriveChannelInventory(facts({ ga4: { configured: true, connections: [], boundToBusiness: false }, searchConsole })).channels.find(c => c.key === "search-console")!
    expect(sc({ scopeGranted: false, site: null })).toMatchObject({ state: "PERMISSION_REQUIRED", active: [], action: { label: "Connect", href: "/businesses/b1/channels#search-console" } })
    expect(sc({ scopeGranted: true, site: null })).toMatchObject({ state: "PERMISSION_REQUIRED", action: { label: "Choose site" } })
    expect(sc({ scopeGranted: true, site: "sc-domain:acme.test" })).toMatchObject({ state: "CONNECTED", identity: "sc-domain:acme.test", active: ["READ", "MEASURE"] })
    const gh = (targets: number) => deriveChannelInventory(facts({ github: { configured: true, targets } })).channels.find(c => c.key === "github")!
    expect(gh(0)).toMatchObject({ state: "PERMISSION_REQUIRED", active: [] })
    expect(gh(1)).toMatchObject({ state: "CONNECTED", active: ["EXECUTE", "VERIFY"] })
  })

  it("treats AI answer checks as a declared instrument, not a connected account", () => {
    const answers = (lastAnswerAt: string | null, providers = ["gemini"]) => deriveChannelInventory(facts({ answerProviders: providers, lastAnswerAt })).builtIn.find(b => b.key === "ai-answers")!
    expect(deriveChannelInventory(facts({ answerProviders: ["gemini"] })).channels.find(c => c.key === "ai-answers")).toBeUndefined()
    expect(answers(null, [])).toMatchObject({ available: false, action: null })
    expect(answers(null).note).toMatch(/no answer has been collected for this business yet/)
    expect(answers("2026-10-20T10:00:00.000Z").note).toMatch(/Last answer collected 2026-10-20/)
  })

  it("keeps unknowns unknown in the assessment", () => {
    const inv = deriveChannelInventory(facts())
    const a = assessSetup(null, "TIMEOUT", inv, false)
    expect(a.measurement).toBe("NONE")
    expect(a.findings.map(f => f.tone)).not.toContain("ok")
    expect(a.findings[0]?.text).toMatch(/could not be read \(timeout\)/)
  })
})
