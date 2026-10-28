import { describe, expect, it } from "vitest"
import { matchRoutes } from "react-router"
import { EvidenceRoutePatterns } from "../app/lib/route-patterns"
import { agentEvidencePath, webSourceUrl } from "../app/lib/agent-evidence"
const id = "00000000-0000-4000-8000-000000000001"
describe("trusted agent evidence navigation", () => {
  it("maps known evidence to authenticated routes", () => {
    expect(agentEvidencePath(id, { kind: "observation", id, text: "Answer" })).toBe(`/observations/${id}`)
    const observationPath = agentEvidencePath(id, { kind: "observation", id, text: "Answer" })
    const observationMatches = observationPath === null ? null : matchRoutes([{ path: EvidenceRoutePatterns.observation }], observationPath)
    expect(observationMatches?.[0]?.params["observationId"]).toBe(id)
    const discoveryPath = agentEvidencePath(id, { kind: "discovery_scope", id, text: "Sources" })
    const discoveryMatches = discoveryPath === null ? null : matchRoutes([{ path: "/businesses/:id", children: [{ path: EvidenceRoutePatterns.sourceDiscovery }] }], discoveryPath)
    expect(discoveryMatches?.at(-1)?.params["id"]).toBe(id)
    expect(agentEvidencePath(id, { kind: "record", id, text: "Client" })).toBe(`/clients/${id}`)
    const referralPath = agentEvidencePath(id, { kind: "referral_import", id, text: "GA4 export" })
    expect(referralPath).toBe(`/clients/${id}/discovery/report`)
    expect(matchRoutes([{ path: "/clients/:id/discovery/report" }], referralPath!)?.[0]?.params["id"]).toBe(id)
  })
  it("rejects unknown kinds, URL injection and arbitrary IDs", () => {
    for (const kind of ["https://evil.test", "javascript:alert(1)", "invented"]) expect(agentEvidencePath(id, { kind, id, text: "x" })).toBeNull()
    expect(agentEvidencePath(id, { kind: "issue", id: "../../other", text: "x" })).toBeNull()
  })
  it("opens only http(s) pages the agent cited as web sources, never inside the app", () => {
    expect(webSourceUrl({ kind: "web", id: "https://northstar.test/pricing", text: "Pricing" })).toBe("https://northstar.test/pricing")
    for (const bad of ["javascript:alert(1)", "data:text/html,x", "/businesses/x", "not a url"]) expect(webSourceUrl({ kind: "web", id: bad, text: "x" })).toBeNull()
    expect(webSourceUrl({ kind: "issue", id: "https://northstar.test/", text: "x" })).toBeNull()
    expect(agentEvidencePath(id, { kind: "web", id, text: "x" })).toBeNull()
  })
})
