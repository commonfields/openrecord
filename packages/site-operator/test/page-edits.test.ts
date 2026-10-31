import { describe, expect, it } from "vitest"
import { applyPageEdit, jsonLdBlock, pageEditObserved } from "../src/page-edits.js"

const page = (head: string, body = "<p>Hi</p>") => `<!doctype html>\n<html>\n  <head>\n${head}\n  </head>\n  <body>${body}</body>\n</html>\n`

describe("page edits", () => {
  it("replaces the one title, or adds one to <head>, escaping the text", () => {
    const html = page('    <meta charset="utf-8">\n    <title>Old</title>')
    const after = applyPageEdit(html, { kind: "SET_TITLE", title: "Fresh & <fast> pizza" })!
    expect(after).toContain("<title>Fresh &amp; &lt;fast&gt; pizza</title>")
    expect(after).not.toContain("Old")
    expect(pageEditObserved(after, { kind: "SET_TITLE", title: "Fresh & <fast> pizza" })).toBe(true)
    const added = applyPageEdit(page('    <meta charset="utf-8">'), { kind: "SET_TITLE", title: "New" })!
    expect(added).toContain('    <meta charset="utf-8">\n    <title>New</title>\n  </head>')
  })

  it("refuses ambiguous pages and changes that change nothing", () => {
    expect(applyPageEdit(page("<title>A</title><title>B</title>"), { kind: "SET_TITLE", title: "C" })).toBeNull()
    expect(applyPageEdit("<html><body>no head</body></html>", { kind: "SET_TITLE", title: "C" })).toBeNull()
    expect(applyPageEdit(page("<title>Same</title>"), { kind: "SET_TITLE", title: "Same" })).toBeNull()
    expect(applyPageEdit(page('<link rel="canonical" href="/a"><link rel="canonical" href="/b">'), { kind: "SET_CANONICAL", url: "https://x.test/" })).toBeNull()
    expect(applyPageEdit(page("", '<img src="/a.png"><img src="/a.png">'), { kind: "SET_IMAGE_ALT", src: "/a.png", alt: "x" })).toBeNull()
  })

  it("sets the meta description and canonical address in place, quoting attributes", () => {
    const html = page('    <meta name="Description" content="old">\n    <link rel="canonical" href="https://x.test/old">')
    const desc = applyPageEdit(html, { kind: "SET_META_DESCRIPTION", description: 'Say "hi" to us' })!
    expect(desc).toContain('<meta name="description" content="Say &quot;hi&quot; to us">')
    expect(desc).not.toContain('content="old"')
    expect(pageEditObserved(desc, { kind: "SET_META_DESCRIPTION", description: 'Say "hi" to us' })).toBe(true)
    const canon = applyPageEdit(html, { kind: "SET_CANONICAL", url: "https://x.test/new?a=1&b=2" })!
    expect(canon).toContain('<link rel="canonical" href="https://x.test/new?a=1&amp;b=2">')
    expect(pageEditObserved(canon, { kind: "SET_CANONICAL", url: "https://x.test/new?a=1&b=2" })).toBe(true)
    expect(pageEditObserved(html, { kind: "SET_CANONICAL", url: "https://x.test/new?a=1&b=2" })).toBe(false)
  })

  it("adds schema.org JSON-LD that cannot break out of its script, once", () => {
    const json = JSON.stringify({ "@context": "https://schema.org", "@type": "FAQPage", name: "</script><script>alert(1)</script>" })
    const after = applyPageEdit(page("<title>T</title>"), { kind: "ADD_JSON_LD", json })!
    expect(after).toContain('<script type="application/ld+json">')
    expect(after).not.toContain("</script><script>")
    expect(pageEditObserved(after, { kind: "ADD_JSON_LD", json })).toBe(true)
    expect(applyPageEdit(after, { kind: "ADD_JSON_LD", json })).toBeNull()
    expect(jsonLdBlock('{"@type":"Thing"}')).toBeNull()
    expect(jsonLdBlock("not json")).toBeNull()
  })

  it("sets alt text on the one matching image", () => {
    const html = page("<title>T</title>", '<img src="/hero.jpg" class="x"><img src="/logo.svg" alt="">')
    const after = applyPageEdit(html, { kind: "SET_IMAGE_ALT", src: "/hero.jpg", alt: "Chef plating a pizza" })!
    expect(after).toContain('<img alt="Chef plating a pizza" src="/hero.jpg" class="x">')
    const logo = applyPageEdit(html, { kind: "SET_IMAGE_ALT", src: "/logo.svg", alt: "Northstar" })!
    expect(logo).toContain('<img src="/logo.svg" alt="Northstar">')
    expect(pageEditObserved(logo, { kind: "SET_IMAGE_ALT", src: "/logo.svg", alt: "Northstar" })).toBe(true)
    expect(applyPageEdit(html, { kind: "SET_IMAGE_ALT", src: "/missing.png", alt: "x" })).toBeNull()
  })

  it("still removes an accidental noindex", () => {
    expect(applyPageEdit(page('<meta name="robots" content="noindex, follow">'), { kind: "REMOVE_NOINDEX_META" })).toContain('content="follow"')
    expect(applyPageEdit(page("<title>T</title>"), { kind: "REMOVE_NOINDEX_META" })).toBeNull()
  })
})
