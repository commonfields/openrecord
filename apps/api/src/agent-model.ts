import { Config, Data, Effect, Option, Redacted, Schema } from "effect"
import { chatCompletionAnswer, chatCompletionRequest } from "@openrecord/contracts"

export class AgentModelError extends Data.TaggedError("AgentModelError")<{
  readonly reason: "UNCONFIGURED" | "TIMEOUT" | "RATE_LIMITED" | "UNAVAILABLE" | "MALFORMED" | "CONTEXT_LIMIT" | "TOOL_LIMIT" | "CANCELLED"
  readonly detail?: "INVALID_JSON" | "RESPONSE_TOO_LARGE" | "INVALID_RESPONSE" | "OUTPUT_LIMIT" | "PROVIDER_STOPPED" | "EMPTY_REPLY" | "LOCAL_REQUEST_LIMIT" | "LOCAL_CONTEXT_LIMIT"
  readonly httpStatus?: number
}> {}

const bounded = (name: string, fallback: number, max: number) => Config.integer(name).pipe(
  Config.withDefault(fallback), Config.validate({ message: "invalid agent resource limit", validation: n => n > 0 && n <= max }),
)
// "cliproxy": a CLIProxyAPI (OpenAI-compatible) endpoint the server can reach,
// for a self-hosted OpenRecord next to the operator's own subscriptions.
export const AGENT_PROVIDERS = ["gemini", "cliproxy"] as const
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"])
/** Plain HTTP only on loopback; no credentials, query or fragment in the URL. */
export const agentBaseUrl = (raw: string) => {
  try {
    const url = new URL(raw)
    if (url.username || url.password || url.search || url.hash) return null
    if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) return null
    return `${url.origin}${url.pathname.replace(/\/+$/, "").replace(/\/v1$/, "")}`
  } catch { return null }
}
export const agentSettings = Config.all({
  provider: Config.literal(...AGENT_PROVIDERS)("AGENT_PROVIDER").pipe(Config.withDefault("gemini" as const)),
  // CLIProxyAPI model IDs may carry a provider prefix or an upper-case letter; Gemini IDs never do.
  model: Config.string("AGENT_MODEL").pipe(Config.validate({ message: "invalid agent model", validation: m => /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(m) })),
  apiKey: Config.redacted("AGENT_API_KEY"),
  baseUrl: Config.string("AGENT_BASE_URL").pipe(Config.withDefault("http://127.0.0.1:8317")),
  // The default suits every supported model; one with a larger output window can be given more.
  maxOutputTokens: bounded("AGENT_MAX_OUTPUT_TOKENS", 8192, 65536),
  timeoutMs: bounded("AGENT_TIMEOUT_MS", 60000, 120000),
})

export const Part = Schema.Struct({
  text: Schema.optional(Schema.String.pipe(Schema.maxLength(20000))),
  thought: Schema.optional(Schema.Boolean),
  thoughtSignature: Schema.optional(Schema.String),
  functionCall: Schema.optional(Schema.Struct({
    name: Schema.String.pipe(Schema.maxLength(100)), args: Schema.Record({ key: Schema.String, value: Schema.Unknown }),
  })),
})
const Response = Schema.Struct({
  candidates: Schema.Array(Schema.Struct({
    content: Schema.Struct({ role: Schema.Literal("model"), parts: Schema.Array(Part).pipe(Schema.maxItems(12)) }),
    finishReason: Schema.optional(Schema.String),
  })).pipe(Schema.minItems(1), Schema.maxItems(1)),
  modelVersion: Schema.optional(Schema.String),
  usageMetadata: Schema.optional(Schema.Struct({
    promptTokenCount: Schema.optional(Schema.NonNegativeInt), candidatesTokenCount: Schema.optional(Schema.NonNegativeInt),
    thoughtsTokenCount: Schema.optional(Schema.NonNegativeInt), totalTokenCount: Schema.optional(Schema.NonNegativeInt),
    // Prompt tokens the provider served from its cache: what the constant prefix (instructions, tool cards) saves.
    cachedContentTokenCount: Schema.optional(Schema.NonNegativeInt),
  })),
})
export type ModelContent = { readonly role: "user" | "model"; readonly parts: ReadonlyArray<unknown> }
export type ModelResponse = typeof Response.Type
export type ModelInput = { readonly contents: ReadonlyArray<ModelContent>; readonly tools: ReadonlyArray<unknown>; readonly system: string
  /** Called with the reasoning produced so far in this step, when the provider streams it. Display only. */
  readonly onThought?: ((thought: string) => Effect.Effect<void, unknown>) | undefined
  /** Called with the answer text produced so far in this step, when the provider streams it. Display only. */
  readonly onText?: ((text: string) => Effect.Effect<void, unknown>) | undefined }
export type AgentModel = (input: ModelInput) => Effect.Effect<ModelResponse, AgentModelError>

/** Reads a JSON body of at most `max` bytes. */
const readJson = async (response: Response, max = 256000): Promise<unknown> => {
  const reader = response.body?.getReader()
  if (!reader) throw new AgentModelError({ reason: "MALFORMED" })
  let size = 0
  const chunks: Uint8Array[] = []
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > max) throw new AgentModelError({ reason: "MALFORMED", detail: "RESPONSE_TOO_LARGE" })
      chunks.push(next.value)
    }
  } finally { await reader.cancel() }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) } catch { throw new AgentModelError({ reason: "MALFORMED", detail: "INVALID_JSON" }) }
}
type StreamPart = { text?: string; thought?: boolean; thoughtSignature?: string; functionCall?: unknown }
/**
 * Folds the chunks of a streamed Gemini answer into the one response a plain
 * request returns. Text arrives in pieces: consecutive pieces of the same kind
 * (reasoning or answer) join into one part, and a signature carried by a piece
 * stays with its part. Tool calls arrive whole. The last finish reason, model
 * version and usage win.
 */
export const geminiStreamFold = () => {
  const parts: StreamPart[] = []
  let finishReason: unknown, modelVersion: unknown, usageMetadata: unknown, seen = false
  return {
    push: (chunk: unknown) => {
      if (chunk === null || typeof chunk !== "object") return
      const c = chunk as { candidates?: ReadonlyArray<{ content?: { parts?: ReadonlyArray<StreamPart> }; finishReason?: unknown }>; modelVersion?: unknown; usageMetadata?: unknown }
      const candidate = c.candidates?.[0]
      if (candidate) seen = true
      for (const part of candidate?.content?.parts ?? []) {
        const last = parts[parts.length - 1]
        if (typeof part.text === "string" && !part.functionCall && last && typeof last.text === "string" && !last.functionCall && !!last.thought === !!part.thought) {
          last.text += part.text
          if (part.thoughtSignature) last.thoughtSignature = part.thoughtSignature
        } else parts.push({ ...part })
      }
      if (candidate?.finishReason !== undefined) finishReason = candidate.finishReason
      if (c.modelVersion !== undefined) modelVersion = c.modelVersion
      if (c.usageMetadata !== undefined) usageMetadata = c.usageMetadata
    },
    thought: () => parts.filter(p => p.thought && p.text).map(p => p.text).join("\n\n"),
    text: () => parts.filter(p => !p.thought && !p.functionCall).map(p => p.text ?? "").join(""),
    response: (): unknown => seen ? { candidates: [{ content: { role: "model", parts }, ...(finishReason !== undefined ? { finishReason } : {}) }],
      ...(modelVersion !== undefined ? { modelVersion } : {}), ...(usageMetadata !== undefined ? { usageMetadata } : {}) } : { candidates: [] },
  }
}
/** Reads a server-sent-event body of at most `max` bytes, handing each `data:` payload to `onData` as it arrives. */
const readEvents = async (response: Response, onData: (data: string) => Promise<void>, max = 1000000) => {
  const reader = response.body?.getReader()
  if (!reader) throw new AgentModelError({ reason: "MALFORMED" })
  const decoder = new TextDecoder("utf-8")
  let size = 0, buffer = ""
  const flush = async (block: string) => {
    const data = block.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).replace(/^ /, "")).join("\n")
    if (data) await onData(data)
  }
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > max) throw new AgentModelError({ reason: "MALFORMED", detail: "RESPONSE_TOO_LARGE" })
      buffer += decoder.decode(next.value, { stream: true })
      let cut: RegExpExecArray | null
      while ((cut = /\r?\n\r?\n/.exec(buffer))) {
        const block = buffer.slice(0, cut.index)
        buffer = buffer.slice(cut.index + cut[0].length)
        await flush(block)
      }
    }
    if (buffer.trim()) await flush(buffer)
  } finally { await reader.cancel().catch(() => undefined) }
}

/** Gemini models that think and can return thought summaries. */
const THINKING_GEMINI = /^gemini-(?:2\.5|[3-9])/
const refuseStatus = async (response: Response) => {
  await response.body?.cancel()
  throw new AgentModelError({ reason: response.status === 429 ? "RATE_LIMITED" : response.status === 401 || response.status === 403 ? "UNCONFIGURED" : "UNAVAILABLE", httpStatus: response.status })
}

/**
 * Gemini resolves a JSON Schema reference it finds inside a function response
 * and refuses the whole request when the target is not one of its own parts.
 * Tool evidence can hold such schemas (a research capability's inputs, a
 * tool's own input schema), so any object that carries a `$`-prefixed key is
 * sent as its JSON text. Function calls and plain text are left alone.
 */
const schemaAsText = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(schemaAsText)
  if (value === null || typeof value !== "object") return value
  const entries = Object.entries(value)
  return entries.some(([key]) => key.startsWith("$")) ? JSON.stringify(value) : Object.fromEntries(entries.map(([key, v]) => [key, schemaAsText(v)]))
}
export const geminiContents = (contents: ReadonlyArray<ModelContent>): ReadonlyArray<ModelContent> => contents.map(content => ({ ...content, parts: content.parts.map(part => {
  const response = (part as { functionResponse?: { name: string; response: unknown } } | null)?.functionResponse
  return response ? { ...(part as object), functionResponse: { ...response, response: schemaAsText(response.response) } } : part
}) }))

export const configuredAgentModel = Effect.gen(function*() {
  const consent = yield* Config.boolean("AGENT_EXTERNAL_PROCESSING_ENABLED").pipe(Config.withDefault(false))
  const model = yield* Config.option(Config.string("AGENT_MODEL"))
  const key = yield* Config.option(Config.redacted("AGENT_API_KEY"))
  if (!consent || Option.isNone(model) || Option.isNone(key) || !Redacted.value(key.value).trim()) {
    return yield* Effect.fail(new AgentModelError({ reason: "UNCONFIGURED" }))
  }
  const cfg = yield* agentSettings.pipe(Effect.mapError(() => new AgentModelError({ reason: "UNCONFIGURED" })))
  if (cfg.provider === "gemini" && !/^[a-z0-9][a-z0-9.-]{0,99}$/.test(cfg.model)) return yield* Effect.fail(new AgentModelError({ reason: "UNCONFIGURED" }))
  const base = cfg.provider === "cliproxy" ? agentBaseUrl(cfg.baseUrl) : null
  if (cfg.provider === "cliproxy" && !base) return yield* Effect.fail(new AgentModelError({ reason: "UNCONFIGURED" }))
  const gemini = async (input: ModelInput, signal: AbortSignal): Promise<ModelResponse> => {
    // Streamed, so the reasoning and the answer can be shown while they are written.
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cfg.model)}:streamGenerateContent?alt=sse`, {
      method: "POST", signal, redirect: "error",
      headers: { "content-type": "application/json", "x-goog-api-key": Redacted.value(cfg.apiKey) },
      body: JSON.stringify({ contents: geminiContents(input.contents), systemInstruction: { parts: [{ text: input.system }] },
        ...(input.tools.length ? { tools: [{ functionDeclarations: input.tools }] } : {}),
        // Thinking models return a summary of the reasoning they already do; it adds no thinking.
        generationConfig: { maxOutputTokens: cfg.maxOutputTokens, ...(THINKING_GEMINI.test(cfg.model) ? { thinkingConfig: { includeThoughts: true } } : {}) } }),
    })
    if (!response.ok) return refuseStatus(response)
    let raw: unknown
    if (/text\/event-stream/i.test(response.headers.get("content-type") ?? "")) {
      const fold = geminiStreamFold()
      let thought = "", text = ""
      // A display callback that fails never fails the step.
      const show = (callback: ModelInput["onThought"], value: string) => callback ? Effect.runPromise(Effect.ignore(callback(value)), { signal }).catch(() => undefined) : Promise.resolve()
      await readEvents(response, async data => {
        let chunk: unknown
        try { chunk = JSON.parse(data) } catch { throw new AgentModelError({ reason: "MALFORMED", detail: "INVALID_JSON" }) }
        fold.push(chunk)
        const nextThought = fold.thought(), nextText = fold.text()
        if (nextThought !== thought) { thought = nextThought; await show(input.onThought, thought) }
        if (nextText !== text) { text = nextText; await show(input.onText, text) }
      })
      raw = fold.response()
    } else raw = await readJson(response)
    const finish = typeof raw === "object" && raw !== null && "candidates" in raw && Array.isArray(raw.candidates) && typeof raw.candidates[0] === "object" && raw.candidates[0] !== null && "finishReason" in raw.candidates[0] ? raw.candidates[0].finishReason : null
    const parsed = Schema.decodeUnknownEither(Response)(raw)
    // An answer that ran into the output limit is still an answer: the loop
    // keeps the text and says it stopped early. Only a cut-off with nothing
    // usable (no text, or a half-written tool call) fails the step.
    if (finish === "MAX_TOKENS") {
      const parts = parsed._tag === "Right" ? parsed.right.candidates[0]?.content.parts ?? [] : []
      if (!parts.some(p => !p.thought && p.text?.trim()) || parts.some(p => p.functionCall)) throw new AgentModelError({ reason: "MALFORMED", detail: "OUTPUT_LIMIT" })
      return parsed._tag === "Right" ? parsed.right : (() => { throw new AgentModelError({ reason: "MALFORMED", detail: "OUTPUT_LIMIT" }) })()
    }
    if (parsed._tag === "Left") throw new AgentModelError({ reason: "MALFORMED", detail: "INVALID_RESPONSE" })
    if (parsed.right.candidates[0]?.finishReason !== "STOP") throw new AgentModelError({ reason: "MALFORMED", detail: "PROVIDER_STOPPED" })
    return parsed.right
  }
  // CLIProxyAPI answers in the OpenAI chat format with native tool calls.
  const cliproxy = async (input: ModelInput, signal: AbortSignal): Promise<ModelResponse> => {
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: "POST", signal, redirect: "error",
      headers: { "content-type": "application/json", authorization: `Bearer ${Redacted.value(cfg.apiKey)}` },
      body: JSON.stringify(chatCompletionRequest(input, cfg.model, { maxTokens: cfg.maxOutputTokens })),
    })
    if (!response.ok) return refuseStatus(response)
    const answer = chatCompletionAnswer(await readJson(response, 1000000))
    if (answer.kind === "malformed") throw new AgentModelError({ reason: "MALFORMED", detail: "INVALID_RESPONSE" })
    const thought = answer.thought ? [{ text: answer.thought.slice(-8000), thought: true }] : []
    const parts = [...thought, ...(answer.kind === "text" ? [{ text: answer.text.slice(0, 20000) }] : answer.calls.map(c => ({ functionCall: { name: c.name, args: c.args } })))]
    const u = answer.usage
    return { candidates: [{ content: { role: "model", parts }, finishReason: "STOP" }], ...(u.model ? { modelVersion: u.model } : {}),
      usageMetadata: { ...(u.promptTokens !== null ? { promptTokenCount: u.promptTokens } : {}), ...(u.outputTokens !== null ? { candidatesTokenCount: u.outputTokens } : {}),
        ...(u.thoughtTokens !== null ? { thoughtsTokenCount: u.thoughtTokens } : {}), ...(u.totalTokens !== null ? { totalTokenCount: u.totalTokens } : {}),
        ...(u.cachedTokens !== null ? { cachedContentTokenCount: u.cachedTokens } : {}) } }
  }
  const invoke: AgentModel = input => Effect.tryPromise({
    try: signal => cfg.provider === "cliproxy" ? cliproxy(input, signal) : gemini(input, signal),
    catch: error => error instanceof AgentModelError ? error : new AgentModelError({ reason: "UNAVAILABLE" }),
  }).pipe(Effect.timeoutFail({ duration: cfg.timeoutMs, onTimeout: () => new AgentModelError({ reason: "TIMEOUT" }) }))
  return { invoke, provider: cfg.provider, requestedModel: cfg.model }
}).pipe(Effect.mapError(() => new AgentModelError({ reason: "UNCONFIGURED" })))
