import { afterEach, describe, expect, it } from "vitest"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { startManagedBridge } from "../src/local-bridge-process.js"

const saved = { mode: process.env["OPENRECORD_LOCAL_BRIDGE"], home: process.env["OPENRECORD_LOCAL_BRIDGE_HOME"] }
afterEach(() => {
  for (const [key, value] of [["OPENRECORD_LOCAL_BRIDGE", saved.mode], ["OPENRECORD_LOCAL_BRIDGE_HOME", saved.home]] as const)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
})
const user = "00000000-0000-4000-8000-000000000001"

describe("local bridge launcher", () => {
  it("refuses unless local bridge mode is on", () => {
    delete process.env["OPENRECORD_LOCAL_BRIDGE"]
    process.env["OPENRECORD_LOCAL_BRIDGE_HOME"] = join(tmpdir(), "or-bridges")
    expect(() => startManagedBridge(join(tmpdir(), "or-bridges", user), ["--version"], { env: {} })).toThrow(/not enabled/)
  })

  it("refuses a directory outside the managed bridge home or not named for a user", () => {
    process.env["OPENRECORD_LOCAL_BRIDGE"] = "1"
    process.env["OPENRECORD_LOCAL_BRIDGE_HOME"] = join(tmpdir(), "or-bridges")
    expect(() => startManagedBridge(join(tmpdir(), "elsewhere", user), ["--version"], { env: {} })).toThrow(/not enabled/)
    expect(() => startManagedBridge(join(tmpdir(), "or-bridges", "not-a-user"), ["--version"], { env: {} })).toThrow(/not enabled/)
  })

  it("starts only this Node binary for a managed home", async () => {
    process.env["OPENRECORD_LOCAL_BRIDGE"] = "1"
    process.env["OPENRECORD_LOCAL_BRIDGE_HOME"] = join(tmpdir(), "or-bridges")
    const child = startManagedBridge(join(tmpdir(), "or-bridges", user), ["-e", "process.stdout.write(process.execPath)"], { env: {} })
    let out = ""
    child.stdout?.on("data", (c: Buffer) => { out += c.toString() })
    await new Promise(r => child.once("exit", r))
    expect(out).toBe(process.execPath)
  })
})
