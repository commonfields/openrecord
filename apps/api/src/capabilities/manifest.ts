import { Schema } from "effect"

/**
 * M1.5 capability manifest. One per capability version, reviewed in code.
 * A manifest describes and routes a capability; it never grants authority.
 * Execution still re-checks tenancy, permission, availability and revision fences.
 */
export const Namespace = Schema.Literal("research", "strategy", "creative", "media", "crm", "measurement", "web", "work")
export type Namespace = typeof Namespace.Type

/** none: reads only. internal_write: OpenRecord rows (drafts, notes, proposals). external_write / irreversible: third-party state. */
export const SideEffect = Schema.Literal("none", "internal_write", "external_write", "irreversible")
export type SideEffect = typeof SideEffect.Type

const Text = (min: number, max: number) => Schema.String.pipe(Schema.filter(s => s.trim().length >= min && s.length <= max, { message: () => `text between ${min} and ${max} characters` }))

export const RoutingCase = Schema.Struct({
  id: Schema.String,
  /** A natural-language step, as a person or the agent would phrase it. */
  task: Text(3, 500),
  /** Routing: the capability must (true) or must not (false) be among the selected schemas. */
  expectSelected: Schema.Boolean,
})
export type RoutingCase = typeof RoutingCase.Type

export const CapabilityManifest = Schema.Struct({
  id: Schema.String.pipe(Schema.pattern(/^[a-z][a-z0-9_]*$/)),
  version: Schema.Int.pipe(Schema.greaterThanOrEqualTo(1)),
  namespace: Namespace,
  title: Text(3, 120),
  whenToUse: Text(20, 8000),
  whenNotToUse: Text(10, 600),
  inputSchema: Schema.Unknown,
  /** Output contracts are not declared yet; every tool returns the AgentToolResult envelope. */
  outputSchema: Schema.NullOr(Schema.Unknown),
  sideEffect: SideEffect,
  permission: Schema.Struct({ role: Schema.Literal("member", "operator"), requiresApproval: Schema.Boolean }),
  idempotency: Schema.Literal("safe_read", "request_key"),
  costClass: Schema.Literal("free", "metered"),
  latencyClass: Schema.Literal("fast", "slow"),
  tenantScope: Schema.Literal("business", "public"),
  evidenceProduced: Schema.Array(Schema.Literal("observation", "proposal", "draft", "note", "receipt", "none")),
  /** Declared only inside a workflow's own turn. */
  workflowOnly: Schema.Boolean,
  /** Routing cases that name this capability. A capability without any is disabled by default. */
  evalCases: Schema.Array(RoutingCase),
})
export type CapabilityManifest = typeof CapabilityManifest.Type

export const isEnabled = (m: CapabilityManifest) => m.evalCases.length > 0
