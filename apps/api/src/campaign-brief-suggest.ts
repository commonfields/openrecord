// Turns a person's own description of a campaign into suggested brief lines.
// Nothing is saved here: the app shows the suggestions in the open brief, and
// only the person's Save stores them. Lines the description does not support
// come back empty instead of invented.
import { Effect, Schema } from "effect"
import type { AgentModel } from "./agent-model.js"

export const BriefSuggestInput = Schema.Struct({
  text: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(4000)),
  today: Schema.String.pipe(Schema.pattern(/^\d{4}-\d{2}-\d{2}$/)),
  selection: Schema.optional(Schema.Unknown),
})

const LINES = {
  title: 200, goal: 2000, audience: 2000, offer: 2000, message: 2000, metric: 500, baseline: 500, target: 500,
  primaryChannel: 200, destination: 1000, launchDate: 10, reviewDate: 10,
} as const
export type BriefSuggestion = { -readonly [K in keyof typeof LINES]: string } & { deliverables: Array<{ title: string; channel: string }> }

export const BRIEF_SYSTEM = `You turn a marketer's own description of a campaign into a one-page brief.
Answer with one JSON object and nothing else, with these string fields:
title (a short campaign name), goal (what should change, by how much, by when), audience (one specific group),
offer (what they are offered and the call to action), message (the one thing they should believe), metric (what is counted and where),
baseline (the current number, if given), target (the number to reach), primaryChannel (where it runs), destination (where people land),
launchDate and reviewDate (YYYY-MM-DD, or ""), and deliverables (a list of up to 8 {title, channel}, channel one of WEBSITE, EMAIL, PAID, SOCIAL, OTHER).
Use only what the description says or plainly implies. Leave a field "" rather than guess a number, a date, a channel or an audience.
Each field is one short sentence. Convert relative dates ("in four weeks") using today's date.`

const DATE = /^\d{4}-\d{2}-\d{2}$/
const CHANNELS = new Set(["WEBSITE", "EMAIL", "PAID", "SOCIAL", "OTHER"])

/** The model's JSON as brief lines: trimmed, bounded, unknown keys dropped, bad dates and channels refused. */
export const readSuggestion = (raw: string): BriefSuggestion | null => {
  const body = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")
  let v: unknown
  try { v = JSON.parse(body.slice(body.indexOf("{"), body.lastIndexOf("}") + 1)) } catch { return null }
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  const text = (k: keyof typeof LINES) => typeof o[k] === "string" ? (o[k] as string).trim().slice(0, LINES[k]) : ""
  const out = Object.fromEntries((Object.keys(LINES) as Array<keyof typeof LINES>).map(k => [k, text(k)])) as unknown as BriefSuggestion
  for (const k of ["launchDate", "reviewDate"] as const) if (!DATE.test(out[k])) out[k] = ""
  if (out.launchDate && out.reviewDate && out.reviewDate < out.launchDate) out.reviewDate = ""
  out.deliverables = (Array.isArray(o["deliverables"]) ? o["deliverables"] : []).slice(0, 8).flatMap(d => {
    if (typeof d !== "object" || d === null) return []
    const title = typeof (d as Record<string, unknown>)["title"] === "string" ? String((d as Record<string, unknown>)["title"]).trim().slice(0, 300) : ""
    const channel = String((d as Record<string, unknown>)["channel"] ?? "").toUpperCase()
    return title ? [{ title, channel: CHANNELS.has(channel) ? channel : "OTHER" }] : []
  })
  return out
}

const ask = (model: AgentModel, text: string, today: string) => Effect.gen(function*() {
  const reply = yield* model({ system: BRIEF_SYSTEM, tools: [], contents: [{ role: "user", parts: [{ text: `Today is ${today}.\n\nDescription:\n${text}` }] }] })
  const answer = reply.candidates[0]?.content.parts.filter(p => !p.thought && p.text).map(p => p.text).join("") ?? ""
  return readSuggestion(answer)
})

/** One more try when the first answer is not a brief: models sometimes answer around the JSON. */
export const suggestBrief = (model: AgentModel, text: string, today: string) => Effect.gen(function*() {
  return (yield* ask(model, text, today)) ?? (yield* ask(model, text, today))
})
