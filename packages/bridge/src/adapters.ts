import { access, mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises"
import { constants } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { Schema } from "effect"
import {
  HARNESS_NAMES,
  HarnessAnswer,
  HarnessReasoningEffort,
  type HarnessDriver,
  type HarnessJob,
  type HarnessModel,
  type HarnessReport
} from "@openrecord/contracts"
import { BridgeFailure, RpcProcess, capture, driverEnvironment } from "./process.js"
import { sessions, type WarmProcess } from "./sessions.js"
import { prepareSearchPath, searchPath } from "./discovery.js"
import { claudeCatalog, claudeSdkProcess } from "./claude-sdk.js"
import { executeCliProxy, probeCliProxy } from "./cliproxy.js"

export const LocalInstance = Schema.Struct({
  id: Schema.UUID,
  driver: Schema.Literal("codex", "claude", "opencode", "cursor", "cliproxy"),
  name: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(100)),
  home: Schema.optional(Schema.String),
  binary: Schema.optional(Schema.String),
  // CLIProxyAPI only: its origin, and where its client key comes from.
  baseUrl: Schema.optional(Schema.String.pipe(Schema.maxLength(500))),
  apiKeyEnv: Schema.optional(Schema.String.pipe(Schema.pattern(/^[A-Z_][A-Z0-9_]{0,99}$/))),
  apiKey: Schema.optional(Schema.String.pipe(Schema.minLength(1), Schema.maxLength(500)))
})
export type LocalInstance = typeof LocalInstance.Type
const BINARY: Record<Exclude<HarnessDriver, "cliproxy">, string> = {
  codex: "codex",
  claude: "claude",
  opencode: "opencode",
  cursor: "agent"
}
const resolvedBinaries = new Map<string, string>()
const AcpConfigOptions = Schema.Array(Schema.Struct({
  id: Schema.String,
  category: Schema.optional(Schema.String),
  options: Schema.optional(Schema.Array(Schema.Struct({ value: Schema.String, name: Schema.String })))
}))
const AcpConfigResponse = Schema.Struct({ configOptions: Schema.optional(AcpConfigOptions) })
const MODELS = Schema.Struct({
  models: Schema.optional(
    Schema.Struct({ availableModels: Schema.Array(Schema.Struct({ modelId: Schema.String, name: Schema.String })) })
  ),
  sessionId: Schema.String,
  configOptions: Schema.optional(AcpConfigOptions)
})
const CodexModels = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({ id: Schema.String, model: Schema.optional(Schema.String), displayName: Schema.String,
      supportedReasoningEfforts: Schema.optional(Schema.Array(Schema.Struct({ reasoningEffort: Schema.String }))) })
  )
})

function environment(instance: LocalInstance) {
  const env = driverEnvironment(instance.driver)
  // Found through the effective PATH, a CLI also runs with it (an nvm-installed
  // CLI needs its node, a Homebrew one its libraries).
  env["PATH"] = searchPath()
  if (instance.home) {
    if (instance.driver === "codex") env["CODEX_HOME"] = instance.home
    else if (instance.driver === "claude") env["CLAUDE_CONFIG_DIR"] = instance.home
    else if (instance.driver === "opencode") env["OPENCODE_CONFIG_DIR"] = instance.home
  }
  if (instance.driver === "opencode")
    env["OPENCODE_CONFIG_CONTENT"] = JSON.stringify({ permission: { "*": "deny" }, mcp: {}, tools: { "*": false } })
  return env
}
const acpArgs = (instance: LocalInstance) => (instance.driver === "opencode" ? ["acp"] : ["acp"])
const codexArgs = ["app-server"]

async function resolveBinary(instance: LocalInstance, cwd: string, env: NodeJS.ProcessEnv) {
  if (instance.driver === "cliproxy") throw new BridgeFailure("UNAVAILABLE")
  const names = instance.driver === "cursor" ? ["cursor-agent", "agent"] : [BINARY[instance.driver]]
  const directories = [
    ...(instance.driver === "opencode" ? [join(homedir(), ".opencode", "bin")] : []),
    ...(env["PATH"] ?? "").split(delimiter).filter((p) => p && !p.includes("node_modules"))
  ]
  const candidates = instance.binary
    ? [instance.binary]
    : [...new Set(directories.flatMap((dir) => names.map((name) => join(dir, name))))]
  const versions = await Promise.all(
    candidates.map(async (binary) => {
      try {
        await access(binary, constants.X_OK)
        const version = (await capture(binary, ["--version"], cwd, env))
          .trim()
          .match(/\d+\.\d+\.\d+(?:[-+.][A-Za-z0-9.-]+)?/)?.[0]
        return version ? { binary, version } : null
      } catch {
        return null
      }
    })
  )
  const valid = versions.filter((v): v is { binary: string; version: string } => v !== null)
  valid.sort((a, b) => {
    const left = a.version.split(/[.-]/).slice(0, 3).map(Number),
      right = b.version.split(/[.-]/).slice(0, 3).map(Number)
    for (let i = 0; i < 3; i++) {
      const diff = (right[i] ?? 0) - (left[i] ?? 0)
      if (diff) return diff
    }
    return 0
  })
  const chosen = valid[0]
  if (!chosen) throw new BridgeFailure("UNAVAILABLE")
  resolvedBinaries.set(instance.id, chosen.binary)
  return chosen
}

async function initializeAcp(rpc: RpcProcess, cwd: string) {
  await rpc.request("initialize", {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    clientInfo: { name: "openrecord", version: "0.1.0" }
  })
  return Schema.decodeUnknownSync(MODELS)(await rpc.request("session/new", { cwd, mcpServers: [] }))
}
function acpModels(session: typeof MODELS.Type): HarnessModel[] {
  if (session.models) return session.models.availableModels.map((m) => ({ id: m.modelId, name: m.name }))
  const options = session.configOptions?.find((o) => o.category === "model" || o.id === "model")?.options ?? []
  return options.map((o) => ({ id: o.value, name: o.name }))
}

function reasoningOption(options: typeof AcpConfigResponse.Type["configOptions"]) {
  return options?.find(option => option.category === "thought_level" || option.id === "effort")
}

async function discoverAcpModels(rpc: RpcProcess, session: typeof MODELS.Type): Promise<HarnessModel[]> {
  const models = acpModels(session)
  const modelOption = session.configOptions?.find(option => option.category === "model" || option.id === "model")
  if (!modelOption) return models
  const found: HarnessModel[] = []
  const deadline = Date.now() + 45000
  for (const model of models) {
    if (Date.now() >= deadline) { found.push(model); continue }
    try {
      const changed = Schema.decodeUnknownSync(AcpConfigResponse)(await rpc.request("session/set_config_option", { sessionId: session.sessionId, configId: modelOption.id, value: model.id }))
      const reasoningEfforts = [...new Set((reasoningOption(changed.configOptions)?.options ?? []).map(option => option.value).filter(Schema.is(HarnessReasoningEffort)))]
      found.push({ ...model, ...(reasoningEfforts.length ? { reasoningEfforts } : {}) })
    } catch {
      return [...found, ...models.slice(found.length)]
    }
  }
  return found
}

/** A fresh, empty working folder whose local project policy denies every file,
 * shell and MCP permission; local policy has priority over broad user defaults. */
async function lockedWorkspace() {
  const cwd = await mkdtemp(join(tmpdir(), "openrecord-harness-"))
  try {
    await mkdir(join(cwd, ".cursor"))
    await writeFile(
      join(cwd, ".cursor", "cli.json"),
      JSON.stringify({ version: 1, permissions: { allow: [], deny: ["Read(**)", "Write(**)", "Shell(*)", "Mcp(*)"] } }),
      { mode: 0o600 }
    )
    await writeFile(
      join(cwd, "opencode.json"),
      JSON.stringify({ permission: { "*": "deny" }, mcp: {}, tools: { "*": false } }),
      { mode: 0o600 }
    )
    return cwd
  } catch (error) {
    await rm(cwd, { recursive: true, force: true })
    throw error
  }
}

export async function withWorkspace<A>(act: (cwd: string) => Promise<A>) {
  const cwd = await lockedWorkspace()
  try {
    return await act(cwd)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
}

export async function executableFor(instance: LocalInstance) {
  await prepareSearchPath()
  return withWorkspace(async (cwd) => (await resolveBinary(instance, cwd, environment(instance))).binary)
}

export async function probe(instance: LocalInstance): Promise<HarnessReport> {
  if (instance.driver === "cliproxy") return probeCliProxy(instance)
  await prepareSearchPath()
  const base: HarnessReport = {
    localId: instance.id,
    driver: instance.driver,
    name: instance.name || HARNESS_NAMES[instance.driver],
    installed: false,
    version: null,
    auth: "unknown",
    state: "unavailable",
    models: []
  }
  return withWorkspace(async (cwd) => {
    try {
      const env = environment(instance)
      const { binary, version } = await resolveBinary(instance, cwd, env)
      const installed = { ...base, installed: true, version }
      try {
        if (instance.driver === "codex") {
          const rpc = new RpcProcess(binary, codexArgs, cwd, env, AbortSignal.timeout(20000))
          try {
            await rpc.request("initialize", {
              clientInfo: { name: "openrecord", version: "0.1.0" },
              capabilities: { experimentalApi: true }
            })
            rpc.notify("initialized")
            const account = Schema.decodeUnknownSync(
              Schema.Struct({
                account: Schema.NullOr(Schema.Struct({ type: Schema.String, email: Schema.optional(Schema.String) })),
                requiresOpenaiAuth: Schema.optional(Schema.Boolean)
              })
            )(await rpc.request("account/read", { refreshToken: false }))
            const catalog = Schema.decodeUnknownSync(CodexModels)(await rpc.request("model/list", { limit: 100 }))
            // The plan's usage windows; a reached limit is reported with when it lifts.
            // Older Codex versions may not answer; that only leaves the limit unknown.
            const limitAnswer = await Promise.race([rpc.request("account/rateLimits/read", {}), new Promise(resolve => setTimeout(resolve, 5000, null))]).catch(() => null)
            const limit = codexLimit(limitAnswer)
            return {
              ...installed,
              ...(limit ? { state: "usage_limited" as const, limitResetsAt: limit.resetsAt } : {}),
              accountLabel: account.account?.email ?? account.account?.type ?? null,
              auth:
                account.account !== null
                  ? "authenticated"
                  : account.requiresOpenaiAuth === false
                    ? "unknown"
                    : "unauthenticated",
              ...(limit ? {} : { state: catalog.data.length ? "ready" as const : "unavailable" as const }),
              models: catalog.data.map(m => {
                const reasoningEfforts = [...new Set((m.supportedReasoningEfforts ?? []).map(e => e.reasoningEffort).filter(Schema.is(HarnessReasoningEffort)))]
                return { id: m.model ?? m.id, name: m.displayName, ...(reasoningEfforts.length ? { reasoningEfforts } : {}) }
              })
            }
          } finally {
            rpc.close()
          }
        }
        if (instance.driver === "claude") {
          const auth = Schema.decodeUnknownSync(
            Schema.Struct({ loggedIn: Schema.Boolean, email: Schema.optional(Schema.String) })
          )(
            JSON.parse(
              await capture(binary, ["auth", "status", "--json"], cwd, env, "", AbortSignal.timeout(15000), [0, 1])
            )
          )
          if (!auth.loggedIn) return { ...installed, accountLabel: null, auth: "unauthenticated", state: "unavailable", models: [] }
          // The account's real models and reasoning levels, from the Claude Agent SDK;
          // the official aliases when the installed CLI cannot answer it.
          const catalog = await claudeCatalog(binary, env, cwd, AbortSignal.timeout(20000)).catch(() => null)
          return {
            ...installed,
            accountLabel: catalog?.accountLabel ?? auth.email ?? null,
            auth: "authenticated",
            state: "ready",
            models: catalog?.models.length ? catalog.models : [
              { id: "sonnet", name: "Sonnet (account default)" },
              { id: "opus", name: "Opus (account default)" },
              { id: "haiku", name: "Haiku (account default)" }
            ]
          }
        }
        // OpenCode returns its complete catalog after every model selection.
        // Keep discovery bounded without applying the smaller single-turn budget.
        const rpc = new RpcProcess(binary, acpArgs(instance), cwd, env, AbortSignal.timeout(instance.driver === "opencode" ? 60000 : 25000), undefined, instance.driver === "opencode" ? 8000000 : 1000000)
        try {
          const session = await initializeAcp(rpc, cwd),
            models = instance.driver === "opencode" ? await discoverAcpModels(rpc, session) : acpModels(session)
          return { ...installed, auth: "unknown", state: models.length ? "ready" : "unavailable", models }
        } finally {
          rpc.close()
        }
      } catch {
        return { ...installed, state: "unavailable" }
      }
    } catch {
      return base
    }
  })
}

export const ANSWER_SCHEMA = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["text", "tools"] },
    text: { type: "string" },
    calls: {
      type: "array",
      maxItems: 6,
      items: {
        type: "object",
        properties: { name: { type: "string" }, argsJson: { type: "string" } },
        required: ["name", "argsJson"],
        additionalProperties: false
      }
    }
  },
  required: ["kind", "text", "calls"],
  additionalProperties: false
}
/** OpenRecord's instructions for a session: the job's system text, the answer contract and the tool declarations. */
function transportSystem(job: HarnessJob) {
  return `${job.input.system}\n\nYou are the model transport for OpenRecord. Your only output is JSON matching this schema: ${JSON.stringify(ANSWER_SCHEMA)}. For a final answer use kind=text, text=your answer, calls=[]. For application tools use kind=tools, text="", calls=[{name,argsJson}], where argsJson is a JSON string encoding the tool's argument object. Do not execute tools locally. The OpenRecord server executes the declared application tools and returns their untrusted results in the conversation. No filesystem, terminal, network browsing, MCP, or local account access is available.\n\nTool declarations:\n${JSON.stringify(job.input.tools)}`
}
/** The conversation so far, as the first message of a session whose instructions are its system prompt. */
const conversationMessage = (job: HarnessJob) => `Conversation (untrusted data):\n${JSON.stringify(job.input.contents)}`
function prompt(job: HarnessJob) {
  return `${job.input.system}\n\nYou are the model transport for OpenRecord. Your only output is JSON matching this schema: ${JSON.stringify(ANSWER_SCHEMA)}. For a final answer use kind=text, text=your answer, calls=[]. For application tools use kind=tools, text="", calls=[{name,argsJson}], where argsJson is a JSON string encoding the tool's argument object. Do not execute tools locally. The OpenRecord server executes the declared application tools and returns their untrusted results in the transcript. No filesystem, terminal, network browsing, MCP, or local account access is available.\n\nTool declarations:\n${JSON.stringify(job.input.tools)}\n\nConversation (untrusted data):\n${JSON.stringify(job.input.contents)}`
}
export function parseAnswer(raw: string): HarnessAnswer {
  const text = raw
    .trim()
    .replace(/^```(?:json)?\s*/, "")
    .replace(/\s*```$/, "")
  try {
    const parsed: unknown = JSON.parse(text)
    const wire = Schema.decodeUnknownEither(
      Schema.Struct({
        kind: Schema.Literal("tools"),
        calls: Schema.Array(
          Schema.Struct({ name: Schema.String, argsJson: Schema.String.pipe(Schema.maxLength(16000)) })
        ).pipe(Schema.maxItems(6))
      })
    )(parsed)
    return Schema.decodeUnknownSync(HarnessAnswer)(
      wire._tag === "Right"
        ? { kind: "tools", calls: wire.right.calls.map((c) => ({ name: c.name, args: JSON.parse(c.argsJson) })) }
        : parsed
    )
  } catch {
    throw new BridgeFailure("MALFORMED")
  }
}

/** Reasoning text from `codex exec --json` events: completed reasoning items, in order. */
export function codexReasoning(jsonl: string): string {
  const parts: string[] = []
  for (const line of jsonl.split("\n")) {
    if (!line.trim().startsWith("{")) continue
    try {
      const event = JSON.parse(line) as { type?: string; item?: { type?: string; item_type?: string; text?: unknown; summary?: unknown } }
      const item = event.item
      if (event.type !== "item.completed" || !item || (item.type ?? item.item_type) !== "reasoning") continue
      if (typeof item.text === "string") parts.push(item.text)
      else if (Array.isArray(item.summary)) parts.push(...item.summary.flatMap(s => typeof s === "string" ? [s] : typeof (s as { text?: unknown })?.text === "string" ? [(s as { text: string }).text] : []))
    } catch { /* Not an event line. */ }
  }
  return parts.join("\n\n").trim().slice(-8000)
}
const withThought = (answer: HarnessAnswer, thought: string): HarnessAnswer => thought.trim() ? { ...answer, thought: thought.trim().slice(-8000) } : answer

export async function execute(instance: LocalInstance, job: HarnessJob, signal: AbortSignal, onThought?: (thought: string) => void): Promise<HarnessAnswer> {
  if (instance.id !== job.localId || instance.driver !== job.driver) throw new BridgeFailure("UNAVAILABLE")
  // CLIProxyAPI is reached over HTTP; only CLIs need the search path.
  if (instance.driver === "cliproxy") return executeCliProxy(instance, job, signal, process.env, onThought)
  await prepareSearchPath()
  if (job.input.reasoningEffort && instance.driver !== "codex" && instance.driver !== "opencode" && instance.driver !== "claude") throw new BridgeFailure("UNAVAILABLE")
  const driver = instance.driver
  // Claude Code and the ACP agents keep one warm session across the steps of
  // a turn; Codex runs each step as its own process.
  if (driver !== "codex") {
    const binary = resolvedBinaries.get(instance.id) ?? instance.binary ?? BINARY[driver], env = environment(instance)
    let thought = ""
    const relay = (t: string) => { thought = t; onThought?.(t) }
    const start = async () => {
      if (driver !== "claude") return acpProcess(instance, binary, env, job, signal)
      const cwd = await lockedWorkspace()
      try {
        return await claudeSdkProcess({ binary, env, cwd, model: job.model, system: transportSystem(job), schema: ANSWER_SCHEMA,
          effort: job.input.reasoningEffort, startSignal: signal, onClose: () => { void rm(cwd, { recursive: true, force: true }) } })
      } catch (error) {
        await rm(cwd, { recursive: true, force: true })
        throw error
      }
    }
    const { answer } = await sessions.run(instance.id, job, start, driver === "claude" ? conversationMessage(job) : prompt(job), signal, relay)
    if (answer.length > 64000) throw new BridgeFailure("MALFORMED")
    return withThought(parseAnswer(answer), thought)
  }
  return withWorkspace(async (cwd) => {
    const binary = resolvedBinaries.get(instance.id) ?? instance.binary ?? BINARY[driver],
      env = environment(instance)
    if (instance.driver === "codex") {
      const schemaFile = join(cwd, "answer-schema.json"),
        answerFile = join(cwd, "answer.json")
      await writeFile(schemaFile, JSON.stringify(ANSWER_SCHEMA), { mode: 0o600 })
      const events = await capture(
        binary,
        [
          "exec",
          "--ignore-user-config",
          "--ignore-rules",
          "--ephemeral",
          "--skip-git-repo-check",
          "--sandbox",
          "read-only",
          "--disable",
          "shell_tool",
          "--disable",
          "unified_exec",
          "--disable",
          "hooks",
          "--disable",
          "apps",
          "--disable",
          "plugins",
          "--disable",
          "multi_agent",
          "--disable",
          "browser_use",
          "--disable",
          "image_generation",
          "--disable",
          "computer_use",
          "--disable",
          "view_image",
          "--disable",
          "memories",
          "--disable",
          "code_mode_host",
          "--enable",
          "skip_host_skill_discovery",
          "-c",
          'web_search="disabled"',
          "-c",
          "project_doc_max_bytes=0",
          ...(job.input.reasoningEffort ? ["-c", `model_reasoning_effort="${job.input.reasoningEffort}"`] : []),
          "--model",
          job.model,
          "--output-schema",
          schemaFile,
          "--output-last-message",
          answerFile,
          "--json",
          "-"
        ],
        cwd,
        env,
        prompt(job),
        signal
      )
      const answer = await readFile(answerFile, "utf8")
      if (answer.length > 64000) throw new BridgeFailure("MALFORMED")
      return withThought(parseAnswer(answer), codexReasoning(events))
    }
    throw new BridgeFailure("UNAVAILABLE")
  })
}

// ---- warm sessions ----

const stepFailure = (signal: AbortSignal) => new BridgeFailure(signal.reason?.name === "TimeoutError" ? "TIMEOUT" : "CANCELLED")

/** An ACP agent (OpenCode, Cursor) as one session for a whole turn: the model
 * and reasoning level are chosen once, then each step is one more prompt. */
async function acpProcess(instance: LocalInstance, binary: string, env: NodeJS.ProcessEnv, job: HarnessJob, startSignal: AbortSignal): Promise<WarmProcess> {
  startSignal.throwIfAborted()
  const cwd = await lockedWorkspace()
  const life = new AbortController()
  let collector: { text: string; thought: string; onThought?: ((t: string) => void) | undefined } | null = null
  const rpc = new RpcProcess(binary, acpArgs(instance), cwd, env, life.signal, (method, params) => {
    if (method !== "session/update" || !collector) return
    const update = Schema.decodeUnknownEither(
      Schema.Struct({
        update: Schema.Struct({
          sessionUpdate: Schema.String,
          content: Schema.optional(Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) }))
        })
      })
    )(params)
    if (update._tag !== "Right") return
    if (update.right.update.sessionUpdate === "agent_message_chunk") collector.text += update.right.update.content?.text ?? ""
    // ACP streams the model's reasoning as thought chunks.
    if (update.right.update.sessionUpdate === "agent_thought_chunk" && update.right.update.content?.text) {
      collector.thought += update.right.update.content.text
      collector.onThought?.(collector.thought.trim().slice(-8000))
    }
  }, 8000000)
  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    life.abort()
    rpc.close(new BridgeFailure("UNAVAILABLE"))
    void rm(cwd, { recursive: true, force: true })
  }
  // Start-up is bounded by the first step's own deadline.
  const guard = <A>(work: Promise<A>, signal: AbortSignal) => new Promise<A>((resolve, reject) => {
    if (signal.aborted) { close(); return reject(stepFailure(signal)) }
    const abort = () => { close(); reject(stepFailure(signal)) }
    signal.addEventListener("abort", abort, { once: true })
    work.then(v => { signal.removeEventListener("abort", abort); resolve(v) }, e => { signal.removeEventListener("abort", abort); reject(e instanceof BridgeFailure ? e : new BridgeFailure("UNAVAILABLE")) })
  })
  let sessionId: string
  try {
    sessionId = await guard((async () => {
      const session = await initializeAcp(rpc, cwd)
      if (!acpModels(session).some((m) => m.id === job.model)) throw new BridgeFailure("UNAVAILABLE")
      let configOptions = session.configOptions
      const option = session.configOptions?.find((o) => o.category === "model" || o.id === "model")
      if (option) {
        const changed = Schema.decodeUnknownSync(AcpConfigResponse)(await rpc.request("session/set_config_option", { sessionId: session.sessionId, configId: option.id, value: job.model }))
        configOptions = changed.configOptions
      } else if (session.models) await rpc.request("session/set_model", { sessionId: session.sessionId, modelId: job.model })
      else throw new BridgeFailure("UNAVAILABLE")
      if (job.input.reasoningEffort) {
        const effort = reasoningOption(configOptions)
        if (!effort?.options?.some(o => o.value === job.input.reasoningEffort)) throw new BridgeFailure("UNAVAILABLE")
        await rpc.request("session/set_config_option", { sessionId: session.sessionId, configId: effort.id, value: job.input.reasoningEffort })
      }
      return session.sessionId
    })(), startSignal)
  } catch (error) {
    close()
    throw error
  }
  return {
    close,
    step: async (text, signal, onThought) => {
      if (closed) throw new BridgeFailure("UNAVAILABLE")
      collector = { text: "", thought: "", onThought }
      try {
        const result = Schema.decodeUnknownSync(Schema.Struct({ stopReason: Schema.String }))(
          await guard(rpc.request("session/prompt", { sessionId, prompt: [{ type: "text", text }] }), signal))
        if (result.stopReason !== "end_turn") throw new BridgeFailure("UNAVAILABLE")
        return collector.text
      } finally {
        collector = null
      }
    },
  }
}

/** Whether Codex's plan has reached a usage limit, and when it lifts, from
 * account/rateLimits/read. Null when usage is allowed or the answer is unknown. */
export function codexLimit(raw: unknown): { resetsAt: string | null } | null {
  const r = (raw ?? {}) as { ordinaryUsageAllowed?: unknown; rateLimits?: { primary?: unknown; secondary?: unknown; rateLimitReachedType?: unknown } | null }
  const windows = [r.rateLimits?.primary, r.rateLimits?.secondary]
    .flatMap(w => w && typeof w === "object" ? [w as { usedPercent?: unknown; resetsAt?: unknown }] : [])
  const full = windows.filter(w => typeof w.usedPercent === "number" && w.usedPercent >= 100)
  const reached = r.ordinaryUsageAllowed === false || full.length > 0 || typeof r.rateLimits?.rateLimitReachedType === "string"
  if (!reached) return null
  const resets = (full.length ? full : windows).map(w => w.resetsAt).filter((t): t is number => typeof t === "number" && t > 0)
  return { resetsAt: resets.length ? new Date(Math.max(...resets) * 1000).toISOString() : null }
}

