// @vitest-environment jsdom
import { act, createRef } from "react"
import { createRoot } from "react-dom/client"
import { describe, expect, it } from "vitest"
import { ComposerEditor, type ComposerEditorHandle } from "../app/components/composer-editor"

// React's act() in a plain DOM test.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mount = async (value: string, onKeyDown?: (e: KeyboardEvent) => boolean) => {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  const ref = createRef<ComposerEditorHandle>()
  let text = value
  const render = async (v: string) => {
    await act(async () => {
      root.render(<ComposerEditor ref={ref} value={v} onChange={t => { text = t }} placeholder="Ask the agent" {...(onKeyDown ? { onKeyDown } : {})} />)
    })
  }
  await render(value)
  return { host, ref, render, text: () => text, unmount: () => act(() => root.unmount()) }
}

describe("composer editor", () => {
  it("shows the text it is given, one paragraph per line, and follows changes", async () => {
    const m = await mount("first line\nsecond line")
    const field = m.host.querySelector("#agent-input")!
    expect(field.getAttribute("role")).toBe("textbox")
    expect([...field.querySelectorAll("p")].map(p => p.textContent)).toEqual(["first line", "second line"])
    await m.render("")
    expect(field.textContent).toBe("")
    expect(field.querySelector("p")?.getAttribute("data-placeholder")).toBe("Ask the agent")
    await m.unmount()
  })

  it("hands keys to the composer before editing", async () => {
    const seen: string[] = []
    const m = await mount("hello", e => { seen.push(e.key); return e.key === "Enter" })
    const field = m.host.querySelector("#agent-input")!
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
    expect(seen).toContain("Enter")
    expect(m.text()).toBe("hello")
    await m.unmount()
  })
})
