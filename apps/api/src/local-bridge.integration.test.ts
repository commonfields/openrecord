// This computer's bridge, started by the server: paired without a code on
// first use, reused while valid, and its installed, signed-in providers turn
// on by themselves unless the person chose otherwise. A stand-in bridge
// program records how it was started; no provider CLI runs.
import { randomUUID } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Effect, Redacted } from "effect"
import { PgClient } from "@effect/sql-pg"
import pg from "pg"
import type { HarnessReport } from "@openrecord/contracts"
import type { Session } from "@openrecord/db"
import { activateHarness, harnessCatalog, pollHarnessJobs, registerBridge, revokeBridge } from "./harness-store.js"
import { ensureLocalBridge } from "./local-bridge.js"

const url = process.env["TEST_DATABASE_URL"] ?? ""
const suite = url ? describe : describe.skip

suite("local bridge (disposable PostgreSQL, stand-in bridge program)", () => {
  const layer = PgClient.layer({ url: Redacted.make(url) })
  const run = <A, E>(fx: Effect.Effect<A, E, import("@effect/sql").SqlClient.SqlClient>) => Effect.runPromise(fx.pipe(Effect.provide(layer)))
  const root = mkdtempSync(join(tmpdir(), "or-local-bridge-"))
  const script = join(root, "bridge.mjs")
  let pool: pg.Pool, session: Session
  const saved = { ...process.env }

  beforeAll(async () => {
    // The stand-in writes its arguments and home, then exits.
    writeFileSync(script, `import { writeFileSync } from "node:fs"; import { join } from "node:path";
      const home = process.env.OPENRECORD_BRIDGE_HOME; writeFileSync(join(home, "started.json"), JSON.stringify({ args: process.argv.slice(2), path: process.env.PATH, env: Object.keys(process.env) }))`)
    process.env["OPENRECORD_LOCAL_BRIDGE"] = "1"
    process.env["OPENRECORD_BRIDGE_SCRIPT"] = script
    process.env["OPENRECORD_LOCAL_BRIDGE_HOME"] = join(root, "homes")
    process.env["ANTHROPIC_API_KEY"] = "PRIVATE-hosted"
    process.env["SESSION_SECRET"] = "PRIVATE-session"
    pool = new pg.Pool({ connectionString: url })
    const accountId = String((await pool.query("INSERT INTO accounts(name) VALUES('TEST local bridge') RETURNING id")).rows[0].id)
    const userId = String((await pool.query("INSERT INTO users(email,password_hash) VALUES($1,'TEST') RETURNING id", [`local-${randomUUID()}@example.test`])).rows[0].id)
    await pool.query("INSERT INTO account_users(account_id,user_id) VALUES($1,$2)", [accountId, userId])
    session = { accountId, userId } as Session
  })
  afterAll(async () => {
    process.env = saved
    await pool.end()
  })

  const home = () => join(root, "homes", session.userId)
  const started = async () => {
    const file = join(home(), "started.json")
    for (let i = 0; i < 100 && !existsSync(file); i++) await new Promise(r => setTimeout(r, 50))
    const value = JSON.parse(readFileSync(file, "utf8")) as { args: string[]; path: string; env: string[] }
    unlinkSync(file)
    await new Promise(r => setTimeout(r, 100)) // the stand-in exits
    return value
  }
  const report = (localId: string, driver: HarnessReport["driver"], over: Partial<HarnessReport>): HarnessReport => ({
    localId, driver, name: driver, installed: true, version: "1", auth: "authenticated", state: "ready", models: [{ id: "m1", name: "m1" }], ...over,
  })

  it("pairs this computer without a code, turns on ready providers, and keeps the person's choice", async () => {
    expect(await run(ensureLocalBridge(session, 3999))).toBe("STARTED")
    const first = await started()
    expect(first.args.slice(0, 3)).toEqual(["pair", "--server", "http://127.0.0.1:3999"])
    expect(first.path.split(":")).toContain("/opt/homebrew/bin")
    // The server's own secrets and API keys never reach the bridge or the CLIs it runs.
    for (const secret of ["DATABASE_URL", "TEST_DATABASE_URL", "ANTHROPIC_API_KEY", "SESSION_SECRET"]) expect(first.env).not.toContain(secret)
    expect(first.env).toContain("HOME")

    // The bridge registers with the code it was given, as the real one does.
    const { bridgeId, token } = await run(registerBridge(first.args[4]!))
    writeFileSync(join(home(), "bridge.json"), JSON.stringify({ bridgeId }))
    expect(token).toHaveLength(43)
    const identity = { id: bridgeId, account_id: session.accountId, user_id: session.userId }
    const ids = { claude: randomUUID(), codex: randomUUID(), cursor: randomUUID(), cliproxy: randomUUID() }
    const reports = [
      report(ids.claude, "claude", { auth: "unknown" }),
      report(ids.codex, "codex", { auth: "unauthenticated" }),
      report(ids.cursor, "cursor", { installed: false, state: "unavailable", models: [] }),
      report(ids.cliproxy, "cliproxy", {}),
    ]
    await run(pollHarnessJobs(identity, reports, false))
    const enabled = async () => Object.fromEntries((await run(harnessCatalog(session))).instances.map(i => [i.driver, i.enabled]))
    expect(await enabled()).toEqual({ claude: true, codex: false, cursor: false, cliproxy: true })
    const catalog = await run(harnessCatalog(session))
    expect(catalog.bridges).toEqual([{ id: bridgeId, name: "This computer", online: true, managed: true }])

    // Turned off by the person: discovery never turns it back on.
    const claude = catalog.instances.find(i => i.driver === "claude")!
    await run(activateHarness(session, claude.id, false))
    await run(pollHarnessJobs(identity, reports, false))
    expect((await enabled())["claude"]).toBe(false)

    // Signed in later: it turns on at the next discovery.
    await run(pollHarnessJobs(identity, reports.map(r => r.driver === "codex" ? { ...r, auth: "authenticated" as const } : r), false))
    expect((await enabled())["codex"]).toBe(true)

    // A later start reuses the paired bridge.
    expect(await run(ensureLocalBridge(session, 3999))).toBe("STARTED")
    expect((await started()).args).toEqual(["run"])
  })

  it("stays off after the person disconnects it, until they connect again", async () => {
    const { bridges } = await run(harnessCatalog(session))
    await run(revokeBridge(session, bridges[0]!.id))
    expect(await run(ensureLocalBridge(session, 3999))).toBe("OFF")
    expect(await run(ensureLocalBridge(session, 3999, true))).toBe("STARTED")
    expect((await started()).args[0]).toBe("pair")

    process.env["OPENRECORD_LOCAL_BRIDGE"] = "0"
    expect(await run(ensureLocalBridge(session, 3999))).toBe("DISABLED")
    process.env["OPENRECORD_LOCAL_BRIDGE"] = "1"
  })
})
