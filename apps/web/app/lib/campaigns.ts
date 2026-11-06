import type { Campaign } from "@openrecord/contracts"
import { api } from "@/lib/api"

export const Campaigns = {
  list: (businessId: string) => api<{ campaigns: Campaign[] }>(`/api/businesses/${encodeURIComponent(businessId)}/campaigns`),
}
export const campaignsKey = (businessId: string) => `campaigns:${businessId}`

/** The stages a saved plan records. A stage is what the plan says, not proof
 * that anything was delivered; delivery shows per deliverable. */
export const CAMPAIGN_STAGES = [
  { status: "DRAFT", label: "Plan", hint: "The agent drafts the goal, audience, message and deliverables." },
  { status: "ACTIVE", label: "Do the work", hint: "Deliverables are prepared, approved and carried out." },
  { status: "REVIEW", label: "Check results", hint: "Results are compared with the baseline and target." },
  { status: "CLOSED", label: "Decide", hint: "Keep, change or stop, and what to try next." },
] as const

export const campaignStage = (c: Campaign) => Math.max(0, CAMPAIGN_STAGES.findIndex(s => s.status === c.brief.status))

export function deliverableCounts(c: Campaign) {
  const tasks = c.brief.tasks
  return { total: tasks.length, done: tasks.filter(t => t.status === "DONE").length, blocked: tasks.filter(t => t.status === "BLOCKED").length }
}

/** One plain line about a campaign's deliverables. */
export function deliverableSummary(c: Campaign) {
  const { total, done, blocked } = deliverableCounts(c)
  if (!total) return "No deliverables yet"
  const base = `${done} of ${total} ${total === 1 ? "deliverable" : "deliverables"} recorded done`
  return blocked ? `${base}, ${blocked} blocked` : base
}

/** What needs to happen next, highest priority first. */
export function campaignAttention(campaign: Campaign) {
  const b = campaign.brief
  if (b.status === "CLOSED") return { label: "Decided", tone: "done" as const, next: b.nextMove || "Discuss the next experiment with the agent." }
  if (b.tasks.some(t => t.status === "BLOCKED")) return { label: "Blocked", tone: "blocked" as const, next: "Ask the agent to explain the blocked deliverables." }
  if (b.status === "REVIEW") return { label: "Check results", tone: "active" as const, next: "Review the available evidence with the agent." }
  if (b.status === "ACTIVE") return { label: "Doing the work", tone: "active" as const, next: "Check delivery evidence and what remains to be done." }
  return { label: "Planning", tone: "draft" as const, next: "Review the plan and ask the agent to prepare the next step." }
}
