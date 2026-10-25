import { randomUUID } from "node:crypto"
import { chmod, lstat, mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { spawn } from "node:child_process"
import { realpathSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { Schema } from "effect"
import { HARNESS_NAMES, HarnessDriver, type HarnessJobResult, type HarnessReport } from "@openrecord/contracts"
import { LocalInstance, executableFor, execute, probe } from "./adapters.js"
import { BridgeClient, serverOrigin } from "./client.js"
import { BridgeFailure, driverEnvironment } from "./process.js"

const Config = Schema.Struct({
  server: Schema.String,
  bridgeId: Schema.UUID,
  token: Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9_-]{43}$/)),
  instances: Schema.Array(LocalInstance).pipe(Schema.maxItems(32))
})
type Config = typeof Config.Type
const root = join(homedir(), ".openrecord"),
  file = join(root, "bridge.json")
const log = (event: string) => process.stdout.write(JSON.stringify({ event }) + "\n")
class BridgeSetupError extends Error {}
async function acquireLock() {
  await mkdir(root, { recursive: true, mode: 0o700 })
  const info = await lstat(root)
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new BridgeSetupError("Bridge configuration directory is not a regular directory")
  const lock = join(root, "bridge.lock")
  const handle = await open(lock, "wx", 0o600).catch(() => {
    throw new BridgeSetupError(
      "A bridge lock exists. Stop the other bridge; after a crash remove only ~/.openrecord/bridge.lock and restart."
    )
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
      "OpenRecord local harness bridge (Node 24+)\n\npair --server <OpenRecord origin> --code <code from Settings>\nrun                         Start a paired bridge\nprobe                       Check installed providers without generating answers\nlogin --driver <driver>     Run an official provider login\nlogin --instance <local id> Sign in to a specific local instance\nadd --driver <driver> --name <name> [--home <directory>] [--binary <path>]\n\nDrivers: codex, claude, opencode, cursor. Provider credentials remain local.\n"
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
      const drivers: HarnessDriver[] = ["codex", "claude", "opencode", "cursor"]
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
      name = option(args, "--name") ?? HARNESS_NAMES[driver]
    if (config.instances.length >= 32) throw new BridgeSetupError("At most 32 local instances are supported")
    await save({
      ...config,
      instances: [
        ...config.instances,
        { id: randomUUID(), driver, name, ...(home ? { home } : {}), ...(binary ? { binary } : {}) }
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
    const binary = await executableFor(instance)
    const commands = { codex: ["login"], claude: ["auth", "login"], opencode: ["auth", "login"], cursor: ["login"] }
    const env = driverEnvironment(instance.driver)
    if (instance.home) {
      if (instance.driver === "codex") env["CODEX_HOME"] = instance.home
      else if (instance.driver === "claude") env["CLAUDE_CONFIG_DIR"] = instance.home
      else if (instance.driver === "opencode") env["OPENCODE_CONFIG_DIR"] = instance.home
    }
    await new Promise<void>((resolve, reject) => {
      const child = spawn(binary, commands[instance.driver], { env, shell: false, stdio: "inherit" })
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
    failures = 0
  try {
    log("bridge running: credentials stay with local providers")
    while (!shutdown.signal.aborted) {
      try {
        if (Date.now() - checkedAt > 30000 && !jobs.size) {
          reports = await Promise.all(config.instances.map(probe))
          checkedAt = Date.now()
        }
        const poll = await client.poll(reports, jobs.size < 2)
        if (poll.refresh) checkedAt = 0
        failures = 0
        for (const [id, job] of jobs) if (!poll.active.includes(id)) job.controller.abort()
        if (poll.job) {
          const job = poll.job,
            controller = new AbortController()
          const instance = config.instances.find((i) => i.id === job.localId)
          const signal = AbortSignal.any([controller.signal, shutdown.signal, AbortSignal.timeout(90000)])
          const promise = (async () => {
            let result: HarnessJobResult
            try {
              if (!instance) throw new BridgeFailure("UNAVAILABLE")
              result = { lease: job.lease, kind: "completed", answer: await execute(instance, job, signal) }
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
