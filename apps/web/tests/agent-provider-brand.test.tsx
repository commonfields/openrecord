import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { modelBrand, providerBrand, ProviderLogo } from "../app/components/provider-logo"

describe("agent provider branding", () => {
  it.each(["claude-code", "codex", "opencode", "cursor", "nvidia"])("renders a vector brand mark for %s rather than a letter placeholder", provider => {
    const markup = renderToStaticMarkup(<ProviderLogo provider={provider} />)
    expect(markup).toContain("<path")
    expect(markup).not.toContain("<text")
    expect(markup).not.toContain("<img")
    expect(markup).toContain("aria-hidden")
    expect(providerBrand(provider).label).not.toBe("")
  })

  it.each(["claude-code", "codex", "opencode", "cursor"])("draws the %s harness mark bare, with no tile or ring", provider => {
    const markup = renderToStaticMarkup(<ProviderLogo bare provider={provider} />)
    expect(markup).toContain("<path")
    expect(markup).not.toMatch(/ring-|bg-|rounded/)
  })

  it("lets monochrome marks follow the theme and keeps brand colour otherwise", () => {
    expect(renderToStaticMarkup(<ProviderLogo bare provider="cursor" />)).toContain('fill="currentColor"')
    expect(renderToStaticMarkup(<ProviderLogo bare provider="codex" />)).toContain('fill="currentColor"')
    expect(renderToStaticMarkup(<ProviderLogo bare provider="claude-code" />)).not.toContain('fill="currentColor"')
  })

  it.each([
    ["anthropic/claude-sonnet-4", "opencode", "claude"],
    ["google/gemini-2.5-flash", "opencode", "gemini"],
    ["gpt-5-codex", "codex", "openai"],
    ["openai/o3-mini", "opencode", "openai"],
    ["deepseek/reasoner", "cursor", "deepseek"],
    ["nvidia/deepseek-ai/deepseek-v4.1-flash", "opencode", "nvidia"],
    ["nvidia/google/gemma-4-31b-it", "opencode", "nvidia"],
    ["custom-model:free", "opencode", "opencode"],
  ])("shows the model brand for %s carried by %s", (model, driver, expected) => {
    expect(modelBrand(model, driver)).toBe(expected)
  })
})
