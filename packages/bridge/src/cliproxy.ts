// CLIProxyAPI driver. CLIProxyAPI is a local proxy that serves the user's own
// CLI subscriptions (Claude Code, Codex, Gemini CLI and others) as an
// OpenAI-compatible API. Unlike the CLI drivers, which are prompted to answer
// in a JSON envelope, this driver uses the endpoint's native tool calling.
//
// The proxy's client key stays on this computer: it is read from an
// environment variable or the private bridge configuration file. Plain HTTP
// is accepted only for a loopback address.
import { accessSync, constants, readFileSync, statSync } from "node:fs"
import { startDetached } from "./process.js"
import { homedir } from "node:os"
import { delimiter, dirname, join } from "node:path"
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

/** Where CLIProxyAPI's config.yaml usually lives: CLIPROXY_CONFIG, its auth directory, Homebrew, or a home checkout. */
export const cliProxyConfigPaths = (env: NodeJS.ProcessEnv = process.env, home = homedir()) => [
  ...(env["CLIPROXY_CONFIG"] ? [env["CLIPROXY_CONFIG"]] : []),
  join(home, ".cli-proxy-api", "config.yaml"),
  "/opt/homebrew/etc/cliproxyapi.conf",
  "/usr/local/etc/cliproxyapi.conf",
  join(home, "CLIProxyAPI", "config.yaml"),
  join(home, "cliproxyapi", "config.yaml"),
]

/** The first client key in a CLIProxyAPI config: access.api-keys, or a top-level api-keys list from older versions. */
export function cliProxyConfigKey(yaml: string): string | null {
  const lines = yaml.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(/^(\s*)api-keys:\s*$/)
    if (!m) continue
    const indent = m[1]!.length
    // Only the client list: top level, or directly under a top-level "access:".
    const parent = indent === 0 ? "" : lines.slice(0, i).reverse().find(l => /^\S/.test(l)) ?? ""
    if (indent !== 0 && !/^access:\s*$/.test(parent)) continue
    for (const line of lines.slice(i + 1)) {
      if (!line.trim() || line.trim().startsWith("#")) continue
      const item = line.match(/^(\s*)-\s*["']?([^"'#\s]+)["']?\s*(#.*)?$/)
      if (!item || item[1]!.length < indent) break
      return item[2]!
    }
  }
  return null
}

const configuredKey = (env: NodeJS.ProcessEnv) => {
  for (const path of cliProxyConfigPaths(env)) {
    try {
      if (statSync(path).size > 1_000_000) continue
      const found = cliProxyConfigKey(readFileSync(path, "utf8"))
      if (found) return found
    } catch { /* not there */ }
  }
  return ""
}
// A key read from CLIProxyAPI's own config is only ever sent to this computer.
const key = (instance: CliProxyInstance, env: NodeJS.ProcessEnv) =>
  instance.apiKey ?? env[instance.apiKeyEnv ?? CLIPROXY_DEFAULT_KEY_ENV] ?? (LOOPBACK.has(cliProxyOrigin(instance.baseUrl).hostname) ? configuredKey(env) : "")

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

const CLIPROXY_BINARIES = ["cli-proxy-api", "cliproxyapi", "CLIProxyAPI"].flatMap(n => process.platform === "win32" ? [`${n}.exe`] : [n])
const executable = (path: string) => { try { accessSync(path, constants.X_OK); return statSync(path).isFile() } catch { return false } }
/** An installed CLIProxyAPI and the config it should run with, or null. */
export function findCliProxy(env: NodeJS.ProcessEnv = process.env, home = homedir()): { binary: string; config: string } | null {
  const config = cliProxyConfigPaths(env, home).find(p => { try { return statSync(p).isFile() } catch { return false } })
  if (!config) return null
  const dirs = [...(env["PATH"] ?? "").split(delimiter).filter(Boolean), dirname(config), join(home, "CLIProxyAPI"), join(home, "cliproxyapi")]
  for (const dir of dirs) for (const name of CLIPROXY_BINARIES) if (executable(join(dir, name))) return { binary: join(dir, name), config }
  return null
}

// Started at most once every five minutes per bridge, so a proxy that keeps
// exiting is not restarted in a loop.
let startedAt = 0
/**
 * Starts CLIProxyAPI in the background when it is installed on this computer
 * but not running, so the person's subscriptions are usable without keeping a
 * terminal open. It keeps running after the bridge stops.
 */
export async function startCliProxy(instance: CliProxyInstance, env: NodeJS.ProcessEnv = process.env, home = homedir()): Promise<boolean> {
  let origin: URL
  try { origin = cliProxyOrigin(instance.baseUrl) } catch { return false }
  if (!LOOPBACK.has(origin.hostname) || Date.now() - startedAt < 300_000) return false
  const found = findCliProxy(env, home)
  if (!found) return false
  startedAt = Date.now()
  if (!startDetached(found.binary, ["-config", found.config], { cwd: dirname(found.config), env })) return false
  // Wait for it to answer, up to ten seconds.
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 500))
    try { await fetch(endpoint(instance, "/v1/models"), { signal: AbortSignal.timeout(1000), redirect: "error" }); return true } catch { /* not yet */ }
  }
  return false
}
/** For tests: allow another start at once. */
export const resetCliProxyStart = () => { startedAt = 0 }

export async function probeCliProxy(instance: CliProxyInstance, env: NodeJS.ProcessEnv = process.env, home = homedir()): Promise<HarnessReport> {
  const first = await probeCliProxyOnce(instance, env)
  if (first.installed || !(await startCliProxy(instance, env, home))) return first
  return probeCliProxyOnce(instance, env)
}

async function probeCliProxyOnce(instance: CliProxyInstance, env: NodeJS.ProcessEnv): Promise<HarnessReport> {
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
