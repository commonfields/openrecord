import { afterEach, describe, expect, it, vi } from "vitest"
import { ConfigProvider, Effect } from "effect"
import { configuredAgentModel } from "./agent-model.js"
const config = ConfigProvider.fromMap(new Map([
  ["AGENT_EXTERNAL_PROCESSING_ENABLED", "true"], ["AGENT_MODEL", "fixture-model"], ["AGENT_API_KEY", "TEST-only-key"], ["AGENT_TIMEOUT_MS", "50"],
]))
const invoke = () => Effect.runPromise(Effect.either(Effect.flatMap(configuredAgentModel, m => m.invoke({ contents: [{ role: "user", parts: [{ text: "Stored question" }] }], tools: [], system: "Untrusted evidence" })).pipe(Effect.withConfigProvider(config))))
afterEach(() => vi.unstubAllGlobals())
describe("Gemini assistant transport (local HTTP fixtures only)", () => {
  it("refuses external processing before fetch even when model credentials are configured", async () => {
    const fetch = vi.fn()
    vi.stubGlobal("fetch", fetch)
    const disabled = ConfigProvider.fromMap(new Map([
      ["AGENT_EXTERNAL_PROCESSING_ENABLED", "false"], ["AGENT_MODEL", "fixture-model"], ["AGENT_API_KEY", "TEST-only-key"],
    ]))
    const result = await Effect.runPromise(Effect.either(configuredAgentModel.pipe(Effect.withConfigProvider(disabled))))
    expect(result).toMatchObject({ _tag: "Left", left: { reason: "UNCONFIGURED" } })
    expect(fetch).not.toHaveBeenCalled()
  })
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

describe("CLIProxyAPI assistant transport (local HTTP fixtures only)", () => {
  const proxy = (extra: Array<[string, string]> = []) => ConfigProvider.fromMap(new Map([
    ["AGENT_EXTERNAL_PROCESSING_ENABLED", "true"], ["AGENT_PROVIDER", "cliproxy"], ["AGENT_MODEL", "claude-sonnet-5-5"], ["AGENT_API_KEY", "TEST-client-key"],
    ["AGENT_BASE_URL", "http://127.0.0.1:8317/v1/"], ["AGENT_TIMEOUT_MS", "50"], ...extra,
  ]))
  const call = (cfg = proxy()) => Effect.runPromise(Effect.either(Effect.flatMap(configuredAgentModel, m => m.invoke({
    contents: [{ role: "user", parts: [{ text: "What is open?" }] }], tools: [{ name: "read_open_issues", description: "Read", parametersJsonSchema: { type: "object", properties: {} } }], system: "sys" })).pipe(Effect.withConfigProvider(cfg))))
  it("sends native tools to the chat endpoint and maps calls and usage back", async () => {
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("http://127.0.0.1:8317/v1/chat/completions")
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer TEST-client-key")
      expect(JSON.parse(String(init.body))).toMatchObject({ model: "claude-sonnet-5-5", max_tokens: 2048, tools: [{ type: "function", function: { name: "read_open_issues" } }] })
      return new Response(JSON.stringify({ model: "claude-sonnet-5-5-observed", usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 },
        choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [{ id: "c", type: "function", function: { name: "read_open_issues", arguments: "{}" } }] } }] }))
    })
    vi.stubGlobal("fetch", fetch)
    expect(await call()).toMatchObject({ _tag: "Right", right: { modelVersion: "claude-sonnet-5-5-observed", usageMetadata: { promptTokenCount: 9, totalTokenCount: 11 },
      candidates: [{ finishReason: "STOP", content: { role: "model", parts: [{ functionCall: { name: "read_open_issues", args: {} } }] } }] } })
  })
  it("returns text replies", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "Two issues." } }] })))
    expect(await call()).toMatchObject({ _tag: "Right", right: { candidates: [{ content: { parts: [{ text: "Two issues." }] } }] } })
  })
  it.each([[429, "RATE_LIMITED"], [401, "UNAVAILABLE"]])("redacts proxy error %s", async (status, reason) => {
    vi.stubGlobal("fetch", async () => new Response("secret upstream detail", { status }))
    const out = await call()
    expect(out).toMatchObject({ _tag: "Left", left: { reason } })
    expect(JSON.stringify(out)).not.toContain("secret")
  })
  it("refuses a non-loopback plain HTTP endpoint before any request", async () => {
    const fetch = vi.fn()
    vi.stubGlobal("fetch", fetch)
    expect(await call(proxy([["AGENT_BASE_URL", "http://192.168.1.3:8317"]]))).toMatchObject({ _tag: "Left", left: { reason: "UNCONFIGURED" } })
    expect(fetch).not.toHaveBeenCalled()
  })
})
