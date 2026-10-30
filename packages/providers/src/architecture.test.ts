import { describe, expect, it } from "vitest"
import { readFileSync, readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { join } from "node:path"
const root = fileURLToPath(new URL("../../../", import.meta.url))
const sources = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
  if (["node_modules", "dist", ".git"].includes(entry.name)) return []
  const path = join(dir, entry.name)
  return entry.isDirectory() ? sources(path) : /\.[cm]?tsx?$/.test(path) && !path.includes(".test.") ? [path] : []
})
// These entry/process owners run on the user's machine, never in the hosted
// graph. fs-containment's import guard enforces that deployment boundary.
const LOCAL_PROCESS_OWNERS = new Set([
  join(root, "packages/bridge/src/main.ts"),
  join(root, "packages/bridge/src/process.ts"),
  // The local-mode launcher: starts only this Node binary on the bridge program, gated by OPENRECORD_LOCAL_BRIDGE.
  join(root, "packages/fs-containment/src/local-bridge-process.ts"),
])
describe("hosted Effect architecture guards", () => {
  it("has no Rust execution, subprocess, or IPC dependency in hosted sources", () => {
    for (const path of [...sources(join(root, "apps")), ...sources(join(root, "packages"))]) {
      const source = readFileSync(path, "utf8")
      expect(source, path).not.toMatch(/RustObservationWorker|OPENRECORD_WORKER_PATH|openrecord-worker-(job|result)-v1|target\/(debug|release)\/openrecord-worker/)
      if (!LOCAL_PROCESS_OWNERS.has(path)) expect(source, path).not.toMatch(/child_process|\bspawn\s*\(/)
    }
  })
  it("providers use injectable HTTP and Config capabilities without direct globals", () => {
    for (const path of sources(join(root, "packages/providers/src"))) {
      expect(readFileSync(path, "utf8"), path).not.toMatch(/process\.env|\bfetch\s*\(|node:https?|axios|undici/)
    }
    const nine = readFileSync(join(root, "packages/providers/src/nine-router.ts"), "utf8")
    expect(nine).toContain("Schema.decodeUnknown")
    expect(nine).toContain("http.execute")
    expect(nine).toContain("response.stream")
    expect(nine).not.toMatch(/response\.json\(|response\.arrayBuffer/)
  })
  it("retry policy and persistence remain owned by CheckRunner", () => {
    const runner = readFileSync(join(root, "apps/worker/src/check-runner.ts"), "utf8")
    expect(runner).toContain("ProviderRegistry")
    expect(runner).toContain("Schedule.recurs(3)")
    expect(runner).toContain("isRetryableProviderError")
    expect(runner).toContain("completeRun: true")
    for (const path of sources(join(root, "packages/providers/src"))) expect(readFileSync(path, "utf8"), path).not.toContain("Effect.retry")
  })
  it("hosted CI and config need no Rust installation or worker path", () => {
    const hosted = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8").split("  hosted:")[1]!
    expect(hosted).not.toMatch(/cargo|rust-toolchain|rust-cache|OPENRECORD_WORKER_PATH/)
    expect(readFileSync(join(root, ".env.example"), "utf8")).not.toContain("OPENRECORD_WORKER_PATH")
  })
})
