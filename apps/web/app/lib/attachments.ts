// Text files a person attaches to a message, read here in the browser and sent
// as text: CSV and TSV exports, Markdown, JSON, plain text, HTML and XML. Up to
// three files, 40,000 characters each and 80,000 together, as the server
// accepts. Images and PDFs are not read yet.
import type { AgentAttachment } from "@/lib/api"

export const MAX_FILES = 3
export const MAX_FILE_CHARS = 40000
export const MAX_TOTAL_CHARS = 80000
export const ACCEPT = ".txt,.md,.markdown,.csv,.tsv,.json,.html,.htm,.xml,.yaml,.yml,.log,text/*,application/json"

const TEXT = /\.(txt|md|markdown|csv|tsv|json|html?|xml|ya?ml|log)$/i
const isText = (file: File) => file.type.startsWith("text/") || file.type === "application/json" || file.type === "application/xml" || TEXT.test(file.name)

export type ReadResult = { attachment: AgentAttachment; truncated: boolean } | { error: string }

export async function readAttachment(file: File): Promise<ReadResult> {
  if (!isText(file)) return { error: /^image\//.test(file.type) || /\.pdf$/i.test(file.name)
    ? `${file.name}: images and PDFs can't be attached yet. Attach a text, CSV, Markdown or JSON file, or paste the text.`
    : `${file.name}: only text files can be attached (text, CSV, Markdown, JSON, HTML).` }
  if (file.size > 5_000_000) return { error: `${file.name} is too large. Attach a file under 5 MB.` }
  const text = (await file.text()).replace(/\r\n/g, "\n").replace(/\u0000/g, "")
  if (!text.trim()) return { error: `${file.name} is empty.` }
  return { attachment: { name: file.name.slice(0, 200), type: (file.type || file.name.split(".").pop() || "").slice(0, 100), text: text.slice(0, MAX_FILE_CHARS) }, truncated: text.length > MAX_FILE_CHARS }
}

/** Adds read files to those already attached, within the count and size limits. */
export function addAttachments(current: ReadonlyArray<AgentAttachment>, added: ReadonlyArray<AgentAttachment>) {
  const out = [...current]
  const dropped: string[] = []
  for (const a of added) {
    const total = out.reduce((n, f) => n + f.text.length, 0)
    if (out.length >= MAX_FILES || total + a.text.length > MAX_TOTAL_CHARS) dropped.push(a.name)
    else out.push(a)
  }
  return { attachments: out, dropped }
}
