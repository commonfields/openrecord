import { Effect, Schema } from "effect"
import { AgentProposalRepository, BusinessRepository, RecordRepository, ActionDraftInput, buildActionDraft, buildClientReport } from "@openrecord/db"
import { AgentInvalidInput, AgentNotInScope, type AgentToolResult } from "./agent-tools.js"
const ReportInput = Schema.Struct({
  start: Schema.optional(Schema.String.pipe(Schema.maxLength(30))),
  end: Schema.optional(Schema.String.pipe(Schema.maxLength(30))),
})
export const draftDeclarations = [
  { name: "draft_source_action", description: "Draft a source action hypothesis for an approved client-record fact with real observations. Never publishes or records completed work.",
    parametersJsonSchema: { type: "object", properties: { slot: { type: "integer", enum: [1, 2, 3] }, proposedAction: { type: "string", maxLength: 1200 }, assumptions: { type: "array", maxItems: 5, items: { type: "string", maxLength: 300 } }, uncertainty: { type: "string", maxLength: 600 }, verificationPlan: { type: "string", maxLength: 600 } }, required: ["slot", "proposedAction", "assumptions", "uncertainty", "verificationPlan"], additionalProperties: false } },
  { name: "prepare_client_report", description: "Prepare an immutable, private client-report draft with deterministic counts and evidence provenance. Optional ISO UTC start/end, end exclusive; defaults to last seven days. No publication or delivery.",
    parametersJsonSchema: { type: "object", properties: { start: { type: "string", format: "date-time" }, end: { type: "string", format: "date-time" } }, additionalProperties: false } },
]
export const dispatchDraftTool = (accountId: string, userId: string, businessId: string, name: string, raw: unknown) => Effect.gen(function*() {
  if (!(yield* (yield* BusinessRepository).getScoped(accountId, businessId))) return yield* Effect.fail(new AgentNotInScope())
  yield* Effect.logInfo("agent draft invoked").pipe(Effect.annotateLogs({ account_id: accountId, business_id: businessId, tool: name, invoked_at: new Date().toISOString() }))
  const records = yield* RecordRepository
  const snapshot = yield* records.snapshot(businessId)
  if (!snapshot) return yield* Effect.fail(new AgentNotInScope())
  const generatedAt = new Date().toISOString()
  const payload = yield* Effect.gen(function*() {
    if (name === "draft_source_action") {
      const input = yield* Schema.decodeUnknown(ActionDraftInput, { onExcessProperty: "error" })(raw)
      return buildActionDraft(snapshot, input, generatedAt)
    }
    const input = yield* Schema.decodeUnknown(ReportInput, { onExcessProperty: "error" })(raw)
    const pending = yield* (yield* AgentProposalRepository).listByBusiness(accountId, businessId, "PROPOSED")
    return buildClientReport(snapshot, { start: input.start ?? new Date(Date.parse(generatedAt) - 7 * 86400000).toISOString(), end: input.end ?? generatedAt }, generatedAt, pending.map(p => ({ id: p.id, kind: p.kind, status: p.status })))
  }).pipe(Effect.mapError(() => new AgentInvalidInput({ tool: name })))
  if (!payload) return yield* Effect.fail(new AgentInvalidInput({ tool: name }))
  const proposal = yield* (yield* AgentProposalRepository).propose({ accountId, businessId, kind: payload.kind, questionId: payload.kind === "DRAFT_SOURCE_ACTION" ? payload.references.find(ref => ref.kind === "question")?.id ?? null : null,
    message: payload.kind === "PREPARE_CLIENT_REPORT" ? "Private evidence-backed client report draft. Review before using; approval does not publish or deliver it." : "Source action hypothesis. Review assumptions and evidence; approval does not apply or record completed work.",
    payload, proposer: "assistant-v1", proposedByUserId: userId,
  })
  // Keep the saved report authoritative; the model gets a short receipt.
  return { summary: proposal.kind === "PREPARE_CLIENT_REPORT" ? "Private report prepared for review" : "Action hypothesis prepared for review",
    citations: [{ kind: "record", id: businessId, text: "Client record" }],
    data: { proposalId: proposal.id, kind: proposal.kind, status: proposal.status, saved: true, generatedAt: proposal.payload?.generatedAt ?? null, reusedPendingDraft: proposal.payload?.generatedAt !== generatedAt, published: false, executed: false,
      instruction: "The operator can read and copy the saved draft below. Do not replace its deterministic numbers with generated totals." } } satisfies AgentToolResult
})
