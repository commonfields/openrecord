// W7: the connected-change panel says exactly what is confirmed and never more.
import { describe, expect, it } from "vitest"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { executionFacts, type ExecutionOperation, type ExecutionState } from "@openrecord/contracts"
import { ExecutionCard, ExecutionFacts } from "../app/components/growth-execution"
import { EXECUTION_STATE_COPY, executionError, executionFactLines, executionStopCopy } from "../app/lib/growth-execution"
import { ApiError } from "../app/lib/api"

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const op = (state: ExecutionState, over: Partial<ExecutionOperation> = {}): ExecutionOperation => ({
  id: id(1), businessId: id(2), opportunityId: id(3), targetId: id(4), owner: "acme", repository: "salon-site", baseBranch: "main", actionKind: "REMOVE_NOINDEX_META",
  filePath: "pricing.html", liveUrl: "https://salon.test/pricing.html", siteFindingId: null, baseCommitSha: "a".repeat(40), baseBlobSha: "b".repeat(40), beforeSha256: "c".repeat(64), afterSha256: "d".repeat(64),
  patchSha256: "e".repeat(64), diff: '--- a/pricing.html\n+++ b/pricing.html\n@@ -1,3 +1,2 @@\n <head>\n-<meta name="robots" content="noindex">\n </head>', rationale: "TEST", proposedBy: "OPERATOR", createdByUserId: id(5),
  createdAt: "2026-10-20T00:00:00.000Z", state, revision: 3, events: [{ id: id(6), state, revision: 1, actor: "OPERATOR", userId: id(5), reason: "TEST", detail: {}, createdAt: "2026-10-20T00:00:00.000Z" }],
  evidence: [], liveChecks: [], receipt: null, ...over,
})
const pr = { id: id(7), kind: "PR_OPENED" as const, detail: { prNumber: 7, prUrl: "https://github.com/acme/salon-site/pull/7" }, observedAt: "2026-10-20T00:00:00.000Z" }
const merged = { interventionId: id(8), claim: "PR_MERGED" as const, mergedAt: "2026-10-20T10:00:00.000Z", mergeCommitSha: "f".repeat(40), pullRequestUrl: "https://github.com/acme/salon-site/pull/7" }
const render = (o: ExecutionOperation) => renderToStaticMarkup(createElement(ExecutionCard, { businessId: id(2), operation: o, reload: async () => {} }))

describe("connected change panel", () => {
  it("keeps the request, the merge and the live site as three separate statements", () => {
    const lines = (o: ExecutionOperation) => executionFactLines(executionFacts(o)).map(l => `${l.label}: ${l.text}`)
    expect(lines(op("PREPARED"))).toEqual(["Request: Not sent to the repository", "Repository merge: Not confirmed", "Live website: Not checked until the merge is confirmed"])
    expect(lines(op("AWAITING_MERGE", { evidence: [pr] }))).toEqual(["Request: Pull request opened", "Repository merge: Not confirmed", "Live website: Not checked until the merge is confirmed"])
    expect(lines(op("VERIFIED", { evidence: [pr], receipt: merged }))[1]).toBe("Repository merge: GitHub merge confirmed")
    expect(lines(op("VERIFIED", { evidence: [pr], receipt: merged }))[2]).toBe("Live website: Website change not yet observed")
    const check = (result: "CHANGE_OBSERVED" | "CHANGE_NOT_OBSERVED" | "INCONCLUSIVE") => ({ liveChecks: [{ id: id(9), result, url: "https://salon.test/pricing.html", httpStatus: 200, detail: "TEST", bodyDigest: null, checkedAt: "2026-10-20T11:00:00.000Z" }] })
    expect(lines(op("VERIFIED", { evidence: [pr], receipt: merged, ...check("CHANGE_OBSERVED") }))[2]).toBe("Live website: Website change observed")
    expect(lines(op("VERIFIED", { evidence: [pr], receipt: merged, ...check("CHANGE_NOT_OBSERVED") }))[2]).toBe("Live website: Website change not observed")
    expect(lines(op("VERIFIED", { evidence: [pr], receipt: merged, ...check("INCONCLUSIVE") }))[2]).toBe("Live website: Website verification unavailable")
    // A live observation without a verified merge says nothing about this authorization.
    expect(lines(op("AWAITING_MERGE", { evidence: [pr], ...check("CHANGE_OBSERVED") }))[2]).toBe("Live website: Not checked until the merge is confirmed")
  })

  it("never says the work is complete, live or successful because GitHub answered", () => {
    for (const state of ["PREPARED", "AUTHORIZED", "DISPATCHING", "AWAITING_MERGE", "RECONCILING", "UNKNOWN", "VERIFIED", "FAILED", "BLOCKED", "CANCELLED"] as const) {
      const html = render(op(state, { evidence: [pr], receipt: state === "VERIFIED" ? merged : null }))
      expect(html, state).not.toMatch(/marketing work completed|work (is )?complete|successfully (published|deployed)|is live now|improv|success(ful)?\b/i)
      expect(html, state).toContain("Business results are measured separately")
      expect(EXECUTION_STATE_COPY[state].title.length).toBeGreaterThan(3)
    }
    const verified = render(op("VERIFIED", { evidence: [pr], receipt: merged }))
    expect(verified).toContain("GitHub merge confirmed")
    expect(verified).toContain("does not show the website is live")
    expect(verified).toContain("Website change not yet observed")
  })

  it("offers each human step only in the state where it applies", () => {
    expect(render(op("PREPARED"))).toContain("Approve this exact change")
    expect(render(op("PREPARED"))).not.toContain("Open the pull request")
    expect(render(op("AUTHORIZED"))).toContain("Open the pull request")
    expect(render(op("AUTHORIZED"))).not.toContain("Approve this exact change")
    expect(render(op("AWAITING_MERGE", { evidence: [pr] }))).toContain("Check GitHub now")
    expect(render(op("AWAITING_MERGE", { evidence: [pr] }))).toContain("Waiting for repository merge")
    expect(render(op("AWAITING_MERGE", { evidence: [pr] }))).not.toMatch(/Open the pull request|Approve this exact change|Check the website now/)
    expect(render(op("VERIFIED", { evidence: [pr], receipt: merged }))).toContain("Check the website now")
    for (const settled of ["FAILED", "BLOCKED", "CANCELLED"] as const) expect(render(op(settled))).not.toMatch(/Open the pull request|Approve this exact change|Check GitHub now|Check the website now/)
    // The exact change and its boundary are always on screen.
    const prepared = render(op("PREPARED"))
    expect(prepared).toContain("acme/salon-site, branch main")
    expect(prepared).toContain("pricing.html")
    expect(prepared).toContain("noindex")
    expect(prepared).toContain("will not merge it, deploy it or edit anything else")
  })

  it("explains why a change stopped in plain words", () => {
    const stopped = (code: string, state: "FAILED" | "BLOCKED" = "BLOCKED") => executionStopCopy(op(state, { events: [{ id: id(6), state, revision: 4, actor: "EXECUTION_SYSTEM", userId: null, reason: "x", detail: { code }, createdAt: "2026-10-20T00:00:00.000Z" }] }))
    expect(stopped("SOURCE_CHANGED")).toContain("page changed after you reviewed it")
    expect(stopped("MERGED_CONTENT_DIFFERS")).toContain("no verification was recorded")
    expect(stopped("PR_CLOSED_WITHOUT_MERGE", "FAILED")).toContain("closed without being merged")
    expect(stopped("PROVIDER_AUTH", "FAILED")).not.toMatch(/token|secret|credential/i)
    expect(executionStopCopy(op("AWAITING_MERGE"))).toBeNull()
    expect(executionError(new ApiError(409, { reason: "ExecutionUnresolved" }))).toContain("still in progress")
    expect(executionError(new ApiError(409, { reason: "NotApplicable" }))).toContain("noindex")
    const facts = renderToStaticMarkup(createElement(ExecutionFacts, { operation: op("PREPARED") }))
    expect(facts).toContain("What is confirmed")
  })
})
