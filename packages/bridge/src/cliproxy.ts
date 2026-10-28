// CLIProxyAPI driver. CLIProxyAPI is a local proxy that serves the user's own
// CLI subscriptions (Claude Code, Codex, Gemini CLI and others) as an
// OpenAI-compatible API. Unlike the CLI drivers, which are prompted to answer
// in a JSON envelope, this driver uses the endpoint's native tool calling.
//
// The proxy's client key stays on this computer: it is read from an
// environment variable or the private bridge configuration file. Plain HTTP
// is accepted only for a loopback address.
import { Schema } from "effect"
import { HARNESS_NAMES, chatCompletionAnswer, chatCompletionRequest, chatModelIds, chatStream, type HarnessAnswer, type HarnessJob, type HarnessReport } from "@openrecord/contracts"
import { BridgeFailure } from "./process.js"

export const CLIPROXY_DEFAULT_URL = "http://127.0.0.1:8317"
export const CLIPROXY_DEFAULT_KEY_ENV = "CLIPROXY_API_KEY"
const MAX_RESPONSE_BYTES = 1_000_000
const MAX_MODELS = 500

export interface CliProxyInstance {
  readonly id: string
  readonly name: string
  readonly baseUrl?: string | undefined
  readonly apiKeyEnv?: string | undefined
  readonly apiKey?: string | undefined
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"])
/** The proxy origin, or a setup error for anything but loopback HTTP or HTTPS. */
export function cliProxyOrigin(raw: string | undefined): URL {
  let url: URL
  try { url = new URL(raw ?? CLIPROXY_DEFAULT_URL) } catch { throw new BridgeFailure("UNAVAILABLE") }
  if (url.username || url.password || url.search || url.hash) throw new BridgeFailure("UNAVAILABLE")
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) throw new BridgeFailure("UNAVAILABLE")
  url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/v1$/, "")
  return url
}
const endpoint = (instance: CliProxyInstance, path: string) => {
  const origin = cliProxyOrigin(instance.baseUrl)
  return new URL(`${origin.pathname.replace(/\/+$/, "")}${path}`, origin.origin)
}
const key = (instance: CliProxyInstance, env: NodeJS.ProcessEnv) => instance.apiKey ?? env[instance.apiKeyEnv ?? CLIPROXY_DEFAULT_KEY_ENV] ?? ""

async function readBounded(response: Response): Promise<unknown> {
  const reader = response.body?.getReader()
  if (!reader) throw new BridgeFailure("MALFORMED")
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > MAX_RESPONSE_BYTES) throw new BridgeFailure("MALFORMED")
      chunks.push(next.value)
    }
  } finally { await reader.cancel().catch(() => {}) }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) } catch { throw new BridgeFailure("MALFORMED") }
}
const statusFailure = (status: number) =>
  new BridgeFailure(status === 429 ? "RATE_LIMITED" : status === 401 || status === 403 ? "UNAUTHENTICATED" : "UNAVAILABLE")

async function call(instance: CliProxyInstance, env: NodeJS.ProcessEnv, path: string, signal: AbortSignal, body?: unknown) {
  const secret = key(instance, env)
  let response: Response
  try {
    response = await fetch(endpoint(instance, path), {
      method: body === undefined ? "GET" : "POST", redirect: "error", signal,
      headers: { accept: "application/json", ...(secret ? { authorization: `Bearer ${secret}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  } catch (e) {
    if (e instanceof BridgeFailure) throw e
    throw new BridgeFailure(signal.aborted ? "TIMEOUT" : "UNAVAILABLE")
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    throw statusFailure(response.status)
  }
  return readBounded(response)
}

export async function probeCliProxy(instance: CliProxyInstance, env: NodeJS.ProcessEnv = process.env): Promise<HarnessReport> {
  const base: HarnessReport = { localId: instance.id, driver: "cliproxy", name: instance.name || HARNESS_NAMES.cliproxy,
    installed: false, version: null, auth: "unknown", state: "unavailable", models: [] }
  let origin: URL
  try { origin = cliProxyOrigin(instance.baseUrl) } catch { return { ...base, state: "error" } }
  const label = `${origin.host}${origin.pathname === "/" ? "" : origin.pathname}`.slice(0, 200)
  try {
    const ids = chatModelIds(await call(instance, env, "/v1/models", AbortSignal.timeout(10000)))
    if (!ids) return { ...base, installed: true, accountLabel: label, state: "error" }
    const models = [...new Map(ids.map(m => [m.id, m])).values()].slice(0, MAX_MODELS).map(m => ({ id: m.id, name: m.id }))
    return { ...base, installed: true, accountLabel: label, auth: key(instance, env) ? "authenticated" : "unknown",
      state: models.length ? "ready" : "unavailable", models, ...(ids.length > MAX_MODELS ? { modelsTruncated: true } : {}) }
  } catch (e) {
    const reason = e instanceof BridgeFailure ? e.reason : "UNAVAILABLE"
    if (reason === "UNAUTHENTICATED") return { ...base, installed: true, accountLabel: label, auth: "unauthenticated" }
    if (reason === "RATE_LIMITED") return { ...base, installed: true, accountLabel: label, state: "usage_limited" }
    // Not running, or not reachable: shown as not installed so Settings says how to start it.
    return base
  }
}

const AnswerText = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(16000))
const MAX_STREAM_BYTES = 2_000_000

/** Reads an SSE stream of chat chunks, reporting the reasoning as it grows. */
async function readStream(response: Response, onThought: ((thought: string) => void) | undefined) {
  const reader = response.body?.getReader()
  if (!reader) throw new BridgeFailure("MALFORMED")
  const stream = chatStream()
  const decoder = new TextDecoder()
  let buffer = "", size = 0, last = ""
  const line = (raw: string) => {
    const data = raw.startsWith("data:") ? raw.slice(5).trim() : null
    if (!data || data === "[DONE]") return
    try { stream.push(JSON.parse(data)) } catch { throw new BridgeFailure("MALFORMED") }
    const thought = stream.thought()
    if (onThought && thought && thought !== last) { last = thought; onThought(thought) }
  }
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > MAX_STREAM_BYTES) throw new BridgeFailure("MALFORMED")
      buffer += decoder.decode(next.value, { stream: true })
      let cut: number
      while ((cut = buffer.indexOf("\n")) >= 0) { line(buffer.slice(0, cut).replace(/\r$/, "")); buffer = buffer.slice(cut + 1) }
    }
    if (buffer.trim()) line(buffer.trim())
  } finally { await reader.cancel().catch(() => {}) }
  return stream.completion()
}

export async function executeCliProxy(instance: CliProxyInstance, job: HarnessJob, signal: AbortSignal, env: NodeJS.ProcessEnv = process.env,
  onThought?: (thought: string) => void): Promise<HarnessAnswer> {
  if (job.input.reasoningEffort) throw new BridgeFailure("UNAVAILABLE")
  const secret = key(instance, env)
  let response: Response
  try {
    // Streamed so the model's reasoning reaches the chat while it works.
    response = await fetch(endpoint(instance, "/v1/chat/completions"), {
      method: "POST", redirect: "error", signal,
      headers: { accept: "text/event-stream, application/json", "content-type": "application/json", ...(secret ? { authorization: `Bearer ${secret}` } : {}) },
      body: JSON.stringify({ ...chatCompletionRequest(job.input, job.model), stream: true, stream_options: { include_usage: true } }),
    })
  } catch (e) {
    if (e instanceof BridgeFailure) throw e
    throw new BridgeFailure(signal.aborted ? "TIMEOUT" : "UNAVAILABLE")
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    throw statusFailure(response.status)
  }
  const raw = (response.headers.get("content-type") ?? "").includes("text/event-stream") ? await readStream(response, onThought) : await readBounded(response)
  const answer = chatCompletionAnswer(raw)
  if (answer.kind === "malformed") throw new BridgeFailure("MALFORMED")
  const thought = answer.thought ? { thought: answer.thought } : {}
  if (answer.kind === "tools") return { kind: "tools", calls: answer.calls.map(c => ({ name: c.name, args: c.args })), ...thought }
  if (!Schema.is(AnswerText)(answer.text)) throw new BridgeFailure("MALFORMED")
  return { kind: "text", text: answer.text, ...thought }
}
