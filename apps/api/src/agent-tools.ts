import { GROWTH_AGENT_TOOLS } from "./agent-growth-tools.js"
import { ACQUISITION_AGENT_TOOLS } from "./agent-acquisition-tools.js"
import { REFERRAL_AGENT_TOOLS } from "./agent-referral-tools.js"
import { SEARCH_AGENT_TOOLS } from "./agent-search-tools.js"
import { WEB_AGENT_TOOLS } from "./agent-web-tools.js"
import { ADS_AGENT_TOOLS } from "./agent-ads-tools.js"
import { RESULTS_AGENT_TOOLS } from "./agent-results-tools.js"
import { OBJECTIVE_AGENT_TOOLS } from "./objectives.js"
import { PERFORMANCE_AGENT_TOOLS } from "./agent-performance-tools.js"
import { INVESTIGATION_READ_TOOLS } from "./agent-investigation-tools.js"
// Agent tool harness V1: first-class, schema-declared, tenant-scoped,
// read-only tools for operator assistance.
//
// Adopted from orchestrator-style harnesses: a tool registry with declared
// input schemas, validated dispatch (unknown tools and excess properties
// fail before any repository runs), and a per-invocation audit log.
// Deliberately not adopted: autonomous writes, worker delegation, model
// fallback/substitution, or cross-model consensus. There are no write tools:
// anything that would write is returned by the assistant as a plan with a UI
// deep link the human clicks, and service access never counts as human review.
//
// Tenancy: every tool checks the business against the session account first;
// unknown and foreign ids both read as "not in scope" without leaking which.
// Untrusted content: answer/source/fact text is operator-owned data. It is
// returned verbatim as cited data and never interpreted as instructions.
import { Data, Effect, JSONSchema, Schema } from "effect"
import { SqlClient } from "@effect/sql"
import {
  GrowthRepository,
  AcquisitionRepository,
  AgentProposalRepository,
  BusinessRepository,
  DiscoveryScopeRepository,
  FactRepository,
  operatorView,
  ProductReadRepository,
  QuestionRepository,
  RecordRepository,
  SetupRepository,
} from "@openrecord/db"
import type { AgentCitation } from "./agent.js"
import { citationEvidenceForObservation, issueStateOf, loadIssueDetail, loadRepresentations } from "./reads.js"
import { loadDiscoveryScopes } from "./discovery-reads.js"

export class AgentUnknownTool extends Data.TaggedError("AgentUnknownTool")<{ readonly tool: string }> {}
export class AgentInvalidInput extends Data.TaggedError("AgentInvalidInput")<{ readonly tool: string }> {}
export { AgentNotInScope } from "./agent-tool-errors.js"
import { AgentNotInScope } from "./agent-tool-errors.js"
export class AgentToolFailed extends Data.TaggedError("AgentToolFailed")<{ readonly tool: string }> {}
/** Opaque tool failure: repository/decoder detail never escapes the harness,
 * mirroring the API rule that errors expose no database failure details. */

const Limit = Schema.optional(
  Schema.Int.pipe(Schema.greaterThanOrEqualTo(1), Schema.lessThanOrEqualTo(20)),
)
const limitOf = (input: { readonly limit?: number | undefined }, fallback = 5): number => input.limit ?? fallback

export interface AgentToolResult {
  readonly summary: string
  readonly citations: ReadonlyArray<AgentCitation>
  readonly data: unknown
  /** Session tools only: approvals a helper saved, and the tasks it reports on. */
  readonly decisions?: ReadonlyArray<import("./agent-registry.js").DecisionRef> | undefined
  readonly tasks?: ReadonlyArray<import("./agent-registry.js").TaskRef> | undefined
}

/** Every service any tool may need. The registry is closed: adding a tool
 * that needs a new service extends this union, which the compiler checks
 * at every call site. */
export type AgentToolDeps =
  | GrowthRepository
  | AcquisitionRepository
  | AgentProposalRepository
  | BusinessRepository
  | DiscoveryScopeRepository
  | FactRepository
  | ProductReadRepository
  | QuestionRepository
  | RecordRepository
  | SetupRepository
  | SqlClient.SqlClient

export interface AgentToolDef {
  readonly name: string
  readonly description: string
  /** Raw decode; runAgentTool maps any failure to AgentInvalidInput. */
  readonly parameters: unknown
  readonly decode: (input: unknown) => Effect.Effect<unknown, unknown, never>
  readonly run: (
    accountId: string,
    businessId: string,
    // Decoded through `decode`; repositories resolve from the handler layer.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    input: any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ) => Effect.Effect<AgentToolResult, any, AgentToolDeps>
}

const scoped = (accountId: string, businessId: string) =>
  Effect.gen(function*() {
    const biz = yield* BusinessRepository
    if (!(yield* biz.getScoped(accountId, businessId))) return yield* Effect.fail(new AgentNotInScope())
  })

const inputContract = <A, I>(schema: Schema.Schema<A, I>) => ({
  parameters: JSONSchema.make(schema),
  decode: (input: unknown) => Schema.decodeUnknown(schema, { onExcessProperty: "error" })(input),
})

const readBusinessTruth: AgentToolDef = {
  name: "read_business_truth",
  description: "Read the business's approved facts (authoritative truth). Read-only.",
  ...inputContract(Schema.Struct({ limit: Limit })),
  run: (accountId, businessId, input: { readonly limit?: number | undefined }) =>
    Effect.gen(function*() {
      yield* scoped(accountId, businessId)
      const facts = yield* FactRepository
      const rows = (yield* facts.listByBusiness(businessId)) as ReadonlyArray<{
        id: string
        predicate: string
        valueText: string
        status: string
        version: number
      }>
      const active = rows.filter((f) => f.status === "ACTIVE")
      const top = active.slice(0, limitOf(input))
      return {
        summary: `${active.length} approved facts read`,
        citations: top.map((f) => ({ kind: "fact", id: f.id, text: `${f.predicate}: ${f.valueText}` })),
        data: {
          totalActive: active.length,
          facts: top.map((f) => ({ id: f.id, predicate: f.predicate, valueText: f.valueText, version: f.version })),
        },
      } satisfies AgentToolResult
    }),
}

const discoverBuyerQuestions: AgentToolDef = {
  name: "discover_buyer_questions",
  description: "List the buyer questions tracked for the business. Read-only.",
  ...inputContract(Schema.Struct({ limit: Limit })),
  run: (accountId, businessId, input: { readonly limit?: number | undefined }) =>
    Effect.gen(function*() {
      yield* scoped(accountId, businessId)
      const questions = yield* QuestionRepository
      const rows = (yield* questions.listByBusiness(businessId)) as ReadonlyArray<{
        id: string
        prompt: string
        label: string | null
      }>
      const top = rows.slice(0, limitOf(input))
      return {
        summary: `${rows.length} buyer questions read`,
        citations: top.map((q) => ({ kind: "question", id: q.id, text: q.prompt })),
        data: { total: rows.length, questions: top.map((q) => ({ id: q.id, prompt: q.prompt, label: q.label })) },
      } satisfies AgentToolResult
    }),
}

const readOpenIssues: AgentToolDef = {
  name: "read_open_issues",
  description: "Read unresolved issues (claims disagreeing with approved truth). Read-only.",
  ...inputContract(Schema.Struct({ limit: Limit })),
  run: (accountId, businessId, input: { readonly limit?: number | undefined }) =>
    Effect.gen(function*() {
      yield* scoped(accountId, businessId)
      const reads = yield* ProductReadRepository
      const rows = yield* reads.issueList(businessId)
      const open = rows
        .map((r) => ({ row: r, state: issueStateOf((r["verdict"] as string | null) ?? null) }))
        .filter((i) => i.state !== "RESOLVED")
      const top = open.slice(0, limitOf(input))
      return {
        summary: `${open.length} open issues read`,
        citations: top.flatMap(({ row }) => {
          const claimId = String(row["claim_id"] ?? row["id"] ?? "")
          const claimText = String(row["claim_text"] ?? "")
          return claimId ? [{ kind: "issue", id: claimId, text: claimText.slice(0, 140) }] : []
        }),
        data: {
          totalOpen: open.length,
          issues: top.map(({ row, state }) => ({
            claim_id: String(row["claim_id"] ?? row["id"] ?? ""),
            claim_text: String(row["claim_text"] ?? ""),
            state,
            observation_id: String(row["observation_id"] ?? ""),
          })),
        },
      } satisfies AgentToolResult
    }),
}

const readRepresentations: AgentToolDef = {
  name: "read_representations",
  description: "Read tracked owned-source representations and their sync findings. Read-only.",
  ...inputContract(Schema.Struct({ limit: Limit })),
  run: (accountId, businessId, input: { readonly limit?: number | undefined }) =>
    Effect.gen(function*() {
      const representations = (yield* loadRepresentations(accountId, businessId)) ?? []
      if (representations.length === 0) {
        // loadRepresentations returns null for out-of-scope businesses; an
        // empty list is also a valid answer, so confirm scope explicitly.
        yield* scoped(accountId, businessId)
      }
      const drift = representations.filter((r) => r.finding.state === "DRIFT").length
      const unknown = representations.filter((r) => r.finding.state === "UNKNOWN").length
      const top = representations.slice(0, limitOf(input))
      return {
        summary: `${representations.length} tracked representations read`,
        citations: top.map((r) => ({
          kind: "representation",
          id: r.binding_id,
          text: `${r.fact.predicate} ${r.finding.state}`,
        })),
        data: {
          total: representations.length,
          drift,
          unknown,
          representations: top.map((r) => ({
            binding_id: r.binding_id,
            predicate: r.fact.predicate,
            state: r.finding.state,
            control: r.source.control,
            url: r.source.url,
          })),
        },
      } satisfies AgentToolResult
    }),
}

const readDiscoveryScopes: AgentToolDef = {
  name: "read_discovery_scopes",
  description: "List owned-site discovery scopes. Read-only; starting a run needs a human click.",
  ...inputContract(Schema.Struct({ limit: Limit })),
  run: (accountId, businessId, input: { readonly limit?: number | undefined }) =>
    Effect.gen(function*() {
      const scopes = ((yield* loadDiscoveryScopes(accountId, businessId)) ?? []) as ReadonlyArray<{
        id: string
        rootUrl: string
      }>
      if (scopes.length === 0) yield* scoped(accountId, businessId)
      const top = scopes.slice(0, limitOf(input))
      return {
        summary: `${scopes.length} discovery scopes read`,
        citations: top.map((s) => ({ kind: "discovery_scope", id: s.id, text: s.rootUrl })),
        data: { total: scopes.length, scopes: top.map((s) => ({ id: s.id, rootUrl: s.rootUrl })) },
      } satisfies AgentToolResult
    }),
}

const readObservation: AgentToolDef = {
  name: "read_observation",
  description: "Fetch one collected AI answer with its citations. Read-only; raw provider payloads are excluded.",
  ...inputContract(Schema.Struct({ observationId: Schema.UUID })),
  run: (accountId, businessId, input: { readonly observationId: string }) =>
    Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const rows = (yield* sql.unsafe(
        `SELECT o.id, o.provider, o.requested_model, o.observed_model, o.collected_at, o.answer_text, o.retrieval_mode, o.synthetic
         FROM observations o JOIN businesses b ON b.id = o.business_id
         WHERE o.id = $1 AND o.business_id = $2 AND b.account_id = $3`,
        [input.observationId, businessId, accountId],
      )) as Array<Record<string, unknown>>
      const row = rows[0]
      if (!row) return yield* Effect.fail(new AgentNotInScope())
      const citations = (yield* citationEvidenceForObservation(accountId, businessId, String(row["id"]))) ?? []
      return {
        summary: `observation read with ${citations.length} citations`,
        citations: [{ kind: "observation", id: String(row["id"]), text: String(row["answer_text"] ?? "").slice(0, 140) }],
        data: {
          observation: {
            id: String(row["id"]),
            provider: String(row["provider"] ?? ""),
            requested_model: (row["requested_model"] as string | null) ?? null,
            observed_model: (row["observed_model"] as string | null) ?? null,
            collected_at: String(row["collected_at"] ?? ""),
            answer_text: String(row["answer_text"] ?? ""),
            retrieval_mode: String(row["retrieval_mode"] ?? ""),
            synthetic: Boolean(row["synthetic"]),
          },
          citations,
        },
      } satisfies AgentToolResult
    }),
}

const readIssue: AgentToolDef = {
  name: "read_issue",
  description: "Read one issue with its verdict, linked facts, and citation evidence. Private review notes are excluded. Read-only.",
  ...inputContract(Schema.Struct({ claimId: Schema.UUID })),
  run: (accountId, businessId, input: { readonly claimId: string }) =>
    Effect.gen(function*() {
      const detail = yield* loadIssueDetail(accountId, businessId, input.claimId)
      if (!detail) return yield* Effect.fail(new AgentNotInScope())
      const claimId = String((detail as Record<string, unknown>)["claim_id"] ?? "")
      const claimText = String((detail as Record<string, unknown>)["claim_text"] ?? "")
      return {
        summary: `issue read with ${(detail.citation_evidence ?? []).length} citation evidence rows`,
        citations: claimId ? [{ kind: "issue", id: claimId, text: claimText.slice(0, 140) }] : [],
        data: {
          claim_id: claimId,
          claim_text: claimText,
          state: detail.state,
          verdict: (detail as Record<string, unknown>)["verdict"] ?? null,
          observation_id: String((detail as Record<string, unknown>)["observation_id"] ?? ""),
          answer_text: String((detail as Record<string, unknown>)["answer_text"] ?? ""),
          provider: (detail as Record<string, unknown>)["provider"] ?? null,
          observed_model: (detail as Record<string, unknown>)["observed_model"] ?? null,
          question_prompt: (detail as Record<string, unknown>)["question_prompt"] ?? null,
          facts: (detail as Record<string, unknown>)["facts"] ?? [],
          citation_evidence: detail.citation_evidence ?? [],
        },
      } satisfies AgentToolResult
    }),
}

const readRecordOutcomes: AgentToolDef = {
  name: "read_record_outcomes",
  description: "Read client record findings, approved facts, recent samples with human judgments, and deterministic before/after comparisons. Use for client problems and evidence. Review and action notes stay private. Read-only.",
  ...inputContract(Schema.Struct({})),
  run: (accountId, businessId) =>
    Effect.gen(function*() {
      yield* scoped(accountId, businessId)
      const records = yield* RecordRepository
      const snapshot = yield* records.snapshot(businessId)
      if (snapshot === null) {
        return { summary: "no client record for this business", citations: [], data: { hasRecord: false } } satisfies AgentToolResult
      }
      const view = operatorView(snapshot)
      return {
        summary: `${view.slots.length} record slots read`,
        citations: [{ kind: "record", id: businessId, text: "Client record evidence" }],
        data: {
          hasRecord: true,
          disclosure: view.disclosure,
          actions: snapshot.actions.slice(-5).map(a => ({ id: a.id, type: a.type, slot: a.slot, links: a.links, performedAt: a.performedAt })),
          recentRuns: view.runs.slice(-3).map(r => ({ id: r.id, kind: r.kind, status: r.status, createdAt: r.createdAt,
            attempted: r.checks.length, successful: r.checks.filter(c => c.observation !== null && c.status === "SUCCEEDED").length,
            reviewed: r.checks.filter(c => c.judgment !== null).length,
            samples: r.checks.slice(0, 15).map(c => ({ questionId: c.questionId, sample: c.sample, status: c.status,
              observation: c.observation === null ? null : { id: c.observation.id, provider: c.observation.provider,
                requestedModel: c.observation.requestedModel, observedModel: c.observation.observedModel,
                collectedAt: c.observation.collectedAt, answerText: c.observation.answerText.slice(0, 1200), answerTruncated: c.observation.answerText.length > 1200,
                synthetic: c.observation.synthetic, retrievalMode: c.observation.retrievalMode, rawDigest: c.observation.rawDigest },
              judgment: c.judgment === null ? null : { id: c.judgment.id, decision: c.judgment.decision, reviewedAt: c.judgment.reviewedAt },
            })),
          })),
          slots: view.slots.map((s) => ({
            slot: s.slot,
            fact: { id: s.item.fact.id, predicate: s.item.fact.predicate, valueText: s.item.fact.valueText, version: s.item.fact.version, approved: s.item.approval !== null },
            question: s.item.question, sourceUrl: s.item.sourceUrl, finding: s.finding,
            comparison:
              s.comparison === null
                ? null
                : s.comparison.state === "DERIVED"
                  ? { state: "DERIVED", outcome: s.comparison.outcome, reason: s.comparison.reason, text: s.comparison.text }
                  : { state: s.comparison.state },
          })),
        },
      } satisfies AgentToolResult
    }),
}

const KIND_LABEL: Readonly<Record<string, string>> = { REQUEST_CHECK: "AI answer check request", DRAFT_SOURCE_ACTION: "Source fix draft",
  PREPARE_CLIENT_REPORT: "Client report draft", PROPOSE_QUESTION_SET: "Buyer question set", REQUEST_ACQUISITION_BATCH: "AI recommendation measurement" }
const ReadProposalsInput = Schema.Struct({
  status: Schema.optional(Schema.Literal("PROPOSED", "APPROVED", "EXECUTED", "REJECTED")),
  proposalId: Schema.optional(Schema.UUID),
  limit: Schema.optional(Schema.Int.pipe(Schema.between(1, 10))),
})

const readProposals: AgentToolDef = {
  name: "read_proposals",
  description: "Read the drafts and requests saved for this business and their decisions: source fix drafts, client reports, buyer question sets, AI answer check requests and measurements, with each draft's full text. Use it to review, compare or build on earlier work, or when asked to check a draft. Filter by status (PROPOSED waits for a decision) or give one proposalId. Read-only.",
  ...inputContract(ReadProposalsInput),
  run: (accountId, businessId, input) =>
    Effect.gen(function*() {
      yield* scoped(accountId, businessId)
      const all = yield* (yield* AgentProposalRepository).listByBusiness(accountId, businessId, input.proposalId ? null : input.status ?? null)
      const picked = input.proposalId ? all.filter(p => p.id === input.proposalId) : all.slice(0, input.limit ?? 5)
      if (input.proposalId && !picked.length) return yield* Effect.fail(new AgentNotInScope())
      const one = picked.length === 1
      return {
        summary: `${picked.length} saved proposal${picked.length === 1 ? "" : "s"} read${input.status ? ` (${input.status.toLowerCase()})` : ""}`,
        citations: picked.map(p => ({ kind: "proposal", id: p.id, text: KIND_LABEL[p.kind] ?? p.kind })),
        data: {
          total: all.length,
          proposals: picked.map(p => ({ id: p.id, kind: KIND_LABEL[p.kind] ?? p.kind, status: p.status, createdAt: p.createdAt, decidedAt: p.decidedAt, proposer: p.proposer, message: p.message,
            ...(p.payload ? { draft: one ? p.payload.text.slice(0, 12000) : p.payload.text.slice(0, 3000), draftTruncated: p.payload.text.length > (one ? 12000 : 3000),
              references: p.payload.references.length, generatedAt: p.payload.generatedAt, ...(p.payload.measurementPlan ? { measurementPlan: p.payload.measurementPlan } : {}) } : {}) })),
        },
      } satisfies AgentToolResult
    }),
}

/** The complete read-only toolset. Adding a write tool requires a
 * proposal/approval boundary review and an update to agent-tools.test.ts,
 * which asserts this exact list. */
export const AGENT_TOOLS: ReadonlyArray<AgentToolDef> = [
  ...GROWTH_AGENT_TOOLS,
  ...ACQUISITION_AGENT_TOOLS,
  ...REFERRAL_AGENT_TOOLS,
  ...SEARCH_AGENT_TOOLS,
  ...WEB_AGENT_TOOLS,
  ...ADS_AGENT_TOOLS,
  ...RESULTS_AGENT_TOOLS,
  ...OBJECTIVE_AGENT_TOOLS,
  ...PERFORMANCE_AGENT_TOOLS,
  ...INVESTIGATION_READ_TOOLS,
  readBusinessTruth,
  discoverBuyerQuestions,
  readOpenIssues,
  readRepresentations,
  readDiscoveryScopes,
  readObservation,
  readIssue,
  readRecordOutcomes,
  readProposals,
]

/** Look up a tool by name without running anything. Fails before any
 * repository or decoder runs. */
export const findAgentTool = (tool: string) =>
  Effect.gen(function*() {
    const def = AGENT_TOOLS.find((t) => t.name === tool)
    if (!def) return yield* Effect.fail(new AgentUnknownTool({ tool }))
    return def
  })

/** Decode raw input against the tool's schema. Excess properties fail. */
export const decodeAgentInput = (def: AgentToolDef, input: unknown) =>
  def.decode(input).pipe(Effect.mapError(() => new AgentInvalidInput({ tool: def.name })))

export const runAgentTool = (accountId: string, businessId: string, tool: string, input: unknown) =>
  Effect.gen(function*() {
    const def = yield* findAgentTool(tool)
    const decoded = yield* decodeAgentInput(def, input)
    yield* Effect.logInfo("agent tool invoked").pipe(Effect.annotateLogs({ tool, account_id: accountId, business_id: businessId, invoked_at: new Date().toISOString() }))
    return yield* def.run(accountId, businessId, decoded).pipe(
      Effect.mapError((e) => (e instanceof AgentNotInScope ? e : new AgentToolFailed({ tool }))),
    )
  })
