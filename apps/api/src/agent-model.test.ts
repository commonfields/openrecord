import { afterEach, describe, expect, it, vi } from "vitest"
import { ConfigProvider, Effect } from "effect"
import { agentSettings, configuredAgentModel, geminiStreamFold } from "./agent-model.js"
const config = ConfigProvider.fromMap(new Map([
  ["AGENT_EXTERNAL_PROCESSING_ENABLED", "true"], ["AGENT_MODEL", "fixture-model"], ["AGENT_API_KEY", "TEST-only-key"], ["AGENT_TIMEOUT_MS", "50"],
]))
const invoke = () => Effect.runPromise(Effect.either(Effect.flatMap(configuredAgentModel, m => m.invoke({ contents: [{ role: "user", parts: [{ text: "Stored question" }] }], tools: [], system: "Untrusted evidence" })).pipe(Effect.withConfigProvider(config))))
afterEach(() => vi.unstubAllGlobals())
describe("Gemini assistant transport (local HTTP fixtures only)", () => {
  it("allows a model response up to three minutes by default while respecting an explicit timeout", async () => {
    const base = [["AGENT_MODEL", "fixture-model"], ["AGENT_API_KEY", "TEST-only-key"]] as Array<[string, string]>
    const defaults = await Effect.runPromise(agentSettings.pipe(Effect.withConfigProvider(ConfigProvider.fromMap(new Map(base)))))
    const configured = await Effect.runPromise(agentSettings.pipe(Effect.withConfigProvider(config)))
    expect(defaults.timeoutMs).toBe(180000)
    expect(configured.timeoutMs).toBe(50)
  })
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
  it("sends a schema held in tool evidence as text, since Gemini refuses a function response that carries a schema reference", async () => {
    const sent: unknown[] = []
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)))
      return new Response(JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }] }), { status: 200 })
    }))
    const schema = { $defs: { Int: { type: "integer" } }, type: "object", properties: { count: { $ref: "#/$defs/Int" } } }
    const call = { functionCall: { name: "find_research_capabilities", args: { $note: "arguments are the model's own and stay as sent" } } }
    const contents = [{ role: "user" as const, parts: [{ text: "$ref in plain text is untouched" }] }, { role: "model" as const, parts: [call] },
      { role: "user" as const, parts: [{ functionResponse: { name: "find_research_capabilities", response: { untrustedEvidence: { summary: "1 capability", data: [{ id: "seo.serp", inputSchema: schema }] } } } }] }]
    await Effect.runPromise(Effect.flatMap(configuredAgentModel, m => m.invoke({ contents, tools: [], system: "x" })).pipe(Effect.withConfigProvider(config)))
    const body = sent[0] as { contents: Array<{ parts: Array<Record<string, any>> }> }
    expect(body.contents[0]!.parts[0]).toEqual(contents[0]!.parts[0])
    expect(body.contents[1]!.parts[0]).toEqual(call)
    const evidence = body.contents[2]!.parts[0]!["functionResponse"].response.untrustedEvidence
    expect(evidence.summary).toBe("1 capability")
    expect(evidence.data[0].id).toBe("seo.serp")
    expect(JSON.parse(evidence.data[0].inputSchema)).toEqual(schema)
  })
  it("uses a dedicated model, preserves tool signatures and records observed usage", async () => {
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      expect(_url).toContain("/fixture-model:streamGenerateContent?alt=sse")
      expect(JSON.parse(String(init.body))).toMatchObject({ generationConfig: { maxOutputTokens: 32768 } })
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
    expect(out).toMatchObject({ _tag: "Left", left: { reason: status === 429 ? "RATE_LIMITED" : status === 401 ? "UNCONFIGURED" : "UNAVAILABLE", httpStatus: status } })
    expect(JSON.stringify(out)).not.toContain("sensitive")
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it.each(["not JSON", JSON.stringify({ candidates: [] }), JSON.stringify({ candidates: [{ content: { role: "model", parts: [] }, finishReason: "MAX_TOKENS" }] }), "x".repeat(256001)])("rejects malformed, blocked and oversized responses", async body => {
    vi.stubGlobal("fetch", async () => new Response(body))
    expect((await invoke())._tag).toBe("Left")
  })
  it("reads a streamed answer piece by piece, showing the reasoning and the text as they grow, and returns it whole", async () => {
    const chunks = [
      { candidates: [{ content: { role: "model", parts: [{ text: "Weighing the goal", thought: true }] } }] },
      { candidates: [{ content: { role: "model", parts: [{ text: "Publish " }] } }], modelVersion: "fixture-model-001" },
      { candidates: [{ content: { role: "model", parts: [{ text: "the pricing page.", thoughtSignature: "sig" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 900, cachedContentTokenCount: 700, candidatesTokenCount: 5, totalTokenCount: 905 } },
    ]
    // Split mid-event, as a network does.
    const wire = chunks.map(c => `data: ${JSON.stringify(c)}\r\n\r\n`).join("")
    const body = new ReadableStream<Uint8Array>({ start(controller) { for (const piece of [wire.slice(0, 70), wire.slice(70, 200), wire.slice(200)]) controller.enqueue(new TextEncoder().encode(piece)); controller.close() } })
    vi.stubGlobal("fetch", async () => new Response(body, { headers: { "content-type": "text/event-stream" } }))
    const thoughts: string[] = [], texts: string[] = []
    const out = await Effect.runPromise(Effect.either(Effect.flatMap(configuredAgentModel, m => m.invoke({ contents: [{ role: "user", parts: [{ text: "Next step?" }] }], tools: [], system: "x",
      onThought: t => Effect.sync(() => { thoughts.push(t) }), onText: t => Effect.sync(() => { texts.push(t) }) })).pipe(Effect.withConfigProvider(config))))
    expect(thoughts).toEqual(["Weighing the goal"])
    expect(texts).toEqual(["Publish ", "Publish the pricing page."])
    expect(out).toMatchObject({ _tag: "Right", right: { modelVersion: "fixture-model-001", usageMetadata: { cachedContentTokenCount: 700 },
      candidates: [{ finishReason: "STOP", content: { parts: [{ text: "Weighing the goal", thought: true }, { text: "Publish the pricing page.", thoughtSignature: "sig" }] } }] } })
  })
  it("keeps a streamed tool call whole and apart from the text around it, and a display callback that fails never fails the step", async () => {
    const fold = geminiStreamFold()
    fold.push({ candidates: [{ content: { parts: [{ text: "Let me check. " }] } }] })
    fold.push({ candidates: [{ content: { parts: [{ functionCall: { name: "read_revenue", args: { days: 30 } }, thoughtSignature: "s1" }] }, finishReason: "STOP" }] })
    expect(fold.text()).toBe("Let me check. ")
    expect(fold.response()).toEqual({ candidates: [{ content: { role: "model", parts: [{ text: "Let me check. " }, { functionCall: { name: "read_revenue", args: { days: 30 } }, thoughtSignature: "s1" }] }, finishReason: "STOP" }] })
    expect(geminiStreamFold().response()).toEqual({ candidates: [] })
    vi.stubGlobal("fetch", async () => new Response(`data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "Fine." }] }, finishReason: "STOP" }] })}\n\n`, { headers: { "content-type": "text/event-stream" } }))
    const out = await Effect.runPromise(Effect.either(Effect.flatMap(configuredAgentModel, m => m.invoke({ contents: [{ role: "user", parts: [{ text: "Hi" }] }], tools: [], system: "x",
      onText: () => Effect.fail("display failed") })).pipe(Effect.withConfigProvider(config))))
    expect(out).toMatchObject({ _tag: "Right", right: { candidates: [{ content: { parts: [{ text: "Fine." }] } }] } })
  })
  it("aborts a timed-out provider", async () => {
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted")))))
    expect(await invoke()).toMatchObject({ _tag: "Left", left: { reason: "TIMEOUT" } })
  })
  it("classifies an output limit without retaining provider content", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ candidates: [{ finishReason: "MAX_TOKENS", privateText: "sensitive provider output" }] })))
    const result = await invoke()
    expect(result).toMatchObject({ _tag: "Left", left: { reason: "MALFORMED", detail: "OUTPUT_LIMIT" } })
    expect(JSON.stringify(result)).not.toContain("sensitive provider output")
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
      expect(JSON.parse(String(init.body))).toMatchObject({ model: "claude-sonnet-5-5", max_tokens: 32768, tools: [{ type: "function", function: { name: "read_open_issues" } }] })
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
  it.each([[429, "RATE_LIMITED"], [401, "UNCONFIGURED"]])("redacts proxy error %s", async (status, reason) => {
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
