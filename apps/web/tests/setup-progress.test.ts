import { describe, expect, it } from "vitest"
import { selectSetup } from "../app/components/setup-flow"

describe("setup progress", () => {
  it("shows updated server progress even when the revision has not changed", () => {
    const local = { businessId: "a", revision: 1, draft: "RUNNING" }
    const server = { businessId: "a", revision: 1, draft: "READY" }
    expect(selectSetup("a", server, local)).toEqual(server)
  })
  it("keeps a newer local result and never shows another business", () => {
    const local = { businessId: "a", revision: 2, draft: "RUNNING" }
    const server = { businessId: "a", revision: 1, draft: "READY" }
    expect(selectSetup("a", server, local)).toEqual(local)
    expect(selectSetup("b", server, local)).toBeNull()
  })
})
