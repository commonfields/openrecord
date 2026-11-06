import { Schema } from "effect"

const Text = (max: number) => Schema.String.pipe(Schema.maxLength(max))
const Required = (max: number) => Text(max).pipe(Schema.filter(s => s.trim().length > 0))
/** Planning context only: a budget here never authorizes spend or verifies tracking. */
export const CampaignDistribution = Schema.Struct({
  primaryChannel: Text(200), rationale: Text(1000),
  motion: Schema.Literal("UNSPECIFIED", "OWNED", "EARNED", "PAID", "PRODUCT_LED", "HYBRID"),
  funnelStage: Schema.Literal("UNSPECIFIED", "AWARENESS", "CONSIDERATION", "CONVERSION", "ACTIVATION", "RETENTION", "EXPANSION", "REFERRAL"),
  destination: Text(1000), cadence: Text(500), budget: Text(500),
  trackingPlan: Text(2000), conversionEvent: Text(500),
})
export type CampaignDistribution = typeof CampaignDistribution.Type
export const CampaignTask = Schema.Struct({
  id: Schema.UUID, title: Required(300), owner: Text(200), due: Text(10),
  channel: Schema.Literal("WEBSITE", "EMAIL", "PAID", "SOCIAL", "OTHER"),
  status: Schema.Literal("TODO", "IN_PROGRESS", "BLOCKED", "DONE"),
  note: Text(2000),
})
export const CampaignBrief = Schema.Struct({
  title: Required(200), goal: Text(2000), audience: Text(2000), offer: Text(2000),
  message: Text(2000), hypothesis: Text(2000), metric: Text(500), baseline: Text(500), target: Text(500),
  owner: Text(200), launchDate: Text(10), reviewDate: Text(10),
  status: Schema.Literal("DRAFT", "ACTIVE", "REVIEW", "CLOSED"),
  tasks: Schema.Array(CampaignTask).pipe(Schema.maxItems(100)),
  result: Text(4000), decision: Schema.Literal("UNDECIDED", "KEEP", "CHANGE", "STOP", "INCONCLUSIVE"),
  learning: Text(4000), nextMove: Text(2000),
  distribution: Schema.optional(CampaignDistribution),
})
export type CampaignBrief = typeof CampaignBrief.Type
export type CampaignTask = typeof CampaignTask.Type
export interface Campaign { id: string; revision: number; brief: CampaignBrief; updated_at: string; created_by_actor?: "OPERATOR" | "ASSISTANT"; last_edited_by_actor?: "OPERATOR" | "ASSISTANT" }

/** Readiness is a planning check, never proof of publication or attribution. */
export function campaignBlockers(c: CampaignBrief): string[] {
  return [
    ...([ [c.goal, "Define a goal"], [c.audience, "Choose an audience"], [c.offer, "Define the offer"],
      [c.message, "Agree the message"], [c.hypothesis, "Write a hypothesis"], [c.metric, "Define the success metric and data source"],
      [c.baseline, "Record a baseline or explain why unavailable"], [c.target, "Set a target"], [c.owner, "Assign a campaign owner"],
      [c.launchDate, "Set a launch date"], [c.reviewDate, "Schedule a review"] ] as const).filter(([value]) => !value.trim()).map(([, label]) => label),
    ...(c.tasks.length === 0 ? ["Add launch deliverables"] : []),
    ...c.tasks.filter(t => !t.owner.trim() || !t.due).map(t => `${t.title}: assign an owner and due date`),
    ...c.tasks.filter(t => t.status !== "DONE").map(t => `${t.title}: ${t.status === "BLOCKED" ? "blocked" : "not complete"}`),
  ]
}
export function campaignTransitionError(c: CampaignBrief, checkLaunch = true): string | null {
  const validDate = (s: string) => !s || (/^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s)
  if (!validDate(c.launchDate)) return "Invalid launch date"
  if (!validDate(c.reviewDate)) return "Invalid review date"
  if (c.tasks.some(t => !validDate(t.due))) return "Invalid deliverable date"
  if (c.reviewDate && c.launchDate && c.reviewDate < c.launchDate) return "Review must follow launch"
  if (new Set(c.tasks.map(t => t.id)).size !== c.tasks.length) return "Duplicate deliverable IDs"
  if (checkLaunch && c.status === "ACTIVE" && campaignBlockers(c).length) return "Complete launch readiness before recording the campaign as active"
  if (c.status === "CLOSED" && (c.decision === "UNDECIDED" || !c.result.trim() || !c.learning.trim() || !c.nextMove.trim())) return "Record results, a decision, learning and the next move before closing"
  return null
}
