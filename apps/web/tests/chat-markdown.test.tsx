// Agent answers render as formatted text, without raw HTML or unsafe links.
import { describe, expect, it } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { ChatMarkdown } from "../app/components/chat-markdown"

const html = (text: string) => renderToStaticMarkup(<ChatMarkdown text={text} />)

describe("chat markdown", () => {
  it("renders lists, bold, tables and code", () => {
    const out = html("Do this:\n\n1. **Fix** the title\n2. Add `schema`\n\n| Page | Score |\n|---|---|\n| Home | 82 |")
    expect(out).toContain("<ol>")
    expect(out).toContain("<strong>Fix</strong>")
    expect(out).toContain("<code>schema</code>")
    expect(out).toContain("<table")
    expect(out).toContain("<td>82</td>")
  })

  it("never renders raw HTML, and only opens web and mail links, in a new tab", () => {
    const out = html('<script>alert(1)</script>\n\nSee <b>x</b> [ok](https://example.com) and [bad](javascript:alert(1))')
    expect(out).not.toContain("<script")
    expect(out).not.toContain("<b>")
    expect(out).toContain('href="https://example.com"')
    expect(out).toContain("<span>bad</span>")
    expect(out).toContain('rel="noopener noreferrer"')
    expect(out).not.toContain("javascript:")
  })
})
