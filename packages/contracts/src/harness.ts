import { Schema } from "effect"

const Text = (max: number) => Schema.String.pipe(Schema.minLength(1), Schema.maxLength(max))
const ModelId = Text(200).pipe(Schema.filter((value) => !value.startsWith("-") && !/[\u0000-\u001f\u007f]/.test(value)))
// "cliproxy" is a local CLIProxyAPI endpoint: an OpenAI-compatible proxy over the
// user's own CLI subscriptions, called with native tool calling.
export const HarnessDriver = Schema.Literal("codex", "claude", "opencode", "cursor", "cliproxy")
export type HarnessDriver = typeof HarnessDriver.Type
export const HarnessReasoningEffort = Schema.Literal("none", "minimal", "low", "medium", "high", "xhigh", "max", "thinking")
export type HarnessReasoningEffort = typeof HarnessReasoningEffort.Type
export const HarnessModel = Schema.Struct({ id: ModelId, name: Text(200), reasoningEfforts: Schema.optional(Schema.Array(HarnessReasoningEffort).pipe(Schema.minItems(1), Schema.maxItems(8))) })
export type HarnessModel = typeof HarnessModel.Type
export const HarnessSelection = Schema.Struct({ instanceId: Schema.UUID, model: ModelId, reasoningEffort: Schema.optional(HarnessReasoningEffort) })
export type HarnessSelection = typeof HarnessSelection.Type

// A bridge may report availability; only the signed-in user controls activation.
// Local paths, credential material and raw process errors never cross this boundary.
export const HarnessReport = Schema.Struct({
  localId: Schema.UUID,
  driver: HarnessDriver,
  name: Text(100),
  installed: Schema.Boolean,
  version: Schema.NullOr(Text(100)),
  auth: Schema.Literal("authenticated", "unauthenticated", "unknown"),
  accountLabel: Schema.optional(Schema.NullOr(Text(200))),
  state: Schema.Literal("ready", "unavailable", "usage_limited", "error"),
  /** When a usage limit lifts, if the provider says (ISO time). */
  limitResetsAt: Schema.optional(Schema.NullOr(Schema.String.pipe(Schema.maxLength(40)))),
  models: Schema.Array(HarnessModel).pipe(Schema.maxItems(500)),
  modelsTruncated: Schema.optional(Schema.Boolean)
})
export type HarnessReport = typeof HarnessReport.Type
export const HarnessInstance = Schema.Struct({
  id: Schema.UUID,
  bridgeId: Schema.UUID,
  localId: Schema.UUID,
  driver: HarnessDriver,
  name: Text(100),
  enabled: Schema.Boolean,
  installed: Schema.Boolean,
  version: Schema.NullOr(Text(100)),
  auth: Schema.Literal("authenticated", "unauthenticated", "unknown"),
  accountLabel: Schema.optional(Schema.NullOr(Text(200))),
  state: Schema.Literal("ready", "unavailable", "usage_limited", "error", "offline"),
  limitResetsAt: Schema.optional(Schema.NullOr(Schema.String)),
  models: Schema.Array(HarnessModel),
  modelsTruncated: Schema.optional(Schema.Boolean),
  checkedAt: Schema.String
})
export type HarnessInstance = typeof HarnessInstance.Type
export const HarnessBridge = Schema.Struct({ id: Schema.UUID, name: Text(100), online: Schema.Boolean, managed: Schema.optional(Schema.Boolean) })
export type HarnessBridge = typeof HarnessBridge.Type
export const HarnessCatalog = Schema.Struct({
  bridges: Schema.Array(HarnessBridge),
  instances: Schema.Array(HarnessInstance),
  hosted: Schema.NullOr(Schema.Struct({ provider: Schema.String, model: Schema.String })),
  /** True when this server runs on the person's own computer and can start its bridge itself. */
  local: Schema.optional(Schema.Boolean)
})
export type HarnessCatalog = typeof HarnessCatalog.Type
export const HarnessActivation = Schema.Struct({ enabled: Schema.Boolean })
export const HarnessPairRequest = Schema.Struct({ name: Text(100) })
export const HarnessRegister = Schema.Struct({ code: Schema.String.pipe(Schema.pattern(/^[A-Za-z0-9_-]{43}$/)) })
export const HarnessPoll = Schema.Struct({
  reports: Schema.Array(HarnessReport).pipe(Schema.maxItems(32)),
  acceptJob: Schema.optional(Schema.Boolean),
  // Hold the request a few seconds until a job arrives (long poll).
  wait: Schema.optional(Schema.Boolean)
})

// The server owns the tool loop. Harnesses return either text or requested
// application tool calls; the bridge never executes those tool calls locally.
// `thought` is the model's own reasoning for this step, when the provider
// returns it. It is shown to the operator and never sent back to the model.
const Thought = Schema.optional(Schema.String.pipe(Schema.maxLength(8000)))
export const HarnessAnswer = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("text"), text: Text(16000), thought: Thought }),
  Schema.Struct({
    kind: Schema.Literal("tools"),
    thought: Thought,
    calls: Schema.Array(
      Schema.Struct({
        name: Text(100),
        args: Schema.Record({ key: Schema.String, value: Schema.Unknown })
      })
    ).pipe(Schema.minItems(1), Schema.maxItems(6))
  })
)
export type HarnessAnswer = typeof HarnessAnswer.Type
export const HarnessModelInput = Schema.Struct({
  reasoningEffort: Schema.optional(HarnessReasoningEffort),
  system: Schema.String.pipe(Schema.maxLength(16000)),
  contents: Schema.Array(Schema.Struct({ role: Schema.Literal("user", "model"), parts: Schema.Array(Schema.Unknown) })),
  tools: Schema.Array(Schema.Unknown)
})
export type HarnessModelInput = typeof HarnessModelInput.Type
export const HarnessJob = Schema.Struct({
  id: Schema.UUID,
  lease: Schema.UUID,
  localId: Schema.UUID,
  driver: HarnessDriver,
  model: ModelId,
  input: HarnessModelInput
})
export type HarnessJob = typeof HarnessJob.Type
export const HarnessJobResult = Schema.Union(
  Schema.Struct({ lease: Schema.UUID, kind: Schema.Literal("completed"), answer: HarnessAnswer }),
  Schema.Struct({
    lease: Schema.UUID,
    kind: Schema.Literal("failed"),
    reason: Schema.Literal("UNAVAILABLE", "RATE_LIMITED", "UNAUTHENTICATED", "MALFORMED", "TIMEOUT", "CANCELLED")
  })
)
export type HarnessJobResult = typeof HarnessJobResult.Type
/** A running job's reasoning so far (the latest text, not a delta), fenced by its lease. */
export const HarnessJobProgress = Schema.Struct({ lease: Schema.UUID, thought: Schema.String.pipe(Schema.maxLength(4000)) })
export type HarnessJobProgress = typeof HarnessJobProgress.Type
export const HARNESS_NAMES: Readonly<Record<HarnessDriver, string>> = {
  codex: "Codex",
  claude: "Claude Code",
  opencode: "OpenCode",
  cursor: "Cursor",
  cliproxy: "CLIProxyAPI"
}
