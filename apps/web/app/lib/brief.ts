// The weekly growth brief: the latest one for a business, writing a new one
// now, and turning the weekly schedule on or off.
import { api } from "./api"

export type Brief = {
  id: string; status: "RUNNING" | "READY" | "FAILED"; trigger: "SCHEDULE" | "MANUAL"
  text: string | null; decisions: Array<{ type: "GROWTH_OPPORTUNITY" | "AGENT_PROPOSAL"; id: string }>; conversationId: string | null
  provider: string | null; model: string | null; failure: string | null; startedAt: string; finishedAt: string | null
}
export type BriefSchedule = { enabled: boolean; nextRunAt: string }
const base = (id: string) => `/api/businesses/${encodeURIComponent(id)}/brief`
export const Briefs = {
  get: (businessId: string) => api<{ brief: Brief | null; previous: Brief | null; schedule: BriefSchedule; hasGoal: boolean; website: string | null }>(base(businessId)),
  run: (businessId: string) => api<{ brief: Brief }>(`${base(businessId)}/run`, { method: "POST", body: "{}" }),
  schedule: (businessId: string, enabled: boolean) => api<{ schedule: BriefSchedule }>(`${base(businessId)}/schedule`, { method: "POST", body: JSON.stringify({ enabled }) }),
}

/** Why a brief couldn't be written, in plain words. */
export const briefFailure = (code: string | null) =>
  code === "MODEL_UNCONFIGURED" ? "No model is available to write it. Connect a model in Settings, then try again."
  : code === "MODEL_RATE_LIMITED" ? "The model's usage limit was reached. It will try again next week, or try now later."
  : code?.startsWith("MODEL_") ? "The model didn't finish writing it. Try again."
  : "It couldn't be written this time. Try again."

export type BriefSectionKind = "changed" | "next" | "results" | "investigating" | "other"
export type BriefSection = { kind: BriefSectionKind; title: string; body: string }
export type BriefParts = { sections: BriefSection[]; note: string | null }

const SECTION_KIND: ReadonlyArray<[RegExp, BriefSectionKind]> = [
  [/^what changed/i, "changed"],
  [/^do this next/i, "next"],
  [/^what we did/i, "results"],
  [/investigat/i, "investigating"],
]

/** Splits a brief into its bold-headed parts (the order the agent is asked
 * to write them in) and the closing line about a missing connection.
 * Returns no sections when the text doesn't follow that shape, so the caller
 * can show it as written. */
export function briefParts(text: string): BriefParts {
  const sections: BriefSection[] = []
  const lead: string[] = []
  for (const line of text.split("\n")) {
    const heading = /^\s*\*\*([^*]+?)\*\*\s*:?\s*(.*)$/.exec(line)
    if (heading) {
      const title = heading[1]!.trim().replace(/:$/, "")
      const kind = SECTION_KIND.find(([re]) => re.test(title))?.[1] ?? "other"
      sections.push({ kind, title, body: heading[2] ?? "" })
    } else if (sections.length) sections[sections.length - 1]!.body += `\n${line}`
    else lead.push(line)
  }
  if (!sections.length || lead.join("").trim()) return { sections: [], note: null }
  for (const s of sections) s.body = s.body.trim()
  // The optional last line names a connection; it trails the last section.
  let note: string | null = null
  const last = sections[sections.length - 1]!
  const paragraphs = last.body.split(/\n\s*\n/)
  if (paragraphs.length > 1 && /connect/i.test(paragraphs[paragraphs.length - 1]!)) {
    note = paragraphs.pop()!.trim()
    last.body = paragraphs.join("\n\n").trim()
  }
  return { sections: sections.filter(s => s.body), note }
}
