import { createHash } from "node:crypto"
import { Effect, JSONSchema, Option, Schema } from "effect"
import { GrowthExecutionRepository, GrowthExecutionRefused } from "@openrecord/db"
import { PrepareExecution, executionFacts } from "@openrecord/contracts"
import { prepareConnectedExecution } from "./growth-execution-routes.js"
import type { ToolContext, ToolDeclaration } from "./agent-registry.js"
import type { AgentToolResult } from "./agent-tools.js"

const Prepare = Schema.Struct({
  opportunityId: Schema.UUID,
  targetId: PrepareExecution.fields.targetId,
  filePath: PrepareExecution.fields.filePath,
  liveUrl: PrepareExecution.fields.liveUrl,
  rationale: PrepareExecution.fields.rationale,
  siteFindingId: PrepareExecution.fields.siteFindingId,
})
const Read = Schema.Struct({ opportunityId: Schema.UUID })
const Empty = Schema.Struct({})

/** The model cannot choose the request key: identical proposals from the same user replay safely. */
const requestKey = (ctx: ToolContext, input: typeof Prepare.Type) => {
  const hash = createHash("sha256").update(JSON.stringify(["agent-connected-execution-v1", ctx.accountId, ctx.businessId, ctx.userId,
    input.opportunityId, input.targetId, input.filePath, input.liveUrl, input.rationale, input.siteFindingId])).digest("hex")
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`
}

export const executionDeclarations: ReadonlyArray<ToolDeclaration> = [
  { name: "read_connected_execution_targets", description: "List this business's connected website repositories and allowed paths. A repository must be connected by an operator first.", parametersJsonSchema: JSONSchema.make(Empty) },
  { name: "prepare_noindex_change", description: "Prepare a reviewable exact removal of an accidental noindex directive from one HTML file in a connected repository, for an already approved initiative. This does not approve, dispatch, publish or merge. The human must review and approve the exact change in the initiative's Connected change section, and authorize opening the pull request. Use IDs and paths from evidence; never guess.", parametersJsonSchema: JSONSchema.make(Prepare) },
  { name: "read_connected_executions", description: "Read connected changes for an initiative, including current state, verified merge and live website observations. A prepared or approved change is not a completed change; a merge is not proof of a live change or business impact.", parametersJsonSchema: JSONSchema.make(Read) },
]

export const dispatchExecutionTool = (ctx: ToolContext, name: string, raw: unknown) => Effect.gen(function*() {
  const available = yield* Effect.serviceOption(GrowthExecutionRepository)
  if (Option.isNone(available)) return yield* Effect.fail(new GrowthExecutionRefused({ reason: "ExecutionNotConfigured" }))
  const repo = available.value
  if (name === "read_connected_execution_targets") {
    yield* Schema.decodeUnknown(Empty, { onExcessProperty: "error" })(raw)
    const targets = yield* repo.targets(ctx.accountId, ctx.businessId)
    return { summary: `${targets.length} connected repositories read`, citations: [], data: { targets } } satisfies AgentToolResult
  }
  if (name === "read_connected_executions") {
    const input = yield* Schema.decodeUnknown(Read, { onExcessProperty: "error" })(raw)
    const operations = yield* repo.list(ctx.accountId, ctx.businessId, input.opportunityId)
    return { summary: `${operations.length} connected changes read`, citations: [], data: { operations: operations.map(o => ({
      id: o.id, state: o.state, revision: o.revision, owner: o.owner, repository: o.repository, filePath: o.filePath,
      liveUrl: o.liveUrl, facts: executionFacts(o), receipt: o.receipt, liveChecks: o.liveChecks.slice(0, 3),
    })) } } satisfies AgentToolResult
  }
  const input = yield* Schema.decodeUnknown(Prepare, { onExcessProperty: "error" })(raw)
  const operation = yield* prepareConnectedExecution({ accountId: ctx.accountId, userId: ctx.userId }, ctx.businessId, input.opportunityId,
    { ...input, actionKind: "REMOVE_NOINDEX_META", idempotencyKey: requestKey(ctx, input) }, "ASSISTANT").pipe(
      Effect.provideService(GrowthExecutionRepository, repo))
  return { summary: "Exact noindex change prepared; human review and approval required", citations: [], data: {
    operationId: operation.id, opportunityId: input.opportunityId, state: operation.state, filePath: operation.filePath,
    liveUrl: operation.liveUrl, owner: operation.owner, repository: operation.repository, patchSha256: operation.patchSha256,
    instruction: "Open the initiative's Connected change section to review the exact diff and approve opening the pull request. Nothing has been published.",
  } } satisfies AgentToolResult
})
