import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import { WordPressSetup } from "../app/components/wordpress"

const state = vi.hoisted(() => ({ data: null as null | { configured: boolean; connection: null }, loading: false }))
vi.mock("@/lib/use-api", () => ({ useApi: () => ({ ...state, reload: vi.fn() }) }))

describe("WordPress connection", () => {
  it("masks the application password when connection is available", () => {
    state.data = { configured: true, connection: null }
    const markup = renderToStaticMarkup(<WordPressSetup businessId="business" bare />)
    expect(markup).toMatch(/type="password"[^>]*aria-label="Application password"/)
    expect(markup).toContain("Connect WordPress")
  })

  it("offers a retry when connection status fails to load", () => {
    state.data = null
    const markup = renderToStaticMarkup(<WordPressSetup businessId="business" bare />)
    expect(markup).toContain("WordPress connection status could not load")
    expect(markup).toContain("Try again")
  })
})
