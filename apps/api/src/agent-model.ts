import { Config, Data, Effect, Option, Redacted, Schema } from "effect"
import { chatCompletionAnswer, chatCompletionRequest } from "@openrecord/contracts"

export class AgentModelError extends Data.TaggedError("AgentModelError")<{
  readonly reason: "UNCONFIGURED" | "TIMEOUT" | "RATE_LIMITED" | "UNAVAILABLE" | "MALFORMED" | "CONTEXT_LIMIT" | "TOOL_LIMIT" | "CANCELLED"
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
  maxOutputTokens: bounded("AGENT_MAX_OUTPUT_TOKENS", 2048, 8192),
  timeoutMs: bounded("AGENT_TIMEOUT_MS", 20000, 120000),
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
  })),
})
export type ModelContent = { readonly role: "user" | "model"; readonly parts: ReadonlyArray<unknown> }
export type ModelResponse = typeof Response.Type
export type ModelInput = { readonly contents: ReadonlyArray<ModelContent>; readonly tools: ReadonlyArray<unknown>; readonly system: string }
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
      if (size > max) throw new AgentModelError({ reason: "MALFORMED" })
      chunks.push(next.value)
    }
  } finally { await reader.cancel() }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) } catch { throw new AgentModelError({ reason: "MALFORMED" }) }
}
const refuseStatus = async (response: Response) => {
  await response.body?.cancel()
  throw new AgentModelError({ reason: response.status === 429 ? "RATE_LIMITED" : "UNAVAILABLE" })
}

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
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cfg.model)}:generateContent`, {
      method: "POST", signal, redirect: "error",
      headers: { "content-type": "application/json", "x-goog-api-key": Redacted.value(cfg.apiKey) },
      body: JSON.stringify({ contents: input.contents, systemInstruction: { parts: [{ text: input.system }] },
        ...(input.tools.length ? { tools: [{ functionDeclarations: input.tools }] } : {}), generationConfig: { maxOutputTokens: cfg.maxOutputTokens } }),
    })
    if (!response.ok) return refuseStatus(response)
    const parsed = Schema.decodeUnknownEither(Response)(await readJson(response))
    if (parsed._tag === "Left" || parsed.right.candidates[0]?.finishReason !== "STOP") throw new AgentModelError({ reason: "MALFORMED" })
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
    if (answer.kind === "malformed") throw new AgentModelError({ reason: "MALFORMED" })
    const parts = answer.kind === "text" ? [{ text: answer.text.slice(0, 20000) }] : answer.calls.map(c => ({ functionCall: { name: c.name, args: c.args } }))
    const u = answer.usage
    return { candidates: [{ content: { role: "model", parts }, finishReason: "STOP" }], ...(u.model ? { modelVersion: u.model } : {}),
      usageMetadata: { ...(u.promptTokens !== null ? { promptTokenCount: u.promptTokens } : {}), ...(u.outputTokens !== null ? { candidatesTokenCount: u.outputTokens } : {}),
        ...(u.thoughtTokens !== null ? { thoughtsTokenCount: u.thoughtTokens } : {}), ...(u.totalTokens !== null ? { totalTokenCount: u.totalTokens } : {}) } }
  }
  const invoke: AgentModel = input => Effect.tryPromise({
    try: signal => cfg.provider === "cliproxy" ? cliproxy(input, signal) : gemini(input, signal),
    catch: error => error instanceof AgentModelError ? error : new AgentModelError({ reason: "UNAVAILABLE" }),
  }).pipe(Effect.timeoutFail({ duration: cfg.timeoutMs, onTimeout: () => new AgentModelError({ reason: "TIMEOUT" }) }))
  return { invoke, provider: cfg.provider, requestedModel: cfg.model }
}).pipe(Effect.mapError(() => new AgentModelError({ reason: "UNCONFIGURED" })))
