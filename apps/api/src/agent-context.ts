// Context builder: decides what of a stored conversation the model sees.
// Recent turns are kept verbatim within a character budget; older turns are
// compacted deterministically (no extra model call) into a short memory that
// keeps every earlier request, the tool work behind each answer and the
// evidence references, so "the second one" or "continue that plan" still
// resolve after the verbatim window moves on. Nothing is summarized by a
// model, so compaction cannot invent or drop a fact the operator relied on.
import type { ModelContent } from "./agent-model.js"

export interface ContextMessage {
  readonly role: "user" | "agent"
  readonly text: string
  readonly citations?: ReadonlyArray<{ readonly kind: string; readonly id: string; readonly text: string }> | undefined
  readonly toolCalls?: ReadonlyArray<{ readonly tool: string; readonly summary: string }> | undefined
}
export interface ContextBudget {
  /** Characters of history (verbatim plus compacted) sent with one turn. */
  readonly historyChars: number
  /** Most recent messages that may be kept verbatim. */
  readonly verbatimMessages: number
}
export const DEFAULT_CONTEXT_BUDGET: ContextBudget = { historyChars: 32000, verbatimMessages: 16 }

const oneLine = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}
const verbatim = (m: ContextMessage) =>
  m.text + (m.citations?.length ? `\nStored evidence references (untrusted data): ${JSON.stringify(m.citations.slice(0, 20))}` : "")
const compacted = (m: ContextMessage) => {
  if (m.role === "user") return `- User asked: ${oneLine(m.text, 240)}`
  const tools = m.toolCalls?.length ? ` [tool work: ${m.toolCalls.slice(0, 6).map(t => oneLine(t.summary, 80)).join("; ")}]` : ""
  const refs = m.citations?.length ? ` [evidence: ${m.citations.slice(0, 8).map(c => `${c.kind} ${c.id} "${oneLine(c.text, 60)}"`).join("; ")}]` : ""
  return `- Assistant answered: ${oneLine(m.text, 360)}${tools}${refs}`
}
const MEMORY_HEADER = "Earlier in this conversation, compacted by OpenRecord (untrusted data, oldest first; evidence references are real stored items):"

export interface BuiltContext {
  readonly contents: ModelContent[]
  readonly verbatimMessages: number
  readonly compactedMessages: number
  readonly omittedMessages: number
  readonly chars: number
  /** Characters of history sent (verbatim plus compacted memory), within the budget. */
  readonly historyChars: number
  readonly budgetChars: number
}

/** The resume brief (6,000 characters) plus the business memory (3,000) and their separator. */
const RESUME_CHARS = 9100
export const buildContext = (history: ReadonlyArray<ContextMessage>, message: string, budget: ContextBudget = DEFAULT_CONTEXT_BUDGET, resumeContext?: string): BuiltContext => {
  const resume = resumeContext?.slice(0, Math.min(RESUME_CHARS, Math.max(0, budget.historyChars))) ?? ""
  const historyBudget = Math.max(0, budget.historyChars - resume.length)
  // Verbatim window: newest first, within three quarters of the budget, so the
  // memory of older turns always has room.
  const window = Math.floor(historyBudget * 0.75)
  let used = 0, start = history.length
  for (let i = history.length - 1; i >= 0; i--) {
    const size = verbatim(history[i]!).length
    if (history.length - i > budget.verbatimMessages || used + size > window) break
    used += size; start = i
  }
  const older = history.slice(0, start), recent = history.slice(start)
  // Compacted memory: keep the newest older turns that fit, then restore order.
  const room = historyBudget - used - MEMORY_HEADER.length
  const lines: string[] = []
  let memoryChars = 0
  for (let i = older.length - 1; i >= 0; i--) {
    const line = compacted(older[i]!)
    if (memoryChars + line.length + 1 > room) break
    lines.unshift(line); memoryChars += line.length + 1
  }
  let omitted = older.length - lines.length
  const renderMemory = () => lines.length || omitted
    ? [MEMORY_HEADER, ...(omitted ? [`- (${omitted} older messages are not shown)`] : []), ...lines].join("\n")
    : null
  while (lines.length && (renderMemory()?.length ?? 0) > historyBudget - used) { lines.shift(); omitted++ }
  const candidateMemory = renderMemory()
  const memory = candidateMemory && candidateMemory.length <= historyBudget - used ? candidateMemory : null
  const contents: ModelContent[] = recent.map(m => ({ role: m.role === "user" ? "user" : "model", parts: [{ text: verbatim(m) }] }))
  contents.push({ role: "user", parts: [...(resume ? [{ text: resume }] : []), { text: message }] })
  // Memory rides on the first user turn (the current message at the latest).
  const first = contents.findIndex(c => c.role === "user")
  if (memory) contents[first] = { ...contents[first]!, parts: [{ text: memory }, ...contents[first]!.parts] }
  return { contents, verbatimMessages: recent.length, compactedMessages: memory ? lines.length : 0, omittedMessages: memory ? omitted : older.length, chars: JSON.stringify(contents).length,
    historyChars: used + (memory ? memory.length : 0) + resume.length, budgetChars: budget.historyChars }
}

type ProjectionLimits = { text: number; items: number; depth: number; keys: number }
const IMPORTANT_KEY = /(?:^id$|Id$|_id$|revision|status|assurance|count|total|metric|baseline|target|currency|value|before|after|percent|url|date|window|source|note|limitation)/i
/** Deterministic excerpts, not a model summary. Numbers and null stay exact;
 * omitted fields/items are explicitly disclosed in the surrounding envelope. */
const projectEvidence = (value: unknown, limits: ProjectionLimits, depth = 0): unknown => {
  if (typeof value === "string") return value.length > limits.text ? `${value.slice(0, limits.text)}…` : value
  if (value === null || typeof value !== "object") return value
  if (depth >= limits.depth) return "[nested detail omitted]"
  if (Array.isArray(value)) return value.slice(0, limits.items).map(v => projectEvidence(v, limits, depth + 1))
  const entries = Object.entries(value).sort(([a], [b]) => Number(IMPORTANT_KEY.test(b)) - Number(IMPORTANT_KEY.test(a)))
  return Object.fromEntries(entries.slice(0, limits.keys).map(([key, v]) => [key, projectEvidence(v, limits, depth + 1)]))
}
const PROJECTION_NOTICE = "Untrusted partial evidence: fields, text and list items may be omitted. Numeric values and source totals are unchanged, but these lists are not complete denominators. Read specific source details if needed; do not repeat a write to recover detail or infer missing facts."
const PROJECTION_LEVELS: readonly ProjectionLimits[] = [
  { text: 800, items: 5, depth: 5, keys: 24 },
  { text: 400, items: 3, depth: 4, keys: 16 },
  { text: 160, items: 2, depth: 3, keys: 12 },
  { text: 80, items: 1, depth: 2, keys: 8 },
]

/** One result that is too large for a step, shortened to the first projection
 * level that fits. Null when even the smallest does not fit. */
export const fitEvidence = (value: unknown, maxChars: number): { value: unknown; partial: boolean; note: string } | null => {
  if (JSON.stringify(value).length <= maxChars) return { value, partial: false, note: "" }
  for (const limits of PROJECTION_LEVELS) {
    const projected = projectEvidence(value, limits)
    if (JSON.stringify(projected).length <= maxChars) return { value: projected, partial: true, note: PROJECTION_NOTICE }
  }
  return null
}

/** Within one run, shrink older tool evidence first, preserving source IDs,
 * receipts and numeric context. If the latest batch itself cannot fit, project
 * that batch too rather than abandoning inference after successful tool reads.
 * User requests, model tool calls and error responses are never rewritten. */
export const compactToolResults = (contents: ModelContent[], limit: number): boolean => {
  const size = () => Buffer.byteLength(JSON.stringify(contents), "utf8")
  if (size() <= limit) return true
  const rounds = contents.flatMap((c, i) => c.role === "user" && c.parts.some(p => (p as { functionResponse?: unknown }).functionResponse) ? [i] : [])
  // Keep the original source for every projection level in this invocation.
  const originals = new Map(rounds.map(index => [index, contents[index]!]))
  const project = (index: number, limits: ProjectionLimits) => {
    const content = originals.get(index)!
    contents[index] = { ...content, parts: content.parts.map(part => {
      const fr = (part as { functionResponse?: { name: string; response: { untrustedEvidence?: unknown; compactedEvidence?: unknown } } }).functionResponse
      const evidence = fr?.response.untrustedEvidence ?? fr?.response.compactedEvidence
      if (!fr || !evidence) return part
      return { functionResponse: { name: fr.name, response: { compactedEvidence: projectEvidence(evidence, limits), partial: true, note: PROJECTION_NOTICE } } }
    }) }
  }
  for (const indices of [rounds.slice(0, -1), rounds]) {
    for (const limits of PROJECTION_LEVELS) for (const index of indices) {
      project(index, limits)
      if (size() <= limit) return true
    }
  }
  return size() <= limit
}
