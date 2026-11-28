// A visible plan: before work that takes several steps, the agent names them,
// and updates the list as each one finishes. The person sees the steps at once
// beside the work (the TOOL_COMPLETED event carries the plan) and ticking off
// as they run; the final plan stays on the reply. Each call replaces the whole
// plan, as a to-do list the model keeps. Nothing is written: this is a read
// with no side effect, so it never needs approval and is free to repeat.
import { Effect, Schema } from "effect"
import type { ToolDeclaration } from "./agent-registry.js"
import { AgentInvalidInput, type AgentToolResult } from "./agent-tools.js"

export const UPDATE_PLAN = "update_plan"
export const MAX_PLAN_STEPS = 8

type PlanStatus = "pending" | "in_progress" | "completed"
// Compact on the request: the steps in order, and how many are finished. The
// first unfinished one is in progress unless every step is done.
const Plan = Schema.Struct({
  steps: Schema.Array(Schema.String.pipe(Schema.trimmed(), Schema.minLength(2), Schema.maxLength(120))).pipe(Schema.minItems(1), Schema.maxItems(MAX_PLAN_STEPS)),
  done: Schema.Int.pipe(Schema.between(0, MAX_PLAN_STEPS)),
})
export type PlanStep = { readonly step: string; readonly status: PlanStatus }
/** The plan as the client draws it. */
export interface PlanRef { readonly steps: ReadonlyArray<PlanStep>; readonly note?: string }

export const planDeclaration: ToolDeclaration = {
  name: UPDATE_PLAN,
  description: "Show your plan as a checklist: steps in order and done, how many are finished. Call it first for work with several steps, again as each finishes, and with all done before answering.",
  // Written by hand: the generated schema would double the card every request carries.
  parametersJsonSchema: { type: "object", properties: { steps: { type: "array", items: { type: "string" } }, done: { type: "integer" } }, required: ["steps", "done"] },
}

export const updatePlan = (args: unknown) => Schema.decodeUnknown(Plan, { onExcessProperty: "error" })(args).pipe(
  Effect.filterOrFail(p => p.done <= p.steps.length, () => new AgentInvalidInput({ tool: UPDATE_PLAN })),
  Effect.map((p): AgentToolResult => {
    const plan: PlanRef = { steps: p.steps.map((step, i) => ({ step, status: i < p.done ? "completed" : i === p.done ? "in_progress" : "pending" })) }
    const current = p.steps[p.done]
    return { summary: `Plan: ${p.done} of ${p.steps.length} done${current ? `, now ${current}` : ""}`, citations: [],
      data: { plan, note: "Shown to the person as a checklist. Carry on with the step in progress; update the plan when it finishes." } }
  }))

/** The plan an update_plan result carries, if any. */
export const planOf = (result: AgentToolResult): PlanRef | undefined => {
  const p = (result.data as { plan?: PlanRef } | null)?.plan
  return p && Array.isArray(p.steps) && p.steps.length ? p : undefined
}
