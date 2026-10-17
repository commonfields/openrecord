import { Config, Data, Effect, Option, Redacted, Schema } from "effect"

export class AgentModelError extends Data.TaggedError("AgentModelError")<{
  readonly reason: "UNCONFIGURED" | "TIMEOUT" | "RATE_LIMITED" | "UNAVAILABLE" | "MALFORMED" | "CONTEXT_LIMIT" | "TOOL_LIMIT"
}> {}

const bounded = (name: string, fallback: number, max: number) => Config.integer(name).pipe(
  Config.withDefault(fallback), Config.validate({ message: "invalid agent resource limit", validation: n => n > 0 && n <= max }),
)
export const agentSettings = Config.all({
  provider: Config.literal("gemini")("AGENT_PROVIDER").pipe(Config.withDefault("gemini" as const)),
  model: Config.string("AGENT_MODEL").pipe(Config.validate({ message: "invalid agent model", validation: m => /^[a-z0-9][a-z0-9.-]{0,99}$/.test(m) })),
  apiKey: Config.redacted("AGENT_API_KEY"),
  maxOutputTokens: bounded("AGENT_MAX_OUTPUT_TOKENS", 2048, 4096),
  timeoutMs: bounded("AGENT_TIMEOUT_MS", 20000, 30000),
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

export const configuredAgentModel = Effect.gen(function*() {
  const consent = yield* Config.boolean("AGENT_EXTERNAL_PROCESSING_ENABLED").pipe(Config.withDefault(false))
  const model = yield* Config.option(Config.string("AGENT_MODEL"))
  const key = yield* Config.option(Config.redacted("AGENT_API_KEY"))
  if (!consent || Option.isNone(model) || Option.isNone(key) || !Redacted.value(key.value).trim()) {
    return yield* Effect.fail(new AgentModelError({ reason: "UNCONFIGURED" }))
  }
  const cfg = yield* agentSettings.pipe(Effect.mapError(() => new AgentModelError({ reason: "UNCONFIGURED" })))
  const invoke: AgentModel = input => Effect.tryPromise({
    try: async signal => {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cfg.model)}:generateContent`, {
        method: "POST", signal, redirect: "error",
        headers: { "content-type": "application/json", "x-goog-api-key": Redacted.value(cfg.apiKey) },
        body: JSON.stringify({ contents: input.contents, systemInstruction: { parts: [{ text: input.system }] },
          tools: [{ functionDeclarations: input.tools }], generationConfig: { maxOutputTokens: cfg.maxOutputTokens } }),
      })
      if (!response.ok) {
        await response.body?.cancel()
        throw new AgentModelError({ reason: response.status === 429 ? "RATE_LIMITED" : "UNAVAILABLE" })
      }
      const reader = response.body?.getReader()
      if (!reader) throw new AgentModelError({ reason: "MALFORMED" })
      let size = 0
      const chunks: Uint8Array[] = []
      try {
        while (true) {
          const next = await reader.read()
          if (next.done) break
          size += next.value.byteLength
          if (size > 256000) throw new AgentModelError({ reason: "MALFORMED" })
          chunks.push(next.value)
        }
      } finally { await reader.cancel() }
      const bytes = new Uint8Array(size)
      let offset = 0
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
      const raw: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
      const parsed = Schema.decodeUnknownEither(Response)(raw)
      if (parsed._tag === "Left" || parsed.right.candidates[0]?.finishReason !== "STOP") throw new AgentModelError({ reason: "MALFORMED" })
      return parsed.right
    },
    catch: error => error instanceof AgentModelError ? error : new AgentModelError({ reason: "UNAVAILABLE" }),
  }).pipe(Effect.timeoutFail({ duration: cfg.timeoutMs, onTimeout: () => new AgentModelError({ reason: "TIMEOUT" }) }))
  return { invoke, provider: cfg.provider, requestedModel: cfg.model }
}).pipe(Effect.mapError(() => new AgentModelError({ reason: "UNCONFIGURED" })))
