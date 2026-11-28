import { describe, expect, it } from "vitest"
import { CONNECTORS, classify, gapsOf, nextCheckMinutes, stateOf, type ConnectorState, type ConnectorStatus } from "./connections.js"

const status = (id: ConnectorStatus["id"], state: ConnectorState): ConnectorStatus => ({ ...CONNECTORS.find(c => c.id === id)!, state, detail: "", accounts: [] })
const all = (ready: ReadonlyArray<ConnectorStatus["id"]>, other: ConnectorState = "NOT_CONNECTED") => CONNECTORS.map(c => status(c.id, ready.includes(c.id) ? "READY" : other))

describe("connection state", () => {
  it("is unavailable when OpenRecord is not set up with the provider, whatever is stored", () => {
    expect(stateOf(false, [{ status: "ACTIVE", forBusiness: true }])).toBe("UNAVAILABLE")
  })
  it("is ready only when a working connection serves this business", () => {
    expect(stateOf(true, [])).toBe("NOT_CONNECTED")
    expect(stateOf(true, [{ status: "ACTIVE", forBusiness: true }])).toBe("READY")
    expect(stateOf(true, [{ status: "NEEDS_RECONNECT", forBusiness: true }, { status: "ACTIVE", forBusiness: true }])).toBe("READY")
  })
  it("asks for a choice when signed in but nothing is chosen for this business", () => {
    expect(stateOf(true, [{ status: "ACTIVE", forBusiness: false }])).toBe("NEEDS_SETUP")
  })
  it("asks to reconnect when the connection serving the business was refused", () => {
    expect(stateOf(true, [{ status: "NEEDS_RECONNECT", forBusiness: true }, { status: "ACTIVE", forBusiness: false }])).toBe("NEEDS_RECONNECT")
    expect(stateOf(true, [{ status: "NEEDS_RECONNECT", forBusiness: false }])).toBe("NEEDS_RECONNECT")
  })
})

describe("tool gating", () => {
  it("withholds every gated tool when nothing is connected, and names what is missing", () => {
    const gaps = gapsOf(all([]))
    expect([...gaps.withheld].sort()).toEqual(["prepare_account_action", "prepare_page_change", "prepare_webflow_change", "prepare_wordpress_change", "read_ad_campaigns", "read_linkedin_posts", "read_reviews", "read_webflow_content", "read_wordpress_content"])
    expect(gaps.note).toContain("not connected: Website repository, WordPress, Webflow, Google Ads, Google Business Profile")
  })
  it("offers a tool gated by several connectors when any of them is ready", () => {
    const gaps = gapsOf(all(["google_business"]))
    expect(gaps.withheld.has("prepare_account_action")).toBe(false)
    expect(gaps.withheld.has("read_reviews")).toBe(false)
    expect(gaps.withheld.has("read_ad_campaigns")).toBe(true)
  })
  it("says which connections must be connected again rather than calling them missing", () => {
    const gaps = gapsOf(CONNECTORS.map(c => status(c.id, c.id === "webflow" ? "NEEDS_RECONNECT" : "READY")))
    expect([...gaps.withheld].sort()).toEqual(["prepare_webflow_change", "read_webflow_content"])
    expect(gaps.note).toContain("must be connected again: Webflow")
    expect(gaps.note).not.toContain("not connected")
  })
  it("adds nothing to the instructions when everything gated is ready", () => {
    expect(gapsOf(all(CONNECTORS.map(c => c.id)))).toEqual({ withheld: new Set(), note: "" })
  })
  it("gates only tools the catalog knows", async () => {
    const { CAPABILITY_MANIFESTS } = await import("./capabilities/catalog.js")
    const known = new Set(CAPABILITY_MANIFESTS.map(m => m.id))
    expect(CONNECTORS.flatMap(c => c.gates).filter(t => !known.has(t))).toEqual([])
  })
})

describe("checks", () => {
  it("treats a refused credential as a reconnect and anything else as a failure to check", () => {
    expect(classify({ _tag: "WebflowRefused", reason: "WebflowAUTH" })).toEqual({ result: "NEEDS_RECONNECT", reason: "WebflowAUTH" })
    expect(classify({ _tag: "GrowthGa4Refused", reason: "Ga4ReauthorizationRequired" })).toEqual({ result: "NEEDS_RECONNECT", reason: "Ga4ReauthorizationRequired" })
    expect(classify({ _tag: "WebflowRefused", reason: "WebflowUNAVAILABLE" })).toEqual({ result: "FAILING", reason: "WebflowUNAVAILABLE" })
    expect(classify(new Error("socket hang up: secret detail"))).toEqual({ result: "FAILING", reason: "CheckFailed" })
    expect(classify({ reason: "has spaces and provider text" })).toEqual({ result: "FAILING", reason: "CheckFailed" })
  })
  it("checks twice a day when working and backs off after unexplained failures", () => {
    expect(nextCheckMinutes("OK", 0)).toBe(720)
    expect([1, 2, 3, 4, 5, 9].map(n => nextCheckMinutes("FAILING", n))).toEqual([60, 120, 240, 480, 720, 720])
    expect(nextCheckMinutes("NEEDS_RECONNECT", 1)).toBe(1440)
  })
})
