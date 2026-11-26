import { Effect } from "effect"
import { AGENT_SYSTEM, runConversation } from "./agent.js"
import { sendConversation, type Responder } from "./agent-conversations.js"
import { AgentModelError, configuredAgentModel, type AgentModel } from "./agent-model.js"
import { harnessModel } from "./harness-model.js"
import { dispatchToolSpec } from "./agent-registry.js"
import { AgentUnknownTool, type AgentToolDeps } from "./agent-tools.js"
import { FOLLOWUP_LIMITS } from "./agent-followup-policy.js"
import { followupToolSpecs } from "./agent-followups.js"
import { loadResumeContext } from "./agent-resume.js"
import { resolveUnattendedSelection } from "./harness-selection.js"
import { lastChatSelection } from "./unattended-agent.js"
import type { VisibilityInvestigationPayload } from "./visibility-investigation-enqueue.js"

const visibilityResponder = (scope: VisibilityInvestigationPayload["scope"]): Responder<AgentToolDeps> =>
  (accountId, userId, businessId, message, history, _selection, assertActive, journal) =>
    Effect.gen(function*() {
      if (accountId !== scope.accountId || userId !== scope.userId || businessId !== scope.businessId) {
        return yield* Effect.fail(new AgentModelError({ reason: "CANCELLED" }))
      }
      const services = yield* Effect.context<AgentToolDeps>()
      const preferred = yield* lastChatSelection(scope)
      const resolved = yield* resolveUnattendedSelection(scope, preferred)
      const picked = yield* (resolved ? harnessModel(scope, resolved) : configuredAgentModel)
      const tools = followupToolSpecs()
      const names = new Set(tools.map(s => s.declaration.name))
      const dispatch = (name: string, args: unknown) => assertActive.pipe(Effect.andThen(
        names.has(name) ? dispatchToolSpec(scope, name, args) : Effect.fail(new AgentUnknownTool({ tool: name })),
      ), Effect.provide(services))
      const model: AgentModel = input => assertActive.pipe(Effect.andThen(picked.invoke(input)))
      const resumeContext = yield* loadResumeContext(scope.accountId, scope.businessId)
      yield* journal.record("VERIFICATION", { visibilityAlert: true, limits: FOLLOWUP_LIMITS })
      return yield* runConversation({
        message,
        history,
        model,
        dispatch,
        journal,
        resumeContext,
        budget: FOLLOWUP_LIMITS,
        tools: tools.map(s => s.declaration),
        system: `${AGENT_SYSTEM}\nThis is an authorized read-only background turn after a visibility alert. Reassess using stored evidence only. No proposals, delegation, publishing or live fetches.`,
      })
    }).pipe(Effect.timeoutFail({ duration: "120 seconds", onTimeout: () => new AgentModelError({ reason: "TIMEOUT" }) }))

export const writeVisibilityInvestigationJob = (raw: VisibilityInvestigationPayload) =>
  Effect.gen(function*() {
    const preferred = yield* lastChatSelection(raw.scope)
    const selection = yield* resolveUnattendedSelection(raw.scope, preferred)
    const result = yield* sendConversation(raw.scope, {
      conversationId: raw.conversationId,
      revision: 0,
      requestId: raw.requestId,
      message: raw.message,
      selection,
      origin: { kind: "wake", title: "Visibility alert" },
    }, visibilityResponder(raw.scope), Effect.void, FOLLOWUP_LIMITS).pipe(Effect.exit)
    if (result._tag === "Failure") {
      yield* Effect.logWarning("visibility investigation turn failed").pipe(
        Effect.annotateLogs({ investigation: raw.investigationId, cause: String(result.cause) }),
      )
    }
  })