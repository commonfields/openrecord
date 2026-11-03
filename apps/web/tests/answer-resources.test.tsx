// @vitest-environment jsdom
import { act } from "react"
import { createRoot } from "react-dom/client"
import { MemoryRouter } from "react-router"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { AnswerResources } from "@/components/agent-chat"

beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true))
afterEach(() => { document.body.innerHTML = ""; vi.unstubAllGlobals() })

describe("answer resources", () => {
  it("hides sources until the reader opens them", async () => {
    const container = document.createElement("div")
    document.body.appendChild(container)
    const root = createRoot(container)
    await act(async () => root.render(<MemoryRouter><AnswerResources businessId={null} citations={[{ kind: "web", id: "https://example.com/", text: "Example source" }]} /></MemoryRouter>))
    const button = container.querySelector("button")!
    expect(button.textContent).toContain("Resources (1)")
    expect(button.getAttribute("aria-expanded")).toBe("false")
    expect(container.textContent).not.toContain("Example source")
    await act(async () => button.click())
    expect(button.getAttribute("aria-expanded")).toBe("true")
    expect(container.textContent).toContain("Example source")
    expect(container.querySelector("a")?.getAttribute("href")).toBe("https://example.com/")
    await act(async () => button.click())
    expect(button.getAttribute("aria-expanded")).toBe("false")
    await act(async () => root.unmount())
  })
})
