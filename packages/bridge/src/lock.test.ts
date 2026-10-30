// The bridge's lock after a crash or restart: a lock naming a process that is
// gone is taken over, a live one is respected, and a lock another bridge has
// only just created is left alone.
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { staleLock } from "./main.js"

describe("bridge lock", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openrecord-lock-"))
  const lock = join(dir, "bridge.lock")
  afterAll(() => rm(dir, { recursive: true, force: true }))

  it("takes over a lock whose process is gone", async () => {
    // A process that has exited: its pid names nothing now.
    const gone = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"]).stdout.toString()
    await writeFile(lock, gone)
    expect(await staleLock(lock)).toBe(true)
  })
  it("respects a live process, including this one", async () => {
    await writeFile(lock, String(process.ppid))
    expect(await staleLock(lock)).toBe(false)
    await writeFile(lock, String(process.pid))
    expect(await staleLock(lock)).toBe(false)
  })
  it("waits a few seconds before treating an empty lock as stale", async () => {
    await writeFile(lock, "")
    expect(await staleLock(lock)).toBe(false)
    const old = new Date(Date.now() - 10_000)
    await utimes(lock, old, old)
    expect(await staleLock(lock)).toBe(true)
  })
})
