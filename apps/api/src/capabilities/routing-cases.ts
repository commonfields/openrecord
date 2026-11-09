/**
 * Routing eval cases for M1.5. Each is one step as a person or the agent would phrase it.
 * expect: capabilities that must be among the selected schemas. avoid: near-misses that must not be.
 * A capability named by no case is disabled by default in the router.
 * These grade selection only; whole-task outcomes are graded on persisted state elsewhere.
 */
export interface RoutingCaseDef { readonly id: string; readonly task: string; readonly expect: ReadonlyArray<string>; readonly avoid?: ReadonlyArray<string> }

export const ROUTING_CASES: ReadonlyArray<RoutingCaseDef> = [
  { id: "campaign-new", task: "Create a campaign to get more trial signups from small agencies", expect: ["record_campaign_draft"] },
  { id: "campaign-edit", task: "Change the audience of the existing onboarding campaign draft to ops teams", expect: ["record_campaign_revision"] },
  { id: "campaign-run", task: "Start the campaign run for the approved campaign and show the next moves", expect: ["record_campaign_run"] },
  { id: "campaign-status", task: "What is the delivery status of the campaign runs?", expect: ["read_campaign_runs"] },
  { id: "campaign-link-delivery", task: "Link the WordPress change to the website deliverable of the campaign run", expect: ["record_campaign_delivery"] },
  { id: "campaign-list", task: "Show me our saved campaigns", expect: ["read_marketing_campaigns"] },
  { id: "work-queue", task: "What marketing work is blocked and what should we do next?", expect: ["read_marketing_work"] },
  { id: "investigation-open", task: "Open an investigation into why qualified leads are falling", expect: ["open_investigation"] },
  { id: "investigation-note", task: "Record a note on the investigation that follow-up emails are slow", expect: ["record_investigation_note"] },
  { id: "investigation-read", task: "Read the older notes of the lead quality investigation", expect: ["read_investigation"] },
  { id: "investigation-wait", task: "Revisit this investigation after the reporting period ends next week", expect: ["wait_for_investigation"] },
  { id: "objective-work", task: "What work have we already done toward our goal?", expect: ["read_objective_investigations"] },
  { id: "memory-save", task: "Remember that we never offer discounts", expect: ["remember"] },
  { id: "memory-forget", task: "Forget the saved memory about discounts", expect: ["forget_memory"] },
  { id: "company-research", task: "Research the competitor company's pricing and hiring", expect: ["research_company"] },
  { id: "ai-answers", task: "What do AI assistants say about us when buyers ask for recommendations?", expect: ["ask_ai_assistants"] },
  { id: "market-research", task: "Do broad market research on demand for wedding DJ booking software", expect: ["web_research"] },
  { id: "research-find", task: "Find a research capability for backlinks of a domain", expect: ["find_research_capabilities"] },
  { id: "research-evidence", task: "What research evidence have we already saved?", expect: ["read_research_evidence"] },
  { id: "research-credit", task: "How much research credit is left and what do calls cost?", expect: ["read_research_credit"] },
  { id: "decision-feedback", task: "Which ideas did the owner reject before and why?", expect: ["read_decision_feedback"] },
  { id: "outcome-note", task: "Record the outcome of the approved FAQ change after its outcome date", expect: ["record_outcome_note"] },
  { id: "wordpress-read", task: "Read the pages on our WordPress site", expect: ["read_wordpress_content"] },
  { id: "wordpress-change", task: "Prepare a WordPress change to the homepage title for approval", expect: ["prepare_wordpress_change"], avoid: ["prepare_page_change"] },
  { id: "repo-change", task: "Prepare a page change in the connected repository to fix the meta description", expect: ["prepare_page_change"] },
  { id: "reviews", task: "Read our unanswered Google reviews", expect: ["read_reviews"] },
  { id: "review-reply", task: "Prepare a reply to the two-star Google review for approval", expect: ["prepare_account_action"] },
  { id: "ads-budget", task: "Prepare raising the daily budget of the Google Ads search campaign", expect: ["prepare_account_action"] },
  { id: "ads-performance", task: "How did our ads perform and what did we spend last month?", expect: ["read_ad_performance"] },
  { id: "growth-opportunity", task: "Propose a growth opportunity to fix the pricing page friction", expect: ["propose_growth_opportunity"] },
  { id: "goal", task: "What is our growth goal and its metric?", expect: ["read_growth_goal"] },
  { id: "search-performance", task: "How is our Google search traffic and click performance?", expect: ["read_search_performance"] },
  { id: "revenue", task: "What was our revenue this month?", expect: ["read_revenue"] },
  { id: "page-read", task: "Read this web page https://example.test/pricing", expect: ["read_web_page"] },
  { id: "site-audit", task: "Audit our whole website for SEO problems", expect: ["audit_website"] },
  { id: "page-speed", task: "Measure the page speed of our homepage", expect: ["measure_web_performance"] },
  { id: "web-search", task: "Search the web for reviews of our product", expect: ["search_web"] },
  { id: "proposals", task: "What drafts and proposals are waiting for approval?", expect: ["read_proposals"] },
  { id: "results", task: "What worked? Show the results ledger of approved work", expect: ["read_results"] },
  { id: "business-truth", task: "What are the approved facts about our business?", expect: ["read_business_truth"] },
  { id: "ai-referrals", task: "How many visits came from AI referrals and crawlers?", expect: ["read_ai_referral_evidence"] },
  { id: "client-report", task: "Draft a private client report for this month", expect: ["prepare_client_report"] },
  { id: "competitor-appearances", task: "Where do competitors appear in AI answers instead of us?", expect: ["read_competitor_appearances"] },
]
