import { describe, expect, it } from "vitest"
import { estimate, tokenPrices } from "./usage.js"

describe("usage cost estimates", () => {
  it("reads server prices and ignores malformed entries", () => {
    const p = tokenPrices("gemini-2.5-flash=0.30/2.50, bad, claude-x=3/15, =1/2, gpt=a/b")
    expect([...p.keys()]).toEqual(["gemini-2.5-flash", "claude-x"])
    expect(p.get("claude-x")).toEqual({ inputPerM: 3, outputPerM: 15 })
  })
  it("estimates only priced models with reported tokens, billing reasoning as output", () => {
    const price = { inputPerM: 3, outputPerM: 15 }
    expect(estimate(price, { prompt: 1_000_000, output: 100_000, thought: 100_000 })).toBeCloseTo(6)
    expect(estimate(undefined, { prompt: 10, output: 10, thought: null })).toBeNull()
    expect(estimate(price, { prompt: null, output: null, thought: null })).toBeNull()
  })
})
