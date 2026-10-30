// AI Discovery API (operator only). Shapes mirror packages/db
// acquisition.ts / acquisition-view.ts JSON. There is no public endpoint.
import { api } from "./api"

export type IntentGroup = "CATEGORY_DISCOVERY" | "PROBLEM_SOLVING" | "ALTERNATIVES" | "INTEGRATION_NEEDS" | "PURCHASE_EVALUATION"
export type Basis = "AUTHORIZED_CLIENT" | "PUBLIC_RESEARCH" | "FIXTURE"
export type Mention = "MENTIONED" | "NOT_MENTIONED" | "UNCLEAR"
export type Recommendation = "RECOMMENDED" | "MENTIONED_NOT_RECOMMENDED" | "ADVISED_AGAINST" | "UNCLEAR"
export type BatchStatus = "QUEUED" | "RUNNING" | "SUCCEEDED" | "PARTIALLY_SUCCEEDED" | "FAILED"
export type Fraction = { n: number; d: number }
export type Brand = { name: string; aliases: string[]; domains: string[]; matchCase: boolean; ambiguity: string | null }

export const INTENT_GROUPS: IntentGroup[] = ["CATEGORY_DISCOVERY", "PROBLEM_SOLVING", "ALTERNATIVES", "INTEGRATION_NEEDS", "PURCHASE_EVALUATION"]
export const GROUP_LABELS: Record<IntentGroup, string> = {
  CATEGORY_DISCOVERY: "Category discovery",
  PROBLEM_SOLVING: "Problem-solving",
  ALTERNATIVES: "Alternatives",
  INTEGRATION_NEEDS: "Integration needs",
  PURCHASE_EVALUATION: "Purchase evaluation",
}
export const BASIS_LABELS: Record<Basis, string> = { AUTHORIZED_CLIENT: "Authorized client", PUBLIC_RESEARCH: "Public research", FIXTURE: "Fixture" }
export const MENTION_LABELS: Record<Mention, string> = { MENTIONED: "Mentioned", NOT_MENTIONED: "Not mentioned", UNCLEAR: "Unclear" }
export const RECOMMENDATION_LABELS: Record<Recommendation, string> = {
  RECOMMENDED: "Recommended",
  MENTIONED_NOT_RECOMMENDED: "Mentioned, not recommended",
  ADVISED_AGAINST: "Advised against",
  UNCLEAR: "Unclear",
}
export const BATCH_STATUS_LABELS: Record<BatchStatus, string> = {
  QUEUED: "Queued", RUNNING: "Running", SUCCEEDED: "Complete", PARTIALLY_SUCCEEDED: "Complete with failures", FAILED: "Failed",
}
export const HINT_LABELS: Record<string, string> = { NEGATIVE_CUE: "negative wording", LIST: "in a list", COMPARISON: "comparison" }

export type Question = { id: string; key: string; group: IntentGroup; position: number; buyerQuestionId: string; prompt: string; createdAt: string }
export type QuestionSet = {
  id: string; version: number; basis: Basis; category: string; target: Brand; competitors: Brand[]; specDigest: string; createdAt: string
  questions: Question[]; questionsNamingTarget: string[]
}
export type Candidate = {
  role: "TARGET" | "COMPETITOR"; brand: string; alias: string; start: number; end: number; matched: string; sentence: string
  hints: string[]; ambiguity: string | null; collision: boolean
}
export type Citation = {
  uri: string | null; title: string | null; position: number | null; domain: string | null; domainBasis: "URI_HOST" | "PROVIDER_TITLE" | "UNRESOLVED"
  owner: "OWNED" | "COMPETITOR" | "OTHER" | "UNRESOLVED"; competitor: string | null; support: "NOT_VERIFIED"; attributedByProvider: boolean
}
export type Judgment = {
  id: string; mention: Mention; recommendation: Recommendation | null; detectorVersion: string; candidateCount: number; note: string | null
  supersedesId: string | null; reviewedByUserId: string; reviewedAt: string
}
export type Observation = {
  id: string; provider: string; requestedModel: string | null; observedModel: string | null; collectedAt: string; answerText: string; rawDigest: string
  synthetic: boolean; retrievalMode: string; retrievalTool: string | null; retrievalRequested: boolean; retrievalObserved: boolean
  searchQueries: string[]; searchSuggestionsHtml: string | null; citations: Citation[]
}
export type Check = {
  id: string; batchId: string; questionId: string; questionKey: string; group: IntentGroup; prompt: string; sample: number
  status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED"; failureClass: string | null; failureDetailSafe: string | null; attempts: number
  queuedAt: string; completedAt: string | null; observation: Observation | null; candidates: Candidate[]; judgment: Judgment | null; judgments: Judgment[]; eligible: boolean
}
export type QuestionSummary = {
  key: string; group: IntentGroup; prompt: string; planned: number; failed: number; eligible: number; reviewed: number; mentioned: number
  recommended: number; ownedCited: number; statement: string
}
export type Metrics = {
  planned: number; providerAttempts: number; succeeded: number; failed: number; pending: number; failures: Array<{ failureClass: string; count: number }>
  eligible: number; syntheticExcluded: number; groundingObserved: Fraction; reviewed: Fraction; candidateSamples: Fraction; mentionRate: Fraction
  recommendationRate: Fraction
  breakdown: { recommended: number; mentionedNotRecommended: number; advisedAgainst: number; recommendationUnclear: number; notMentioned: number; mentionUnclear: number }
  ownedCitationRate: Fraction; competitors: Array<{ name: string; samples: Fraction }>; questions: QuestionSummary[]; questionsRecommended: Fraction
  groups: Array<{ group: IntentGroup; questions: number; reviewed: number; recommended: number }>
}
export type Batch = {
  id: string; setId: string; setVersion: number; scope: "SMOKE" | "FULL"; questionCount: number; sampleCount: number; provider: string; requestedModel: string | null
  retrievalRequested: boolean; maxProviderCalls: number; createdAt: string; status: BatchStatus; surface: string; collectedFrom: string | null; collectedTo: string | null
  metrics: Metrics
}
export type Referral = {
  id: string; synthetic: boolean; propertyRef: string; dateStart: string; dateEnd: string; timeZone: string; attributionBasis: string; conversionEvent: string | null
  rawDigest: string; importedAt: string; totalSessions: number; aiSessions: number
  bySource: Array<{ assistant: string; sources: string[]; sessions: number; conversions: number | null }>
  signups: number | "SIGNUPS_NOT_MEASURED"
}
export type DiscoveryView = {
  profile: { businessId: string; name: string; websiteUrl: string; engagement: string }
  sets: QuestionSet[]; batches: Batch[]; checks: Check[]; referrals: Referral[]; activeBatch: boolean; detectorVersion: string; aiSourcesVersion: string
}
export type DiscoveryResponse = { view: DiscoveryView; surface: { provider: string; model: string }; maxAttemptsPerCheck: number }
export type ComparisonPeriod = { batchId: string; createdAt: string; provider: string; questionSetVersion: number; requestedModel: string | null; observedModels: string[]; recommendation: Fraction; mention: Fraction; ownedCitations: Fraction; reviewed: Fraction; failed: number }
export type BatchComparison = { state: "COMPARABLE" | "NOT_COMPARABLE"; reasons: string[]; before: ComparisonPeriod; after: ComparisonPeriod; limitation: string }

export type Representative = {
  questionKey: string; prompt: string; sample: number; collectedAt: string; answerText: string; mention: Mention; recommendation: Recommendation | null
  observationId: string; rawDigest: string; ownedCitations: string[]
}
export type Report = {
  question: string
  business: { name: string; websiteUrl: string }
  category: string | null
  basis: Basis | null
  questionSet: { version: number; specDigest: string; questions: number; createdAt: string } | null
  ownedDomains: string[]
  competitors: string[]
  periods: Array<{ batchId: string; scope: "SMOKE" | "FULL"; setVersion: number; surface: string; sampleCount: number; collectedFrom: string | null; collectedTo: string | null
    metrics: Metrics; representative: Representative[] }>
  configurationChanged: string[]
  referrals: { provided: boolean; imports: Referral[]; syntheticExcluded: number }
  limitations: string[]
  detectorVersion: string
  aiSourcesVersion: string
}

export type CreateSetInput = { basis: Basis; category: string; target: Omit<Brand, "matchCase"> & { matchCase?: boolean }; competitors: Array<Omit<Brand, "matchCase"> & { matchCase?: boolean }>
  questions: Array<{ group: IntentGroup; prompt: string }> }
export type ImportInput = { dataOrigin: "GA4_EXPORT" | "SYNTHETIC_FIXTURE"; propertyRef: string; dateStart: string; dateEnd: string; timeZone: string
  attributionBasis: "SESSION_SOURCE_MEDIUM"; conversionEvent: string | null; csv: string }

const json = (body: unknown): RequestInit => ({ body: JSON.stringify(body) })
const base = (id: string) => `/api/acquisition/clients/${encodeURIComponent(id)}`

export const Discovery = {
  get: (id: string) => api<DiscoveryResponse>(base(id)),
  compare: (id: string, beforeId: string, afterId: string) => api<{ comparison: BatchComparison }>(`${base(id)}/comparison/${encodeURIComponent(beforeId)}/${encodeURIComponent(afterId)}`),
  report: (id: string) => api<{ report: Report }>(`${base(id)}/report`),
  createSet: (id: string, input: CreateSetInput) => api<{ set: QuestionSet }>(`${base(id)}/question-sets`, { method: "POST", ...json(input) }),
  startBatch: (id: string, input: { setId: string; scope: "SMOKE" | "FULL"; questionKeys?: string[]; samples: number; acknowledgedMaxProviderCalls: number }) =>
    api<{ batch: { id: string } }>(`${base(id)}/batches`, { method: "POST", ...json(input) }),
  judge: (id: string, input: { observationId: string; mention: Mention; recommendation: Recommendation | null; note: string | null }) =>
    api<{ judgment: Judgment }>(`${base(id)}/judgments`, { method: "POST", ...json(input) }),
  importReferrals: (id: string, input: ImportInput) => api<{ importId: string; duplicate: boolean }>(`${base(id)}/referral-imports`, { method: "POST", ...json(input) }),
}

export const fraction = (f: Fraction) => `${f.n} of ${f.d}`
export const discoveryPath = (clientId: string) => `/clients/${encodeURIComponent(clientId)}/discovery`
export const discoveryReportPath = (clientId: string) => `${discoveryPath(clientId)}/report`

/** "Name | alias, alias | domain, domain [| case]" per line, for the competitor field. */
export const parseCompetitors = (text: string): Array<{ name: string; aliases: string[]; domains: string[]; matchCase: boolean; ambiguity: null }> =>
  text.split("\n").map(l => l.trim()).filter(Boolean).map(line => {
    const [name = "", aliases = "", domains = "", flag = ""] = line.split("|").map(s => s.trim())
    const list = (s: string) => s.split(",").map(x => x.trim()).filter(Boolean)
    return { name, aliases: list(aliases), domains: list(domains), matchCase: flag.toLowerCase() === "case", ambiguity: null }
  })
export const formatCompetitors = (brands: Brand[]) =>
  brands.map(b => `${b.name} | ${b.aliases.join(", ")} | ${b.domains.join(", ")}${b.matchCase ? " | case" : ""}`).join("\n")

/** What to measure, suggested for the person to confirm: from an accepted buyer-question proposal, else from setup. Never frozen by itself. */
export type AcquisitionSuggestion = {
  source: "PROPOSAL" | "SETUP" | null; brandName: string | null; category: string | null; domains: string[]
  competitors: Array<{ name: string; website?: string }>; questions: Array<{ group: string; prompt: string }>
  confirmedCompetitors: string[]; hasFrozenSet: boolean
}
export const acquisitionSuggestion = (businessId: string) =>
  api<{ suggestion: AcquisitionSuggestion }>(`/api/businesses/${encodeURIComponent(businessId)}/acquisition/suggestion`)
/** Suggested competitors in the competitor field's format, their website's domain as the one known domain. */
export const suggestedCompetitorLines = (list: AcquisitionSuggestion["competitors"]) =>
  list.map(c => { let d = ""; try { d = c.website ? new URL(c.website).hostname.replace(/^www\./, "") : "" } catch { d = "" } return `${c.name} |  | ${d}` }).join("\n")
