// A visible plan: before work that takes several steps, the agent names them,
// and updates the list as each one finishes. The person sees the steps at once
// beside the work (the TOOL_COMPLETED event carries the plan) and ticking off
// as they run; the final plan stays on the reply. Each call replaces the whole
// plan, as a to-do list the model keeps. Nothing is written: this is a read
// with no side effect, so it never needs approval and is free to repeat.
import { Effect, JSONSchema, Schema } from "effect"
import type { ToolDeclaration } from "./agent-registry.js"
import { AgentInvalidInput, type AgentToolResult } from "./agent-tools.js"

export const UPDATE_PLAN = "update_plan"
export const MAX_PLAN_STEPS = 8

const Status = Schema.Literal("pending", "in_progress", "completed")
const Step = Schema.Struct({
  step: Schema.String.pipe(Schema.trimmed(), Schema.minLength(2), Schema.maxLength(120)),
  status: Status,
})
const Plan = Schema.Struct({
  steps: Schema.Array(Step).pipe(Schema.minItems(1), Schema.maxItems(MAX_PLAN_STEPS)),
  note: Schema.optional(Schema.String.pipe(Schema.trimmed(), Schema.maxLength(200))),
})
export type PlanStep = { readonly step: string; readonly status: typeof Status.Type }
/** The plan as the client draws it. */
export interface PlanRef { readonly steps: ReadonlyArray<PlanStep>; readonly note?: string }

export const planDeclaration: ToolDeclaration = {
  name: UPDATE_PLAN,
  description: `Show the person your plan for this request as a short checklist, and keep it current. Call it first, before other tools, when the work takes several steps: more than two tool calls, research before a recommendation, or more than one piece of work. Give 2 to ${MAX_PLAN_STEPS} steps in a few plain words each, in order, with the first one in_progress and the rest pending. Call it again with the whole list whenever a step finishes or the plan changes: mark finished steps completed and the next one in_progress, at most one in_progress at a time. Mark every step completed (or drop the ones you no longer need) before your final answer. Skip it for a quick question or one read. It writes nothing and needs no approval.`,
  parametersJsonSchema: JSONSchema.make(Plan),
}

export const updatePlan = (args: unknown) => Schema.decodeUnknown(Plan, { onExcessProperty: "error" })(args).pipe(
  // At most one step in progress; more is reported to the model as invalid input.
  Effect.filterOrFail(p => p.steps.filter(s => s.status === "in_progress").length <= 1, () => new AgentInvalidInput({ tool: UPDATE_PLAN })),
  Effect.map((p): AgentToolResult => {
    const plan: PlanRef = { steps: p.steps.map(s => ({ step: s.step, status: s.status })), ...(p.note ? { note: p.note } : {}) }
    const done = plan.steps.filter(s => s.status === "completed").length
    const current = plan.steps.find(s => s.status === "in_progress")
    return { summary: `Plan: ${done} of ${plan.steps.length} done${current ? `, now ${current.step}` : ""}`, citations: [],
      data: { plan, note: "Shown to the person as a checklist. Carry on with the step in progress; update the plan when it finishes." } }
  }))

/** The plan an update_plan result carries, if any. */
export const planOf = (result: AgentToolResult): PlanRef | undefined => {
  const p = (result.data as { plan?: PlanRef } | null)?.plan
  return p && Array.isArray(p.steps) && p.steps.length ? p : undefined
}
