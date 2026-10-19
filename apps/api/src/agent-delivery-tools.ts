import { Effect, JSONSchema, Schema } from "effect"
import { BusinessRepository, GrowthDeliveryRepository } from "@openrecord/db"
import { DeliveryEdits, PrepareDelivery } from "@openrecord/contracts"
import { AgentNotInScope } from "./agent-tool-errors.js"
import type { AgentToolDef, AgentToolResult } from "./agent-tools.js"
import { prepareDelivery } from "./growth-delivery.js"

// The agent may read delivery status and draft a change. It cannot approve a
// draft, open a pull request, record a merge or attest a deployment: those
// paths exist only as operator HTTP routes and GitHub-confirmed records.

const scoped = (accountId: string, businessId: string) => Effect.gen(function*() {
  if (!(yield* (yield* BusinessRepository).getScoped(accountId, businessId))) return yield* Effect.fail(new AgentNotInScope())
})
const StatusInput = Schema.Struct({ opportunityId: Schema.optional(Schema.UUID) })

export const DELIVERY_AGENT_TOOLS: ReadonlyArray<AgentToolDef> = [
  { name: "read_delivery_status",
    description: "Read up to five marketing deliveries: the exact file change, its review state, the pull request GitHub confirmed, the merge GitHub reported, and deployment evidence with its provenance. A drafted or approved change is not delivered; a merged pull request is not a deployment. Read-only.",
    parameters: JSONSchema.make(StatusInput), decode: input => Schema.decodeUnknown(StatusInput, { onExcessProperty: "error" })(input),
    run: (accountId, businessId, input: typeof StatusInput.Type) => Effect.gen(function*() {
      yield* scoped(accountId, businessId)
      const items = (yield* (yield* GrowthDeliveryRepository).list(accountId, businessId, input.opportunityId ?? null)).slice(0, 5)
      return {
        summary: `${items.length} marketing deliveries read`,
        citations: items.map(d => ({ kind: "growth_delivery", id: d.id, text: `${d.filePath} (${d.state.toLowerCase().replaceAll("_", " ")})` })),
        data: { deliveries: items.map(d => {
          const opened = d.events.find(e => e.state === "PR_OPENED")
          const merged = d.events.find(e => e.state === "PR_MERGED")
          const deployed = d.events.find(e => e.state === "DEPLOYMENT_VERIFIED")
          return {
            id: d.id, opportunityId: d.opportunityId, repository: `${d.owner}/${d.repository}`, filePath: d.filePath, state: d.state,
            proposedBy: d.proposedBy, rationale: d.rationale.slice(0, 300), edits: d.edits.length,
            pullRequest: opened ? { number: opened.detail["prNumber"], url: opened.detail["prUrl"] } : null,
            merge: merged ? { mergeCommit: String(merged.detail["mergeCommitSha"] ?? "").slice(0, 12), confirmedBy: "GitHub" } : null,
            deployment: deployed ? { provenance: deployed.detail["provenance"], observedAt: deployed.detail["observedAt"], url: deployed.detail["url"] } : "NOT_VERIFIED",
          }
        }) },
      } satisfies AgentToolResult
    }) },
]

const Propose = Schema.Struct({
  opportunityId: Schema.UUID,
  targetId: Schema.UUID,
  filePath: PrepareDelivery.fields.filePath,
  edits: DeliveryEdits,
  rationale: PrepareDelivery.fields.rationale,
  assumptions: PrepareDelivery.fields.assumptions,
  idempotencyKey: Schema.UUID,
})
export const deliveryProposalDeclarations = [{ name: "propose_marketing_change",
  description: "Draft an exact marketing copy change for an APPROVED growth opportunity: find/replace edits on one Markdown/MDX file in a repository the operator connected (each find must appear exactly once in the current file). Saves a DRAFTED change and its diff for human review. Cannot approve it, open a pull request, merge or deploy. Use a stable UUID idempotencyKey when retrying.",
  parametersJsonSchema: JSONSchema.make(Propose),
}]

export const dispatchDeliveryProposal = (accountId: string, userId: string, businessId: string, raw: unknown) => Effect.gen(function*() {
  yield* scoped(accountId, businessId)
  const { opportunityId, ...input } = yield* Schema.decodeUnknown(Propose, { onExcessProperty: "error" })(raw)
  const delivery = yield* prepareDelivery({ accountId, userId }, businessId, opportunityId, "ASSISTANT", input)
  return {
    summary: "Marketing change drafted for human review",
    citations: [{ kind: "growth_delivery", id: delivery.id, text: `Draft change to ${delivery.filePath}` }],
    data: { deliveryId: delivery.id, state: delivery.state, filePath: delivery.filePath, edits: delivery.edits.length,
      instruction: "Open the product growth workspace to review the diff. A draft is not approved, opened, merged or deployed." },
  } satisfies AgentToolResult
})
