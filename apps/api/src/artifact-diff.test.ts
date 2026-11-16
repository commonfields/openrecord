import { describe, expect, it } from "vitest"
import { diffTokens, markChanges, summarize, tokenize } from "./artifact-diff.js"

const page = (body: string) => `<!doctype html><html><head><title>T</title><style>p{color:red}</style></head><body>${body}</body></html>`

describe("what changed between two versions of a page", () => {
  it("finds the words that changed and the heading they sit under", () => {
    const s = summarize(page("<h1>Cakes</h1><p>Order two weeks ahead.</p><h2>Delivery</h2><p>We deliver in Bandung.</p>"),
      page("<h1>Cakes</h1><p>Order three weeks ahead.</p><h2>Delivery</h2><p>We deliver in Bandung and Jakarta.</p>"))
    expect(s).toMatchObject({ rewritten: false, addedWords: 4, removedWords: 2 })
    expect(s.changes).toEqual([
      { near: "Cakes", before: "two", after: "three" },
      { near: "Delivery", before: "Bandung.", after: "Bandung and Jakarta." },
    ])
  })

  it("marks added text and strikes removed text, and never shows a removed tag", () => {
    const html = markChanges(page("<p>Old line</p><div class='x'>gone</div>"), page("<p>New line</p>"))!
    expect(html).toContain(`<del class="or-change">Old</del><ins class="or-change">New</ins> line`)
    expect(html).toContain(`<del class="or-change">gone</del>`)
    expect(html).not.toContain("class='x'")
    // The marks' style goes into the page's own head.
    expect(html).toMatch(/del\.or-change\{[^}]+\}<\/style><\/head>/)
  })

  it("leaves an unchanged page unmarked", () => {
    const p = page("<p>Same</p>")
    expect(summarize(p, p)).toMatchObject({ addedWords: 0, removedWords: 0, changes: [] })
    expect(markChanges(p, p)).not.toContain(`class="or-change"`)
  })

  it("compares the head whole, so a style change is not marked inside the page", () => {
    const ops = diffTokens(tokenize(page("<p>x</p>")), tokenize(page("<p>x</p>").replace("color:red", "color:blue")))!
    expect(ops.filter(o => o.kind !== "same").every(o => o.token.tag)).toBe(true)
    expect(summarize(page("<p>x</p>"), page("<p>x</p>").replace("color:red", "color:blue")).changes).toEqual([])
  })

  it("reports a rewrite instead of marking every word", () => {
    const words = (seed: string) => page(`<p>${Array.from({ length: 3000 }, (_, i) => `${seed}${i}`).join(" ")}</p>`)
    expect(summarize(words("a"), words("b"))).toMatchObject({ rewritten: true, changes: [] })
    expect(markChanges(words("a"), words("b"))).toBeNull()
  })
})
