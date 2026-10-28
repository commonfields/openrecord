// The bridge on this computer, run by OpenRecord itself. When the app runs on
// the person's own machine (the desktop app, or a local dev server with
// OPENRECORD_LOCAL_BRIDGE=1), the server starts a bridge for the signed-in
// user, pairs it without a code, and turns on each installed, signed-in
// provider (Codex, Claude Code, OpenCode, Cursor, CLIProxyAPI). Nothing to
// download or paste.
//
// Never enable this on a shared or hosted server: the bridge runs the
// provider CLIs with this machine's sign-ins for whoever is signed in.
import { spawn, type ChildProcess } from "node:child_process"
import { existsSync, readFileSync, unlinkSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { homedir } from "node:os"
import { delimiter, join } from "node:path"
import { fileURLToPath } from "node:url"
import { createHash, randomBytes } from "node:crypto"
import { SqlClient } from "@effect/sql"
import { Effect } from "effect"
import type { Session } from "@openrecord/db"

export const localBridgeEnabled = () => /^(1|true|on)$/i.test(process.env["OPENRECORD_LOCAL_BRIDGE"] ?? "")

const children = new Map<string, ChildProcess>()
process.once("exit", () => { for (const child of children.values()) child.kill("SIGTERM") })

const home = (userId: string) => join(process.env["OPENRECORD_LOCAL_BRIDGE_HOME"] ?? join(homedir(), ".openrecord", "app"), userId)
const hash = (token: string) => createHash("sha256").update(token).digest("hex")

/** The bridge program: an explicit path (the desktop bundle), this checkout's source, or the built download. */
const program = (): { args: string[]; cwd?: string } | null => {
  const explicit = process.env["OPENRECORD_BRIDGE_SCRIPT"]
  if (explicit) return existsSync(explicit) ? { args: [explicit] } : null
  const source = fileURLToPath(new URL("../../../packages/bridge/src/main.ts", import.meta.url))
  if (existsSync(source)) return { args: ["--import", "tsx", source], cwd: fileURLToPath(new URL("../../../packages/bridge/", import.meta.url)) }
  const bundle = fileURLToPath(new URL("../../web/public/openrecord-bridge.mjs", import.meta.url))
  return existsSync(bundle) ? { args: [bundle] } : null
}

// Apps opened from the Dock or Finder get a short PATH; add where CLIs usually live.
const cliPath = () => [...new Set([...(process.env["PATH"] ?? "").split(delimiter),
  "/opt/homebrew/bin", "/usr/local/bin", join(homedir(), ".local", "bin"), join(homedir(), ".opencode", "bin"),
  join(homedir(), ".npm-global", "bin"), join(homedir(), ".bun", "bin"), join(homedir(), ".cargo", "bin")].filter(Boolean))].join(delimiter)

// What the bridge may see of the server's environment: system paths, the CLIs'
// own sign-in directories and CLIProxyAPI's key. Never the server's secrets or
// API keys: an ANTHROPIC_API_KEY or OPENAI_API_KEY meant for hosted models
// would make the CLIs bill that key instead of the person's subscription.
const BRIDGE_ENV = ["HOME", "USER", "LOGNAME", "SHELL", "USERPROFILE", "SYSTEMROOT", "APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME",
  "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY",
  "CODEX_HOME", "CLAUDE_CONFIG_DIR", "OPENCODE_CONFIG_DIR", "CLIPROXY_API_KEY", "CLIPROXY_CONFIG"]
export const bridgeEnvironment = (source: NodeJS.ProcessEnv, dir: string): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(BRIDGE_ENV.flatMap(k => source[k] === undefined ? [] : [[k, source[k]]])),
  PATH: cliPath(), OPENRECORD_BRIDGE_HOME: dir,
})

const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM" } }

/** A bridge from an earlier server process may still be running from this directory; a dead one leaves a stale lock. */
const runningElsewhere = (dir: string) => {
  const lock = join(dir, "bridge.lock")
  if (!existsSync(lock)) return false
  const pid = Number(readFileSync(lock, "utf8").trim())
  if (Number.isInteger(pid) && pid > 0 && alive(pid)) return true
  try { unlinkSync(lock) } catch { /* already gone */ }
  return false
}

const configuredBridgeId = (dir: string) => {
  try { const id = JSON.parse(readFileSync(join(dir, "bridge.json"), "utf8"))?.bridgeId; return typeof id === "string" ? id : null } catch { return null }
}

export type LocalBridgeStatus = "DISABLED" | "UNAVAILABLE" | "OFF" | "STARTED" | "RUNNING"

/**
 * Start this computer's bridge for the signed-in user, pairing it on first use.
 * Safe to call on every page load. Once the person disconnects "This computer"
 * in Settings it stays off until they connect it again (connect: true).
 */
export const ensureLocalBridge = (session: Session, serverPort: number, connect = false) =>
  Effect.gen(function* () {
    if (!localBridgeEnabled()) return "DISABLED" as LocalBridgeStatus
    const current = children.get(session.userId)
    if (current && current.exitCode === null && !current.killed) return "RUNNING" as LocalBridgeStatus
    const dir = home(session.userId)
    if (runningElsewhere(dir)) return "RUNNING" as LocalBridgeStatus
    const bridge = program()
    if (!bridge) return "UNAVAILABLE" as LocalBridgeStatus
    const sql = yield* SqlClient.SqlClient
    // Reuse the paired bridge while it is still valid; otherwise retire the old one and pair again.
    const existing = configuredBridgeId(dir)
    const valid = existing
      ? (yield* sql`SELECT id FROM agent_bridges WHERE id=${existing} AND account_id=${session.accountId} AND user_id=${session.userId}
          AND managed AND revoked_at IS NULL AND token_hash IS NOT NULL`).length > 0
      : false
    if (!valid && existing && !connect) {
      const revoked = yield* sql`SELECT id FROM agent_bridges WHERE id=${existing} AND account_id=${session.accountId} AND user_id=${session.userId} AND managed AND revoked_at IS NOT NULL`
      if (revoked.length) return "OFF" as LocalBridgeStatus
    }
    let args: string[]
    if (valid) args = ["run"]
    else {
      const code = randomBytes(32).toString("base64url")
      yield* sql.withTransaction(Effect.gen(function* () {
        const retired = yield* sql`UPDATE agent_bridges SET revoked_at=now(),token_hash=NULL,pair_hash=NULL
          WHERE account_id=${session.accountId} AND user_id=${session.userId} AND managed AND revoked_at IS NULL RETURNING id`
        for (const row of retired) {
          yield* sql`UPDATE agent_harness_instances SET enabled=false WHERE bridge_id=${String(row["id"])}`
          yield* sql`UPDATE agent_harness_jobs SET status='CANCELLED',lease=NULL,input='{}',result=NULL,completed_at=now()
            WHERE bridge_id=${String(row["id"])} AND status IN ('QUEUED','RUNNING')`
        }
        yield* sql`INSERT INTO agent_bridges(account_id,user_id,name,pair_hash,managed) VALUES(${session.accountId},${session.userId},'This computer',${hash(code)},true)`
      }))
      args = ["pair", "--server", `http://127.0.0.1:${serverPort}`, "--code", code]
    }
    yield* Effect.promise(() => mkdir(dir, { recursive: true, mode: 0o700 }))
    const child = spawn(process.execPath, [...bridge.args, ...args], {
      ...(bridge.cwd ? { cwd: bridge.cwd } : {}),
      env: bridgeEnvironment(process.env, dir),
      stdio: ["ignore", "pipe", "pipe"], shell: false,
    })
    children.set(session.userId, child)
    // The bridge prints one JSON event per line and never prints credentials.
    child.stdout?.on("data", (chunk: Buffer) => { for (const line of chunk.toString("utf8").split("\n")) if (line.trim()) Effect.runFork(Effect.logInfo(`local bridge: ${line.trim().slice(0, 300)}`)) })
    child.stderr?.on("data", (chunk: Buffer) => Effect.runFork(Effect.logWarning(`local bridge: ${chunk.toString("utf8").trim().slice(0, 300)}`)))
    child.once("exit", () => { if (children.get(session.userId) === child) children.delete(session.userId) })
    return "STARTED" as LocalBridgeStatus
  })
