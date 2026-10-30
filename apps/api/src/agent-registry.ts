// One registry for every tool the agent can call. Each entry declares what the
// tool may do (read, save working memory, or propose work), whether repeating
// it is safe, and how it is labelled in run progress. Dispatch is closed: a
// name that is not here never reaches a repository.
//
// No entry can approve, publish or execute. "propose" tools only save pending
// work a person decides on, and every one of them deduplicates on the server:
// a pending proposal of the same kind, or a server-derived idempotency key.
// That makes a retried or resumed run safe without trusting model input.
import { Effect, Schema } from "effect"
import { AgentProposalRepository } from "@openrecord/db"
import { dispatchGrowthProposal, growthProposalDeclarations } from "./agent-growth-tools.js"
import { acquisitionProposalDeclarations, dispatchAcquisitionProposal } from "./agent-acquisition-proposals.js"
import { dispatchDraftTool, draftDeclarations } from "./agent-drafts.js"
import { AGENT_TOOLS, AgentInvalidInput, AgentUnknownTool, runAgentTool, type AgentToolDeps, type AgentToolResult } from "./agent-tools.js"
import { AgentNotInScope } from "./agent-tool-errors.js"
import { AgentModelError } from "./agent-model.js"
import { diagnoseMarketingProblems, firstImprovementDeclarations, proposeFirstImprovement, type AgentOrigin } from "./agent-first-improvement.js"
import { STARTS_WORK } from "./agent-session-tools.js"
import { dispatchInvestigation, investigationDeclarations } from "./agent-investigation-tools.js"
import { dispatchExecutionTool, executionDeclarations } from "./agent-execution-tools.js"

/** "record" saves unverified internal memory; "delegate" starts a helper turn. */
export type ToolEffect = "read" | "propose" | "delegate" | "record"
export interface ToolContext {
  readonly accountId: string; readonly userId: string; readonly businessId: string
  readonly origin?: AgentOrigin | undefined
}
export interface ToolDeclaration { readonly name: string; readonly description: string; readonly parametersJsonSchema: unknown }
export interface AgentToolSpec {
  readonly declaration: ToolDeclaration
  readonly effect: ToolEffect
  /** "safe": a read, free to repeat. "deduplicated": the server returns the saved result on repeat. */
  readonly replay: "safe" | "deduplicated"
  /** Workflow-only tools are declared only inside their workflow's turn. */
  readonly scope: "general" | "workflow"
  readonly run: (ctx: ToolContext, args: unknown) => Effect.Effect<AgentToolResult, unknown, AgentToolDeps>
}

const ProposeCheck = Schema.Struct({ questionId: Schema.UUID })
const proposeCheckRun = (ctx: ToolContext, args: unknown) => Effect.gen(function*() {
  yield* Effect.logInfo("agent proposal invoked").pipe(Effect.annotateLogs({ account_id: ctx.accountId, business_id: ctx.businessId, tool: "propose_check_run", invoked_at: new Date().toISOString() }))
  const parsed = yield* Schema.decodeUnknown(ProposeCheck, { onExcessProperty: "error" })(args)
  const proposal = yield* (yield* AgentProposalRepository).propose({ accountId: ctx.accountId, businessId: ctx.businessId, kind: "REQUEST_CHECK", questionId: parsed.questionId,
    message: "Assistant-proposed re-check. Review question, provider, model and cost before approval.", proposer: "assistant-v1", proposedByUserId: ctx.userId })
  return { summary: "Re-check proposed; approval required", citations: [{ kind: "question", id: parsed.questionId, text: "Proposed buyer question" }],
    data: { proposalId: proposal.id, status: proposal.status, questionId: proposal.questionId, executed: false } } satisfies AgentToolResult
})

const declared = (list: ReadonlyArray<ToolDeclaration>, name: string) => list.find(d => d.name === name)!
export const AGENT_TOOL_SPECS: ReadonlyArray<AgentToolSpec> = [
  ...executionDeclarations.map((declaration): AgentToolSpec => ({ declaration,
    effect: declaration.name === "prepare_noindex_change" ? "propose" : "read",
    replay: declaration.name === "prepare_noindex_change" ? "deduplicated" : "safe", scope: "general",
    run: (ctx, args) => dispatchExecutionTool(ctx, declaration.name, args) })),
  ...investigationDeclarations.map((declaration): AgentToolSpec => ({ declaration, effect: "record", replay: "deduplicated", scope: "general",
    run: (ctx, args) => dispatchInvestigation(ctx, declaration.name, args) })),
  ...growthProposalDeclarations.map((declaration): AgentToolSpec => ({ declaration, effect: "propose", replay: "deduplicated", scope: "general",
    run: (ctx, args) => dispatchGrowthProposal(ctx.accountId, ctx.userId, ctx.businessId, args) })),
  ...draftDeclarations.map((declaration): AgentToolSpec => ({ declaration, effect: "propose", replay: "deduplicated", scope: "general",
    run: (ctx, args) => dispatchDraftTool(ctx.accountId, ctx.userId, ctx.businessId, declaration.name, args) })),
  ...acquisitionProposalDeclarations.map((declaration): AgentToolSpec => ({ declaration, effect: "propose", replay: "deduplicated", scope: "general",
    run: (ctx, args) => dispatchAcquisitionProposal(ctx.accountId, ctx.userId, ctx.businessId, declaration.name, args) })),
  ...AGENT_TOOLS.map((t): AgentToolSpec => ({ declaration: { name: t.name, description: t.description, parametersJsonSchema: t.parameters },
    effect: "read", replay: "safe", scope: "general", run: (ctx, args) => runAgentTool(ctx.accountId, ctx.businessId, t.name, args) })),
  { declaration: { name: "propose_check_run", description: "Prepare a REQUEST_CHECK proposal for a stored question. Never executes. Human approval and provider/model selection required.",
      parametersJsonSchema: { type: "object", properties: { questionId: { type: "string", format: "uuid" } }, required: ["questionId"], additionalProperties: false } },
    effect: "propose", replay: "deduplicated", scope: "general", run: proposeCheckRun },
  { declaration: declared(firstImprovementDeclarations, "diagnose_marketing_problems"), effect: "read", replay: "safe", scope: "workflow",
    run: ctx => diagnoseMarketingProblems(ctx.accountId, ctx.businessId) },
  { declaration: declared(firstImprovementDeclarations, "propose_first_improvement"), effect: "propose", replay: "deduplicated", scope: "workflow",
    run: (ctx, args) => proposeFirstImprovement(ctx.accountId, ctx.userId, ctx.businessId, args, ctx.origin) },
]

export const findToolSpec = (name: string) => AGENT_TOOL_SPECS.find(s => s.declaration.name === name)
export const toolEffect = (name: string): ToolEffect => findToolSpec(name)?.effect ?? (STARTS_WORK.has(name) ? "delegate" : "read")

export const dispatchToolSpec = (ctx: ToolContext, name: string, args: unknown) => Effect.gen(function*() {
  const spec = findToolSpec(name)
  if (!spec) return yield* Effect.fail(new AgentUnknownTool({ tool: name }))
  return yield* spec.run(ctx, args)
})

/** Short present-tense label for run progress, from the tool name alone. */
const VERBS: Readonly<Record<string, string>> = { read: "Reading", discover: "Listing", propose: "Proposing", draft: "Drafting", prepare: "Preparing", compare: "Comparing", diagnose: "Diagnosing",
  delegate: "Delegating", message: "Messaging", cancel: "Cancelling", list: "Listing", search: "Searching", audit: "Auditing", open: "Opening", record: "Recording" }
export const toolLabel = (name: string) => {
  const [verb = "", ...rest] = name.split("_")
  return `${VERBS[verb] ?? "Running"} ${rest.join(" ")}`.trim()
}

// Typed tool failures. The model gets a stable code, whether retrying can help
// and what to do next; repository and decoder detail never leaves the server.
export type ToolFailureCode = "UNKNOWN_TOOL" | "INVALID_INPUT" | "NOT_FOUND" | "REFUSED" | "TOOL_FAILED" | "RESULT_TOO_LARGE" | "BUDGET_EXHAUSTED"
export interface ToolFailure { readonly code: ToolFailureCode; readonly retryable: boolean; readonly guidance: string; readonly summary: string }
const FAILURES: Readonly<Record<ToolFailureCode, Omit<ToolFailure, "code">>> = {
  UNKNOWN_TOOL: { retryable: false, summary: "Tool not available for this request", guidance: "This tool is not available in this request. Use only the declared tools." },
  INVALID_INPUT: { retryable: true, summary: "Request refused: invalid tool input", guidance: "The arguments did not match the tool schema. Correct them once, using only declared properties and IDs returned by earlier tools." },
  NOT_FOUND: { retryable: false, summary: "Referenced evidence not found in this business", guidance: "The referenced item does not exist in this business. Do not guess IDs; use IDs returned by tools." },
  REFUSED: { retryable: false, summary: "Request refused by the server", guidance: "The server refused this request in its current state. Explain what is missing instead of retrying." },
  TOOL_FAILED: { retryable: true, summary: "Evidence temporarily unavailable", guidance: "The evidence store did not answer. You may retry once; otherwise say the evidence is unavailable." },
  RESULT_TOO_LARGE: { retryable: true, summary: "Evidence exceeds context limit; request a smaller selection", guidance: "The result is too large. Request a smaller selection with a lower limit or a specific ID." },
  BUDGET_EXHAUSTED: { retryable: false, summary: "Not run: tool budget for this request used up", guidance: "The tool budget for this request is used up. Answer from the evidence already read and say what was not checked." },
}
export const toolFailure = (code: ToolFailureCode): ToolFailure => ({ code, ...FAILURES[code] })
export const classifyToolFailure = (e: unknown): ToolFailure => {
  const tag = (e as { _tag?: string } | null)?._tag
  if (e instanceof AgentUnknownTool) return toolFailure("UNKNOWN_TOOL")
  if (e instanceof AgentInvalidInput || tag === "ParseError") return toolFailure("INVALID_INPUT")
  if (e instanceof AgentNotInScope) return toolFailure("NOT_FOUND")
  if (tag === "AgentInvestigationConflict") return { ...toolFailure("REFUSED"), guidance: "The investigation state changed. Read read_investigation for its current state_note_id before deciding whether a new state change is still appropriate. Do not blindly retry." }
  if (tag === "GrowthExecutionRefused") {
    const reason = (e as { readonly reason?: string }).reason
    const guidance: Readonly<Record<string, string>> = {
      ExecutionNotConfigured: "Connected execution is not configured. Ask the operator to configure the repository connection; do not claim a change was prepared.",
      RepositoryNotPermitted: "The connected repository is not allowed by the server. Ask an administrator to review the connection.",
      InitiativeNotApproved: "The initiative must be approved by a person before preparing a connected change.",
      PathNotPermitted: "The page is outside the connected repository's allowed paths. Ask the operator to review the connection.",
      NotApplicable: "The supported noindex change cannot be safely applied to this file. Do not guess another change.",
      ExecutionAlreadyOpen: "A connected change is already open. Read its current state before proposing another.",
    }
    return { ...toolFailure("REFUSED"), guidance: guidance[reason ?? ""] ?? toolFailure("REFUSED").guidance }
  }
  if (tag === "AgentProposalRefused" || tag === "GrowthRefused" || tag === "AcquisitionRefused") return toolFailure("REFUSED")
  return toolFailure("TOOL_FAILED")
}
/** Run-level failures (cancellation, lost lease) stop the run; they are not tool results. */
export const isRunFailure = (e: unknown): e is AgentModelError => e instanceof AgentModelError

/** Something a person decides on, created by a proposal tool. The chat renders
 * each one as an approval card on the reply that created it. */
export interface DecisionRef { readonly type: "AGENT_PROPOSAL" | "GROWTH_OPPORTUNITY"; readonly id: string }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const decisionRefs = (receipt: Readonly<Record<string, unknown>>): DecisionRef[] => [
  ...(typeof receipt["proposalId"] === "string" && UUID.test(receipt["proposalId"]) ? [{ type: "AGENT_PROPOSAL" as const, id: receipt["proposalId"] }] : []),
  ...(typeof receipt["opportunityId"] === "string" && UUID.test(receipt["opportunityId"]) ? [{ type: "GROWTH_OPPORTUNITY" as const, id: receipt["opportunityId"] }] : []),
]
/** A task another session ran for this one. The chat renders it as a card linking to that session. */
export type TaskStatus = "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED" | "INTERRUPTED"
export interface TaskRef { readonly id: string; readonly sessionId: string; readonly title: string; readonly role: string; readonly status: TaskStatus; readonly model?: string }
/** At most ten, first occurrence kept; a later status for the same task replaces the earlier one. */
export const mergeTasks = (refs: Iterable<TaskRef>): TaskRef[] => {
  const seen = new Map<string, TaskRef>()
  for (const r of refs) if (seen.has(r.id) || seen.size < 10) seen.set(r.id, r)
  return [...seen.values()]
}
/** At most ten, first occurrence kept. */
export const mergeDecisions = (refs: Iterable<DecisionRef>): DecisionRef[] => {
  const seen = new Map<string, DecisionRef>()
  for (const r of refs) if (!seen.has(`${r.type}:${r.id}`) && seen.size < 10) seen.set(`${r.type}:${r.id}`, r)
  return [...seen.values()]
}

/** The durable receipt of a proposal tool: identifiers and states only, never evidence text. */
export const proposalReceipt = (result: AgentToolResult): Record<string, string | boolean | number | null> => {
  const data = result.data
  if (data === null || typeof data !== "object") return {}
  return Object.fromEntries(Object.entries(data as Record<string, unknown>).filter(([k, v]) =>
    (/(?:Id|^status|^kind|^saved|^executed|^published|^reusedPendingDraft|^approval)$/.test(k)) &&
    (v === null || typeof v === "boolean" || typeof v === "number" || (typeof v === "string" && v.length <= 120))) as Array<[string, string | boolean | number | null]>)
}
