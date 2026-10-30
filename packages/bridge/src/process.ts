import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { createInterface } from "node:readline"
import { Schema } from "effect"
import type { HarnessDriver } from "@openrecord/contracts"

export class BridgeFailure extends Error {
  constructor(
    readonly reason: "UNAVAILABLE" | "UNAUTHENTICATED" | "MALFORMED" | "TIMEOUT" | "CANCELLED" | "RATE_LIMITED",
    readonly diagnostic?: {
      operation: string
      code?: number
      category?: "FREE_TIER_UNAVAILABLE" | "MODEL_UNAVAILABLE" | "PROVIDER_ERROR"
    }
  ) {
    super(reason)
  }
}
export function failureReason(output: string): BridgeFailure["reason"] {
  if (/rate[_ -]?limit|usage[_ -]?limit|quota[_ -]?(?:exceeded|exhausted)|insufficient[_ -]quota/i.test(output))
    return "RATE_LIMITED"
  if (/unauthenticated|authentication[_ -]?(?:required|failed)|not[_ -]logged[_ -]in/i.test(output))
    return "UNAUTHENTICATED"
  return "UNAVAILABLE"
}

// Keep unrelated deployment/provider secrets out of child environments.
export function driverEnvironment(driver: HarnessDriver, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const common = [
    "PATH",
    "HOME",
    // Claude Code finds its macOS Keychain sign-in by user name.
    "USER",
    "LOGNAME",
    "USERPROFILE",
    "SYSTEMROOT",
    "APPDATA",
    "LOCALAPPDATA",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
    "TMPDIR",
    "TEMP",
    "LANG",
    "LC_ALL",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR"
  ]
  const specific: Record<HarnessDriver, string[]> = {
    codex: ["CODEX_HOME", "OPENAI_API_KEY"],
    claude: [
      "CLAUDE_CONFIG_DIR",
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_BASE_URL",
      "CLAUDE_CODE_OAUTH_TOKEN"
    ],
    opencode: ["OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR"],
    cursor: ["CURSOR_API_KEY"],
    // Called over HTTP, never started as a child process.
    cliproxy: []
  }
  const environment: NodeJS.ProcessEnv = { NO_COLOR: "1", TERM: "dumb" }
  for (const key of [...common, ...specific[driver]]) if (source[key] !== undefined) environment[key] = source[key]
  if (driver === "claude")
    Object.assign(environment, {
      ENABLE_CLAUDEAI_MCP_SERVERS: "false",
      CLAUDE_CODE_AUTO_CONNECT_IDE: "0",
      CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: "1"
    })
  return environment
}

export function stopProcess(child: ChildProcessWithoutNullStreams) {
  if (child.pid === undefined) return
  try {
    if (process.platform === "win32") child.kill("SIGKILL")
    else process.kill(-child.pid, "SIGKILL")
  } catch {
    child.kill("SIGKILL")
  }
}

export function launch(binary: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, signal: AbortSignal) {
  signal.throwIfAborted()
  const child = spawn(binary, args, {
    cwd,
    env,
    shell: false,
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"]
  })
  const stop = () => stopProcess(child)
  signal.addEventListener("abort", stop, { once: true })
  child.once("close", () => signal.removeEventListener("abort", stop))
  // Raw stderr can contain account details, paths and tokens. Never forward it.
  child.stderr.resume()
  child.stdin.on("error", () => {})
  return child
}

export async function capture(
  binary: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  input = "",
  signal = AbortSignal.timeout(15000),
  acceptedExitCodes: readonly number[] = [0]
): Promise<string> {
  const child = launch(binary, args, cwd, env, signal)
  return await new Promise((resolve, reject) => {
    let output = "",
      settled = false
    const finish = (error?: BridgeFailure) => {
      if (settled) return
      settled = true
      signal.removeEventListener("abort", aborted)
      if (error) reject(error)
      else resolve(output)
    }
    const aborted = () => {
      stopProcess(child)
      finish(new BridgeFailure(signal.reason?.name === "TimeoutError" ? "TIMEOUT" : "CANCELLED"))
    }
    signal.addEventListener("abort", aborted, { once: true })
    child.on("error", () => finish(new BridgeFailure("UNAVAILABLE")))
    child.stdout.on("data", (chunk) => {
      output += String(chunk)
      if (Buffer.byteLength(output) > 512000) {
        stopProcess(child)
        finish(new BridgeFailure("MALFORMED"))
      }
    })
    child.on("close", (code) =>
      finish(code !== null && acceptedExitCodes.includes(code) ? undefined : new BridgeFailure(failureReason(output)))
    )
    child.stdin.end(input)
    if (signal.aborted) aborted()
  })
}

const RpcEnvelope = Schema.Struct({
  jsonrpc: Schema.optional(Schema.String),
  id: Schema.optional(Schema.Union(Schema.Number, Schema.String)),
  method: Schema.optional(Schema.String),
  params: Schema.optional(Schema.Unknown),
  result: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.Unknown)
})
export class RpcProcess {
  private next = 0
  private pending = new Map<
    number,
    { operation: string; resolve: (result: unknown) => void; reject: (error: BridgeFailure) => void }
  >()
  private child: ChildProcessWithoutNullStreams
  private lines
  private bytes = 0
  private ended = false
  private abort: () => void
  constructor(
    binary: string,
    args: string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
    private signal: AbortSignal,
    private notification: (method: string, params: unknown) => void = () => {},
    private maxOutputBytes = 1000000
  ) {
    this.child = launch(binary, args, cwd, env, signal)
    this.lines = createInterface({ input: this.child.stdout })
    this.abort = () => this.close(new BridgeFailure(signal.reason?.name === "TimeoutError" ? "TIMEOUT" : "CANCELLED"))
    signal.addEventListener("abort", this.abort, { once: true })
    this.child.once("error", () => this.close(new BridgeFailure("UNAVAILABLE")))
    this.child.once("close", () => this.close(new BridgeFailure("UNAVAILABLE")))
    this.child.stdout.on("data", (chunk) => {
      this.bytes += Buffer.byteLength(chunk)
      if (this.bytes > this.maxOutputBytes) this.close(new BridgeFailure("MALFORMED"))
    })
    this.lines.on("line", (line) => {
      try {
        const message = Schema.decodeUnknownSync(RpcEnvelope)(JSON.parse(line))
        if (message.method && message.id !== undefined) {
          // ACP requests for files, terminal access and permissions are refused.
          const reply =
            message.method === "session/request_permission"
              ? { jsonrpc: "2.0", id: message.id, result: { outcome: { outcome: "cancelled" } } }
              : { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Client capability unavailable" } }
          this.child.stdin.write(JSON.stringify(reply) + "\n")
        } else if (typeof message.id === "number") {
          const pending = this.pending.get(message.id)
          if (pending) {
            this.pending.delete(message.id)
            const code = Schema.decodeUnknownEither(Schema.Struct({ code: Schema.Number }))(message.error)
            if (message.error) {
              const privateError = JSON.stringify(message.error)
              const category = /FreeTierError|free.tier/i.test(privateError)
                ? "FREE_TIER_UNAVAILABLE"
                : /model.not.found|unknown.model|model.*not.available/i.test(privateError)
                  ? "MODEL_UNAVAILABLE"
                  : "PROVIDER_ERROR"
              pending.reject(
                new BridgeFailure(failureReason(privateError), {
                  operation: pending.operation,
                  ...(code._tag === "Right" ? { code: code.right.code } : {}),
                  category
                })
              )
            } else pending.resolve(message.result)
          }
        } else if (message.method) this.notification(message.method, message.params)
      } catch {
        this.close(new BridgeFailure("MALFORMED"))
      }
    })
    if (signal.aborted) this.abort()
  }
  async request(method: string, params: unknown): Promise<unknown> {
    if (this.ended) throw new BridgeFailure("UNAVAILABLE")
    return new Promise((resolve, reject) => {
      const id = ++this.next
      this.pending.set(id, { operation: method, resolve, reject })
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n")
    })
  }
  notify(method: string, params: unknown = {}) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n")
  }
  close(error = new BridgeFailure("CANCELLED")) {
    if (this.ended) return
    this.ended = true
    this.signal.removeEventListener("abort", this.abort)
    this.lines.close()
    stopProcess(this.child)
    for (const pending of this.pending.values())
      pending.reject(new BridgeFailure(error.reason, { operation: pending.operation }))
    this.pending.clear()
  }
}

/**
 * Starts a program in the background, detached from the bridge, and returns
 * at once: for local services the bridge brings up (CLIProxyAPI), which keep
 * running after the bridge stops. No shell; output is discarded.
 */
export const startDetached = (binary: string, args: ReadonlyArray<string>, options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv }): boolean => {
  try {
    const child = spawn(binary, [...args], { cwd: options.cwd, detached: true, stdio: "ignore", shell: false, env: options.env })
    child.on("error", () => {})
    child.unref()
    return true
  } catch { return false }
}

