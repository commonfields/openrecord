import { Config, Effect, Schema } from "effect"
import { RecordSurfaceConfig } from "@openrecord/config"
import { ACQ_INTENT_GROUPS, ACQ_MAX_ATTEMPTS_PER_CHECK, AcquisitionRepository, AgentProposalRepository, BusinessRepository, sealDraft } from "@openrecord/db"
import { AgentInvalidInput, AgentNotInScope, type AgentToolResult } from "./agent-tools.js"
const Samples = Schema.Int.pipe(Schema.between(1, 5))
// Competitors are suggestions for the operator to confirm when they freeze the set; they never become part of a set on their own.
const Competitor = Schema.Struct({ name: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(120)), website: Schema.optional(Schema.String.pipe(Schema.maxLength(300))) })
const QuestionInput = Schema.Struct({ category: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(200)), competitors: Schema.optional(Schema.Array(Competitor).pipe(Schema.maxItems(10))), questions: Schema.Array(Schema.Struct({ group: Schema.Literal(...ACQ_INTENT_GROUPS), prompt: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(500)) })).pipe(Schema.minItems(1), Schema.maxItems(60)), samples: Samples })
const MeasurementInput = Schema.Struct({ setId: Schema.UUID, samples: Samples })
export const acquisitionProposalDeclarations = [
  { name: "propose_question_set", description: "Save buyer-question and measurement-plan text for human review. Propose 10 to 15 questions spread across the intent groups, phrased the way a real buyer asks an AI assistant (with the place for a local business), never naming this brand. Call read_competitors first and include its competitors, so the measurement shows who AI assistants recommend instead. Never freezes a set or infers client authorization. Operator must choose the authorization basis in AI Discovery.",
    parametersJsonSchema: { type: "object", properties: { category: { type: "string", maxLength: 200 }, competitors: { type: "array", maxItems: 10, description: "Up to ten competitors to measure against, from read_competitors; the operator confirms them when freezing the set.", items: { type: "object", properties: { name: { type: "string", maxLength: 120 }, website: { type: "string", maxLength: 300 } }, required: ["name"], additionalProperties: false } }, questions: { type: "array", minItems: 1, maxItems: 60, items: { type: "object", properties: { group: { type: "string", enum: ACQ_INTENT_GROUPS }, prompt: { type: "string", maxLength: 500 } }, required: ["group", "prompt"], additionalProperties: false } }, samples: { type: "integer", minimum: 1, maximum: 5 } }, required: ["category", "questions", "samples"], additionalProperties: false } },
  { name: "propose_acquisition_measurement", description: "Save an exact frozen question-set, configured provider/model, samples and maximum-call/cost plan. Never starts calls; the operator must approve the stated cost in the UI. Unknown cost blocks approval.",
    parametersJsonSchema: { type: "object", properties: { setId: { type: "string", format: "uuid" }, samples: { type: "integer", minimum: 1, maximum: 5 } }, required: ["setId", "samples"], additionalProperties: false } },
]
export const dispatchAcquisitionProposal = (accountId: string, userId: string, businessId: string, name: string, raw: unknown) => Effect.gen(function*() {
  if (!(yield* (yield* BusinessRepository).getScoped(accountId, businessId))) return yield* Effect.fail(new AgentNotInScope())
  const snapshot = yield* (yield* AcquisitionRepository).snapshot(businessId)
  if (!snapshot) return yield* Effect.fail(new AgentNotInScope())
  const surface = yield* RecordSurfaceConfig
  const rate = yield* Config.number("AGENT_MEASUREMENT_MAX_USD_PER_ATTEMPT").pipe(Config.withDefault(-1))
  const generatedAt = new Date().toISOString()
  yield* Effect.logInfo("agent acquisition proposal invoked").pipe(Effect.annotateLogs({ account_id: accountId, business_id: businessId, tool: name, invoked_at: generatedAt }))
  const parsed = yield* Effect.gen(function*() {
    if (name === "propose_question_set") {
      const input = yield* Schema.decodeUnknown(QuestionInput, { onExcessProperty: "error" })(raw)
      return { kind: "questions" as const, input }
    }
    const input = yield* Schema.decodeUnknown(MeasurementInput, { onExcessProperty: "error" })(raw)
    return { kind: "measurement" as const, input }
  }).pipe(Effect.mapError(() => new AgentInvalidInput({ tool: name })))
  const set = parsed.kind === "measurement" ? snapshot.sets.find(s => s.id === parsed.input.setId) : null
  if (parsed.kind === "measurement" && !set) return yield* Effect.fail(new AgentNotInScope())
  const questions = parsed.kind === "questions" ? parsed.input.questions : set!.questions
  const calls = questions.length * parsed.input.samples * ACQ_MAX_ATTEMPTS_PER_CHECK
  const cost = surface.provider === "mock" ? 0 : Number.isFinite(rate) && rate > 0 && rate <= 1000 ? Math.ceil(calls * rate * 100) / 100 : null
  const plan = { setId: set?.id ?? null, provider: surface.provider, requestedModel: surface.provider === "mock" ? null : surface.model,
    questions: questions.length, samples: parsed.input.samples, maxProviderCalls: calls, estimatedMaxCostUsd: cost,
    costBasis: surface.provider === "mock" ? "SYNTHETIC_FIXTURE_NO_PROVIDER_CHARGE" : "OPERATOR_CONFIGURED_UPPER_BOUND_INCLUDING_GROUNDING_AND_RETRIES",
    missingRequirements: [...(set ? [] : ["HUMAN_AUTHORIZATION_BASIS_AND_QUESTION_SET_FREEZE"]), ...(cost === null ? ["MEASUREMENT_COST_UPPER_BOUND"] : [])] }
  const text = [`${parsed.kind === "questions" ? "Proposed buyer questions" : "Proposed acquisition measurement"} for ${snapshot.profile.name}`,
    ...questions.map((q, i) => `${i + 1}. [${q.group.toLowerCase().replaceAll("_", " ")}] ${q.prompt}`),
    ...(parsed.kind === "questions" && parsed.input.competitors?.length ? [`Competitors to measure against: ${parsed.input.competitors.map(c => c.website ? `${c.name} (${c.website})` : c.name).join(", ")}.`] : []),
    `Measurement provider: ${plan.provider}. Requested model: ${plan.requestedModel ?? "synthetic fixture"}. Proposed samples per question: ${plan.samples}.`,
    `Maximum provider call count: ${calls}, including up to ${ACQ_MAX_ATTEMPTS_PER_CHECK} attempts per sample. Estimated maximum cost: ${cost === null ? "unavailable; approval blocked" : `USD ${cost.toFixed(2)}`}.`,
    `Cost basis: ${cost === null ? "Not configured" : plan.costBasis === "SYNTHETIC_FIXTURE_NO_PROVIDER_CHARGE" ? "Synthetic fixture only" : "Deployment-configured upper bound per attempt, including grounding and retries; not a current provider quote"}.`,
    ...(parsed.kind === "questions" ? ["Accepting this text does not freeze questions or grant business authorization. The operator selects the authorization basis and freezes the reviewed set in AI Discovery."] : ["Only explicit operator approval of this exact frozen set and cost budget queues measurements. No human judgment or publication is approved."]),
    `Missing requirements: ${plan.missingRequirements.map(r => r === "MEASUREMENT_COST_UPPER_BOUND" ? "a configured measurement cost bound" : "operator-selected authorization basis and frozen question set").join(", ") || "None"}.`].join("\n\n")
  const kind = parsed.kind === "questions" ? "PROPOSE_QUESTION_SET" as const : "REQUEST_ACQUISITION_BATCH" as const
  const payload = sealDraft({ kind, businessId, generatedAt, text, references: [{ kind: "acquisition", id: businessId, text: "Review frozen questions in AI Discovery" }],
    evidence: { ...plan, setDigest: set?.specDigest ?? null, category: parsed.kind === "questions" ? parsed.input.category : set!.category, questions,
      ...(parsed.kind === "questions" && parsed.input.competitors?.length ? { competitors: parsed.input.competitors } : {}) }, measurementPlan: plan })
  const proposal = yield* (yield* AgentProposalRepository).propose({ accountId, businessId, kind, questionId: null, message: parsed.kind === "questions" ? "Review buyer-question text. Acceptance does not freeze questions or assert authorization." : "Review the exact acquisition measurement and maximum cost before approval.", payload, proposer: "assistant-v1", proposedByUserId: userId })
  return { summary: "Acquisition proposal saved; no calls started", citations: payload.references,
    data: { proposalId: proposal.id, kind, status: proposal.status, plan: proposal.payload?.measurementPlan, executed: false } } satisfies AgentToolResult
})
