// Claude Code through Anthropic's official Claude Agent SDK, pointed at the
// person's own installed `claude` and signed-in subscription.
//
// Discovery asks the SDK for the account's real models (with the reasoning
// levels each accepts) and the signed-in plan, instead of three aliases. A
// run is one warm SDK session per turn: OpenRecord's instructions and tool
// declarations are the session's system prompt, the conversation is the first
// message, and later steps send only what is new (see sessions.ts).
//
// The lockdown is the same as before: no built-in tools, no MCP servers, no
// settings or hooks from the person's configuration, no slash commands, no
// saved session, and every tool permission request denied. The model only
// answers with JSON matching the answer schema; OpenRecord's server runs the
// application tools it asks for.
import { query, type Options, type Query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import { HarnessReasoningEffort, type HarnessModel } from "@openrecord/contracts"
import { Schema } from "effect"
import { BridgeFailure, failureReason } from "./process.js"
import type { WarmProcess } from "./sessions.js"

/** A queue of user messages the SDK reads as its streaming input. */
class Inbox implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = []
  private wake: (() => void) | null = null
  private closed = false
  push(text: string) {
    this.items.push({ type: "user", message: { role: "user", content: [{ type: "text", text }] }, parent_tool_use_id: null })
    this.wake?.()
  }
  close() { this.closed = true; this.wake?.() }
  async *[Symbol.asyncIterator]() {
    for (;;) {
      while (this.items.length) yield this.items.shift()!
      if (this.closed) return
      await new Promise<void>(resolve => { this.wake = resolve })
      this.wake = null
    }
  }
}

const lockdown = (cwd: string, binary: string, env: NodeJS.ProcessEnv, abortController: AbortController): Options => ({
  pathToClaudeCodeExecutable: binary,
  cwd,
  env: Object.fromEntries(Object.entries(env).filter((e): e is [string, string] => typeof e[1] === "string")),
  abortController,
  tools: [],
  settingSources: [],
  strictMcpConfig: true,
  mcpServers: {},
  persistSession: false,
  canUseTool: async () => ({ behavior: "deny", message: "No local tools are available." }),
  extraArgs: { "disable-slash-commands": null, settings: '{"disableAllHooks":true}' },
})

const ModelRow = Schema.Struct({
  value: Schema.String, displayName: Schema.String,
  supportedEffortLevels: Schema.optional(Schema.Array(Schema.String)),
})
/** The account's models as the SDK lists them, with the reasoning levels OpenRecord can pass on. */
export function claudeModels(rows: unknown): HarnessModel[] {
  const decoded = Schema.decodeUnknownEither(Schema.Array(ModelRow))(rows)
  if (decoded._tag === "Left") return []
  const seen = new Set<string>()
  return decoded.right.flatMap(m => {
    if (seen.has(m.value) || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(m.value)) return []
    seen.add(m.value)
    const efforts = [...new Set((m.supportedEffortLevels ?? []).filter(Schema.is(HarnessReasoningEffort)))].slice(0, 8)
    return [{ id: m.value, name: m.displayName.slice(0, 200), ...(efforts.length ? { reasoningEfforts: efforts } : {}) }]
  })
}

/** The account's real models and sign-in, from a short SDK session that sends no prompt. */
export async function claudeCatalog(binary: string, env: NodeJS.ProcessEnv, cwd: string, signal: AbortSignal): Promise<{ models: HarnessModel[]; accountLabel: string | null }> {
  const abort = new AbortController(), inbox = new Inbox()
  const stop = () => abort.abort()
  signal.addEventListener("abort", stop, { once: true })
  const q = query({ prompt: inbox, options: lockdown(cwd, binary, env, abort) })
  try {
    const [models, account] = await Promise.all([
      q.supportedModels(),
      q.accountInfo().catch(() => null),
    ])
    const a = (account ?? {}) as { email?: unknown; subscriptionType?: unknown }
    return { models: claudeModels(models), accountLabel: typeof a.email === "string" ? a.email : typeof a.subscriptionType === "string" ? a.subscriptionType : null }
  } finally {
    signal.removeEventListener("abort", stop)
    inbox.close()
    abort.abort()
  }
}

const stepFailure = (signal: AbortSignal) => new BridgeFailure(signal.reason?.name === "TimeoutError" ? "TIMEOUT" : "CANCELLED")
const MAX_STEP_OUTPUT = 512000

/** One warm Claude session for a turn. `system` is fixed for the session; each step is one user message. */
export async function claudeSdkProcess(opts: {
  binary: string; env: NodeJS.ProcessEnv; cwd: string; model: string; system: string; schema: unknown
  effort?: string | undefined; startSignal: AbortSignal; onClose: () => void
}): Promise<WarmProcess> {
  opts.startSignal.throwIfAborted()
  const abort = new AbortController(), inbox = new Inbox()
  const q: Query = query({ prompt: inbox, options: {
    ...lockdown(opts.cwd, opts.binary, opts.env, abort),
    model: opts.model,
    systemPrompt: opts.system,
    // Summarized reasoning streams to the chat as the model thinks.
    thinking: { type: "adaptive", display: "summarized" },
    ...(opts.effort ? { effort: opts.effort as NonNullable<Options["effort"]> } : {}),
    outputFormat: { type: "json_schema", schema: opts.schema as Record<string, unknown> },
  } })
  const messages = q[Symbol.asyncIterator]()
  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    inbox.close()
    abort.abort()
    opts.onClose()
  }
  return {
    close,
    step: async (text, signal, onThought) => {
      if (closed) throw new BridgeFailure("UNAVAILABLE")
      if (signal.aborted) throw stepFailure(signal)
      let stopped: BridgeFailure | null = null
      const onAbort = () => { stopped = stepFailure(signal); close() }
      signal.addEventListener("abort", onAbort, { once: true })
      let thought = "", bytes = 0
      try {
        inbox.push(text)
        for (;;) {
          let next: IteratorResult<SDKMessage>
          try { next = await messages.next() } catch (error) { throw stopped ?? new BridgeFailure(failureReason(String(error))) }
          if (stopped) throw stopped
          if (next.done) throw new BridgeFailure("UNAVAILABLE")
          const m = next.value
          bytes += JSON.stringify(m).length
          if (bytes > MAX_STEP_OUTPUT) throw new BridgeFailure("MALFORMED")
          if (m.type === "assistant") {
            const parts = (m.message.content as Array<{ type?: string; thinking?: unknown }>).flatMap(c => c.type === "thinking" && typeof c.thinking === "string" ? [c.thinking] : [])
            if (parts.length) { thought = [thought, ...parts].filter(Boolean).join("\n\n"); onThought?.(thought.trim().slice(-8000)) }
          } else if (m.type === "result") {
            if (m.subtype !== "success" || m.is_error) throw new BridgeFailure(failureReason(JSON.stringify(m)))
            const structured = (m as { structured_output?: unknown }).structured_output
            return structured !== undefined ? JSON.stringify(structured) : m.result
          }
        }
      } catch (error) {
        close()
        throw error instanceof BridgeFailure ? error : new BridgeFailure("UNAVAILABLE")
      } finally {
        signal.removeEventListener("abort", onAbort)
      }
    },
  }
}
