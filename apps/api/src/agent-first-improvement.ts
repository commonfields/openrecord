import { createHash } from "node:crypto"
import { SqlClient } from "@effect/sql"
import { Effect, JSONSchema, Schema } from "effect"
import { BusinessRepository, FactRepository, GrowthRefused, GrowthRepository, SetupRepository } from "@openrecord/db"
import type { GrowthEvidenceInput, GrowthOpportunityFields } from "@openrecord/contracts"
import { AgentNotInScope } from "./agent-tool-errors.js"
import { SKILLS } from "./agent-skills.js"
import type { AgentToolResult } from "./agent-tools.js"
import { diagnoseMarketing, type ContradictedAnswer, type DiagnosisInput, type ProblemCandidate } from "./marketing-diagnosis.js"
import { WEBSITE_RULES } from "./setup-plan.js"

// Tools of the first-improvement workflow. One read (diagnosis) and one
// propose-only write: a PROPOSED growth opportunity for human review. Neither
// fetches the network, approves, publishes or executes. Business refusals are
// returned as structured results with a recovery instruction; scope failures
// stay opaque.

/** Who produced the turn, recorded on the proposal. Never a credential. */
export interface AgentOrigin { readonly provider: string; readonly model: string }

const DiagnoseInput = Schema.Struct({})
const ProposeInput = Schema.Struct({
  candidateKey: Schema.String.pipe(Schema.pattern(/^(homepage\.[a-z-]+|answer\.contradicted:[0-9a-f-]{36})$/)),
  proposedChange: Schema.String.pipe(Schema.minLength(20), Schema.maxLength(2000), Schema.filter(s => s.trim().length >= 20)),
})

export const firstImprovementDeclarations = [
  { name: "diagnose_marketing_problems",
    description: "Diagnose the selected business from recorded evidence only: confirmed brief, growth goal, approved facts, OpenRecord's stored homepage read and human-reviewed AI answers. Returns ranked candidate problems with evidence references, the selected problem, gaps, conflicts and specialist guidance. Read-only; no network access.",
    parametersJsonSchema: JSONSchema.make(DiagnoseInput) },
  { name: "propose_first_improvement",
    description: "Save the improvement for the diagnosed candidate as a PROPOSED opportunity for human review. The server supplies the problem, target page, evidence and uncertainty; you supply only the concrete change. Repeating returns the same proposal. Cannot approve, publish, execute or measure anything.",
    parametersJsonSchema: JSONSchema.make(ProposeInput) },
]

const OPEN = new Set(["DISCOVERED", "PROPOSED", "APPROVED"])

const load = (accountId: string, businessId: string) => Effect.gen(function*() {
  const business = yield* (yield* BusinessRepository).getScoped(accountId, businessId)
  if (!business) return yield* Effect.fail(new AgentNotInScope())
  const setup = yield* (yield* SetupRepository).get(accountId, businessId)
  const growth = yield* GrowthRepository
  // Businesses created before growth profiles exist read as "no goal", not as a failure.
  const missing = <A>(fallback: A) => Effect.catchIf((e: unknown) => e instanceof GrowthRefused && e.reason === "GrowthNotFound", () => Effect.succeed(fallback))
  const profile = yield* growth.profile(accountId, businessId).pipe(missing(null))
  const facts = (yield* (yield* FactRepository).listByBusiness(businessId)).filter(f => f.status === "ACTIVE")
  const sql = yield* SqlClient.SqlClient
  // Current (non-superseded) human judgments on real, non-synthetic answers only.
  const current = `JOIN human_judgments j ON j.claim_id = c.id AND NOT EXISTS (SELECT 1 FROM human_judgments child WHERE child.supersedes_id = j.id)`
  const contradicted = (yield* sql.unsafe(
    `SELECT c.id AS claim_id, c.text AS claim_text, o.id AS observation_id, j.id AS judgment_id, o.provider, o.collected_at, q.prompt
     FROM candidate_claims c JOIN observations o ON o.id = c.observation_id JOIN businesses b ON b.id = o.business_id ${current}
     LEFT JOIN check_runs cr ON cr.id = o.check_run_id LEFT JOIN buyer_questions q ON q.id = cr.question_id
     WHERE o.business_id = $1 AND b.account_id = $2 AND j.verdict = 'CONTRADICTED' AND NOT o.synthetic
     ORDER BY o.collected_at DESC, c.id LIMIT 3`, [businessId, accountId])) as ReadonlyArray<Record<string, unknown>>
  const unreviewed = (yield* sql.unsafe(
    `SELECT count(*) AS n FROM candidate_claims c JOIN observations o ON o.id = c.observation_id JOIN businesses b ON b.id = o.business_id
     WHERE o.business_id = $1 AND b.account_id = $2 AND NOT o.synthetic AND NOT EXISTS (SELECT 1 FROM human_judgments j WHERE j.claim_id = c.id)`,
    [businessId, accountId])) as ReadonlyArray<Record<string, unknown>>
  const opportunities = yield* growth.list(accountId, businessId, 20).pipe(missing([]))
  const input: DiagnosisInput = {
    businessName: setup?.brief?.businessName ?? business.name,
    website: !setup ? { state: "NOT_STARTED" }
      : setup.discoveryStatus === "DONE" && setup.discovery ? { state: "READ", url: setup.websiteUrl, signals: setup.discovery }
        : setup.discoveryStatus === "FAILED" ? { state: "FAILED", url: setup.websiteUrl, failure: setup.discoveryFailure ?? "UNKNOWN" }
          : { state: "PENDING", url: setup.websiteUrl },
    brief: setup?.brief ?? null,
    goalStatement: profile?.primaryGoal.statement ?? null,
    facts: facts.map(f => ({ id: f.id, predicate: f.predicate, valueText: f.valueText })),
    contradictedAnswers: contradicted.map((r): ContradictedAnswer => ({ claimId: String(r["claim_id"]), claimText: String(r["claim_text"]),
      observationId: String(r["observation_id"]), judgmentId: String(r["judgment_id"]), provider: String(r["provider"]),
      collectedAt: new Date(r["collected_at"] as string).toISOString(), questionPrompt: (r["prompt"] as string | null) ?? null })),
    unreviewedClaims: Number(unreviewed[0]?.["n"] ?? 0),
    openOpportunities: opportunities.filter(o => OPEN.has(o.status)).map(o => ({ id: o.id, title: o.title })),
  }
  return { input, diagnosis: diagnoseMarketing(input), setup, profile }
})

const citationsOf = (c: ProblemCandidate) => c.evidence.map(e => e.kind === "WEBSITE_READ"
  ? { kind: "website_read", id: `${e.check}@${e.bodyDigest ?? e.fetchedAt}`, text: `Homepage read ${e.fetchedAt.slice(0, 10)}: ${e.check}` }
  : { kind: "observation", id: e.observationId, text: `Reviewed ${e.provider} answer, ${e.collectedAt.slice(0, 10)}` })

export const diagnoseMarketingProblems = (accountId: string, businessId: string) => Effect.gen(function*() {
  const { input, diagnosis } = yield* load(accountId, businessId)
  const w = input.website
  return {
    summary: diagnosis.status === "PROBLEM_SELECTED" ? `${diagnosis.candidates.length} supported ${diagnosis.candidates.length === 1 ? "problem" : "problems"} found; one selected`
      : diagnosis.status === "NO_SUPPORTED_PROBLEM" ? "No supported problem found in the recorded evidence" : "Not enough evidence to diagnose",
    citations: diagnosis.selected ? citationsOf(diagnosis.selected) : [],
    data: {
      status: diagnosis.status,
      business: { name: input.businessName, briefConfirmed: input.brief !== null, category: input.brief?.category ?? null, audience: input.brief?.audience ?? null,
        valueProposition: input.brief?.valueProposition ?? null, goal: input.goalStatement },
      approvedFacts: input.facts.slice(0, 8),
      selected: diagnosis.selected, selectionReason: diagnosis.selectionReason,
      otherCandidates: diagnosis.candidates.slice(1, 5).map(c => ({ key: c.key, severity: c.severity, observed: c.observed })),
      gaps: diagnosis.gaps, conflicts: diagnosis.conflicts, checked: diagnosis.checked,
      // Progressive loading: only the selected problem's specialist guidance enters the context.
      specialistGuidance: diagnosis.selected ? SKILLS[diagnosis.selected.specialist].instructions : null,
      untrustedWebsiteText: w.state === "READ" ? { title: w.signals.title, description: w.signals.description, headings: w.signals.headings.slice(0, 5) } : null,
      nextActions: diagnosis.selected ? ["Explain the selected problem with its evidence and uncertainty.", "Call propose_first_improvement with the selected key and one concrete change."]
        : ["Explain what is missing or what was checked.", "Do not propose an improvement."],
    },
  } satisfies AgentToolResult
})

const refused = (reason: string, recovery: string): AgentToolResult => ({ summary: `Proposal not saved: ${reason.toLowerCase().replace(/_/g, " ")}`, citations: [],
  data: { status: "REFUSED", reason, recovery, saved: false, published: false } })

/** Stable per business, candidate and evidence snapshot: retries never duplicate. */
const proposalKey = (businessId: string, candidate: ProblemCandidate) => {
  const hex = createHash("sha256").update(JSON.stringify(["first-improvement", SKILLS["first-improvement"].version, businessId, candidate.key, candidate.evidence])).digest("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${((parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16)}${hex.slice(18, 20)}-${hex.slice(20, 32)}`
}

const provenance = (candidate: ProblemCandidate, origin: AgentOrigin | undefined) => {
  const skill = SKILLS[candidate.specialist]
  const evidence = candidate.evidence.map(e => e.kind === "WEBSITE_READ"
    ? `homepage ${e.url} read by OpenRecord ${e.fetchedAt}${e.bodyDigest ? ` (sha256 ${e.bodyDigest.slice(0, 16)})` : ""}, check ${e.check}`
    : `${e.provider} answer ${e.collectedAt} reviewed as contradicting approved facts`).join("; ")
  return `Agent hypothesis from OpenRecord workflow first-improvement v${SKILLS["first-improvement"].version}, specialist ${skill.id} v${skill.version}${origin ? `, inference ${origin.provider} ${origin.model}` : ""}. Evidence: ${evidence}. Requires human approval; nothing was changed or published and no impact is claimed.`.slice(0, 1000)
}

export const proposeFirstImprovement = (accountId: string, userId: string, businessId: string, raw: unknown, origin?: AgentOrigin) => Effect.gen(function*() {
  const input = yield* Schema.decodeUnknown(ProposeInput, { onExcessProperty: "error" })(raw)
  const { diagnosis, setup, profile } = yield* load(accountId, businessId)
  const candidate = diagnosis.candidates.find(c => c.key === input.candidateKey)
  if (!candidate) return refused("CANDIDATE_NOT_CURRENT", "Call diagnose_marketing_problems again and use a candidate key it returns.")
  if (candidate.existingOpportunityId) return { summary: "This improvement is already proposed", citations: [{ kind: "growth_opportunity", id: candidate.existingOpportunityId, text: "Existing proposal" }],
    data: { status: "ALREADY_PROPOSED", opportunityId: candidate.existingOpportunityId, approval: "REQUIRED", saved: false, published: false, executed: false,
      nextActions: ["Tell the user the existing proposal awaits their decision in Work."] } } satisfies AgentToolResult
  if (!profile) return refused("GOAL_REQUIRED", "Ask the user to confirm the business brief and growth goal in /setup first.")
  const fields = buildFields(candidate, input.proposedChange, setup?.brief ?? null, profile)
  if (!fields) return refused("BRIEF_REQUIRED", "Ask the user to confirm the business brief in /setup first.")
  const evidence: GrowthEvidenceInput[] = [{ type: "MODEL_SUGGESTION", note: provenance(candidate, origin) },
    ...candidate.evidence.flatMap(e => e.kind === "REVIEWED_AI_ANSWER"
      ? [{ type: "OBSERVED" as const, reference: { kind: "OBSERVATION" as const, id: e.observationId }, note: "AI answer a person reviewed as contradicting approved facts." }] : [])]
  const key = proposalKey(businessId, candidate)
  const sql = yield* SqlClient.SqlClient
  const replay = (yield* sql`SELECT 1 FROM growth_opportunities WHERE business_id = ${businessId} AND request_key = ${key}`).length > 0
  const created = yield* (yield* GrowthRepository).create({ accountId, userId }, businessId, "ASSISTANT", {
    ...fields, ownerUserId: userId, initialStatus: "PROPOSED", idempotencyKey: key, evidence,
  }).pipe(Effect.map(o => ({ ok: true as const, o })), Effect.catchIf(e => e instanceof GrowthRefused, e => Effect.succeed({ ok: false as const, reason: e.reason })))
  if (!created.ok) return refused(created.reason === "PrimaryGoalChanged" ? "GOAL_CHANGED" : "NOT_SAVED", "Call diagnose_marketing_problems again; if it repeats, ask the user to review the goal in OpenRecord.")
  const opportunity = created.o
  return {
    summary: "Improvement saved as a proposal; human approval required",
    citations: [{ kind: "growth_opportunity", id: opportunity.id, text: opportunity.title }, ...citationsOf(candidate)],
    data: { status: replay ? "ALREADY_PROPOSED" : "PROPOSED", opportunityId: opportunity.id, title: opportunity.title,
      targetUrl: opportunity.targetUrl, approval: "REQUIRED", saved: true, published: false, executed: false, outcome: "UNMEASURED",
      nextActions: ["Tell the user to approve or decline it in Work. Nothing was changed on the website."] },
  } satisfies AgentToolResult
})

const buildFields = (candidate: ProblemCandidate, proposedChange: string, brief: import("@openrecord/contracts").SetupBrief | null,
  profile: { readonly primaryGoal: { readonly id: string }; readonly audience: string }): GrowthOpportunityFields | null => {
  const base = { goalId: profile.primaryGoal.id, targetUrl: candidate.targetUrl, proposedChange: proposedChange.trim(), baselineAvailability: "UNKNOWN" as const }
  const web = candidate.evidence.find(e => e.kind === "WEBSITE_READ")
  if (web) {
    const rule = WEBSITE_RULES.find(r => r.key === web.check)
    if (!brief || !rule) return null
    const built = rule.build({ brief, site: new URL(web.url).hostname.replace(/^www\./, "") })
    return { ...built, ...base, audience: brief.audience, uncertainty: `${candidate.uncertainty} ${built.uncertainty}`.slice(0, 2000),
      source: `OpenRecord homepage read on ${web.fetchedAt.slice(0, 10)}` }
  }
  const answer = candidate.evidence.find(e => e.kind === "REVIEWED_AI_ANSWER")
  if (!answer) return null
  return { ...base, audience: brief?.audience ?? profile.audience,
    title: "Correct what AI answers say about the business",
    problemStatement: `${candidate.observed} ${candidate.whyItMatters}`.slice(0, 2000),
    buyerIntent: candidate.observed.match(/"(.+)"/)?.[1] ?? "Get accurate information about the business from an AI assistant",
    expectedMechanism: "Stating the approved fact clearly on a page the business controls gives search engines and AI assistants accurate material to quote.",
    assumptions: "The approved fact is current and the page can be edited.",
    uncertainty: candidate.uncertainty, source: `OpenRecord reviewed AI answer from ${answer.collectedAt.slice(0, 10)}` }
}

