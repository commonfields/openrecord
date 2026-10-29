import { describe, expect, it } from "vitest"
import { structuredDataProblems } from "../src/structured-data.js"

const block = (value: unknown) => `<script type="application/ld+json">${JSON.stringify(value)}</script>`

describe("structured data checks", () => {
  it("finds unresolved short types and invalid type values in valid JSON-LD", () => {
    expect(structuredDataProblems(block({ "@type": "Product", name: "Example" }))).toEqual(["MISSING_CONTEXT"])
    expect(structuredDataProblems(block({ "@context": "https://schema.org", "@type": 42 }))).toEqual(["INVALID_TYPE"])
    expect(structuredDataProblems(block({ "@context": "https://schema.org", "@type": [], name: "Example" }))).toEqual(["INVALID_TYPE"])
    expect(structuredDataProblems(block({ "@context": "https://schema.org", name: "Example" }))).toEqual(["MISSING_TYPE"])
  })

  it("accepts inherited graph contexts, identifier references and fully qualified types", () => {
    const html = block({ "@context": "https://schema.org", "@graph": [{ "@type": ["Organization", "LocalBusiness"], name: "Example" }, { "@id": "#location" }] })
      + block({ "@type": "https://schema.org/Product", name: "Example" })
    expect(structuredDataProblems(html)).toEqual([])
  })

  it("leaves absent or malformed JSON-LD to the existing syntax check", () => {
    expect(structuredDataProblems("<p>No structured data</p>")).toEqual([])
    expect(structuredDataProblems('<script type="application/ld+json">{bad}</script>')).toEqual([])
  })
})
