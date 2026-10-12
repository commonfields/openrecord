// Record integrity architecture boundary (no database): human judgments
// cannot be fabricated by workers, seeds or scripts; the public projection
// allowlist holds at the source level; customer-facing copy never implies
// that OpenRecord caused an external change.
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

describe("record integrity human-review boundary", () => {
  it("worker and engineering scripts never write record judgments, claims or approvals", () => {
    const scanned = [...sources(join(root, "apps/worker/src")), ...sources(join(root, "scripts")), join(root, "packages/db/src/seed.ts")]
    expect(scanned.length).toBeGreaterThan(0)
    for (const path of scanned) {
      const content = readFileSync(path, "utf8")
      expect(content, path).not.toMatch(/INSERT INTO record_judgments|INSERT INTO record_claims|INSERT INTO record_item_approvals/)
      expect(content, path).not.toMatch(/RecordRepository.*judge|record_judge/i)
    }
  })
  it("migrations never fabricate a human judgment, claim or approval", () => {
    for (const file of readdirSync(join(root, "packages/db/migrations")).filter(f => f.endsWith(".sql"))) {
      const content = readFileSync(join(root, "packages/db/migrations", file), "utf8")
      expect(content, file).not.toMatch(/INSERT INTO record_judgments|INSERT INTO record_claims|INSERT INTO record_item_approvals/)
      // Backfills may pin existing judgments to their fact version; they
      // must never set a verdict, a reviewer or review time.
      expect(content, file).not.toMatch(/UPDATE\s+record_judgments\s+SET[^;]*(decision|reviewed_by|reviewed_at)/)
    }
  })
  it("only the session-attributed repository path reviews, with temporal pinning", () => {
    const routes = readFileSync(join(root, "apps/api/src/record-routes.ts"), "utf8")
    expect(routes).not.toMatch(/reviewed_by|reviewedBy/)
    expect(routes).toContain("judge(session")
    const repo = readFileSync(join(root, "packages/db/src/record.ts"), "utf8")
    expect(repo).toContain("FactNotValidAtObservation")
  })
})

describe("record integrity evidence boundary", () => {
  it("the public projection exposes no reviewer identity, note or provider internals", () => {
    const view = readFileSync(join(root, "packages/db/src/record-view.ts"), "utf8")
    const publicSection = view.slice(view.indexOf("Public projection"))
    expect(publicSection).not.toContain("reviewed_by_user_id")
    expect(publicSection).not.toMatch(/judgment:\s*\{[^}]*note/)
    expect(publicSection).not.toContain("requestParameters")
    // Provider metadata enters only through the sanitized search-suggestion
    // sink; raw payloads and error detail never reach the projection.
    expect(publicSection).not.toMatch(/providerMetadata\s*[,}]/)
    expect(publicSection).toContain("searchSuggestionsHtml")
    expect(publicSection).toContain("Reviewed by the agency")
    expect(publicSection).toContain("CAUSALITY_DISCLOSURE")
  })
  it("emitted outcome copy never implies OpenRecord caused an external change", async () => {
    const { outcomeText, reasonText, sampleStatement } = await import("./record-view.js")
    const banned = /caused|because of|thanks to|led to|resulted in|fixed the AI|optimization successful|improvement/i
    const reasons = ["NO_BASELINE", "BEFORE_CHECK_FAILED", "AFTER_CHECK_FAILED", "FACT_CHANGED", "QUESTION_CHANGED", "SYNTHETIC_EVIDENCE",
      "BEFORE_NO_RETRIEVAL", "AFTER_NO_RETRIEVAL", "SURFACE_CHANGED", "SURFACE_UNKNOWN", "OUT_OF_ORDER",
      "BEFORE_UNKNOWN", "AFTER_UNKNOWN", "ANSWER_NO_LONGER_MATCHES", "BASELINE_MATCHED", "PARTIAL_RUN"] as const
    for (const reason of reasons) expect(reasonText(reason), reason).not.toMatch(banned)
    for (const outcome of ["OBSERVED_CORRECTED", "NO_OBSERVED_CHANGE", "RESOLVED_EXTERNALLY"] as const) {
      expect(outcomeText({ state: "DERIVED", outcome, reason: null }, []), outcome).not.toMatch(banned)
    }
    expect(outcomeText({ state: "DERIVED", outcome: "INDETERMINATE", reason: "AFTER_UNKNOWN" }, [])).not.toMatch(banned)
    expect(sampleStatement({ total: 5, reviewed: 5, contradict: 4, matches: 1, unknown: 0 })).not.toMatch(banned)
  })
})
