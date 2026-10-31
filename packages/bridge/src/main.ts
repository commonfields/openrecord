import { randomUUID } from "node:crypto"
import { chmod, lstat, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"
import { spawn } from "node:child_process"
import { realpathSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { Schema } from "effect"
import { HARNESS_NAMES, HarnessDriver, type HarnessJobResult, type HarnessReport } from "@openrecord/contracts"
import { LocalInstance, executableFor, execute, probe } from "./adapters.js"
import { sessions } from "./sessions.js"
import { BridgeClient, serverOrigin } from "./client.js"
import { BridgeFailure, driverEnvironment } from "./process.js"
import { CLIPROXY_DEFAULT_KEY_ENV, CLIPROXY_DEFAULT_URL, cliProxyOrigin } from "./cliproxy.js"

const Config = Schema.Struct({
  server: Schema.String,
  bridgeId: Schema.UUID,
  token: Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9_-]{43}$/)),
  instances: Schema.Array(LocalInstance).pipe(Schema.maxItems(32))
})
type Config = typeof Config.Type
// OPENRECORD_BRIDGE_HOME lets the OpenRecord app run its own bridge beside a
// manually paired one: separate configuration, separate lock.
const home = process.env["OPENRECORD_BRIDGE_HOME"]
const root = home && isAbsolute(home) ? home : join(homedir(), ".openrecord"),
  file = join(root, "bridge.json")
const log = (event: string) => process.stdout.write(JSON.stringify({ event }) + "\n")
class BridgeSetupError extends Error {}
/** True when the lock names a process that no longer exists (or names nothing readable). */
export async function staleLock(lock: string) {
  const pid = Number((await readFile(lock, "utf8").catch(() => "")).trim())
  // An empty lock may be one another bridge has just created; give it a moment to write its pid.
  if (!Number.isSafeInteger(pid) || pid <= 0) return Date.now() - (await lstat(lock).then(i => i.mtimeMs).catch(() => 0)) > 5000
  if (pid === process.pid) return false
  try { process.kill(pid, 0); return false } catch (e) { return (e as NodeJS.ErrnoException).code === "ESRCH" }
}
async function acquireLock() {
  await mkdir(root, { recursive: true, mode: 0o700 })
  const info = await lstat(root)
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new BridgeSetupError("Bridge configuration directory is not a regular directory")
  const lock = join(root, "bridge.lock")
  const take = () => open(lock, "wx", 0o600)
  const handle = await take().catch(async () => {
    // A bridge that crashed or was cut off by a restart leaves its lock behind.
    // Take it over only when the process it names is gone; a live one still wins.
    if (await staleLock(lock)) { await unlink(lock).catch(() => {}); return take() }
    throw new BridgeSetupError("Another bridge is already running from " + root + ". Stop it first.")
  }).catch((e: unknown) => {
    if (e instanceof BridgeSetupError) throw e
    throw new BridgeSetupError("Another bridge is already running from " + root + ". Stop it first.")
  })
  await handle.writeFile(String(process.pid))
  return async () => {
    await handle.close()
    await unlink(lock)
  }
}
async function save(config: Config) {
  const validated = Schema.decodeUnknownSync(Config)(config)
  await mkdir(root, { recursive: true, mode: 0o700 })
  const info = await lstat(root)
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new BridgeSetupError("Bridge configuration directory is not a regular directory")
  const temporary = join(root, `bridge-${randomUUID()}.tmp`)
  await writeFile(temporary, JSON.stringify(validated, null, 2), { mode: 0o600, flag: "wx" })
  await rename(temporary, file)
  await chmod(file, 0o600)
}
async function load() {
  const info = await lstat(file)
  if (info.isSymbolicLink() || !info.isFile() || (process.platform !== "win32" && (info.mode & 0o077) !== 0))
    throw new BridgeSetupError("Bridge configuration must be a private regular file")
  const config = Schema.decodeUnknownSync(Config)(JSON.parse(await readFile(file, "utf8")))
  serverOrigin(config.server)
  return config
}
const option = (args: string[], key: string) => {
  const i = args.indexOf(key)
  return i < 0 ? undefined : args[i + 1]
}
export async function main(args = process.argv.slice(2)) {
  if (args[0] === "--") args = args.slice(1)
  const command = args[0] ?? "run"
  if (command === "--help" || command === "help") {
    process.stdout.write(
      "OpenRecord local harness bridge (Node 24+)\n\npair --server <OpenRecord origin> --code <code from Settings>\nrun                         Start a paired bridge\nprobe                       Check installed providers without generating answers\nlogin --driver <driver>     Run an official provider login\nlogin --instance <local id> Sign in to a specific local instance\nadd --driver <driver> --name <name> [--home <directory>] [--binary <path>]\nadd --driver cliproxy [--url <origin>] [--api-key-env <NAME>]\n\nDrivers: codex, claude, opencode, cursor, cliproxy. Provider credentials remain local.\nCLIProxyAPI defaults to " + CLIPROXY_DEFAULT_URL + " with its client key in " + CLIPROXY_DEFAULT_KEY_ENV + ".\n"
    )
    return
  }
  if (command === "pair") {
    const server = serverOrigin(option(args, "--server") ?? ""),
      code = option(args, "--code")
    if (!code || !/^[A-Za-z0-9_-]{43}$/.test(code))
      throw new BridgeSetupError("Use the pairing command from OpenRecord Settings → Agent")
    const release = await acquireLock()
    try {
      const registered = Schema.decodeUnknownSync(Schema.Struct({ bridgeId: Schema.UUID, token: Schema.String }))(
        await new BridgeClient(server, "").request("/api/bridge/register", { code }, false)
      )
      // CLIProxyAPI is discovered at its default local address; it shows as not running until started.
      const drivers: HarnessDriver[] = ["codex", "claude", "opencode", "cursor", "cliproxy"]
      await save({
        server,
        ...registered,
        instances: drivers.map((driver) => ({ id: randomUUID(), driver, name: HARNESS_NAMES[driver] }))
      })
      log("paired: starting local harness discovery")
      return await run(await load(), async () => undefined)
    } finally {
      await release()
    }
  }
  if (command === "add") {
    const config = await load(),
      driver = Schema.decodeUnknownSync(HarnessDriver)(option(args, "--driver"))
    const home = option(args, "--home"),
      binary = option(args, "--binary"),
      url = option(args, "--url"),
      apiKeyEnv = option(args, "--api-key-env"),
      name = option(args, "--name") ?? HARNESS_NAMES[driver]
    if (config.instances.length >= 32) throw new BridgeSetupError("At most 32 local instances are supported")
    if (driver === "cliproxy") {
      try { cliProxyOrigin(url) } catch { throw new BridgeSetupError("Use an https:// URL, or http:// on 127.0.0.1 or localhost") }
      if (apiKeyEnv !== undefined && !/^[A-Z_][A-Z0-9_]{0,99}$/.test(apiKeyEnv)) throw new BridgeSetupError("--api-key-env must name an environment variable")
    }
    await save({
      ...config,
      instances: [
        ...config.instances,
        driver === "cliproxy"
          ? { id: randomUUID(), driver, name, ...(url ? { baseUrl: url } : {}), ...(apiKeyEnv ? { apiKeyEnv } : {}) }
          : { id: randomUUID(), driver, name, ...(home ? { home } : {}), ...(binary ? { binary } : {}) }
      ]
    })
    log("instance added: restart the bridge to discover it")
    return
  }
  if (command === "login") {
    const config = await load(),
      id = option(args, "--instance"),
      driver = option(args, "--driver")
    const instance = config.instances.find((i) => (id ? i.id === id : i.driver === driver))
    if (!instance)
      throw new BridgeSetupError("Choose --driver codex|claude|opencode|cursor or --instance from local configuration")
    if (instance.driver === "cliproxy")
      throw new BridgeSetupError("Sign in to providers in CLIProxyAPI itself (for example: cli-proxy-api --claude-login)")
    const loginDriver = instance.driver
    const binary = await executableFor(instance)
    const commands = { codex: ["login"], claude: ["auth", "login"], opencode: ["auth", "login"], cursor: ["login"] }
    const env = driverEnvironment(loginDriver)
    if (instance.home) {
      if (instance.driver === "codex") env["CODEX_HOME"] = instance.home
      else if (instance.driver === "claude") env["CLAUDE_CONFIG_DIR"] = instance.home
      else if (instance.driver === "opencode") env["OPENCODE_CONFIG_DIR"] = instance.home
    }
    await new Promise<void>((resolve, reject) => {
      const child = spawn(binary, commands[loginDriver], { env, shell: false, stdio: "inherit" })
      child.once("error", () => reject(new BridgeSetupError("Provider CLI is unavailable")))
      child.once("exit", (code) =>
        code === 0 ? resolve() : reject(new BridgeSetupError("Provider sign-in did not complete"))
      )
    })
    log("provider sign-in finished: refresh the provider in OpenRecord")
    return
  }
  if (command === "probe") {
    const config = await load()
    for (const instance of config.instances) {
      const result = await probe(instance)
      const { accountLabel: _accountLabel, ...status } = result
      process.stdout.write(JSON.stringify(status) + "\n")
    }
    return
  }
  if (command !== "run") throw new BridgeSetupError("Commands: pair, run, probe, login, add; use --help for options")
  await run(await load())
}

async function run(config: Config, releaseLock?: () => Promise<void>) {
  const release = releaseLock ?? (await acquireLock())
  const shutdown = new AbortController(),
    jobs = new Map<string, { controller: AbortController; promise: Promise<void> }>()
  const stop = () => shutdown.abort()
  process.once("SIGINT", stop)
  process.once("SIGTERM", stop)
  const client = new BridgeClient(config.server, config.token)
  let reports: HarnessReport[] = [],
    checkedAt = 0,
    failures = 0,
    quick = true,
    discovering: Promise<void> | null = null
  try {
    log("bridge running: credentials stay with local providers")
    while (!shutdown.signal.aborted) {
      try {
        // Discovery runs beside the poll loop: a message sent while providers
        // are being checked starts at once instead of after the check.
        if (Date.now() - checkedAt > 30000 && !jobs.size && !discovering) {
          checkedAt = Date.now()
          discovering = Promise.all(config.instances.map(probe)).then(found => { reports = found; checkedAt = Date.now() }, () => {}).finally(() => { discovering = null })
          if (!reports.length) await discovering
        }
        const asked = Date.now()
        const poll = await client.poll(reports, jobs.size < 4, true)
        quick = !poll.job && Date.now() - asked < 500
        if (poll.refresh) checkedAt = 0
        failures = 0
        for (const [id, job] of jobs) if (!poll.active.includes(id)) job.controller.abort()
        if (poll.job) {
          const job = poll.job,
            controller = new AbortController()
          const instance = config.instances.find((i) => i.id === job.localId)
          const signal = AbortSignal.any([controller.signal, shutdown.signal, AbortSignal.timeout(90000)])
          // The model's reasoning so far, sent at most every 400 ms while it works.
          let sentAt = 0, pending: string | null = null, timer: ReturnType<typeof setTimeout> | null = null
          const send = () => {
            timer = null
            if (pending === null) return
            const thought = pending.slice(-4000)
            pending = null; sentAt = Date.now()
            client.progress(job.id, { lease: job.lease, thought }).catch(() => {})
          }
          const onThought = (thought: string) => {
            pending = thought
            if (!timer) timer = setTimeout(send, Math.max(0, 400 - (Date.now() - sentAt)))
          }
          const promise = (async () => {
            let result: HarnessJobResult
            try {
              if (!instance) throw new BridgeFailure("UNAVAILABLE")
              result = { lease: job.lease, kind: "completed", answer: await execute(instance, job, signal, onThought) }
            } catch (e) {
              const reason = e instanceof BridgeFailure ? e.reason : "UNAVAILABLE"
              result = { lease: job.lease, kind: "failed", reason }
              if (reason === "RATE_LIMITED" || reason === "UNAUTHENTICATED")
                reports = reports.map((report) =>
                  report.localId === job.localId
                    ? {
                        ...report,
                        state: reason === "RATE_LIMITED" ? "usage_limited" : "unavailable",
                        auth: reason === "UNAUTHENTICATED" ? "unauthenticated" : report.auth
                      }
                    : report
                )
            }
            if (timer) clearTimeout(timer)
            try {
              await client.complete(job.id, result)
            } catch {
              /* A cancelled/revoked/expired result stays fenced on the server. */
            }
          })().finally(() => jobs.delete(job.id))
          jobs.set(job.id, { controller, promise })
        }
      } catch (e) {
        for (const job of jobs.values()) job.controller.abort()
        if (e instanceof BridgeFailure && e.reason === "UNAUTHENTICATED") {
          log("bridge revoked: pair again in Settings")
          break
        }
        if (failures++ === 0) log("OpenRecord unavailable: reconnecting")
      }
      // A long poll that waited already paced the loop; poll again at once.
      if (!failures && !quick) continue
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, Math.min(1000 * 2 ** Math.min(failures, 4), 15000))
        function done() {
          clearTimeout(timer)
          shutdown.signal.removeEventListener("abort", done)
          resolve()
        }
        shutdown.signal.addEventListener("abort", done, { once: true })
      })
    }
  } finally {
    shutdown.abort()
    for (const job of jobs.values()) job.controller.abort()
    await Promise.allSettled([...jobs.values()].map((j) => j.promise))
    process.removeListener("SIGINT", stop)
    process.removeListener("SIGTERM", stop)
    sessions.closeAll()
    await release()
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)))
  main().catch((error) => {
    process.stderr.write(
      error instanceof BridgeSetupError
        ? `${error.message}\n`
        : "OpenRecord bridge failed. Check installation, pairing, and the local configuration permissions.\n"
    )
    process.exitCode = 1
  })
