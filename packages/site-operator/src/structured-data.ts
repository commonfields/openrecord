import { load } from "cheerio"

/** Limited JSON-LD checks, informed by claude-seo's MIT-licensed schema skill.
 * This is not a JSON-LD expansion, Schema.org, or rich-result validator. */
export type StructuredDataProblem = "MISSING_CONTEXT" | "MISSING_TYPE" | "INVALID_TYPE"

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

/** Check top-level entities and @graph entries only. Do not fetch remote contexts. */
export const structuredDataProblems = (html: string): ReadonlyArray<StructuredDataProblem> => {
  const $ = load(html)
  const problems = new Set<StructuredDataProblem>()
  const inspect = (value: unknown, hasContext: boolean, depth: number): void => {
    if (depth > 8) return
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 100)) inspect(item, hasContext, depth + 1)
      return
    }
    if (!isRecord(value)) return
    const context = value["@context"]
    const contextAvailable = hasContext || (context !== undefined && context !== null)
    const type = value["@type"]
    const graph = value["@graph"]
    if (type !== undefined) {
      const valid = (item: unknown) => typeof item === "string" && item.trim().length > 0
      const validType = Array.isArray(type) ? type.length > 0 && type.every(valid) : valid(type)
      if (!validType) problems.add("INVALID_TYPE")
      else {
        const types = Array.isArray(type) ? type : [type]
        if (!contextAvailable && types.some(item => typeof item === "string" && !/^[a-z][a-z0-9+.-]*:/i.test(item))) problems.add("MISSING_CONTEXT")
      }
    } else if (graph === undefined && value["@id"] === undefined && Object.keys(value).some(key => !key.startsWith("@"))) {
      problems.add("MISSING_TYPE")
    }
    if (graph !== undefined) inspect(graph, contextAvailable, depth + 1)
  }
  $('script[type="application/ld+json"]').each((index, element) => {
    if (index >= 100) return
    try { inspect(JSON.parse($(element).text()), false, 0) } catch { /* Syntax errors are reported by the page inspector. */ }
  })
  return [...problems]
}
