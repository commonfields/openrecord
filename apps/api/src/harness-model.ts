import { Effect } from "effect"
import type { HarnessSelection } from "@openrecord/contracts"
import { AgentModelError, type AgentModel, type ModelResponse } from "./agent-model.js"
import { invokeHarness, resolveHarness, HarnessRefused } from "./harness-store.js"

export const harnessModel = (
  scope: { accountId: string; userId: string; businessId: string },
  selection: HarnessSelection
) =>
  Effect.gen(function* () {
    const instance = yield* resolveHarness(scope, selection)
    // Capture the SQL service once; the existing model loop has no transport dependencies.
    const context = yield* Effect.context<import("@effect/sql").SqlClient.SqlClient>()
    const invoke: AgentModel = (input) =>
      invokeHarness(scope, selection, input).pipe(
        Effect.provide(context),
        Effect.flatMap((result) => {
          if (result.kind === "failed")
            return Effect.fail(
              new AgentModelError({
                reason:
                  result.reason === "RATE_LIMITED"
                    ? "RATE_LIMITED"
                    : result.reason === "MALFORMED"
                      ? "MALFORMED"
                      : result.reason === "TIMEOUT"
                        ? "TIMEOUT"
                        : "UNAVAILABLE"
              })
            )
          const response: ModelResponse = {
            candidates: [
              {
                finishReason: "STOP",
                content: {
                  role: "model",
                  parts:
                    result.answer.kind === "text"
                      ? [{ text: result.answer.text }]
                      : result.answer.calls.map((call) => ({ functionCall: { name: call.name, args: call.args } }))
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
                reason:
                  e instanceof HarnessRefused && e.reason === "CONTEXT_LIMIT"
                    ? "CONTEXT_LIMIT"
                    : e instanceof HarnessRefused && e.reason === "MODEL_UNAVAILABLE"
                      ? "UNCONFIGURED"
                      : "UNAVAILABLE"
              })
        )
      )
    return { invoke, provider: instance.driver, requestedModel: selection.model, instanceId: instance.id }
  })
