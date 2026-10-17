// AI Acquisition architecture boundary (no database): recommendation reviews
// are human-only, the acquisition loop never reuses Record Integrity verdicts,
// it adds no provider engine, and it has no public projection.
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
const root = fileURLToPath(new URL("../../../", import.meta.url))
const sources = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
  if (["node_modules", "dist", ".git"].includes(entry.name)) return []
  const path = join(dir, entry.name)
  return entry.isDirectory() ? sources(path) : /\.tsx?$/.test(path) && !path.includes(".test.") ? [path] : []
})
const read = (rel: string) => readFileSync(join(root, rel), "utf8")

describe("AI acquisition human-review boundary", () => {
  it("worker, scripts, seeds and migrations never write recommendation reviews", () => {
    const scanned = [...sources(join(root, "apps/worker/src")), ...sources(join(root, "scripts")), join(root, "packages/db/src/seed.ts")]
    for (const path of scanned) expect(readFileSync(path, "utf8"), path).not.toMatch(/INSERT INTO acq_judgments|AcquisitionRepository/)
    for (const file of readdirSync(join(root, "packages/db/migrations")).filter(f => f.endsWith(".sql"))) {
      expect(read(`packages/db/migrations/${file}`), file).not.toMatch(/INSERT INTO acq_judgments|UPDATE\s+acq_judgments/)
    }
  })
  it("detection proposes candidates only; there is no automatic or LLM judge", () => {
    const detect = read("packages/db/src/acquisition-detect.ts").split("\n").filter(l => !l.trim().startsWith("//")).join("\n")
    expect(detect).not.toMatch(/RECOMMENDED|recommended\s*:/)
    expect(detect).not.toMatch(/ProviderRegistry|fetch\(|jev/i)
    const routes = read("apps/api/src/acquisition-routes.ts")
    expect(routes).toContain("judge(session")
    expect(routes).not.toMatch(/reviewed_by|reviewedBy|ProviderRegistry|jev/i)
  })
  it("never reuses Record Integrity verdicts for recommendation status", () => {
    for (const rel of ["packages/db/src/acquisition.ts", "packages/db/src/acquisition-view.ts", "packages/db/migrations/0026_ai_acquisition_pilot_v1.sql"]) {
      const body = read(rel).split("\n").filter(l => !l.trim().startsWith("--") && !l.trim().startsWith("//")).join("\n")
      expect(body, rel).not.toMatch(/MATCHES|CONTRADICTS|record_judgments/)
    }
  })
  it("adds no provider engine: batches only queue ordinary worker checks", () => {
    const repo = read("packages/db/src/acquisition.ts")
    expect(repo).toContain("INSERT INTO check_runs")
    expect(repo).not.toMatch(/@openrecord\/providers|generateContent|fetch\(/)
  })
  it("has no public route and no share projection", () => {
    const routes = read("apps/api/src/acquisition-routes.ts")
    expect(routes).not.toMatch(/\/api\/public|record_shares|publicRecord/)
  })
})
