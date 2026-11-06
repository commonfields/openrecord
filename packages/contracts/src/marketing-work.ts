import type { Campaign } from "./campaigns.js"

export interface MarketingWorkItem {
  key: string
  priority: number
  title: string
  kind: "AGENT_WORK" | "HUMAN_DECISION" | "CAPABILITY_GAP"
  detail: string
  tools: string[]
}
export interface MarketingRunState {
  status: string
  tasks: readonly { taskId: string; state: string }[]
}

/** Missing planning inputs are not a marketing score or proof of readiness.
 * Delivery states must come from the scoped adapter report, never model input. */
export function marketingCampaignWork(campaign: Campaign, today: string, run?: MarketingRunState) {
  const c = campaign.brief
  const items: MarketingWorkItem[] = []
  const add = (key: string, priority: number, title: string, kind: MarketingWorkItem["kind"], detail: string, tools: string[] = []) =>
    items.push({ key, priority, title, kind, detail, tools })
  const editable = c.status === "DRAFT"
  const draftKind = editable ? "AGENT_WORK" : "HUMAN_DECISION"
  const editTools = editable ? ["record_campaign_revision"] : []

  if (c.status === "CLOSED") {
    return { campaignId: campaign.id, revision: campaign.revision, title: c.title, status: c.status, items,
      learning: c.learning ? { learning: c.learning, nextMove: c.nextMove, result: c.result, assurance: "OPERATOR_RECORDED" as const } : null }
  }
  if ((c.status === "ACTIVE" || c.status === "REVIEW") && (!c.reviewDate || c.reviewDate <= today)) {
    add("review", 10, "Review outcomes against the original goal", "AGENT_WORK",
      "Read the saved criteria and source data. Recommend keep/change/stop/inconclusive; the person records the decision. A review date is not an automated schedule.",
      ["read_campaign_runs", "read_revenue", "read_search_performance", "read_ad_performance"])
  }
  const missingBrief = (["goal", "audience", "offer", "message", "hypothesis"] as const).filter(key => !c[key].trim())
  if (missingBrief.length) add("brief", 20, "Complete the customer and offer brief", draftKind,
    `Missing: ${missingBrief.join(", ")}. Research before drafting; mark assumptions, preserve existing decisions and ask only for essential unknowns.`, editTools)

  const d = c.distribution
  const missingDistribution = !d ? ["primary channel", "channel rationale", "distribution motion", "funnel stage", "destination", "cadence", "budget"]
    : [!d.primaryChannel.trim() && "primary channel", !d.rationale.trim() && "channel rationale", d.motion === "UNSPECIFIED" && "distribution motion",
      d.funnelStage === "UNSPECIFIED" && "funnel stage", !d.destination.trim() && "destination", !d.cadence.trim() && "cadence", !d.budget.trim() && "budget"].filter(Boolean)
  if (missingDistribution.length) add("distribution", 30, "Plan how the offer reaches the audience", draftKind,
    `Missing: ${missingDistribution.join(", ")}. Pick one primary path, not every channel. Budget is a proposal, never spending authorization; record no paid spend where appropriate.`, editTools)

  const missingMeasurement: string[] = (["metric", "baseline", "target", "reviewDate"] as const).filter(key => !c[key].trim())
  if (!d?.trackingPlan.trim()) missingMeasurement.push("trackingPlan")
  if (!d?.conversionEvent.trim()) missingMeasurement.push("conversionEvent")
  if (missingMeasurement.length) add("measurement-plan", 35, "Define the outcome and tracking before launch", draftKind,
    `Missing: ${missingMeasurement.join(", ")}. Do not invent a baseline, customer counts or verified tracking. Suggestions and unavailable evidence must be labelled.`, editTools)

  const undrafted = c.tasks.filter(t => !t.note.trim() && t.status !== "DONE")
  if (!c.tasks.length || undrafted.length) add("drafts", 40, "Prepare concrete deliverables", draftKind,
    !c.tasks.length ? "Add a small set of channel-specific drafts, not generic task titles."
      : `${undrafted.length} unfinished deliverables have no draft or handoff. Save real copy using existing task IDs.`, editTools)
  if (!c.owner.trim() || !c.launchDate || c.tasks.some(t => !t.owner.trim() || !t.due)) {
    add("coordination", 50, "Agree ownership and timing", "HUMAN_DECISION",
      "Owner labels and dates are planning context, not member assignments, notifications or scheduled execution. Propose a practical handoff; do not claim someone was assigned.")
  }

  if (run?.status === "CANCELLED") add("delivery", 5, "Respect the stopped campaign run", "HUMAN_DECISION", "Do not restart, link proposals or replay external work without a new explicit instruction.")
  else if (run?.status === "WAITING_FOR_APPROVAL" || run?.tasks.some(t => t.state === "WAITING_FOR_APPROVAL")) add("delivery", 55, "Review the prepared external change", "HUMAN_DECISION",
    "The operator must approve the exact proposal. Preparing it is not publication.", ["read_campaign_runs", "read_proposals"])
  else if (run?.status === "VERIFYING" || run?.tasks.some(t => t.state === "VERIFYING")) add("delivery", 55, "Check the existing delivery receipt", "AGENT_WORK",
    "Read the adapter state. Do not create a duplicate change or treat publication as live verification.", ["read_campaign_runs"])
  else if (run?.tasks.some(t => t.state === "BLOCKED")) add("delivery", 55, "Investigate the failed or rejected delivery", "HUMAN_DECISION",
    "Read the adapter receipt and explain the failure. Never automatically replay a failed, rejected or undone change.", ["read_campaign_runs"])
  else if (run?.status === "STALE" && run.tasks.some(t => t.state === "DELIVERY_OBSERVED")) add("delivery", 55, "Reconcile delivered work with the changed brief", "HUMAN_DECISION",
    "An earlier revision has observed delivery. Review its exact content and the new brief; do not prepare a duplicate publication.", ["read_campaign_runs"])
  else if (run?.status !== "DELIVERY_OBSERVED" && c.tasks.length) add("delivery", 60, "Advance the next supported delivery", "AGENT_WORK",
    "Read current runs and connected targets first. Start a revision-pinned preparation run if needed; prepare an exact supported change for approval and link its receipt. A draft does not prove quality or delivery.",
    ["read_campaign_runs", "record_campaign_run", "read_wordpress_content", "prepare_wordpress_change", "record_campaign_delivery"])

  if (c.tasks.some(t => t.channel !== "WEBSITE" && t.status !== "DONE")) add("distribution-adapter", 70, "Make unsupported delivery an explicit handoff", "CAPABILITY_GAP",
    "The campaign receipt playbook currently links WordPress changes only. Other supported account actions may be proposed separately; email/social sending and campaign-bound receipts are not implemented. Prepare usable copy, identify who sends it and say what remains manual.")
  add("measurement-evidence", 80, "Connect campaign-specific outcome evidence", "CAPABILITY_GAP",
    "Campaign result text is operator-recorded. Campaign-bound verified instrumentation, measured outcome snapshots and automatic review scheduling are not implemented. Read available source data with its window and limitations; do not claim campaign attribution.")
  items.sort((a, b) => a.priority - b.priority || a.key.localeCompare(b.key))
  return { campaignId: campaign.id, revision: campaign.revision, title: c.title, status: c.status, items, learning: null }
}
