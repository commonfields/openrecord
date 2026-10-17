import { describe, expect, it } from "vitest"
import { agentEvidencePath } from "../app/lib/agent-evidence"
const id = "00000000-0000-4000-8000-000000000001"
describe("trusted agent evidence navigation", () => {
  it("maps known evidence to authenticated routes", () => {
    expect(agentEvidencePath(id, { kind: "observation", id, text: "Answer" })).toBe(`/businesses/${id}/observations/${id}`)
    expect(agentEvidencePath(id, { kind: "record", id, text: "Client" })).toBe(`/clients/${id}`)
  })
  it("rejects unknown kinds, URL injection and arbitrary IDs", () => {
    for (const kind of ["https://evil.test", "javascript:alert(1)", "invented"]) expect(agentEvidencePath(id, { kind, id, text: "x" })).toBeNull()
    expect(agentEvidencePath(id, { kind: "issue", id: "../../other", text: "x" })).toBeNull()
  })
})
