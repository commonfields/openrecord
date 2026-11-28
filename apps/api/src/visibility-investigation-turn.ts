import { SqlClient } from "@effect/sql"
import { assertWithinSpend, isHostedProvider } from "./agent-spend.js"
import { Effect, Schema } from "effect"
import { AGENT_SYSTEM, runConversation } from "./agent.js"
import { sendConversation, type Responder } from "./agent-conversations.js"
import { AgentModelError, configuredAgentModel, type AgentModel } from "./agent-model.js"
import { harnessModel } from "./harness-model.js"
import { AGENT_TOOL_SPECS, dispatchToolSpec } from "./agent-registry.js"
import { AgentUnknownTool, type AgentToolDeps } from "./agent-tools.js"
import { FOLLOWUP_LIMITS } from "./agent-followup-policy.js"
import { resolveUnattendedSelection } from "./harness-selection.js"
import { lastChatSelection } from "./unattended-agent.js"
import { VisibilityInvestigationPayload } from "./visibility-investigation-enqueue.js"

const READS = new Set(["read_investigation", "read_research_evidence", "compare_acquisition_batches",
  "read_acquisition_citations", "read_competitor_appearances"])
const tools = AGENT_TOOL_SPECS.filter(spec => spec.effect === "read" && spec.scope === "general" && READS.has(spec.declaration.name))
const names = new Set(tools.map(spec => spec.declaration.name))
const InvestigationRead = Schema.Struct({ investigationId: Schema.UUID, beforeNoteId: Schema.optional(Schema.UUID) })

const visibilityResponder = ({ scope, investigationId }: VisibilityInvestigationPayload): Responder<AgentToolDeps> =>
  (accountId, userId, businessId, message, history, selection, assertActive, journal) =>
    Effect.gen(function*() {
      if (accountId !== scope.accountId || userId !== scope.userId || businessId !== scope.businessId) {
        return yield* Effect.fail(new AgentModelError({ reason: "CANCELLED" }))
      }
      const services = yield* Effect.context<AgentToolDeps>()
      const guard = assertActive.pipe(Effect.provide(services))
      const picked = yield* (selection ? harnessModel(scope, selection) : configuredAgentModel)
      const dispatch = (name: string, args: unknown) => Effect.gen(function*() {
        yield* guard
        if (!names.has(name)) return yield* Effect.fail(new AgentUnknownTool({ tool: name }))
        if (name === "read_investigation") {
          const input = yield* Schema.decodeUnknown(InvestigationRead, { onExcessProperty: "error" })(args)
          if (input.investigationId !== investigationId) return yield* Effect.fail(new AgentUnknownTool({ tool: name }))
        }
        return yield* dispatchToolSpec(scope, name, args)
      }).pipe(Effect.provide(services))
      const watcher = Effect.forever(guard.pipe(Effect.andThen(Effect.sleep("500 millis"))))
      // The hosted model is metered: each step first checks the account's spend limits.
      const spend = isHostedProvider(picked.provider) ? assertWithinSpend(accountId) : Effect.void
      const model: AgentModel = input => spend.pipe(Effect.andThen(guard), Effect.andThen(Effect.raceFirst(picked.invoke(input), watcher)), Effect.provide(services))
      yield* journal.record("VERIFICATION", { visibilityAlert: true, limits: FOLLOWUP_LIMITS })
      const reply = yield* runConversation({
        message,
        history,
        model,
        dispatch,
        journal,
        budget: FOLLOWUP_LIMITS,
        completion: { requiredTools: ["read_investigation"] },
        tools: tools.map(s => s.declaration),
        system: `${AGENT_SYSTEM}\nThis is an authorized read-only background turn after a visibility alert. Reassess using stored evidence only. No proposals, delegation, publishing or live fetches.`,
      })
      return { ...reply, provider: picked.provider, requestedModel: picked.requestedModel }
    }).pipe(Effect.timeoutFail({ duration: "120 seconds", onTimeout: () => new AgentModelError({ reason: "TIMEOUT" }) }))

export const writeVisibilityInvestigationJob = (payload: unknown, job: {
  readonly account_id: string; readonly user_id: string; readonly business_id: string; readonly ref_id: string
}) =>
  Effect.gen(function*() {
    const raw = yield* Schema.decodeUnknown(VisibilityInvestigationPayload)(payload)
    if (raw.scope.accountId !== job.account_id || raw.scope.userId !== job.user_id || raw.scope.businessId !== job.business_id || raw.investigationId !== job.ref_id)
      return yield* Effect.fail("VISIBILITY_INVESTIGATION_OUT_OF_SCOPE" as const)
    const sql = yield* SqlClient.SqlClient
    const active = Effect.gen(function*() {
      const rows = yield* sql`SELECT i.id FROM growth_investigations i
        JOIN businesses b ON b.id=i.business_id AND b.archived_at IS NULL
        JOIN account_users u ON u.account_id=b.account_id AND u.user_id=${raw.scope.userId}
        WHERE i.id=${raw.investigationId} AND i.business_id=${raw.scope.businessId} AND b.account_id=${raw.scope.accountId}
        FOR SHARE OF i, b, u`
      if (!rows.length) return yield* Effect.fail(new AgentModelError({ reason: "CANCELLED" }))
    }).pipe(Effect.mapError(error => error instanceof AgentModelError ? error : new AgentModelError({ reason: "UNAVAILABLE" })))
    yield* active
    const preferred = yield* lastChatSelection(raw.scope)
    const selection = yield* resolveUnattendedSelection(raw.scope, preferred)
    const respond = visibilityResponder(raw)
    yield* sendConversation(raw.scope, {
      conversationId: raw.conversationId,
      revision: 0,
      requestId: raw.requestId,
      message: raw.message,
      selection,
      origin: { kind: "wake", title: "Visibility alert" },
    }, (accountId, userId, businessId, message, history, selected, assertActive, journal, turn) =>
      respond(accountId, userId, businessId, message, history, selected, active.pipe(Effect.andThen(assertActive)), journal, turn),
    active, FOLLOWUP_LIMITS).pipe(Effect.mapError(() => "VISIBILITY_INVESTIGATION_FAILED" as const))
  })
