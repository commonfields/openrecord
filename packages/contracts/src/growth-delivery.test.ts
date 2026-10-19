import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import {
  ConnectDeliveryTarget, DeliveryState, allowedPathEntryProblem, applyDeliveryEdits, canTransitionDelivery, deliverablePathProblem,
  diffLines, pathAllowed, unifiedDiff, type DeliveryActor,
} from "./growth-delivery.js"

describe("deliverable content paths", () => {
  it("accepts plain Markdown and MDX content files", () => {
    for (const ok of ["README.md", "content/pages/home.mdx", "src/content/blog/launch-post.md", "docs/Get_Started.MD"]) expect(deliverablePathProblem(ok)).toBeNull()
  })
  it.each([
    ["../secrets.md", "PATH_TRAVERSAL"],
    ["content/../../etc/passwd.md", "PATH_TRAVERSAL"],
    ["content//home.md", "PATH_TRAVERSAL"],
    ["./home.md", "PATH_TRAVERSAL"],
    ["/abs/home.md", "PATH_NOT_RELATIVE_FILE"],
    [".github/workflows/deploy.md", "PATH_HIDDEN_SEGMENT"],
    ["content/.env.md", "PATH_HIDDEN_SEGMENT"],
    [".env", "PATH_HIDDEN_SEGMENT"],
    ["package.json", "PATH_EXTENSION"],
    [".github/workflows/ci.yml", "PATH_HIDDEN_SEGMENT"],
    ["src/pages/index.tsx", "PATH_EXTENSION"],
    ["content/home.md\u0000.txt", "PATH_CHARACTERS"],
    ["content/home page.md", "PATH_CHARACTERS"],
    ["content\\home.md", "PATH_CHARACTERS"],
    ["content/home.md/", "PATH_NOT_RELATIVE_FILE"],
    ["café.md", "PATH_NOT_NORMALIZED"],
  ])("refuses %s (%s)", (path, code) => {
    expect(deliverablePathProblem(path)).toBe(code)
  })
  it("limits delivery to the connected repository's allowed files and directories", () => {
    const allowed = ["content/pages/", "README.md"]
    expect(pathAllowed("content/pages/home.mdx", allowed)).toBe(true)
    expect(pathAllowed("content/pages/nested/pricing.md", allowed)).toBe(true)
    expect(pathAllowed("README.md", allowed)).toBe(true)
    expect(pathAllowed("content/pagesX/home.md", allowed)).toBe(false)
    expect(pathAllowed("docs/README.md", allowed)).toBe(false)
    expect(pathAllowed("content/pages/../../README.md", allowed)).toBe(false)
    expect(pathAllowed("content/pages/.hidden.md", allowed)).toBe(false)
  })
  it("refuses unsafe allowed-path entries, including the repository root", () => {
    expect(allowedPathEntryProblem("content/")).toBeNull()
    expect(allowedPathEntryProblem("/")).toBe("PATH_ROOT_NOT_ALLOWED")
    expect(allowedPathEntryProblem(".github/")).toBe("PATH_HIDDEN_SEGMENT")
    expect(allowedPathEntryProblem("../")).toBe("PATH_TRAVERSAL")
    expect(allowedPathEntryProblem("package.json")).toBe("PATH_EXTENSION")
    const base = { owner: "acme", repository: "site", baseBranch: "main", idempotencyKey: "6b0b0f6a-1c1d-4c4e-8f2a-1b2c3d4e5f60" }
    expect(Schema.decodeUnknownEither(ConnectDeliveryTarget)({ ...base, allowedPaths: ["content/"] })._tag).toBe("Right")
    for (const allowedPaths of [[], ["/"], [".github/workflows/"], ["src/app.tsx"]]) {
      expect(Schema.decodeUnknownEither(ConnectDeliveryTarget)({ ...base, allowedPaths })._tag).toBe("Left")
    }
    for (const baseBranch of ["../main", "main/", "feature..x", "-x", "refs.lock"]) {
      expect(Schema.decodeUnknownEither(ConnectDeliveryTarget)({ ...base, baseBranch, allowedPaths: ["content/"] })._tag).toBe("Left")
    }
  })
})

describe("exact delivery edits", () => {
  const source = "# Notes for teams\n\nWrite notes together.\n\nStart free.\n"
  it("applies non-overlapping single-occurrence edits independent of order", () => {
    const edits = [{ find: "Start free.", replace: "Start a free trial." }, { find: "# Notes for teams", replace: "# Meetings that turn into tasks" }]
    const forward = applyDeliveryEdits(source, edits)
    const backward = applyDeliveryEdits(source, [...edits].reverse())
    expect(forward).toEqual({ ok: true, content: "# Meetings that turn into tasks\n\nWrite notes together.\n\nStart a free trial.\n" })
    expect(backward).toEqual(forward)
  })
  it("refuses a missing, ambiguous, overlapping or empty change instead of guessing", () => {
    expect(applyDeliveryEdits(source, [{ find: "Pricing", replace: "x" }])).toEqual({ ok: false, failure: { code: "NOT_FOUND", index: 0 } })
    expect(applyDeliveryEdits("free free", [{ find: "free", replace: "paid" }])).toEqual({ ok: false, failure: { code: "AMBIGUOUS", index: 0 } })
    expect(applyDeliveryEdits(source, [{ find: "Write notes", replace: "x" }, { find: "notes together", replace: "y" }]).ok).toBe(false)
    expect(applyDeliveryEdits(source, [{ find: "Start free.", replace: "Start free." }])).toEqual({ ok: false, failure: { code: "NO_CHANGE" } })
  })
})

describe("reviewable diff", () => {
  it("shows only changed lines with context, aligned after inserted lines", () => {
    const before = ["# Title", "a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "Start free."].join("\n")
    const after = ["# New title", "Subtitle line", "a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "Start a free trial."].join("\n")
    const hunks = diffLines(before, after, 2)
    expect(hunks).toHaveLength(2)
    expect(hunks[0]!.lines.map(l => `${l.kind[0]}${l.text}`)).toEqual(["r# Title", "a# New title", "aSubtitle line", "ca", "cb"])
    expect(hunks[1]!.lines.map(l => `${l.kind[0]}${l.text}`)).toEqual(["ci", "cj", "rStart free.", "aStart a free trial."])
    expect(hunks[1]!.lines[2]).toMatchObject({ before: 12, after: null })
    expect(hunks[1]!.lines[3]).toMatchObject({ before: null, after: 13 })
    const text = unifiedDiff("content/home.md", hunks)
    expect(text.split("\n").slice(0, 3)).toEqual(["--- a/content/home.md", "+++ b/content/home.md", "@@ -1,3 +1,4 @@"])
  })
  it("returns no hunks for identical content", () => {
    expect(diffLines("same\ntext", "same\ntext")).toEqual([])
  })
})

describe("delivery authority", () => {
  it("exhaustively matches the declared table: only people approve, reject and attest; only the delivery system records GitHub facts", () => {
    const actors: DeliveryActor[] = ["OPERATOR", "ASSISTANT", "DELIVERY_SYSTEM"]
    const allowed = new Set([
      "null>DRAFTED:OPERATOR", "null>DRAFTED:ASSISTANT",
      "DRAFTED>APPROVED_FOR_PR:OPERATOR", "DRAFTED>REJECTED:OPERATOR", "APPROVED_FOR_PR>REJECTED:OPERATOR",
      "APPROVED_FOR_PR>STALE:DELIVERY_SYSTEM", "APPROVED_FOR_PR>PR_OPENED:DELIVERY_SYSTEM",
      "PR_OPENED>PR_MERGED:DELIVERY_SYSTEM", "PR_OPENED>CLOSED_WITHOUT_DELIVERY:DELIVERY_SYSTEM",
      "PR_MERGED>DEPLOYMENT_VERIFIED:OPERATOR",
    ])
    for (const from of [null, ...DeliveryState.literals]) for (const to of DeliveryState.literals) for (const actor of actors) {
      expect(canTransitionDelivery(from, to, actor)).toBe(allowed.has(`${from}>${to}:${actor}`))
    }
    // The agent can draft and nothing else; a merged PR is not a deployment.
    expect(DeliveryState.literals.filter(to => DeliveryState.literals.some(from => canTransitionDelivery(from, to, "ASSISTANT")))).toEqual([])
    expect(canTransitionDelivery("PR_OPENED", "DEPLOYMENT_VERIFIED", "DELIVERY_SYSTEM")).toBe(false)
  })
})
