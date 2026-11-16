// A tool card keeps every constraint and every written description; only
// Effect's generated refinement labels, which repeat the keywords, are dropped.
import { describe, expect, it } from "vitest"
import { JSONSchema, Schema } from "effect"
import { toolCard } from "./agent-tool-cards.js"

describe("a tool card's input schema", () => {
  it("drops generated labels but keeps limits, written descriptions and fields named title or description", () => {
    const schema = JSONSchema.make(Schema.Struct({
      title: Schema.String.pipe(Schema.maxLength(300)),
      description: Schema.optional(Schema.String.pipe(Schema.maxLength(500)).annotations({ description: "What the page says under its title" })),
      limit: Schema.Int.pipe(Schema.between(1, 20)),
    }))
    const card = toolCard({ name: "read_webflow_content", description: "Read the site.", parametersJsonSchema: schema })
    const text = JSON.stringify(card.parametersJsonSchema)
    expect(text).not.toMatch(/maxLength\(300\)|character\(s\)|between\(1, 20\)/)
    expect(card.parametersJsonSchema).toMatchObject({ required: ["title", "limit"], properties: {
      title: { type: "string", maxLength: 300 },
      description: { maxLength: 500, description: "What the page says under its title" },
      limit: { minimum: 1, maximum: 20 },
    } })
  })
})
