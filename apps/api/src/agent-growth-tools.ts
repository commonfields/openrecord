import { Effect, JSONSchema, Schema } from "effect"
import { BusinessRepository, GrowthRepository } from "@openrecord/db"
import { GrowthObservedRef, GrowthOpportunityFields } from "@openrecord/contracts"
import { AgentNotInScope } from "./agent-tool-errors.js"
import type { AgentToolDef, AgentToolResult } from "./agent-tools.js"

const scoped = (accountId: string, businessId: string) => Effect.gen(function*() {
  if (!(yield* (yield* BusinessRepository).getScoped(accountId, businessId))) return yield* Effect.fail(new AgentNotInScope())
})
const Empty = Schema.Struct({})
const ListInput = Schema.Struct({ limit: Schema.optional(Schema.Int.pipe(Schema.between(1, 5))) })
export const GROWTH_AGENT_TOOLS: ReadonlyArray<AgentToolDef> = [
  { name: "read_growth_goal", description: "Read the human-authored primary growth goal, immutable metric definition and product positioning. Event counts are not distinct people. Read-only.",
    parameters: JSONSchema.make(Empty), decode: input => Schema.decodeUnknown(Empty, { onExcessProperty: "error" })(input),
    run: (accountId, businessId) => Effect.gen(function*() {
      yield* scoped(accountId, businessId)
      const profile = yield* (yield* GrowthRepository).profile(accountId, businessId)
      return { summary: profile ? "Primary growth goal and product positioning read" : "Growth goal is not configured",
        citations: profile ? [{ kind: "growth_goal", id: profile.primaryGoal.id, text: "Primary growth goal" }] : [], data: { profile } }
    }) },
  { name: "read_growth_opportunities", description: "Read up to five growth opportunity summaries, explicit evidence types and current lifecycle revisions. Proposals are hypotheses, never shipped changes or measured outcomes. Read-only.",
    parameters: JSONSchema.make(ListInput), decode: input => Schema.decodeUnknown(ListInput, { onExcessProperty: "error" })(input),
    run: (accountId, businessId, input: typeof ListInput.Type) => Effect.gen(function*() {
      yield* scoped(accountId, businessId)
      const items = yield* (yield* GrowthRepository).list(accountId, businessId, input.limit ?? 3)
      return { summary: `${items.length} recent growth opportunities read`, citations: items.map(o => ({ kind: "growth_opportunity", id: o.id, text: o.title })),
        data: { opportunities: items.map(o => ({ id: o.id, title: o.title, goalId: o.goalId, status: o.status, revision: o.revision,
          problemStatement: o.problemStatement.slice(0, 300), proposedChange: o.proposedChange.slice(0, 300), uncertainty: o.uncertainty.slice(0, 300),
          evidence: o.evidence.slice(0, 5).map(e => ({ type: e.type, ...(e.type === "OBSERVED" ? { reference: e.reference } : {}) })) })) } }
    }) },
]
const Propose = Schema.Struct({
  ...GrowthOpportunityFields.fields, idempotencyKey: Schema.UUID,
  observedReferences: Schema.Array(GrowthObservedRef).pipe(Schema.maxItems(10)),
})
export const growthProposalDeclarations = [{ name: "propose_growth_opportunity",
  description: "Save a PROPOSED growth opportunity as an assistant hypothesis for human review. Cite stored evidence references only; unavailable references are dropped and reported. Use a stable UUID idempotencyKey when retrying. Cannot approve, cancel, change goals, deliver or measure anything.",
  parametersJsonSchema: JSONSchema.make(Propose),
}]
export const dispatchGrowthProposal = (accountId: string, userId: string, businessId: string, raw: unknown) => Effect.gen(function*() {
  yield* scoped(accountId, businessId)
  const input = yield* Schema.decodeUnknown(Propose, { onExcessProperty: "error" })(raw)
  const repo = yield* GrowthRepository
  const { observedReferences, idempotencyKey, ...fields } = input
  const refs = yield* repo.validateObserved(accountId, businessId, observedReferences)
  const opportunity = yield* repo.create({ accountId, userId }, businessId, "ASSISTANT", { ...fields, idempotencyKey,
    ownerUserId: userId, initialStatus: "PROPOSED",
    // Baseline availability cannot be inferred from merely naming a reference.
    baselineAvailability: "UNKNOWN",
    evidence: [{ type: "MODEL_SUGGESTION", note: "Agent suggestion and hypothesis; requires operator review. No measured impact is claimed." },
      ...refs.valid.map(reference => ({ type: "OBSERVED" as const, reference, note: "Stored evidence cited by the assistant; relevance requires human review." }))],
  })
  return { summary: "Growth hypothesis saved for human review", citations: [{ kind: "growth_opportunity", id: opportunity.id, text: opportunity.title }],
    data: { opportunityId: opportunity.id, status: opportunity.status, hypothesis: true, droppedReferences: refs.dropped,
      validatedObservedReferences: refs.valid.length, instruction: "Open the product growth workspace to review. A proposal is not approval, delivery or measured impact." } } satisfies AgentToolResult
})
