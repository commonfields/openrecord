// OpenAI-compatible chat completions, as served by CLIProxyAPI (and any other
// OpenAI-compatible gateway). OpenRecord's run loop keeps its transcript in the
// Gemini shape: text parts, functionCall parts from the model and
// functionResponse parts from the server. This module converts that transcript
// to chat messages with native tool calling, and a chat completion back to a
// text answer or a bounded list of requested tool calls.
//
// The transcript carries no call IDs, so they are derived from position: the
// k-th function call in model content i is `call_i_k`, and the server's
// functionResponse parts that follow answer those calls in the same order.
import { Schema } from "effect"

export interface ChatTranscriptInput {
  readonly system: string
  readonly contents: ReadonlyArray<{ readonly role: "user" | "model"; readonly parts: ReadonlyArray<unknown> }>
  readonly tools: ReadonlyArray<unknown>
}
type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> }
  | { role: "tool"; tool_call_id: string; content: string }

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null

/** OpenAI tool definitions from OpenRecord tool declarations (`parametersJsonSchema`). */
export const chatTools = (tools: ReadonlyArray<unknown>) => tools.flatMap(tool => {
  const t = record(tool)
  if (!t || typeof t["name"] !== "string") return []
  return [{ type: "function" as const, function: { name: t["name"], description: typeof t["description"] === "string" ? t["description"] : "",
    parameters: record(t["parametersJsonSchema"]) ?? record(t["parameters"]) ?? { type: "object", properties: {} } } }]
})

/** Chat messages for a transcript. Thought parts are never sent back. */
export const chatMessages = (input: ChatTranscriptInput): ChatMessage[] => {
  const messages: ChatMessage[] = [{ role: "system", content: input.system }]
  let pending: string[] = []
  input.contents.forEach((content, index) => {
    const parts = content.parts.map(record).filter((p): p is Record<string, unknown> => p !== null && p["thought"] !== true)
    if (content.role === "model") {
      const calls = parts.flatMap(p => record(p["functionCall"]) ? [record(p["functionCall"])!] : [])
      const text = parts.map(p => typeof p["text"] === "string" ? p["text"] : "").join("")
      pending = calls.map((_, k) => `call_${index}_${k}`)
      messages.push(calls.length
        ? { role: "assistant", content: text || null, tool_calls: calls.map((call, k) => ({ id: pending[k]!, type: "function" as const,
            function: { name: String(call["name"] ?? ""), arguments: JSON.stringify(call["args"] ?? {}) } })) }
        : { role: "assistant", content: text })
      return
    }
    const texts: string[] = []
    let answered = 0
    for (const part of parts) {
      const response = record(part["functionResponse"])
      if (response) {
        const id = pending[answered++]
        // A response with no matching call is shown as text rather than dropped.
        if (id) messages.push({ role: "tool", tool_call_id: id, content: JSON.stringify(response["response"] ?? null) })
        else texts.push(JSON.stringify(response))
      } else if (typeof part["text"] === "string") texts.push(part["text"])
    }
    pending = []
    if (texts.length) messages.push({ role: "user", content: texts.join("\n\n") })
  })
  return messages
}

export const chatCompletionRequest = (input: ChatTranscriptInput, model: string, options: { readonly maxTokens?: number; readonly reasoningEffort?: string } = {}) => {
  const tools = chatTools(input.tools)
  return {
    model, stream: false, messages: chatMessages(input),
    ...(tools.length ? { tools, tool_choice: "auto" as const } : {}),
    ...(options.maxTokens ? { max_tokens: options.maxTokens } : {}),
    ...(options.reasoningEffort ? { reasoning_effort: options.reasoningEffort } : {}),
  }
}

const ToolCall = Schema.Struct({ type: Schema.optional(Schema.String), function: Schema.Struct({ name: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(100)), arguments: Schema.String }) })
const Completion = Schema.Struct({
  model: Schema.optional(Schema.String),
  choices: Schema.Array(Schema.Struct({
    message: Schema.Struct({ content: Schema.optional(Schema.NullOr(Schema.String)), reasoning_content: Schema.optional(Schema.NullOr(Schema.String)),
      tool_calls: Schema.optional(Schema.NullOr(Schema.Array(ToolCall))) }),
    finish_reason: Schema.optional(Schema.NullOr(Schema.String)),
  })).pipe(Schema.minItems(1)),
  usage: Schema.optional(Schema.NullOr(Schema.Struct({
    prompt_tokens: Schema.optional(Schema.Number), completion_tokens: Schema.optional(Schema.Number), total_tokens: Schema.optional(Schema.Number),
    completion_tokens_details: Schema.optional(Schema.NullOr(Schema.Struct({ reasoning_tokens: Schema.optional(Schema.Number) }))),
  }))),
})
export interface ChatUsage { readonly model: string | null; readonly promptTokens: number | null; readonly outputTokens: number | null; readonly thoughtTokens: number | null; readonly totalTokens: number | null }
/** `thought` is the model's reasoning (`reasoning_content`) when the endpoint returns it. */
export type ChatAnswer =
  | { readonly kind: "text"; readonly text: string; readonly usage: ChatUsage; readonly thought?: string }
  | { readonly kind: "tools"; readonly calls: ReadonlyArray<{ readonly name: string; readonly args: Record<string, unknown> }>; readonly usage: ChatUsage; readonly thought?: string }
  | { readonly kind: "malformed" }
const MAX_THOUGHT = 8000

/** A completion's answer: requested tool calls (at most `maxCalls`) or the reply text. */
export const chatCompletionAnswer = (raw: unknown, maxCalls = 6): ChatAnswer => {
  const parsed = Schema.decodeUnknownEither(Completion)(raw)
  if (parsed._tag === "Left") return { kind: "malformed" }
  const choice = parsed.right.choices[0]!
  const u = parsed.right.usage
  const usage: ChatUsage = { model: parsed.right.model ?? null, promptTokens: u?.prompt_tokens ?? null, outputTokens: u?.completion_tokens ?? null,
    thoughtTokens: u?.completion_tokens_details?.reasoning_tokens ?? null, totalTokens: u?.total_tokens ?? null }
  const reasoning = (choice.message.reasoning_content ?? "").trim()
  const thought = reasoning ? { thought: reasoning.length > MAX_THOUGHT ? reasoning.slice(-MAX_THOUGHT) : reasoning } : {}
  const calls = choice.message.tool_calls ?? []
  if (calls.length) {
    if (calls.length > maxCalls) return { kind: "malformed" }
    const decoded: Array<{ name: string; args: Record<string, unknown> }> = []
    for (const call of calls) {
      let args: unknown
      try { args = call.function.arguments.trim() ? JSON.parse(call.function.arguments) : {} } catch { return { kind: "malformed" } }
      const object = record(args)
      if (!object) return { kind: "malformed" }
      decoded.push({ name: call.function.name, args: object })
    }
    return { kind: "tools", calls: decoded, usage, ...thought }
  }
  // A reply cut off by the token limit is not a complete answer.
  if (choice.finish_reason === "length") return { kind: "malformed" }
  const text = (choice.message.content ?? "").trim()
  return text ? { kind: "text", text, usage, ...thought } : { kind: "malformed" }
}

/** Model IDs from `GET /v1/models`. */
const ModelList = Schema.Struct({ data: Schema.Array(Schema.Struct({ id: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(200)), owned_by: Schema.optional(Schema.String) })) })
export const chatModelIds = (raw: unknown): ReadonlyArray<{ readonly id: string; readonly ownedBy: string | null }> | null => {
  const parsed = Schema.decodeUnknownEither(ModelList)(raw)
  return parsed._tag === "Left" ? null : parsed.right.data.map(m => ({ id: m.id, ownedBy: m.owned_by ?? null }))
}

/** Folds `stream: true` chunks (SSE `data:` payloads) into one completion that
 * chatCompletionAnswer reads. Reasoning is readable at any point while it streams. */
export const chatStream = () => {
  let content = "", reasoning = "", model: string | undefined, finish: string | null = null, usage: unknown = undefined
  const calls: Array<{ name: string; arguments: string }> = []
  return {
    push(chunk: unknown) {
      const c = record(chunk)
      if (!c) return
      if (typeof c["model"] === "string") model = c["model"]
      if (record(c["usage"])) usage = c["usage"]
      const choices = Array.isArray(c["choices"]) ? c["choices"] : []
      const choice = record(choices[0])
      if (!choice) return
      if (typeof choice["finish_reason"] === "string") finish = choice["finish_reason"]
      const delta = record(choice["delta"])
      if (!delta) return
      if (typeof delta["content"] === "string") content += delta["content"]
      if (typeof delta["reasoning_content"] === "string") reasoning += delta["reasoning_content"]
      for (const raw of Array.isArray(delta["tool_calls"]) ? delta["tool_calls"] : []) {
        const call = record(raw)
        if (!call) continue
        const index = typeof call["index"] === "number" ? call["index"] : calls.length
        const fn = record(call["function"]) ?? {}
        const slot = calls[index] ??= { name: "", arguments: "" }
        if (typeof fn["name"] === "string") slot.name += fn["name"]
        if (typeof fn["arguments"] === "string") slot.arguments += fn["arguments"]
      }
    },
    /** The reasoning so far, trimmed to its latest part. */
    thought: () => reasoning.trim().slice(-MAX_THOUGHT),
    completion: () => ({ ...(model ? { model } : {}), ...(usage ? { usage } : {}), choices: [{ finish_reason: finish,
      message: { content: content || null, reasoning_content: reasoning || null,
        tool_calls: calls.length ? calls.map(call => ({ type: "function", function: call })) : null } }] }),
  }
}
