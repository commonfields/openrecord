import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import { ContentEdits, applyContentEdits } from "./content-edits.js"
import { executionEdit, executionKindMatchesPath } from "./growth-execution.js"

describe("exact Markdown content edits", () => {
  it("applies disjoint edits against the original source, independently of order", () => {
    const edits = [{ find: "old offer", replace: "new offer" }, { find: "Before", replace: "After" }]
    expect(applyContentEdits("# Before\n\nAn old offer.\n", edits)).toBe("# After\n\nAn new offer.\n")
    expect(applyContentEdits("# Before\n\nAn old offer.\n", [...edits].reverse())).toBe("# After\n\nAn new offer.\n")
  })
  it("refuses missing, ambiguous, overlapping and no-op replacements", () => {
    expect(applyContentEdits("abc", [{ find: "missing", replace: "x" }])).toBeNull()
    expect(applyContentEdits("abc abc", [{ find: "abc", replace: "x" }])).toBeNull()
    expect(applyContentEdits("abc", [{ find: "ab", replace: "x" }, { find: "bc", replace: "y" }])).toBeNull()
    expect(applyContentEdits("abc", [{ find: "abc", replace: "abc" }])).toBeNull()
    expect(applyContentEdits("abc", [])).toBeNull()
    expect(applyContentEdits("abc", [{ find: "abc", replace: "new" }, { find: "new", replace: "later" }])).toBeNull()
  })
  it("allows deletion and preserves Unicode bytes without normalizing content", () => {
    expect(applyContentEdits("Café\nRemove this.\n", [{ find: "Remove this.\n", replace: "" }])).toBe("Café\n")
  })
  it("bounds request schemas and does not mix source formats or extra fields", () => {
    const decode = Schema.decodeUnknownEither(ContentEdits, { onExcessProperty: "error" })
    for (const bad of [[], [{ find: "", replace: "x" }], [{ find: "a", replace: "x", extra: true }], Array.from({ length: 21 }, () => ({ find: "a", replace: "b" }))]) expect(decode(bad)._tag).toBe("Left")
    expect(decode([{ find: "界".repeat(5000), replace: "界".repeat(5000) }])._tag).toBe("Left")
    expect(executionEdit("REPLACE_MARKDOWN", { title: "Wrong field" }, "https://site.test/")).toBeNull()
    expect(executionKindMatchesPath("REPLACE_MARKDOWN", "content/post.mdx")).toBe(true)
    expect(executionKindMatchesPath("REPLACE_MARKDOWN", "index.html")).toBe(false)
    expect(executionKindMatchesPath("SET_TITLE", "content/post.md")).toBe(false)
    expect(executionKindMatchesPath("REPLACE_MARKDOWN", ".github/notes.md")).toBe(false)
  })
})
