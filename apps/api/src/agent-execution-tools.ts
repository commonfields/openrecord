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
  actionKind: PrepareExecution.fields.actionKind,
  value: PrepareExecution.fields.value,
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
    input.opportunityId, input.targetId, input.actionKind, input.value ?? null, input.filePath, input.liveUrl, input.rationale, input.siteFindingId])).digest("hex")
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`
}

export const executionDeclarations: ReadonlyArray<ToolDeclaration> = [
  { name: "read_connected_execution_targets", description: "List this business's connected website repositories and allowed paths. A repository must be connected by an operator first.", parametersJsonSchema: JSONSchema.make(Empty) },
  { name: "prepare_page_change", description: "Prepare one exact, reviewable change to one HTML file in a connected repository, for an already approved initiative. actionKind and value: REMOVE_NOINDEX_META (no value) takes out an accidental noindex; SET_TITLE {title} sets the page title (about 50 to 60 characters, the page's real topic and the business name); SET_META_DESCRIPTION {description} sets the search snippet (about 140 to 160 characters, what the page offers and why to click); SET_CANONICAL {canonicalUrl} points the canonical link at an address on the same site; ADD_JSON_LD {jsonLd} adds schema.org structured data as a JSON string (FAQPage, LocalBusiness, Product, Organization...), using only facts from approved business truth or the page itself; SET_IMAGE_ALT {imageSrc, alt} sets alt text on the one image whose src attribute is exactly imageSrc. You write the words; they reach the site only after a person reviews the exact diff in the initiative's Connected change section and authorizes the pull request. This does not approve, dispatch, publish or merge. A page that is ambiguous for the change is refused, not guessed. Read the page first and use paths and addresses from evidence.", parametersJsonSchema: JSONSchema.make(Prepare) },
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
    { targetId: input.targetId, actionKind: input.actionKind, ...(input.value ? { value: input.value } : {}), filePath: input.filePath, liveUrl: input.liveUrl,
      rationale: input.rationale, siteFindingId: input.siteFindingId, idempotencyKey: requestKey(ctx, input) }, "ASSISTANT").pipe(
      Effect.provideService(GrowthExecutionRepository, repo))
  return { summary: "Exact page change prepared; human review and approval required", citations: [], data: {
    operationId: operation.id, opportunityId: input.opportunityId, state: operation.state, actionKind: operation.actionKind, filePath: operation.filePath, diff: operation.diff.slice(0, 4000),
    liveUrl: operation.liveUrl, owner: operation.owner, repository: operation.repository, patchSha256: operation.patchSha256,
    instruction: "Open the initiative's Connected change section to review the exact diff and approve opening the pull request. Nothing has been published.",
  } } satisfies AgentToolResult
})
