import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import {
  AuthorizeExecution, ConnectExecutionTarget, EXECUTION_IN_FLIGHT, EXECUTION_TERMINAL, EXECUTION_TRANSITIONS, ExecutionState, PrepareExecution, allowedExecutionPathProblem,
  canTransitionExecution, diffLines, executionFacts, executionPathAllowed, executionPathProblem, executionRepositoryDenied, unifiedDiff, type ExecutionOperation,
} from "./index.js"

const uuid = "00000000-0000-4000-8000-000000000001"
describe("connected execution contracts", () => {
  it("accepts only plain, relative HTML pages and refuses escapes, hidden files and other types", () => {
    for (const ok of ["index.html", "pages/about.html", "a/b/c/d.htm", "Pricing_2.HTML"]) expect(executionPathProblem(ok), ok).toBeNull()
    const bad: Array<[string, string]> = [["", "PATH_LENGTH"], ["../x.html", "PATH_TRAVERSAL"], ["a/../b.html", "PATH_TRAVERSAL"], ["/abs.html", "PATH_NOT_RELATIVE_FILE"], ["a//b.html", "PATH_TRAVERSAL"],
      [".github/x.html", "PATH_HIDDEN_SEGMENT"], ["a/.env.html", "PATH_HIDDEN_SEGMENT"], ["notes.md", "PATH_EXTENSION"], ["x.js", "PATH_EXTENSION"], ["a b.html", "PATH_CHARACTERS"], ["a\\b.html", "PATH_CHARACTERS"],
      ["dir/", "PATH_NOT_RELATIVE_FILE"], ["a/b/c/d/e/f/g/h/i/j/k/l/m.html", "PATH_DEPTH"], ["é.html", "PATH_CHARACTERS"]]
    for (const [path, problem] of bad) expect(executionPathProblem(path), path).toBe(problem)
    expect(allowedExecutionPathProblem("pages/")).toBeNull()
    expect(allowedExecutionPathProblem("/")).toBe("PATH_ROOT_NOT_ALLOWED")
    expect(allowedExecutionPathProblem("../")).toBe("PATH_TRAVERSAL")
    expect(executionPathAllowed("pages/about.html", ["pages/"])).toBe(true)
    expect(executionPathAllowed("pagesx/about.html", ["pages/"])).toBe(false)
    expect(executionPathAllowed("pricing.html", ["pricing.html"])).toBe(true)
    expect(executionPathAllowed("pricing.html.html", ["pricing.html"])).toBe(false)
    expect(executionPathAllowed("../pricing.html", ["../"])).toBe(false)
  })

  it("never allows OpenRecord's own repository, in any case", () => {
    expect(executionRepositoryDenied("commonfields", "openrecord")).toBe(true)
    expect(executionRepositoryDenied("CommonFields", "OpenRecord")).toBe(true)
    expect(executionRepositoryDenied("commonfields", "openrecord-site")).toBe(false)
    expect(executionRepositoryDenied("acme", "site", ["Acme/Site"])).toBe(true)
  })

  it("gives the assistant no authority, the person every human step and the system every provider fact", () => {
    for (const to of ExecutionState.literals) {
      expect(canTransitionExecution("PREPARED", to, "ASSISTANT"), `assistant -> ${to}`).toBe(false)
    }
    expect(canTransitionExecution(null, "PREPARED", "ASSISTANT")).toBe(true)
    expect(canTransitionExecution("PREPARED", "AUTHORIZED", "OPERATOR")).toBe(true)
    expect(canTransitionExecution("PREPARED", "AUTHORIZED", "EXECUTION_SYSTEM")).toBe(false)
    expect(canTransitionExecution("AUTHORIZED", "DISPATCHING", "EXECUTION_SYSTEM")).toBe(false)
    expect(canTransitionExecution("RECONCILING", "VERIFIED", "OPERATOR")).toBe(false)
    expect(canTransitionExecution("AWAITING_MERGE", "VERIFIED", "EXECUTION_SYSTEM")).toBe(false)     // verification passes through reconciliation
    expect(canTransitionExecution("DISPATCHING", "VERIFIED", "EXECUTION_SYSTEM")).toBe(false)
    expect(EXECUTION_TRANSITIONS.filter(t => t.from !== null && EXECUTION_TERMINAL.includes(t.from))).toEqual([])
    expect(EXECUTION_IN_FLIGHT.every(s => !EXECUTION_TERMINAL.includes(s))).toBe(true)
    // Every state is reachable from PREPARED and every non-terminal state can settle.
    const reach = new Set<string>(["PREPARED"]); let grew = true
    while (grew) { grew = false; for (const t of EXECUTION_TRANSITIONS) if (t.from && reach.has(t.from) && !reach.has(t.to)) { reach.add(t.to); grew = true } }
    expect([...reach].sort()).toEqual([...ExecutionState.literals].sort())
  })

  it("derives three separate facts and never merges them", () => {
    const base = { evidence: [], liveChecks: [] } as Pick<ExecutionOperation, "evidence" | "liveChecks">
    const pr = { id: uuid, kind: "PR_OPENED" as const, detail: {}, observedAt: "2026-10-20T00:00:00.000Z" }
    const live = (result: "CHANGE_OBSERVED" | "CHANGE_NOT_OBSERVED" | "INCONCLUSIVE") => ({ id: uuid, result, url: "https://x.test", httpStatus: 200, detail: "d", bodyDigest: null, checkedAt: "2026-10-20T00:00:00.000Z" })
    expect(executionFacts({ state: "PREPARED", ...base })).toEqual({ request: "NOT_SENT", providerAction: "NOT_VERIFIED", liveChange: "NOT_CHECKED" })
    expect(executionFacts({ state: "DISPATCHING", ...base })).toEqual({ request: "ACCEPTED_BY_OPENRECORD", providerAction: "NOT_VERIFIED", liveChange: "NOT_CHECKED" })
    expect(executionFacts({ state: "AWAITING_MERGE", evidence: [pr], liveChecks: [] })).toEqual({ request: "ACCEPTED_BY_PROVIDER", providerAction: "NOT_VERIFIED", liveChange: "NOT_CHECKED" })
    expect(executionFacts({ state: "VERIFIED", evidence: [pr], liveChecks: [] }).liveChange).toBe("PENDING")
    expect(executionFacts({ state: "VERIFIED", evidence: [pr], liveChecks: [live("CHANGE_OBSERVED")] }).liveChange).toBe("OBSERVED")
    // Only the newest check counts; newest first.
    expect(executionFacts({ state: "VERIFIED", evidence: [pr], liveChecks: [live("INCONCLUSIVE"), live("CHANGE_OBSERVED")] }).liveChange).toBe("INCONCLUSIVE")
    // A page that changed without a verified merge says nothing about this authorization.
    for (const state of ["AWAITING_MERGE", "RECONCILING", "FAILED", "BLOCKED"] as const) expect(executionFacts({ state, evidence: [pr], liveChecks: [live("CHANGE_OBSERVED")] }).liveChange).toBe("NOT_CHECKED")
    // A stopped operation is never reported as "not performed": OpenRecord cannot prove a negative.
    expect(executionFacts({ state: "BLOCKED", evidence: [pr], liveChecks: [] }).providerAction).toBe("NOT_VERIFIED")
  })

  it("decodes strict requests", () => {
    const decode = <A, I>(s: Schema.Schema<A, I>, v: unknown) => Schema.decodeUnknownEither(s, { onExcessProperty: "error" })(v)._tag === "Right"
    const prepare = { targetId: uuid, actionKind: "REMOVE_NOINDEX_META", filePath: "pricing.html", liveUrl: "https://salon.test/pricing.html", rationale: "TEST", siteFindingId: null, idempotencyKey: uuid }
    expect(decode(PrepareExecution, prepare)).toBe(true)
    expect(decode(PrepareExecution, { ...prepare, actionKind: "REWRITE" })).toBe(false)
    expect(decode(PrepareExecution, { ...prepare, filePath: "../x.html" })).toBe(false)
    expect(decode(PrepareExecution, { ...prepare, liveUrl: "javascript:alert(1)" })).toBe(false)
    expect(decode(PrepareExecution, { ...prepare, rationale: "   " })).toBe(false)
    expect(decode(PrepareExecution, { ...prepare, token: "x" })).toBe(false)
    expect(decode(AuthorizeExecution, { reviewedPatchSha256: "a".repeat(64), expectedRevision: 1, reason: "r", idempotencyKey: uuid })).toBe(true)
    expect(decode(AuthorizeExecution, { reviewedPatchSha256: "A".repeat(64), expectedRevision: 1, reason: "r", idempotencyKey: uuid })).toBe(false)
    const connect = { owner: "acme", repository: "site", baseBranch: "main", siteTargetId: uuid, allowedPaths: ["pricing.html"], idempotencyKey: uuid }
    expect(decode(ConnectExecutionTarget, connect)).toBe(true)
    for (const bad of [{ owner: "a/b" }, { repository: "../x" }, { baseBranch: "a..b" }, { baseBranch: "x.lock" }, { allowedPaths: [] }, { allowedPaths: ["notes.md"] }, { allowedPaths: ["../"] }]) expect(decode(ConnectExecutionTarget, { ...connect, ...bad }), JSON.stringify(bad)).toBe(false)
  })

  it("renders a minimal reviewable diff of the one-line change", () => {
    const before = "<head>\n<title>x</title>\n<meta name=\"robots\" content=\"noindex\">\n</head>\n"
    const after = "<head>\n<title>x</title>\n</head>\n"
    const diff = unifiedDiff("pricing.html", diffLines(before, after))
    expect(diff).toBe('--- a/pricing.html\n+++ b/pricing.html\n@@ -1,5 +1,4 @@\n <head>\n <title>x</title>\n-<meta name="robots" content="noindex">\n </head>\n ')
    expect(diffLines(before, before)).toEqual([])
  })
})
