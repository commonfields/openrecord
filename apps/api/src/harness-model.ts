import { Effect } from "effect"
import type { HarnessSelection } from "@openrecord/contracts"
import { AgentModelError, type AgentModel, type ModelResponse } from "./agent-model.js"
import { invokeHarness, resolveHarness, HarnessRefused } from "./harness-store.js"

export const harnessFailureReason = (reason: string): AgentModelError["reason"] => {
  if (reason === "CANCELLED") return "CANCELLED"
  if (reason === "UNAUTHENTICATED" || reason === "MODEL_UNAVAILABLE") return "UNCONFIGURED"
  if (reason === "RATE_LIMITED" || reason === "TIMEOUT" || reason === "CONTEXT_LIMIT" || reason === "MALFORMED") return reason
  return "UNAVAILABLE"
}

export const harnessModel = (
  scope: { accountId: string; userId: string; businessId: string | null },
  selection: HarnessSelection
) =>
  Effect.gen(function* () {
    const instance = yield* resolveHarness(scope, selection)
    // Capture the SQL service once; the existing model loop has no transport dependencies.
    const context = yield* Effect.context<import("@effect/sql").SqlClient.SqlClient>()
    const invoke: AgentModel = (input) =>
      invokeHarness(scope, selection, input, input.onThought).pipe(
        Effect.provide(context),
        Effect.flatMap((result) => {
          if (result.kind === "failed")
            return Effect.fail(
              new AgentModelError({
                reason: harnessFailureReason(result.reason)
              })
            )
          const response: ModelResponse = {
            candidates: [
              {
                finishReason: "STOP",
                content: {
                  role: "model",
                  parts: [
                    ...(result.answer.thought ? [{ text: result.answer.thought, thought: true }] : []),
                    ...(result.answer.kind === "text"
                      ? [{ text: result.answer.text }]
                      : result.answer.calls.map((call) => ({ functionCall: { name: call.name, args: call.args } })))
                  ]
                }
              }
            ]
          }
          return Effect.succeed(response)
        }),
        Effect.mapError((e) =>
          e instanceof AgentModelError
            ? e
            : new AgentModelError({
                reason: e instanceof HarnessRefused ? harnessFailureReason(e.reason) : "UNAVAILABLE"
              })
        )
      )
    return { invoke, provider: instance.driver, requestedModel: selection.model, instanceId: instance.id }
  })
