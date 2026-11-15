// Leaving blanks: a choice that is the person's to make, asked without
// stopping. The agent names the question, offers a few answers and says what
// it assumes, then carries on with that assumption. The question shows at
// once beside the work (its TOOL_COMPLETED event carries it) and stays on the
// reply. An answer given while the run works reaches it as a note between
// steps (migration 0087); one given later is an ordinary message. Nothing is
// written: this is a read with no side effect.
import { randomUUID } from "node:crypto"
import { Effect, JSONSchema, Schema } from "effect"
import type { ToolDeclaration } from "./agent-registry.js"
import type { AgentToolResult } from "./agent-tools.js"

export const LEAVE_BLANK = "leave_blank"
export const MAX_BLANKS_PER_REPLY = 3

const Blank = Schema.Struct({
  question: Schema.String.pipe(Schema.trimmed(), Schema.minLength(3), Schema.maxLength(140)),
  options: Schema.optionalWith(Schema.Array(Schema.String.pipe(Schema.trimmed(), Schema.minLength(1), Schema.maxLength(40))).pipe(Schema.maxItems(4)), { default: () => [] }),
  assumed: Schema.String.pipe(Schema.trimmed(), Schema.minLength(1), Schema.maxLength(80)),
})
/** A question left for the person, as the client draws it. */
export interface BlankRef { readonly id: string; readonly question: string; readonly options: ReadonlyArray<string>; readonly assumed: string }

export const blankDeclaration: ToolDeclaration = {
  name: LEAVE_BLANK,
  description: "Leave a question for the person without stopping your work: a choice that is theirs to make and that you cannot read with your tools (a claim to confirm, the audience, tone, a number they did not give). Give the question in a few plain words, up to 4 short answers to pick from, and the answer you will assume meanwhile. Then carry on using the assumed answer; never wait for a reply. If the person answers while you work, their answer arrives as a message before a later step: use it then. Use it for real choices only, at most 3 per request, and never for anything your tools can read. Say in your answer which assumptions you made.",
  parametersJsonSchema: JSONSchema.make(Blank),
}

export const leaveBlank = (args: unknown) => Schema.decodeUnknown(Blank, { onExcessProperty: "error" })(args).pipe(Effect.map((b): AgentToolResult => {
  const blank: BlankRef = { id: randomUUID(), question: b.question, options: b.options.slice(0, 4), assumed: b.assumed }
  return { summary: `Asked: ${b.question} Assuming: ${b.assumed}`, citations: [],
    data: { blank, note: "Shown to the person. Continue with the assumed answer now; do not wait." } }
}))

/** The blank a leave_blank result carries, if any. */
export const blankOf = (result: AgentToolResult): BlankRef | undefined => {
  const b = (result.data as { blank?: BlankRef } | null)?.blank
  return b && typeof b.id === "string" && typeof b.question === "string" ? b : undefined
}
