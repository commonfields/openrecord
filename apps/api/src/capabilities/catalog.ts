import { Schema } from "effect"
import { AGENT_TOOL_SPECS, type AgentToolSpec } from "../agent-registry.js"
import { CapabilityManifest, type Namespace } from "./manifest.js"
import { ROUTING_CASES } from "./routing-cases.js"

type Evidence = CapabilityManifest["evidenceProduced"][number]
interface Meta {
  readonly ns: Namespace; readonly title: string; readonly not: string
  readonly cost?: "metered"; readonly slow?: true; readonly publicScope?: true; readonly evidence?: ReadonlyArray<Evidence>
}

/**
 * Hand-reviewed routing metadata for each registered agent tool. A tool missing here fails the build test.
 * whenNotToUse names the near-miss and the capability to use instead.
 */
const META: Readonly<Record<string, Meta>> = {
  create_artifact: { ns: "work", title: "Write and save a finished piece of work", not: "Not for changing an existing artifact (edit_artifact), a campaign plan (record_campaign_draft) or publishing (prepare_wordpress_change, prepare_page_change).", evidence: ["draft"] },
  edit_artifact: { ns: "work", title: "Change a saved artifact as a new version", not: "Not for a new piece (create_artifact) or for publishing it.", evidence: ["draft"] },
  read_artifact: { ns: "work", title: "Read a saved artifact's content", not: "Not for the list of artifacts (list_artifacts) or as evidence about the business.", evidence: ["none"] },
  list_artifacts: { ns: "work", title: "List saved artifacts", not: "Not for proposals waiting for approval (read_proposals) or campaigns (read_marketing_campaigns).", evidence: ["none"] },
  record_campaign_draft: { ns: "work", title: "Save a new campaign draft", not: "Not for editing an existing campaign (record_campaign_revision) or for an alternative nobody asked for.", evidence: ["draft"] },
  record_campaign_revision: { ns: "work", title: "Edit an existing draft campaign", not: "Not for a new campaign (record_campaign_draft) or for marking work done or launched.", evidence: ["draft"] },
  record_campaign_run: { ns: "work", title: "Start or resume a campaign run", not: "Not for editing the brief, approving, publishing or spending.", evidence: ["receipt"] },
  read_campaign_runs: { ns: "work", title: "Read campaign runs and delivery state", not: "Not for the campaign brief itself (read_marketing_campaigns).", evidence: ["none"] },
  record_campaign_delivery: { ns: "work", title: "Link a WordPress change to a campaign deliverable", not: "Not for preparing the change (prepare_wordpress_change) or claiming it was published.", evidence: ["receipt"] },
  record_campaign_measurement: { ns: "measurement", title: "Bind a website deliverable to a predeclared plan", not: "Not after the deliverable's change was approved, and not for declaring a plan (operators declare plans).", evidence: ["receipt"] },
  read_campaign_outcome: { ns: "measurement", title: "Read a campaign deliverable's chain to its outcome", not: "Not as proof of lift or attribution; not for run state alone (read_campaign_runs).", evidence: ["none"] },
  read_marketing_campaigns: { ns: "work", title: "Read saved campaigns", not: "Not for run or delivery state (read_campaign_runs).", evidence: ["none"] },
  read_marketing_work: { ns: "work", title: "Read the marketing work queue and blockers", not: "Not for one campaign's full brief (read_marketing_campaigns).", evidence: ["none"] },
  read_connected_execution_targets: { ns: "web", title: "List connected repositories for page changes", not: "Not for WordPress sites (read_wordpress_content).", evidence: ["none"] },
  prepare_page_change: { ns: "web", title: "Prepare an exact repository page change", not: "Not for WordPress (prepare_wordpress_change) or initiatives that are not yet approved.", evidence: ["proposal"] },
  read_connected_executions: { ns: "web", title: "Read prepared and dispatched repository changes", not: "Not for WordPress changes or ad account actions.", evidence: ["none"] },
  wait_for_investigation: { ns: "work", title: "Schedule a revisit of an investigation", not: "Not for recording findings (record_investigation_note) or running anything in the background.", evidence: ["note"] },
  open_investigation: { ns: "work", title: "Open an investigation under the goal", not: "Not for changing the goal itself or for a simple one-off answer.", evidence: ["note"] },
  record_investigation_note: { ns: "work", title: "Append an investigation note", not: "Not for long-lived preferences (remember) or as proof that work was done.", evidence: ["note"] },
  read_investigation: { ns: "work", title: "Read one investigation's full notes", not: "Not for the overview of goal and linked work (read_objective_investigations).", evidence: ["none"] },
  read_objective_investigations: { ns: "work", title: "Read the goal, its linked work and investigations", not: "Not for one investigation's older notes (read_investigation).", evidence: ["none"] },
  remember: { ns: "work", title: "Save a durable business preference or lesson", not: "Not for investigation findings (record_investigation_note) or personal data.", evidence: ["note"] },
  forget_memory: { ns: "work", title: "Remove a saved business memory", not: "Not for rewriting investigation history, which is append-only.", evidence: ["note"] },
  cross_source_marketing_investigation: { ns: "research", title: "Investigate how a company markets across sources", not: "Not for the business's own metrics (read_search_performance, read_revenue).", slow: true, publicScope: true, evidence: ["observation"] },
  research_company: { ns: "research", title: "Research a company profile, loops, pricing and hiring", not: "Not for AI answer questions (ask_ai_assistants) or broad market questions (web_research).", cost: "metered", slow: true, publicScope: true, evidence: ["observation"] },
  ask_ai_assistants: { ns: "research", title: "Ask AI assistants what they say", not: "Not for web search results (search_web) or company profiles (research_company).", cost: "metered", slow: true, evidence: ["observation"] },
  web_research: { ns: "research", title: "Broad market research on the web", not: "Not for one known page (read_web_page) or one company (research_company).", cost: "metered", slow: true, publicScope: true, evidence: ["observation"] },
  find_research_capabilities: { ns: "research", title: "Find research capabilities for a need", not: "Not for running one (run_research).", evidence: ["none"] },
  run_research: { ns: "research", title: "Run one research capability", not: "Not before finding its id and inputs (find_research_capabilities).", cost: "metered", slow: true, evidence: ["observation"] },
  read_research_evidence: { ns: "research", title: "Read saved research evidence", not: "Not for running new research (run_research).", evidence: ["none"] },
  read_research_credit: { ns: "research", title: "Read research credit and prices", not: "Not for ad spend (read_ad_performance).", evidence: ["none"] },
  research_timeline: { ns: "research", title: "Timeline of saved research", not: "Not for new research.", evidence: ["none"] },
  read_decision_feedback: { ns: "work", title: "Read the owner's past decisions and reasons", not: "Not for pending drafts (read_proposals).", evidence: ["none"] },
  record_outcome_note: { ns: "measurement", title: "Save what changed after approved work", not: "Not for claiming cause, or for work before its outcome date.", evidence: ["note"] },
  list_connected_tools: { ns: "research", title: "List the team's connected tool servers", not: "Not for OpenRecord's own research capabilities (find_research_capabilities).", evidence: ["none"] },
  call_connected_tool: { ns: "research", title: "Call a read-only connected tool", not: "Not for any write; connected tools are read-only here.", evidence: ["observation"] },
  read_wordpress_content: { ns: "web", title: "Read WordPress posts and pages", not: "Not for public pages of other sites (read_web_page).", evidence: ["none"] },
  prepare_wordpress_change: { ns: "web", title: "Prepare an exact WordPress change for approval", not: "Not for repositories (prepare_page_change) or facts not in approved business truth.", evidence: ["proposal"] },
  read_reviews: { ns: "web", title: "Read Google Business Profile reviews", not: "Not for app store reviews (run_research).", evidence: ["none"] },
  read_ad_campaigns: { ns: "media", title: "Read Google Ads campaigns", not: "Not for performance numbers (read_ad_performance).", evidence: ["none"] },
  prepare_account_action: { ns: "media", title: "Prepare an ad or review-reply action for approval", not: "Not for website changes (prepare_wordpress_change, prepare_page_change).", evidence: ["proposal"] },
  propose_growth_opportunity: { ns: "strategy", title: "Propose a growth opportunity under the goal", not: "Not for a full campaign (record_campaign_draft) or an already rejected idea.", evidence: ["proposal"] },
  draft_source_action: { ns: "research", title: "Draft a source action hypothesis", not: "Not for proposing site changes.", evidence: ["proposal"] },
  prepare_client_report: { ns: "work", title: "Draft a private client report", not: "Not for sending or publishing a report.", evidence: ["draft"] },
  propose_question_set: { ns: "strategy", title: "Propose buyer questions to track", not: "Not for running checks (propose_check_run).", evidence: ["proposal"] },
  propose_acquisition_measurement: { ns: "measurement", title: "Propose an acquisition measurement", not: "Not for reading results (read_acquisition_overview).", evidence: ["proposal"] },
  read_growth_goal: { ns: "strategy", title: "Read the growth goal and its metric", not: "Not for linked work (read_objective_investigations).", evidence: ["none"] },
  read_growth_opportunities: { ns: "strategy", title: "Read growth opportunities and their state", not: "Not for campaigns (read_marketing_campaigns).", evidence: ["none"] },
  read_acquisition_overview: { ns: "research", title: "Read the AI acquisition overview", not: "Not for web search traffic (read_search_performance).", evidence: ["none"] },
  read_buyer_question_results: { ns: "research", title: "Read buyer question check results", not: "Not for proposing new questions (propose_question_set).", evidence: ["none"] },
  read_competitor_appearances: { ns: "research", title: "Read competitor appearances in AI answers", not: "Not for researching a competitor company (research_company).", evidence: ["none"] },
  read_acquisition_citations: { ns: "research", title: "Read sources AI answers cite", not: "Not for backlinks (run_research).", evidence: ["none"] },
  compare_acquisition_batches: { ns: "research", title: "Compare two AI answer batches", not: "Not as proof of a cause.", evidence: ["none"] },
  read_ai_referral_evidence: { ns: "measurement", title: "Read AI referral and crawler evidence", not: "Not as customers or revenue (read_revenue).", evidence: ["none"] },
  read_search_performance: { ns: "measurement", title: "Read search console performance", not: "Not for AI answers (read_acquisition_overview).", evidence: ["none"] },
  assess_web_page: { ns: "web", title: "Assess one web page", not: "Not for the whole site (audit_website).", publicScope: true, evidence: ["observation"] },
  read_web_page: { ns: "web", title: "Read one web page", not: "Not for several pages (read_web_pages) or a site map (map_website).", publicScope: true, evidence: ["observation"] },
  read_web_pages: { ns: "web", title: "Read several web pages", not: "Not for one page (read_web_page).", publicScope: true, evidence: ["observation"] },
  map_website: { ns: "web", title: "Map a website's pages", not: "Not for reading page content (read_web_pages).", slow: true, publicScope: true, evidence: ["observation"] },
  search_web: { ns: "web", title: "Search the web", not: "Not for AI assistant answers (ask_ai_assistants).", publicScope: true, evidence: ["observation"] },
  audit_website: { ns: "web", title: "Audit a whole website", not: "Not for one page (assess_web_page).", slow: true, publicScope: true, evidence: ["observation"] },
  read_competitors: { ns: "strategy", title: "Read saved competitors", not: "Not for new competitor research (research_company).", evidence: ["none"] },
  read_revenue: { ns: "measurement", title: "Read revenue", not: "Not for ad spend (read_ad_performance).", evidence: ["none"] },
  read_local_profile: { ns: "web", title: "Read the Google Business Profile", not: "Not for reviews (read_reviews).", evidence: ["none"] },
  read_ad_performance: { ns: "media", title: "Read ad performance and spend", not: "Not as incremental effect.", evidence: ["none"] },
  read_results: { ns: "measurement", title: "Read the results ledger", not: "Not for pending drafts (read_proposals).", evidence: ["none"] },
  measure_web_performance: { ns: "web", title: "Measure page speed", not: "Not for content quality (assess_web_page).", slow: true, publicScope: true, evidence: ["observation"] },
  read_business_truth: { ns: "strategy", title: "Read approved business facts", not: "Not for unapproved web claims.", evidence: ["none"] },
  discover_buyer_questions: { ns: "strategy", title: "Discover buyer questions", not: "Not for tracking them (propose_question_set).", evidence: ["none"] },
  read_open_issues: { ns: "research", title: "Read open representation issues", not: "Not for one issue in detail (read_issue).", evidence: ["none"] },
  read_representations: { ns: "research", title: "Read how the business is represented", not: "Not for approved facts (read_business_truth).", evidence: ["none"] },
  read_discovery_scopes: { ns: "research", title: "Read discovery scopes", not: "Not for running discovery.", evidence: ["none"] },
  read_observation: { ns: "research", title: "Read one saved observation", not: "Not for listing evidence (read_research_evidence).", evidence: ["none"] },
  read_issue: { ns: "research", title: "Read one representation issue", not: "Not for the issue list (read_open_issues).", evidence: ["none"] },
  read_record_outcomes: { ns: "measurement", title: "Read record outcomes", not: "Not for the results ledger (read_results).", evidence: ["none"] },
  read_proposals: { ns: "work", title: "Read saved drafts, proposals and decisions", not: "Not for past decision reasons alone (read_decision_feedback).", evidence: ["none"] },
  propose_check_run: { ns: "research", title: "Propose re-checking a buyer question", not: "Not for proposing new questions (propose_question_set).", evidence: ["proposal"] },
  diagnose_marketing_problems: { ns: "strategy", title: "Diagnose marketing problems from evidence", not: "Workflow only; not in ordinary turns.", evidence: ["none"] },
  propose_first_improvement: { ns: "strategy", title: "Propose the first improvement", not: "Workflow only; not in ordinary turns.", evidence: ["proposal"] },
}

/** Every agent tool only reads or writes OpenRecord rows; external effects happen only on operator approval routes. */
const sideEffectOf = (spec: AgentToolSpec) => spec.effect === "read" ? "none" as const : "internal_write" as const

export const manifestFor = (spec: AgentToolSpec): CapabilityManifest => {
  const name = spec.declaration.name
  const meta = META[name]
  if (!meta) throw new Error(`No capability metadata for ${name}`)
  return Schema.decodeUnknownSync(CapabilityManifest)({
    id: name, version: 1, namespace: meta.ns, title: meta.title,
    whenToUse: spec.declaration.description, whenNotToUse: meta.not,
    inputSchema: spec.declaration.parametersJsonSchema, outputSchema: null,
    sideEffect: sideEffectOf(spec),
    permission: { role: "member", requiresApproval: spec.effect === "propose" },
    idempotency: spec.replay === "safe" ? "safe_read" : "request_key",
    costClass: meta.cost ?? "free", latencyClass: meta.slow ? "slow" : "fast", tenantScope: meta.publicScope ? "public" : "business",
    evidenceProduced: meta.evidence ?? ["none"], workflowOnly: spec.scope === "workflow",
    evalCases: ROUTING_CASES.flatMap(c => c.expect.includes(name) ? [{ id: c.id, task: c.task, expectSelected: true }]
      : (c.avoid ?? []).includes(name) ? [{ id: c.id, task: c.task, expectSelected: false }] : []),
  })
}

export const CAPABILITY_MANIFESTS: ReadonlyArray<CapabilityManifest> = AGENT_TOOL_SPECS.map(manifestFor)
export const METADATA_NAMES = Object.keys(META)
