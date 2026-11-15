// Prompt Analysis: what the business's tracked buyer questions ask, and what
// AI answers to them name.
//
// For each question in the latest question set:
//   stage    Discovery, Consideration, Purchase or Support: where the asker is
//   want     what they want from the assistant: a recommendation, a
//            comparison, a price check, how to do something, whether a
//            product can do something, or plain information
//   brand    whether the question names the business, names only others, or
//            is unbranded (where visibility is most up for grabs)
//   named    the brands the question names, and the brands the answers name
//            (exact-name detections over the latest batch's answers, and the
//            reviewed mention of the business where a person judged it)
//
// These are the business's tracked questions, not the market's demand: no
// count here is a search or prompt volume. Stage and want are rules on the
// question's words (and its intent group), not a model's guess, so the same
// question always lands in the same place.
import { detectMentions, type AcquisitionView, type BrandSpec } from "@openrecord/db"

export const PROMPT_ANALYSIS_VERSION = "rules-v1"

export type Stage = "DISCOVERY" | "CONSIDERATION" | "PURCHASE" | "SUPPORT"
export type Want = "RECOMMENDATION" | "COMPARISON" | "PRICE_CHECK" | "HOW_TO" | "FEATURE_CHECK" | "INFORMATION"
export type Branding = "BRANDED" | "COMPETITOR_BRANDED" | "UNBRANDED"

export const STAGES: ReadonlyArray<Stage> = ["DISCOVERY", "CONSIDERATION", "PURCHASE", "SUPPORT"]
export const WANTS: ReadonlyArray<Want> = ["RECOMMENDATION", "COMPARISON", "PRICE_CHECK", "HOW_TO", "FEATURE_CHECK", "INFORMATION"]

// In the order they are tried: the first that matches decides.
const WANT_RULES: ReadonlyArray<readonly [Want, RegExp]> = [
  ["PRICE_CHECK", /\b(price[sd]?|pricing|cost[s]?|how much|fees?|cheap(est)?|afford\w*|free (trial|plan|tier|version)|freemium|pay[- ]as[- ]you[- ]go|trial|discount|plans?)\b/i],
  // "Which platform offers / has / supports …": whether something can do a thing, asked across products.
  ["FEATURE_CHECK", /^\s*which\b.*\b(offers?|ha(s|ve)|supports?|includes?|integrat\w*|works? with)\b/i],
  ["COMPARISON", /\b(vs\.?|versus|compare[sd]?|comparison|alternatives?( to)?|better than|difference between|similar to|(platforms?|tools?|apps?|software|services?|companies) like|instead of)\b/i],
  ["RECOMMENDATION", /\b(best|top|recommend\w*|which (\w+ ){0,3}(platforms?|tools?|apps?|software|services?|providers?|apis?|companies|vendors?)|what (tools?|platforms?|apps?|options) (exist|are there|are available)|where (can|do|should) (i|we) (find|get|hire|book|buy)|which (\w+ ){0,3}(should|to use|is good)|what (\w+ ){0,3}(should i|to use)|good (\w+ ){0,2}for|leading|most (reliable|popular|trusted))\b/i],
  ["HOW_TO", /\b(how (do|can|should) (i|we|you)|how to|step[- ]by[- ]step|tutorial|configure|install|troubleshoot)\b/i],
  ["FEATURE_CHECK", /^\s*(does|do|can|is|are|will)\b|\b(integrat\w+ with|support[s]?|offer[s]?|include[s]?|work[s]? with)\b/i],
]
const SUPPORT = /\b(cancel|refund|log ?in|sign ?in|account|billing|invoice|not working|error|reset|contact (support|them)|customer service|phone support)\b/i
const PURCHASE = /\b(buy|purchase|sign ?up|subscribe|pricing|price|cost|how much|trial|plans?|discount|contract)\b/i
const CONSIDERATION = /\b(vs\.?|versus|compare|comparison|alternatives?|reviews?|pros and cons|worth it|better than|like \w+|instead of|secure|reliable|integrat\w+|support[s]?)\b/i

const GROUP_STAGE: Readonly<Record<string, Stage>> = {
  CATEGORY_DISCOVERY: "DISCOVERY", PROBLEM_SOLVING: "DISCOVERY", ALTERNATIVES: "CONSIDERATION", INTEGRATION_NEEDS: "CONSIDERATION", PURCHASE_EVALUATION: "PURCHASE",
}

/** What the asker wants from the assistant. */
export const wantOf = (prompt: string): Want => WANT_RULES.find(([, re]) => re.test(prompt))?.[0] ?? "INFORMATION"

/** Where the asker is in buying. A branded how-to or account question is support; the words decide before the intent group does. */
export const stageOf = (prompt: string, branding: Branding, group: string | null): Stage => {
  if (branding === "BRANDED" && (SUPPORT.test(prompt) || wantOf(prompt) === "HOW_TO")) return "SUPPORT"
  if (PURCHASE.test(prompt)) return "PURCHASE"
  if (CONSIDERATION.test(prompt) || branding === "COMPETITOR_BRANDED") return "CONSIDERATION"
  return (group && GROUP_STAGE[group]) || (branding === "BRANDED" ? "CONSIDERATION" : "DISCOVERY")
}

export interface PromptRow {
  readonly key: string
  readonly prompt: string
  readonly intentGroup: string
  readonly stage: Stage
  readonly want: Want
  readonly branding: Branding
  /** Brands the question itself names. */
  readonly namedInPrompt: ReadonlyArray<string>
  /** Answers read for it in the latest batch, and how many named each brand (exact-name detections, not reviewed). */
  readonly answers: number
  readonly namedInAnswers: Readonly<Record<string, number>>
  /** How many answers a person reviewed, and in how many of those the business was mentioned. */
  readonly reviewed: { readonly n: number; readonly mentioned: number }
}

const brandNames = (text: string, target: BrandSpec, competitors: ReadonlyArray<BrandSpec>) =>
  [...new Set(detectMentions(text, target, competitors).map(m => m.brand))]

/**
 * The analysis of the latest question set, with its latest finished batch's
 * answers. Null when the business has no question set yet.
 */
export const analysePrompts = (view: AcquisitionView) => {
  const set = view.sets.at(-1)
  if (!set) return null
  const batch = [...view.batches].reverse().find(b => b.setId === set.id && b.status !== "QUEUED" && b.status !== "RUNNING") ?? null
  const rows: PromptRow[] = set.questions.map(q => {
    const namedInPrompt = brandNames(q.prompt, set.target, set.competitors)
    const branding: Branding = namedInPrompt.includes(set.target.name) ? "BRANDED" : namedInPrompt.length ? "COMPETITOR_BRANDED" : "UNBRANDED"
    const checks = batch ? view.checks.filter(c => c.batchId === batch.id && c.questionId === q.id && c.eligible) : []
    const namedInAnswers: Record<string, number> = {}
    for (const c of checks) for (const b of new Set(c.candidates.map(m => m.brand))) namedInAnswers[b] = (namedInAnswers[b] ?? 0) + 1
    const reviewed = checks.filter(c => c.judgment)
    return { key: q.key, prompt: q.prompt, intentGroup: q.group, stage: stageOf(q.prompt, branding, q.group), want: wantOf(q.prompt), branding, namedInPrompt,
      answers: checks.length, namedInAnswers, reviewed: { n: reviewed.length, mentioned: reviewed.filter(c => c.judgment!.mention === "MENTIONED").length } }
  })
  const count = <K extends string>(keys: ReadonlyArray<K>, of: (r: PromptRow) => K) => Object.fromEntries(keys.map(k => [k, rows.filter(r => of(r) === k).length])) as Record<K, number>
  // Unbranded questions whose answers were read and never named the business: visibility up for grabs.
  const open = rows.filter(r => r.branding === "UNBRANDED" && r.answers > 0 && !r.namedInAnswers[set.target.name])
  const othersInOpen: Record<string, number> = {}
  for (const r of open) for (const [b, n] of Object.entries(r.namedInAnswers)) othersInOpen[b] = (othersInOpen[b] ?? 0) + n
  // Patterns: each stage and want that has questions, with example prompts.
  const patterns = STAGES.flatMap(stage => WANTS.flatMap(want => {
    const of = rows.filter(r => r.stage === stage && r.want === want)
    return of.length ? [{ stage, want, questions: of.length, unbranded: of.filter(r => r.branding === "UNBRANDED").length, examples: of.slice(0, 3).map(r => r.prompt) }] : []
  }))
  return {
    version: PROMPT_ANALYSIS_VERSION,
    brand: set.target.name,
    competitors: set.competitors.map(c => c.name),
    setVersion: set.version,
    batch: batch ? { id: batch.id, surface: batch.surface, collectedFrom: batch.collectedFrom, collectedTo: batch.collectedTo } : null,
    questions: rows.length,
    byStage: count(STAGES, r => r.stage),
    byWant: count(WANTS, r => r.want),
    byBranding: count<Branding>(["BRANDED", "COMPETITOR_BRANDED", "UNBRANDED"], r => r.branding),
    open: { questions: open.map(r => ({ key: r.key, prompt: r.prompt, stage: r.stage, want: r.want, namedInAnswers: r.namedInAnswers })), othersNamed: othersInOpen },
    // Stages with fewer than two tracked questions: the agent can draft more (propose_question_set).
    thinStages: STAGES.filter(s => rows.filter(r => r.stage === s).length < 2),
    patterns,
    rows,
    limitations: [
      "These are the questions this business tracks, not how often people ask them: no figure here is a prompt or search volume.",
      "Stage and want come from rules on each question's words and its intent group; they are consistent, not a judgment of intent.",
      "Brands in answers are exact-name detections in the latest batch's answers, not human-reviewed; the business's reviewed mentions are counted separately.",
      ...(set.target.ambiguity || /\s/.test(set.target.name) && /^[a-z\s]+$/i.test(set.target.name) ? [`"${set.target.name}" can also be an ordinary phrase, so a question using those words may count as naming the business.`] : []),
      ...(batch ? [`Answers come from one surface (${batch.surface}); other assistants may answer differently.`] : ["No finished batch yet: answers have not been read for these questions."]),
    ],
  }
}
export type PromptAnalysis = NonNullable<ReturnType<typeof analysePrompts>>
