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

export const buildContext = (history: ReadonlyArray<ContextMessage>, message: string, budget: ContextBudget = DEFAULT_CONTEXT_BUDGET, resumeContext?: string): BuiltContext => {
  const resume = resumeContext?.slice(0, Math.min(6000, Math.max(0, budget.historyChars))) ?? ""
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

/** Within one run, shrink the oldest tool results to their summaries and
 * references until the request fits. The newest results stay complete. */
export const compactToolResults = (contents: ModelContent[], limit: number): boolean => {
  const size = () => JSON.stringify(contents).length
  if (size() <= limit) return true
  const rounds = contents.flatMap((c, i) => c.role === "user" && c.parts.some(p => (p as { functionResponse?: unknown }).functionResponse) ? [i] : [])
  for (const index of rounds.slice(0, -1)) {
    const content = contents[index]!
    contents[index] = { ...content, parts: content.parts.map(part => {
      const fr = (part as { functionResponse?: { name: string; response: { untrustedEvidence?: { summary: string; citations: ReadonlyArray<unknown> } } } }).functionResponse
      const evidence = fr?.response.untrustedEvidence
      if (!fr || !evidence) return part
      return { functionResponse: { name: fr.name, response: { compactedEvidence: { summary: evidence.summary, citations: evidence.citations.slice(0, 10) },
        note: "Full result omitted to fit the context budget. Call the tool again if its details are needed." } } }
    }) }
    if (size() <= limit) return true
  }
  return size() <= limit
}
