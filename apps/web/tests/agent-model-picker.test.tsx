import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { AgentModelPicker } from "../app/components/agent-model-picker"
import type { ModelOption } from "../app/lib/harness"

const options: readonly ModelOption[] = [{ kind: "hosted", value: "hosted", provider: "gemini", model: "gemini-2.5-flash" }]

describe("model picker trigger", () => {
  it.each([false, true])("renders the selected model and its brand with locked=%s", locked => {
    const markup = renderToStaticMarkup(<AgentModelPicker options={options} value="hosted" label="Model" checking={false} unavailable={false} locked={locked} onChoose={() => undefined} onManage={() => undefined} />)
    expect(markup).toContain('aria-label="Agent model"')
    expect(markup).toContain("gemini-2.5-flash")
    expect(markup).toContain('title="Gemini"')
    expect(markup.includes('disabled=""')).toBe(locked)
  })

  it("keeps the unavailable selection label instead of silently showing another model", () => {
    const markup = renderToStaticMarkup(<AgentModelPicker options={options} value={undefined} label="Model unavailable" checking={false} unavailable locked={false} onChoose={() => undefined} onManage={() => undefined} />)
    expect(markup).toContain("Model unavailable")
    expect(markup).not.toContain("gemini-2.5-flash")
  })
})
