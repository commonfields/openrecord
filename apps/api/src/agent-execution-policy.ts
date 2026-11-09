import type { ModelInput } from "./agent-model.js"
import type { ToolDeclaration } from "./agent-registry.js"

export const EXECUTION_LIMITS = { requestBytes: 128000, runMs: 480000, answerReserveMs: 75000, modelCallMs: 60000, synthesisBytes: 24000 } as const
export const modelRequestBytes = (input: Pick<ModelInput, "contents" | "system" | "tools">) =>
  Buffer.byteLength(JSON.stringify({ contents: input.contents, system: input.system, tools: input.tools }), "utf8")

/** Narrow explicit commands only; ordinary conversation retains its capabilities. */
export function commandTools(message: string, tools: readonly ToolDeclaration[]) {
  const command = /^\/(marketing|campaign(?:-run|-status|-review)?|status|report)\b/i.exec(message.trim())?.[1]?.toLowerCase()
  if (!command) return tools
  const core = new Set(["read_business_truth", "read_growth_goal", "read_marketing_work", "read_marketing_campaigns", "read_campaign_runs", "read_proposals", "read_results", "read_record_outcomes", "read_objective_investigations"])
  const research = new Set(["research_company", "read_web_page", "read_web_pages", "search_web", "cross_source_marketing_investigation", "read_search_performance", "read_ad_performance", "read_revenue", "read_ai_referral_evidence"])
  const delivery = new Set(["read_wordpress_content", "prepare_wordpress_change", "record_campaign_delivery", "read_connected_execution_targets", "prepare_page_change", "read_connected_executions", "read_growth_opportunities", "read_ad_campaigns", "read_reviews", "prepare_account_action"])
  return tools.filter(tool => core.has(tool.name)
    || (command === "marketing" && (research.has(tool.name) || delivery.has(tool.name) || ["record_campaign_draft", "record_campaign_revision", "record_campaign_run", "record_campaign_measurement", "read_campaign_outcome", "read_investigation", "open_investigation", "record_investigation_note"].includes(tool.name)))
    || (command === "campaign" && (research.has(tool.name) || ["record_campaign_draft", "record_campaign_revision"].includes(tool.name)))
    || (command === "campaign-run" && (delivery.has(tool.name) || ["record_campaign_run", "record_campaign_revision", "record_campaign_measurement", "read_campaign_outcome"].includes(tool.name)))
    || ((command === "campaign-review" || command === "report") && (research.has(tool.name) || tool.name === "read_campaign_outcome")))
}
