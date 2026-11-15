// The decision engine: before the model's first step, decide what a business
// turn is about, which tools it needs, and what to read for it straight away.
//
// Measured on the dev runs of 2026-11-10 to 2026-11-15, a turn spent about
// three quarters of its time in model steps (4.6 a turn, about 9 seconds each),
// and the first step was nearly always the model choosing the same orientation
// reads (business truth, goal, search performance, competitors). So:
//
//   1. intents   fast rules on the request (no model) name what it is about:
//                a report, AI visibility research, writing, the website, a
//                campaign, ads and local, or reviewing past work. Several can
//                match; none is a valid answer.
//   2. prefetch  each matched intent's orientation reads run together before
//                the first model step, as if the model had asked for them, so
//                that step is spent on the work itself.
//   3. tools     the turn declares the core tools, every read that takes no
//                inputs (a line each), the intents' tools and the router's
//                best matches. Every other registered tool stays
//                reachable: its name is listed, and tool_details declares it.
//
// Nothing here grants anything: dispatch checks every call as before, and a
// request no rule recognises keeps every tool, as a turn did before.
import { SqlClient } from "@effect/sql"
import { Effect } from "effect"
import { toolEffect, type ToolDeclaration } from "./agent-registry.js"
import { CAPABILITY_MANIFESTS } from "./capabilities/catalog.js"
import { makeRouter } from "./capabilities/router.js"

export const DECISION_VERSION = "rules-v1"

export type Intent = "report" | "visibility" | "write" | "site" | "campaign" | "media" | "review"

interface IntentRule {
  readonly match: RegExp
  /** Declared with their whole schema from the start: the saves this intent exists for. */
  readonly expand?: ReadonlyArray<string>
  /** Declared for the turn. */
  readonly tools: ReadonlyArray<string>
  /** Read before the first model step: no inputs, fast, read-only. */
  readonly prefetch: ReadonlyArray<string>
}

/** Declared on every routed turn: orientation, the research pair, and asking the person. */
// With the reads most dev turns used (each in a third to two thirds of them):
// their cards are a line each, and missing one costs a whole extra step.
export const CORE_TOOLS = [
  "read_business_truth", "read_growth_goal", "read_proposals", "read_decision_feedback", "read_objective_investigations",
  "read_competitors", "read_search_performance", "read_results", "read_acquisition_overview", "read_marketing_work", "read_marketing_campaigns",
  "find_research_capabilities", "run_research", "read_research_evidence", "read_web_page", "read_web_pages", "search_web",
  "remember", "leave_blank",
] as const

const RULES: Readonly<Record<Intent, IntentRule>> = {
  report: {
    match: /\b(how (are|is|did) (we|it|our)|doing|results?|perform\w*|traffic|clicks?|impressions?|revenue|sales|signups?|conversions?|numbers|metrics?|kpis?|report|status|progress|this (week|month)|last (week|month)|what (changed|worked)|goal)\b/,
    tools: ["read_search_performance", "read_results", "read_revenue", "read_ad_performance", "read_acquisition_overview", "read_ai_referral_evidence",
      "read_local_profile", "read_marketing_work", "read_marketing_campaigns", "read_growth_opportunities", "read_record_outcomes", "read_open_issues",
      "read_competitors", "prepare_client_report", "read_campaign_runs", "read_campaign_outcome"],
    prefetch: ["read_search_performance", "read_results", "read_revenue", "read_objective_investigations", "read_ad_performance", "read_growth_goal"],
  },
  visibility: {
    match: /\b(ai (answers?|assistants?|search|visibility|overviews?)|chatgpt|claude|gemini|perplexity|copilot|llms?|aeo|geo|cit(e|es|ed|ing|ations?)|sources?|mentions?|competitors?|compar\w+|alternatives?|buyer questions?|prompts?|visibility|research|reddit|youtube|forums?|review sites?|outreach)\b/,
    tools: ["read_competitors", "read_acquisition_overview", "read_acquisition_citations", "read_buyer_question_results", "read_competitor_appearances",
      "read_ai_referral_evidence", "discover_buyer_questions", "ask_ai_assistants", "propose_question_set", "propose_acquisition_measurement",
      "compare_acquisition_batches", "propose_check_run", "research_company", "web_research", "cross_source_marketing_investigation",
      "read_representations", "read_open_issues", "read_issue", "read_observation", "draft_source_action", "read_discovery_scopes",
      "research_timeline", "read_research_credit", "list_connected_tools", "call_connected_tool"],
    prefetch: ["read_competitors", "read_business_truth", "read_research_evidence", "read_growth_goal", "read_acquisition_citations"],
  },
  write: {
    match: /\b(write|draft|create|build|design|make|landing page|page copy|article|blog|post|email|newsletter|ad copy|headline|tagline|brief|one-pager|faq|copy)\b/,
    tools: ["create_artifact", "edit_artifact", "read_artifact", "list_artifacts", "record_campaign_draft", "record_campaign_revision",
      "read_marketing_campaigns", "read_competitors", "read_wordpress_content"],
    expand: ["create_artifact", "edit_artifact"],
    prefetch: ["read_business_truth", "read_growth_goal", "read_competitors"],
  },
  site: {
    match: /\b(website|site|seo|audit|homepage|web pages?|pricing page|index\w*|crawl\w*|robots|sitemap|schema|structured data|meta|titles?|canonicals?|speed|core web vitals|wordpress|publish|deploy|repository|repo)\b/,
    tools: ["audit_website", "map_website", "assess_web_page", "measure_web_performance", "read_search_performance", "read_wordpress_content",
      "prepare_wordpress_change", "read_connected_execution_targets", "prepare_page_change", "read_connected_executions", "read_open_issues",
      "read_issue", "propose_growth_opportunity", "read_growth_opportunities"],
    prefetch: ["read_business_truth", "read_search_performance", "read_connected_execution_targets", "read_growth_goal", "read_growth_opportunities"],
  },
  campaign: {
    match: /\b(campaigns?|launch|run|deliverables?|plan|initiative|opportunit\w+|investigat\w+|next (step|move)s?|what should we|priorit\w+|focus|backlog|blocked|work)\b/,
    tools: ["record_campaign_draft", "record_campaign_revision", "record_campaign_run", "read_campaign_runs", "record_campaign_delivery",
      "record_campaign_measurement", "read_campaign_outcome", "read_marketing_campaigns", "read_marketing_work", "propose_growth_opportunity",
      "read_growth_opportunities", "open_investigation", "record_investigation_note", "read_investigation", "wait_for_investigation"],
    prefetch: ["read_results", "read_search_performance", "read_objective_investigations", "read_business_truth", "read_revenue", "read_marketing_work"],
  },
  media: {
    match: /\b(ads?|adwords|google ads|meta ads|facebook ads|spend|budget|cpc|cpa|roas|bids?|reviews?|stars?|google business|local|maps|listing)\b/,
    tools: ["read_ad_campaigns", "read_ad_performance", "prepare_account_action", "read_reviews", "read_local_profile"],
    prefetch: ["read_ad_performance", "read_search_performance", "read_results", "read_local_profile", "read_business_truth"],
  },
  review: {
    match: /\b(review(er)?|second opinion|check (this|the|my)|approve|approval|proposals?|decisions?|inbox|pending|rejected|outcomes?)\b/,
    tools: ["read_proposals", "read_decision_feedback", "record_outcome_note", "read_results", "read_record_outcomes", "read_observation", "read_issue"],
    prefetch: ["read_proposals", "read_business_truth", "read_acquisition_overview", "read_decision_feedback"],
  },
}

/** At most this many intents shape a turn. */
const MAX_INTENTS = 2
/** Each turn reads at most this many things before its first model step. */
const MAX_PREFETCH = 6
/** The router's picks added beside the intents' tools. */
const ROUTER_K = 8
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i

export interface Prefetch { readonly name: string; readonly args: Record<string, unknown> }
export interface TurnDecision {
  readonly version: string
  readonly intents: ReadonlyArray<Intent>
  /** Declared for the turn; null keeps every tool (nothing recognised). */
  readonly tools: ReadonlyArray<string> | null
  readonly prefetch: ReadonlyArray<Prefetch>
  /** Declared whole from the first step, so using them never costs a tool_details step. */
  readonly expand: ReadonlyArray<string>
}

const route = makeRouter(CAPABILITY_MANIFESTS)

/** The artifact the app says the person is looking at (`withViewing`), if any. */
export const viewedArtifact = (message: string): string | null => {
  const note = message.match(/\[App context, not written by the person:[^\]]*\]/)?.[0]
  return note?.match(UUID)?.[0]?.toLowerCase() ?? null
}

/** The person's own words: what the app appended (attachments, viewing) is left out. */
const ownWords = (message: string) => message.split("\n\n[App context, not written by the person:")[0]!.split("\n\nAttached file")[0]!

/** A read with no inputs: its card is a line, so it is always declared. */
const lightRead = (t: ToolDeclaration) => toolEffect(t.name) === "read" && !((t.parametersJsonSchema as { required?: ReadonlyArray<string> } | null)?.required?.length)

/**
 * Decides a business turn. `declarations` is every tool the turn may use; the
 * decision only ever narrows it, and lists nothing that is not in it.
 */
export const decideTurn = (message: string, declarations: ReadonlyArray<ToolDeclaration>): TurnDecision => {
  const available = declarations.map(d => d.name)
  const words = ownWords(message)
  const text = words.toLowerCase()
  const has = new Set(available)
  const viewing = viewedArtifact(message)
  // Ranked by how many of an intent's words the request uses; a long brief
  // touches most intents once, so only the strongest (and near ties) count.
  const scores = (Object.keys(RULES) as Intent[]).map(i => ({ i, n: text.match(new RegExp(RULES[i].match.source, "g"))?.length ?? 0 })).filter(x => x.n > 0)
  const top = Math.max(0, ...scores.map(x => x.n))
  const intents = scores.filter(x => x.n >= Math.max(1, top * 0.5)).sort((a, b) => b.n - a.n).slice(0, MAX_INTENTS).map(x => x.i)
  // A change asked for while a piece is open beside the chat is writing, about that piece.
  if (viewing && !intents.includes("write")) intents.push("write")
  // A slash command chooses its own tools elsewhere; a greeting or a word of thanks reads nothing.
  if (text.trim().startsWith("/") || (!intents.length && text.trim().split(/\s+/).length <= 4))
    return { version: DECISION_VERSION, intents, tools: null, prefetch: [], expand: [] }
  const prefetch: Prefetch[] = []
  const add = (name: string, args: Record<string, unknown> = {}) => {
    if (has.has(name) && prefetch.length < MAX_PREFETCH && !prefetch.some(p => p.name === name)) prefetch.push({ name, args })
  }
  if (viewing) add("read_artifact", { artifactId: viewing })
  // Interleaved, so each intent gets its first reads before any gets its last.
  // Per intent, in the order the dev turns' first steps asked for them most.
  const lists = intents.length ? intents.map(i => RULES[i].prefetch) : [["read_growth_goal", "read_business_truth", "read_acquisition_overview", "read_proposals"]]
  for (let k = 0; k < Math.max(...lists.map(l => l.length)); k++) for (const l of lists) if (l[k]) add(l[k]!)
  if (!intents.length) return { version: DECISION_VERSION, intents, tools: null, prefetch, expand: [] }
  const routed = route({ text: words, allowedSideEffects: ["none", "internal_write", "external_write", "irreversible"], k: ROUTER_K }).selected
  const wanted = new Set<string>([...CORE_TOOLS, ...declarations.filter(lightRead).map(d => d.name), ...intents.flatMap(i => RULES[i].tools), ...routed, ...prefetch.map(p => p.name)])
  // Registry order, so a routed turn reads like a full one.
  const expand = intents.flatMap(i => RULES[i].expand ?? []).filter(n => has.has(n))
  return { version: DECISION_VERSION, intents, tools: available.filter(n => wanted.has(n)), prefetch, expand }
}

/** Names the turn does not declare, for the instructions: any of them can still be used. */
export const otherToolsNote = (declared: ReadonlyArray<string>, available: ReadonlyArray<string>) => {
  const rest = available.filter(n => !declared.includes(n))
  return rest.length
    ? `\n\nThis turn declares the tools its request needs. These are also available; to use one, call tool_details with its name first: ${rest.join(", ")}.`
    : ""
}

/** What a tool needs connected for the business before it can do anything but refuse. */
const NEEDS: ReadonlyArray<{ readonly connection: "wordpress" | "google_ads" | "ads_or_profile"; readonly name: string; readonly tools: ReadonlyArray<string> }> = [
  { connection: "wordpress", name: "WordPress", tools: ["read_wordpress_content", "prepare_wordpress_change"] },
  { connection: "google_ads", name: "Google Ads", tools: ["read_ad_campaigns"] },
  { connection: "ads_or_profile", name: "Google Ads or Google Business Profile", tools: ["prepare_account_action"] },
]

/**
 * The tools a business cannot use right now because what they work on is not
 * connected, and a sentence for the instructions saying so. In the dev runs
 * these were called and refused (WordPress 13 times in five days).
 */
export const connectionGaps = (accountId: string, businessId: string) => Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql`SELECT
    EXISTS(SELECT 1 FROM wordpress_connections WHERE account_id = ${accountId} AND business_id = ${businessId} AND status <> 'DISCONNECTED') AS wordpress,
    EXISTS(SELECT 1 FROM ad_account_bindings b JOIN ad_connections c ON c.id = b.connection_id WHERE b.account_id = ${accountId} AND b.business_id = ${businessId}
      AND b.ended_at IS NULL AND c.status <> 'DISCONNECTED' AND b.provider = 'google_ads') AS google_ads,
    EXISTS(SELECT 1 FROM ad_account_bindings b JOIN ad_connections c ON c.id = b.connection_id WHERE b.account_id = ${accountId} AND b.business_id = ${businessId}
      AND b.ended_at IS NULL AND c.status <> 'DISCONNECTED' AND b.provider = 'google_business') AS google_business`
  const r = rows[0] ?? {}
  const has = { wordpress: r["wordpress"] === true, google_ads: r["google_ads"] === true, ads_or_profile: r["google_ads"] === true || r["google_business"] === true }
  const missing = NEEDS.filter(n => !has[n.connection])
  return {
    withheld: new Set(missing.flatMap(n => n.tools)),
    note: missing.length ? `\n\nNot connected for this business: ${missing.map(n => n.name).join("; ")}. Tools that need them are not offered this turn; if the request needs one, say it is not connected and that the person can connect it on the Channels page.` : "",
  }
}).pipe(Effect.orElseSucceed(() => ({ withheld: new Set<string>(), note: "" })))
