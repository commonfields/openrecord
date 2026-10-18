// read_ai_referral_evidence: the Agency Operator's scoped view of validated
// GA4 referral exports. Scope is verified before any read; the snapshot and
// all numbers come from the acquisition-owned repository and read model via
// the pure agentReferralRead contract. No raw CSV, no row-level data, no
// visitor identifiers and no synthetic imports reach the conversation model.
import { Effect, JSONSchema, Schema } from "effect"
import { AcquisitionRepository, BusinessRepository, REFERRAL_DATA_UNAVAILABLE, agentReferralRead } from "@openrecord/db"
import { AgentNotInScope } from "./agent-tool-errors.js"
import type { AgentToolDef, AgentToolResult } from "./agent-tools.js"

const Input = Schema.Struct({ importId: Schema.optional(Schema.UUID), beforeImportId: Schema.optional(Schema.UUID) })

export const readAgentReferralEvidence = (accountId: string, businessId: string, input: typeof Input.Type) => Effect.gen(function*() {
  if (!(yield* (yield* BusinessRepository).getScoped(accountId, businessId))) return yield* Effect.fail(new AgentNotInScope())
  const snapshot = yield* (yield* AcquisitionRepository).snapshot(businessId)
  const data = agentReferralRead(snapshot, input)
  if (data === "NOT_FOUND") return yield* Effect.fail(new AgentNotInScope())
  if (data.state === REFERRAL_DATA_UNAVAILABLE) {
    return { summary: "Referral data unavailable: no validated real GA4 export", citations: [], data } satisfies AgentToolResult
  }
  const e = data.evidence
  return {
    summary: `GA4 export ${e.period.start} to ${e.period.end}: ${e.sessions.aiAttributed} AI-attributed sessions; ${e.configuredConversions.event === null ? "conversions not configured" : `configured event ${e.configuredConversions.event}`}`,
    citations: [e, ...(data.comparison ? [data.comparison.before] : [])].map(i => ({ kind: "referral_import", id: i.importId, text: `GA4 export ${i.period.start} to ${i.period.end}` })),
    data,
  } satisfies AgentToolResult
})

export const REFERRAL_AGENT_TOOLS: ReadonlyArray<AgentToolDef> = [{
  name: "read_ai_referral_evidence",
  description: "Read validated, non-synthetic operator GA4 referral exports: AI-attributed website sessions by assistant (ChatGPT, Claude, Gemini, ...), the configured conversion event and signups, with property, period, time zone, attribution basis and import digest. Defaults to the latest export; pass importId and beforeImportId (from the returned imports list) for a descriptive period comparison. REFERRAL_DATA_UNAVAILABLE and SIGNUPS_NOT_MEASURED mean unknown, never zero. Referral sessions are not measured AI recommendations; never infer causality. Read-only.",
  parameters: JSONSchema.make(Input),
  decode: raw => Schema.decodeUnknown(Input, { onExcessProperty: "error" })(raw),
  run: readAgentReferralEvidence,
}]
