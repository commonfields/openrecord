// Cursor through Cursor's official TypeScript SDK (@cursor/sdk), signed in
// with the person's own Cursor account (`Cursor.auth.login()`, a browser
// sign-in that stores a user key in ~/.cursor/sdk/auth.json), or with
// CURSOR_API_KEY when that is set.
//
// Discovery asks the SDK for the account's sign-in and real model catalog
// (Composer and the other models the plan includes). A run is one warm local
// SDK agent per turn, like Claude Code's: OpenRecord's instructions and tool
// declarations are the system prompt, the conversation is the first message,
// and later steps send only what is new (see sessions.ts).
//
// The lockdown matches the other providers: no built-in tools, no MCP
// servers, no project or user rules, and an empty in-memory file tree, so
// nothing on this computer is read, written or run. The model only answers
// with JSON matching the answer schema; OpenRecord's server runs the
// application tools it asks for.
import type { SDKAgent, SDKMessage } from "@cursor/sdk"
import type { HarnessModel } from "@openrecord/contracts"
import { BridgeFailure, failureReason } from "./process.js"
import type { WarmProcess } from "./sessions.js"

// Loaded only when Cursor is used: the downloadable single-file bridge leaves
// the SDK out (it ships native helpers), and reports Cursor as not installed.
let loaded: Promise<typeof import("@cursor/sdk")> | null = null
export const cursorSdk = () => (loaded ??= import("@cursor/sdk"))

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/

/** The account's models as `Cursor.models.list()` returns them. */
export function cursorModels(rows: unknown): HarnessModel[] {
  if (!Array.isArray(rows)) return []
  const seen = new Set<string>()
  return rows.flatMap(row => {
    const m = (row ?? {}) as { id?: unknown; displayName?: unknown }
    if (typeof m.id !== "string" || !MODEL_ID.test(m.id) || seen.has(m.id)) return []
    seen.add(m.id)
    return [{ id: m.id, name: (typeof m.displayName === "string" && m.displayName.trim() ? m.displayName : m.id).slice(0, 200) }]
  })
}

/** The SDK's version, as the installed package reports it. */
export const CURSOR_SDK_VERSION = "1.4.0"

export type CursorCatalog =
  | { readonly signedIn: false }
  | { readonly signedIn: true; readonly accountLabel: string | null; readonly models: HarnessModel[] }

/** Sign-in and the account's models; no agent is started and no prompt is sent. */
export async function cursorCatalog(signal: AbortSignal): Promise<CursorCatalog> {
  const bounded = <A>(work: Promise<A>) => new Promise<A>((resolve, reject) => {
    if (signal.aborted) return reject(new BridgeFailure("TIMEOUT"))
    const stop = () => reject(new BridgeFailure("TIMEOUT"))
    signal.addEventListener("abort", stop, { once: true })
    work.then(v => { signal.removeEventListener("abort", stop); resolve(v) }, e => { signal.removeEventListener("abort", stop); reject(e) })
  })
  const { Cursor } = await cursorSdk()
  const keyed = typeof process.env["CURSOR_API_KEY"] === "string" && process.env["CURSOR_API_KEY"] !== ""
  const status = keyed ? null : await bounded(Cursor.auth.status())
  if (status && status.status !== "logged-in") return { signedIn: false }
  const [models, me] = await Promise.all([bounded(Cursor.models.list()), bounded(Cursor.me()).catch(() => null)])
  const label = status?.status === "logged-in" && status.email ? status.email : me?.apiKeyName ?? null
  return { signedIn: true, accountLabel: label, models: cursorModels(models) }
}

const stepFailure = (signal: AbortSignal) => new BridgeFailure(signal.reason?.name === "TimeoutError" ? "TIMEOUT" : "CANCELLED")
const MAX_STEP_OUTPUT = 512000

/** One warm Cursor agent for a turn. `system` is fixed for the agent; each step is one message. */
export async function cursorSdkProcess(opts: {
  cwd: string; model: string; system: string; startSignal: AbortSignal; onClose: () => void
}): Promise<WarmProcess> {
  opts.startSignal.throwIfAborted()
  let agent: SDKAgent
  try {
    const { Agent, emptyFs } = await cursorSdk()
    agent = await Agent.create({
      model: { id: opts.model },
      systemPrompt: opts.system,
      tools: [],
      mcpServers: {},
      local: { cwd: opts.cwd, fs: emptyFs(), reportedWorkspacePath: "/", settingSources: [] },
    })
  } catch (error) {
    opts.onClose()
    throw new BridgeFailure(failureReason(String(error)))
  }
  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    try { agent.close() } catch { /* Already closed. */ }
    opts.onClose()
  }
  return {
    close,
    step: async (text, signal, onThought) => {
      if (closed) throw new BridgeFailure("UNAVAILABLE")
      if (signal.aborted) throw stepFailure(signal)
      let stopped: BridgeFailure | null = null
      let run: Awaited<ReturnType<SDKAgent["send"]>> | null = null
      const onAbort = () => { stopped = stepFailure(signal); void run?.cancel().catch(() => undefined); close() }
      signal.addEventListener("abort", onAbort, { once: true })
      let thought = "", answer = "", bytes = 0
      try {
        run = await agent.send(text)
        for await (const m of run.stream() as AsyncIterable<SDKMessage>) {
          if (stopped) throw stopped
          bytes += JSON.stringify(m).length
          if (bytes > MAX_STEP_OUTPUT) throw new BridgeFailure("MALFORMED")
          if (m.type === "thinking" && m.text) {
            thought += m.text
            onThought?.(thought.trim().slice(-8000))
          } else if (m.type === "assistant") {
            for (const c of m.message.content) if (c.type === "text") answer += c.text
          }
        }
        if (stopped) throw stopped
        const result = await run.wait()
        if (result.status !== "finished") throw new BridgeFailure(failureReason(JSON.stringify(result.error ?? result.status)))
        return result.result ?? answer
      } catch (error) {
        close()
        throw stopped ?? (error instanceof BridgeFailure ? error : new BridgeFailure(failureReason(String(error))))
      } finally {
        signal.removeEventListener("abort", onAbort)
      }
    },
  }
}
