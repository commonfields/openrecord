// Web search capture for AI-answer measurement jobs: the searches a model ran
// and the pages they returned, from Claude's tool results and Codex events.
import { describe, expect, it } from "vitest"
import { searchSources } from "./claude-sdk.js"
import { codexSearches } from "./adapters.js"

describe("web search capture", () => {
  it("reads titles and addresses from a web search tool result", () => {
    const result = [{ type: "text", text: 'Web search results for query: "best dentist downtown"\n\nLinks: [{"title":"Top 10 dentists","url":"https://reviews.example.org/dentists"},{"title":"Bright Smiles","url":"https://brightsmiles.test/"}]' }]
    expect(searchSources(result)).toEqual([{ url: "https://reviews.example.org/dentists", title: "Top 10 dentists" }, { url: "https://brightsmiles.test/", title: "Bright Smiles" }])
    expect(searchSources("see https://a.example.org/x and https://b.example.org/y")).toEqual([{ url: "https://a.example.org/x" }, { url: "https://b.example.org/y" }])
  })
  it("reads the searches Codex ran from its event stream", () => {
    const events = [
      JSON.stringify({ type: "item.completed", item: { type: "web_search", query: "best dentist downtown", results: [{ url: "https://reviews.example.org/dentists" }] } }),
      JSON.stringify({ type: "item.completed", item: { type: "reasoning", text: "thinking" } }),
      "not json",
    ].join("\n")
    expect(codexSearches(events)).toEqual({ searches: ["best dentist downtown"], sources: [{ url: "https://reviews.example.org/dentists" }] })
  })
})
