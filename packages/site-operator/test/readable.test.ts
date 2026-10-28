import { describe, expect, it } from "vitest"
import { readablePage } from "../src/readable.js"

const page = (body: string, head = "", lang = ' lang="en"') => `<!doctype html><html${lang}><head>${head}</head><body>${body}</body></html>`

describe("readablePage", () => {
  it("reads the main text, outline and search signals of a page", () => {
    const r = readablePage(page(
      `<nav><a href="/pricing">Pricing</a><a href="https://other.test/x">Partner</a><a href="mailto:a@b.test">Mail</a></nav>
       <main><h1>Clinic scheduling</h1><p>Book   patients in two clicks.</p><h2>How much does it cost?</h2><ul><li>Starter</li></ul>
       <script>window.secret = "not text"</script><img src="a.png"><img src="b.png" alt="Calendar"></main>`,
      `<title> Northstar | Scheduling </title><meta name="description" content="Online booking."><link rel="canonical" href="https://northstar.test/">
       <meta property="og:title" content="Northstar"><meta property="article:modified_time" content="2026-10-01">
       <script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Organization"},{"@type":["WebSite","Thing"]}]}</script>
       <script type="application/ld+json">{not json</script>`),
      "https://northstar.test/")
    expect(r).toMatchObject({ title: "Northstar | Scheduling", description: "Online booking.", canonical: "https://northstar.test/", lang: "en",
      h1Count: 1, questionHeadings: 1, lists: 1, images: 2, imagesMissingAlt: 1, openGraph: true, modified: "2026-10-01", invalidStructuredData: 1, externalLinkCount: 1 })
    expect(r.structuredDataTypes).toEqual(["Organization", "Thing", "WebSite"])
    expect(r.headings).toEqual([{ level: 1, text: "Clinic scheduling" }, { level: 2, text: "How much does it cost?" }])
    expect(r.text).toBe("Clinic scheduling\nBook patients in two clicks.\nHow much does it cost?\nStarter")
    expect(r.text).not.toContain("secret")
    expect(r.internalLinks).toEqual(["https://northstar.test/pricing"])
  })

  it("cuts long text and reads the body when there is no main element", () => {
    const r = readablePage(page(`<p>${"word ".repeat(400)}</p>`, "", ""), "https://northstar.test/a", { maxChars: 100 })
    expect(r.wordCount).toBe(400)
    expect(r.text).toHaveLength(100)
    expect(r.truncated).toBe(true)
    expect(r.lang).toBeNull()
  })
})
