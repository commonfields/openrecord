import { describe, expect, it } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { parseVisual } from "../app/components/chat-visual"
import { ChatMarkdown } from "../app/components/chat-markdown"

describe("visual replies", () => {
  it("accepts bar, line, donut and stats specs within their limits", () => {
    expect(parseVisual(JSON.stringify({ type: "bar", title: "Share", unit: "%", labels: ["ChatGPT", "Gemini"], series: [{ name: "Named", values: [40, null] }] })))
      .toMatchObject({ type: "bar", unit: "%", labels: ["ChatGPT", "Gemini"], series: [{ name: "Named", values: [40, null] }] })
    expect(parseVisual(JSON.stringify({ type: "stats", title: "This week", stats: [{ label: "Answers", value: 24 }] }))).toMatchObject({ type: "stats", stats: [{ label: "Answers", value: "24", hint: null }] })
    const many = parseVisual(JSON.stringify({ type: "line", title: "t", labels: ["a"], series: Array.from({ length: 12 }, (_, i) => ({ name: `s${i}`, values: [i] })) }))
    expect(many && "series" in many ? many.series.length : 0).toBe(8)
  })
  it("refuses what it cannot draw honestly", () => {
    expect(parseVisual("{not json")).toBeNull()
    expect(parseVisual(JSON.stringify({ type: "pie3d", labels: ["a"], series: [] }))).toBeNull()
    expect(parseVisual(JSON.stringify({ type: "bar", title: "t", labels: ["a", "b"], series: [{ name: "x", values: ["1", 2] }] }))).toBeNull()
    expect(parseVisual(JSON.stringify({ type: "bar", title: "t", labels: ["a"], series: [{ name: "x", values: [null] }] }))).toBeNull()
    expect(parseVisual(JSON.stringify({ type: "donut", title: "t", labels: ["a"], series: [{ name: "x", values: [-1] }] }))).toBeNull()
  })
  it("renders a chart block as a figure, never its JSON, and keeps other code as code", () => {
    const chart = "```chart\n" + JSON.stringify({ type: "stats", title: "Headline", stats: [{ label: "Answers", value: "24" }] }) + "\n```"
    const html = renderToStaticMarkup(<ChatMarkdown text={`Before\n\n${chart}\n\nAfter`} />)
    expect(html).toContain("<figure")
    expect(html).toContain("Headline")
    expect(html).not.toContain("&quot;type&quot;")
    expect(renderToStaticMarkup(<ChatMarkdown text={"```js\nconst x = 1\n```"} />)).toContain("<code")
    expect(renderToStaticMarkup(<ChatMarkdown text={"```chart\n{\"type\":\"ba"} live />)).toContain("Drawing chart")
  })
})
