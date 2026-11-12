// Tool cards: how the registered tools are declared to the model on each step.
//
// Every tool is declared on every step, so the model never has to guess that a
// tool exists. What varies is how much of it is sent:
//
//   card      the tool's purpose in one sentence and its near-miss, with its
//             real input schema when that schema is small;
//   expanded  the full description and schema, once the run has asked for
//             them with tool_details or a call was refused for its inputs.
//
// A tool whose schema is large (the saves and prepared changes, a small share
// of calls) declares an open object on its card and says so, which costs one
// tool_details call the first time it is used and nothing on every other turn.
import type { ToolDeclaration } from "./agent-registry.js"
import { CAPABILITY_MANIFESTS } from "./capabilities/catalog.js"

/** Input schemas larger than this are sent only once a tool is expanded. */
export const LAZY_SCHEMA_BYTES = 900
const CARD_SENTENCE_CHARS = 240
const MAX_DETAILS = 6

const NEAR_MISS = new Map(CAPABILITY_MANIFESTS.map(m => [m.id, m.whenNotToUse]))
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8")

const firstSentence = (text: string) => {
  const flat = text.replace(/\s+/g, " ").trim()
  const end = flat.search(/[.!?](?:\s|$)/)
  const sentence = end < 0 ? flat : flat.slice(0, end + 1)
  return sentence.length > CARD_SENTENCE_CHARS ? `${sentence.slice(0, CARD_SENTENCE_CHARS - 1)}…` : sentence
}

/** `$schema` and `$id` name the dialect and the document, which the model does not use. */
const withoutSchemaIds = (schema: unknown) => {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) return schema
  const { $schema: _dialect, $id: _id, ...rest } = schema as Record<string, unknown>
  return rest
}

export const hasLazySchema = (tool: ToolDeclaration) => NEAR_MISS.has(tool.name) && bytes(tool.parametersJsonSchema) > LAZY_SCHEMA_BYTES

/** The card for one tool. Tools without catalog metadata (session and extension tools) are declared whole. */
export const toolCard = (tool: ToolDeclaration): ToolDeclaration => {
  const nearMiss = NEAR_MISS.get(tool.name)
  if (nearMiss === undefined) return tool
  const lazy = hasLazySchema(tool)
  return {
    name: tool.name,
    description: `${firstSentence(tool.description)} ${nearMiss}${lazy ? " Inputs are detailed: call tool_details for this tool first." : ""}`,
    parametersJsonSchema: lazy ? { type: "object" } : withoutSchemaIds(tool.parametersJsonSchema),
  }
}

export const TOOL_DETAILS: ToolDeclaration = {
  name: "tool_details",
  description: "Read the full guidance and input schema of up to six declared tools before using them. Free: it reads nothing about the business and changes nothing.",
  parametersJsonSchema: { type: "object", properties: { names: { type: "array", items: { type: "string" }, minItems: 1, maxItems: MAX_DETAILS } }, required: ["names"], additionalProperties: false },
}

/** What one step declares: a card per tool, the whole declaration for expanded ones, and tool_details while any card remains. */
export const declareTools = (tools: ReadonlyArray<ToolDeclaration>, expanded: ReadonlySet<string>): ReadonlyArray<ToolDeclaration> => {
  const cards = new Map(tools.map(t => [t.name, toolCard(t)]))
  const declared = tools.map(t => expanded.has(t.name) ? t : cards.get(t.name)!)
  return declared.some((d, i) => d !== tools[i]) ? [...declared, TOOL_DETAILS] : declared
}

/** The names a tool_details call asks for that are declared in this turn. */
export const detailNames = (args: unknown, tools: ReadonlyArray<ToolDeclaration>): ReadonlyArray<string> => {
  const names = (args as { names?: unknown } | null)?.names
  if (!Array.isArray(names)) return []
  const declared = new Set(tools.map(t => t.name))
  return [...new Set(names.filter((n): n is string => typeof n === "string" && declared.has(n)))].slice(0, MAX_DETAILS)
}

export const toolDetails = (names: ReadonlyArray<string>, tools: ReadonlyArray<ToolDeclaration>) =>
  tools.filter(t => names.includes(t.name)).map(t => ({ name: t.name, guidance: t.description, inputSchema: t.parametersJsonSchema }))
