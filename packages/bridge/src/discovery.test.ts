import { delimiter, join } from "node:path"
import { describe, expect, it } from "vitest"
import type { HarnessReport } from "@openrecord/contracts"
import { codexLimit } from "./adapters.js"
import { knownDirectories, mergePaths, parseShellPath } from "./discovery.js"
import { HOLD_MS, UsageLimits } from "./limits.js"

describe("finding provider CLIs", () => {
  it("knows the common install folders, newest nvm Node first", () => {
    const dirs = knownDirectories("/Users/t", "darwin", d => d.endsWith(join(".nvm", "versions", "node")) ? ["v18.20.1", "v20.19.5", "v9.0.0", "system"] : [])
    expect(dirs).toEqual(expect.arrayContaining(["/opt/homebrew/bin", "/usr/local/bin", "/Users/t/.local/bin", "/Users/t/.bun/bin", "/Users/t/.npm-global/bin", "/Users/t/.volta/bin"]))
    const nvm = dirs.filter(d => d.includes(".nvm"))
    expect(nvm).toEqual(["/Users/t/.nvm/versions/node/v20.19.5/bin", "/Users/t/.nvm/versions/node/v18.20.1/bin", "/Users/t/.nvm/versions/node/v9.0.0/bin"])
    expect(knownDirectories("C:\\Users\\t", "win32", () => [])).not.toContain("/opt/homebrew/bin")
  })

  it("searches its own PATH, then the login shell's, then known folders, without duplicates or node_modules", () => {
    const merged = mergePaths([["/usr/bin", "/repo/node_modules/.bin"].join(delimiter), ["/opt/homebrew/bin", "/usr/bin"].join(delimiter), null], ["/opt/homebrew/bin", "/Users/t/.local/bin"])
    expect(merged).toEqual(["/usr/bin", "/opt/homebrew/bin", "/Users/t/.local/bin"])
  })

  it("reads the PATH from a login shell even when its startup files print around it", () => {
    expect(parseShellPath("Welcome!\n__OPENRECORD_PATH__/a:/b__OPENRECORD_PATH__\nbye")).toBe("/a:/b")
    expect(parseShellPath("no markers")).toBeNull()
  })
})

describe("usage limits", () => {
  it("reads when Codex's limit lifts from its rate-limit windows", () => {
    // The shape Codex 0.163 returns for a Plus plan whose weekly window is used up.
    const limited = { ordinaryUsageAllowed: false, rateLimits: { primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: 1793454769 }, secondary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: 1793774208 }, rateLimitReachedType: "rate_limit_reached" } }
    expect(codexLimit(limited)).toEqual({ resetsAt: new Date(1793774208 * 1000).toISOString() })
    expect(codexLimit({ ordinaryUsageAllowed: true, rateLimits: { primary: { usedPercent: 40, resetsAt: 1 } } })).toBeNull()
    expect(codexLimit(null)).toBeNull()
    expect(codexLimit({ ordinaryUsageAllowed: false })).toEqual({ resetsAt: null })
  })

  it("keeps a refused provider usage-limited across probes until a run succeeds or the hold ends", () => {
    let now = 0
    const limits = new UsageLimits(() => now)
    const ready = { localId: "11111111-1111-4111-8111-111111111111", driver: "claude", name: "Claude Code", installed: true, version: "1", auth: "authenticated", state: "ready", models: [] } satisfies HarnessReport
    expect(limits.apply([ready])[0]?.state).toBe("ready")
    limits.hit(ready.localId)
    expect(limits.apply([ready])[0]?.state).toBe("usage_limited")
    expect(limits.apply([{ ...ready, state: "unavailable" }])[0]?.state).toBe("unavailable")
    limits.clear(ready.localId)
    expect(limits.apply([ready])[0]?.state).toBe("ready")
    limits.hit(ready.localId)
    now = HOLD_MS + 1
    expect(limits.apply([ready])[0]?.state).toBe("ready")
  })
})

describe("OpenCode reasoning levels", () => {
  const models = [{ id: "a", name: "A" }, { id: "b", name: "B" }, { id: "c", name: "C" }]
  it("asks about each model once, remembers the answer, and stays within its time budget", async () => {
    const { withReasoningLevels } = await import("./adapters.js")
    let now = 0
    const asked: string[] = []
    const lookup = async (id: string) => { asked.push(id); now += 5; return id === "a" ? ["low", "high"] as const : [] }
    const first = await withReasoningLevels("budget-test", models, lookup, 8, () => now)
    expect(asked).toEqual(["a", "b"])
    expect(first).toEqual([{ id: "a", name: "A", reasoningEfforts: ["low", "high"] }, { id: "b", name: "B" }, { id: "c", name: "C" }])
    await withReasoningLevels("budget-test", models, lookup, 8, () => now)
    expect(asked).toEqual(["a", "b", "c"])
    await withReasoningLevels("budget-test", models, lookup, 8, () => now)
    expect(asked).toEqual(["a", "b", "c"])
  })
  it("stops asking after a failure and keeps instances apart", async () => {
    const { withReasoningLevels } = await import("./adapters.js")
    const asked: string[] = []
    const failing = async (id: string) => { asked.push(id); throw new Error("TEST") }
    expect(await withReasoningLevels("fail-test", models, failing)).toEqual(models)
    expect(asked).toEqual(["a"])
    const other: string[] = []
    await withReasoningLevels("other-test", models, async id => { other.push(id); return [] })
    expect(other).toEqual(["a", "b", "c"])
  })
})
