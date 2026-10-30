import { afterEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { managedBridgeId, managedBridgePid, managedBridgeUsers, prepareManagedBridgeHome } from "../src/local-bridge-files.js"

const roots: string[] = []
const id = "00000000-0001-4100-8000-000000000001"
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "openrecord-bridge-files-test-"))
  roots.push(root)
  vi.stubEnv("OPENRECORD_LOCAL_BRIDGE", "1")
  vi.stubEnv("OPENRECORD_LOCAL_BRIDGE_HOME", root)
  const home = join(root, id)
  prepareManagedBridgeHome(home)
  return { root, home }
}
describe("managed local bridge files", () => {
  it("returns only the bridge identity and lock PID, never credentials", () => {
    const { home } = fixture()
    writeFileSync(join(home, "bridge.json"), JSON.stringify({ bridgeId: id, token: "TEST not a real credential" }))
    writeFileSync(join(home, "bridge.lock"), String(process.pid))
    expect(managedBridgeId(home)).toBe(id)
    expect(managedBridgePid(home)).toBe(process.pid)
    expect(managedBridgeUsers()).toEqual([id])
    expect(() => prepareManagedBridgeHome(join(home, "..", "unexpected"))).toThrow()
  })
  it("refuses symlinked state and all operations when local mode is disabled", () => {
    const { root, home } = fixture()
    const target = join(root, "outside.json")
    writeFileSync(target, JSON.stringify({ bridgeId: id }))
    symlinkSync(target, join(home, "bridge.json"))
    expect(managedBridgeId(home)).toBeNull()
    vi.stubEnv("OPENRECORD_LOCAL_BRIDGE", "0")
    expect(managedBridgeUsers()).toEqual([])
    expect(managedBridgePid(home)).toBeNull()
    expect(() => prepareManagedBridgeHome(home)).toThrow()
  })
})
