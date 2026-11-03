import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import { ResearchConnections } from "../app/components/research-connections"

const state = vi.hoisted(() => ({ data: null as null | { available: boolean; providers: Array<{ id: string; name: string; how: string; url: string; example: string; paid: boolean; optional: boolean; endpoints: string[]; connected: boolean; hint: string | null }> }, loading: false }))
vi.mock("@/lib/use-api", () => ({ useApi: () => ({ ...state, reload: vi.fn() }) }))

describe("research accounts", () => {
  it("shows discoverable accounts and makes key-based access clear", () => {
    state.data = { available: true, providers: [{ id: "example", name: "Example research", how: "Create a key", url: "https://example.com", example: "key", paid: true, optional: false, endpoints: ["Search"], connected: false, hint: null }] }
    const markup = renderToStaticMarkup(<ResearchConnections businessId="business" />)
    expect(markup).toContain("Example research")
    expect(markup).toContain("Search research accounts")
    expect(markup).toContain("Connect with key")
    expect(markup).toContain("billed to your own account")
  })

  it("shows a retry when accounts cannot load", () => {
    state.data = null
    const markup = renderToStaticMarkup(<ResearchConnections businessId="business" />)
    expect(markup).toContain("Research accounts could not load")
    expect(markup).toContain("Try again")
  })
})
