import { afterEach, describe, expect, it, vi } from "vitest"
import { ConfigProvider, Effect } from "effect"
import { configuredAgentModel } from "./agent-model.js"
const config = ConfigProvider.fromMap(new Map([
  ["AGENT_EXTERNAL_PROCESSING_ENABLED", "true"], ["AGENT_MODEL", "fixture-model"], ["AGENT_API_KEY", "TEST-only-key"], ["AGENT_TIMEOUT_MS", "50"],
]))
const invoke = () => Effect.runPromise(Effect.either(Effect.flatMap(configuredAgentModel, m => m.invoke({ contents: [{ role: "user", parts: [{ text: "Stored question" }] }], tools: [], system: "Untrusted evidence" })).pipe(Effect.withConfigProvider(config))))
afterEach(() => vi.unstubAllGlobals())
describe("Gemini assistant transport (local HTTP fixtures only)", () => {
  it("uses a dedicated model, preserves tool signatures and records observed usage", async () => {
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      expect(_url).toContain("/fixture-model:generateContent")
      expect(JSON.parse(String(init.body))).toMatchObject({ generationConfig: { maxOutputTokens: 2048 } })
      return new Response(JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ thoughtSignature: "fixture-signature", functionCall: { name: "read_business_truth", args: {} } }] }, finishReason: "STOP" }], modelVersion: "observed-fixture", usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 3 } }))
    })
    vi.stubGlobal("fetch", fetch)
    const out = await invoke()
    expect(out).toMatchObject({ _tag: "Right", right: { modelVersion: "observed-fixture", usageMetadata: { promptTokenCount: 11 } } })
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it.each([429, 401, 500])("redacts provider error %s without retry", async status => {
    const fetch = vi.fn(async () => new Response("sensitive provider detail", { status }))
    vi.stubGlobal("fetch", fetch)
    const out = await invoke()
    expect(out).toMatchObject({ _tag: "Left", left: { reason: status === 429 ? "RATE_LIMITED" : "UNAVAILABLE" } })
    expect(JSON.stringify(out)).not.toContain("sensitive")
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it.each(["not JSON", JSON.stringify({ candidates: [] }), JSON.stringify({ candidates: [{ content: { role: "model", parts: [] }, finishReason: "MAX_TOKENS" }] }), "x".repeat(256001)])("rejects malformed, blocked and oversized responses", async body => {
    vi.stubGlobal("fetch", async () => new Response(body))
    expect((await invoke())._tag).toBe("Left")
  })
  it("aborts a timed-out provider", async () => {
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted")))))
    expect(await invoke()).toMatchObject({ _tag: "Left", left: { reason: "TIMEOUT" } })
  })
})
