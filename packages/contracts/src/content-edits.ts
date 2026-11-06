import { Schema } from "effect"

/** Exact copy edits retained from the historical Markdown delivery prototype. */
export const ContentEdits = Schema.Array(Schema.Struct({
  find: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(5000)),
  replace: Schema.String.pipe(Schema.maxLength(5000)),
})).pipe(Schema.minItems(1), Schema.maxItems(20),
  // Leave room for JSONB formatting inside W7's existing 20,000-byte value cap.
  Schema.filter(edits => new TextEncoder().encode(JSON.stringify(edits)).byteLength <= 16_000))
export type ContentEdits = typeof ContentEdits.Type

/** Match every span against the original source; never guess or depend on order. */
export function applyContentEdits(source: string, edits: ContentEdits): string | null {
  if (!edits.length || edits.length > 20) return null
  const spans: Array<{ start: number; end: number; replace: string }> = []
  for (const edit of edits) {
    if (!edit.find || edit.find.length > 5000 || edit.replace.length > 5000) return null
    const start = source.indexOf(edit.find)
    if (start < 0 || source.indexOf(edit.find, start + 1) >= 0) return null
    spans.push({ start, end: start + edit.find.length, replace: edit.replace })
  }
  spans.sort((a, b) => a.start - b.start)
  if (spans.some((span, i) => i > 0 && span.start < spans[i - 1]!.end)) return null
  let result = "", cursor = 0
  for (const span of spans) { result += source.slice(cursor, span.start) + span.replace; cursor = span.end }
  result += source.slice(cursor)
  return result === source ? null : result
}
