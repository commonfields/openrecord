import { SqlClient } from "@effect/sql"
import { BusinessRepository } from "@openrecord/db"
import { CampaignBrief, type CampaignTask } from "@openrecord/contracts"
import { Data, Effect, JSONSchema, Schema } from "effect"
import { AgentNotInScope } from "./agent-tool-errors.js"
import type { ToolContext, ToolDeclaration } from "./agent-registry.js"

export class CampaignRunRefused extends Data.TaggedError("CampaignRunRefused")<{ reason: string }> {}
const refuse = (reason: string) => Effect.fail(new CampaignRunRefused({ reason }))
const CampaignInput = Schema.Struct({ campaignId: Schema.UUID })
const LinkInput = Schema.Struct({ runId: Schema.UUID, taskId: Schema.UUID, wordpressChangeId: Schema.UUID })
export const CAMPAIGN_RUN_LIMITS = { maxDeliverables: 30, externalCalls: 0, maxRunsReturned: 5 } as const
export interface CampaignDelivery {
  task_id: string; wordpress_change_id: string; status: string
  live_check: { observed?: boolean | null } | null
}

/** Status comes from adapter records, not model-provided success flags. */
export function campaignRunReport(snapshot: CampaignBrief, currentRevision: number, runRevision: number, deliveries: readonly CampaignDelivery[]) {
  const stale = currentRevision !== runRevision
  const missing = (["goal", "audience", "offer", "message", "hypothesis", "metric", "baseline", "target", "owner", "launchDate", "reviewDate"] as const)
    .filter(key => !snapshot[key].trim())
  const tasks = snapshot.tasks.map(task => {
    const receipt = deliveries.find(d => d.task_id === task.id)
    const state = !task.note.trim() ? "NEEDS_DRAFT"
      : !receipt ? task.channel === "WEBSITE" ? "DRAFT_READY" : "HUMAN_HANDOFF"
      : receipt.status === "PROPOSED" ? "WAITING_FOR_APPROVAL"
      : receipt.status === "PUBLISHING" ? "VERIFYING"
      : receipt.status === "PUBLISHED" ? receipt.live_check?.observed === true ? "DELIVERY_OBSERVED" : "VERIFYING"
      : "BLOCKED"
    return { taskId: task.id, title: task.title, channel: task.channel, state,
      wordpressChangeId: receipt?.wordpress_change_id ?? null,
      nextMove: state === "DRAFT_READY" ? "Read connected targets and prepare an exact change for human approval. Draft readiness is not content-quality approval."
        : state === "HUMAN_HANDOFF" ? "No automated delivery adapter in this playbook. Give the owner the draft and channel handoff."
        : state === "NEEDS_DRAFT" ? "Prepare concrete draft content, then save an updated campaign."
        : state === "WAITING_FOR_APPROVAL" ? "The operator must review the exact linked WordPress change."
        : state === "VERIFYING" ? "Read the WordPress adapter result; publication alone does not prove the public page changed."
        : state === "DELIVERY_OBSERVED" ? "The adapter observed this linked change live; campaign impact remains unmeasured."
        : "The linked change failed, was rejected or undone. Investigate; do not replay automatically.",
    }
  })
  const status = stale ? "STALE" : missing.length || !tasks.length || tasks.some(t => ["NEEDS_DRAFT", "HUMAN_HANDOFF", "BLOCKED"].includes(t.state)) ? "BLOCKED"
    : tasks.every(t => t.state === "DELIVERY_OBSERVED") ? "DELIVERY_OBSERVED"
    : tasks.some(t => t.state === "WAITING_FOR_APPROVAL") ? "WAITING_FOR_APPROVAL"
    : tasks.some(t => t.state === "VERIFYING") ? "VERIFYING" : "WAITING_FOR_REVIEW"
  return { status, stale, missing, tasks, limits: CAMPAIGN_RUN_LIMITS,
    note: "Pinned internal preparation playbook v1, inspired by pstack's plan/review/verify discipline; no remote skill loading. No external call, publication or spending is performed by these run tools. Linked-change receipts describe adapter outcomes, not content alignment, whole-campaign completion or causal business impact. Human-attested task completion is not adapter verification. Resume by reading this run and current adapter state; never replay a publication from chat history." }
}

type CampaignScope = Pick<ToolContext, "accountId" | "businessId">
const scope = (ctx: CampaignScope) => Effect.gen(function*() {
  if (!(yield* (yield* BusinessRepository).getScoped(ctx.accountId, ctx.businessId))) return yield* Effect.fail(new AgentNotInScope())
})
export const readCampaignRuns = (ctx: CampaignScope, campaignId: string, limit: 1 | 5 = 5) => Effect.gen(function*() {
  yield* scope(ctx)
  const sql = yield* SqlClient.SqlClient
  const campaigns = yield* sql`SELECT revision FROM marketing_campaigns WHERE business_id=${ctx.businessId} AND id=${campaignId}`
  if (!campaigns[0]) return yield* Effect.fail(new AgentNotInScope())
  const runs = yield* sql`SELECT id,campaign_revision,snapshot,playbook_version,created_at,cancelled_at FROM marketing_campaign_runs
    WHERE business_id=${ctx.businessId} AND campaign_id=${campaignId} ORDER BY campaign_revision DESC LIMIT ${limit}`
  const reports = []
  for (const run of runs) {
    const brief = yield* Schema.decodeUnknown(CampaignBrief)(run["snapshot"])
    const deliveries = yield* sql<CampaignDelivery>`SELECT d.task_id,d.wordpress_change_id,w.status,w.live_check
      FROM marketing_campaign_deliveries d JOIN wordpress_changes w ON w.id=d.wordpress_change_id AND w.business_id=d.business_id
      WHERE d.business_id=${ctx.businessId} AND d.run_id=${run["id"]}`
    const report = campaignRunReport(brief, Number(campaigns[0]["revision"]), Number(run["campaign_revision"]), deliveries)
    reports.push({ id: run["id"], campaignRevision: run["campaign_revision"], playbookVersion: run["playbook_version"], createdAt: run["created_at"],
      ...report, status: run["cancelled_at"] ? "CANCELLED" : report.status })
  }
  return { summary: `${reports.length} durable campaign runs read`, citations: [], data: { campaignId, currentRevision: Number(campaigns[0]["revision"]), runs: reports } }
})

export const campaignRunDeclarations: ReadonlyArray<ToolDeclaration> = [
  { name: "record_campaign_run", description: "Start or resume the pinned, bounded preparation playbook for a saved campaign. Persists its exact revision and returns per-deliverable blockers and next moves. Same campaign revision reuses the run. Does not call providers, approve, spend, publish or mark a task done. Read before preparing any external change; stop on STALE and start a run of the current revision.", parametersJsonSchema: JSONSchema.make(CampaignInput) },
  { name: "read_campaign_runs", description: "Read durable campaign runs and recompute current status from scoped WordPress adapter records. Detects changed campaign revisions, pending approvals, failures and observed live changes. A linked receipt is not proof the entire campaign shipped or caused results.", parametersJsonSchema: JSONSchema.make(CampaignInput) },
  { name: "record_campaign_delivery", description: "Link one existing WordPress change to a WEBSITE deliverable of a current campaign run. Read the change and confirm the target/content match first. The server verifies business and task scope; it never approves, publishes or trusts an agent's success claim. Repeating the same link is safe; replacing a link or linking stale runs is refused.", parametersJsonSchema: JSONSchema.make(LinkInput) },
]

export const dispatchCampaignRun = (ctx: ToolContext, name: string, raw: unknown) => Effect.gen(function*() {
  yield* scope(ctx)
  const sql = yield* SqlClient.SqlClient
  if (name === "read_campaign_runs") {
    const input = yield* Schema.decodeUnknown(CampaignInput, { onExcessProperty: "error" })(raw)
    return yield* readCampaignRuns(ctx, input.campaignId)
  }
  if (name === "record_campaign_run") {
    const input = yield* Schema.decodeUnknown(CampaignInput, { onExcessProperty: "error" })(raw)
    yield* sql.withTransaction(Effect.gen(function*() {
      const campaign = (yield* sql`SELECT id,revision,brief FROM marketing_campaigns WHERE business_id=${ctx.businessId} AND id=${input.campaignId} FOR UPDATE`)[0]
      if (!campaign) return yield* Effect.fail(new AgentNotInScope())
      const brief = yield* Schema.decodeUnknown(CampaignBrief)(campaign["brief"])
      if (brief.tasks.length > CAMPAIGN_RUN_LIMITS.maxDeliverables) return yield* refuse("TooManyDeliverables")
      if (brief.status === "CLOSED") return yield* refuse("CampaignClosed")
      yield* sql`INSERT INTO marketing_campaign_runs(business_id,campaign_id,campaign_revision,created_by_user_id,snapshot)
        VALUES (${ctx.businessId},${input.campaignId},${campaign["revision"]},${ctx.userId},${JSON.stringify(brief)}::jsonb)
        ON CONFLICT (business_id,campaign_id,campaign_revision) DO NOTHING`
    }))
    return yield* readCampaignRuns(ctx, input.campaignId)
  }
  if (name !== "record_campaign_delivery") return yield* refuse("UnknownCampaignRunTool")
  const input = yield* Schema.decodeUnknown(LinkInput, { onExcessProperty: "error" })(raw)
  const campaignId = yield* sql.withTransaction(Effect.gen(function*() {
    const run = (yield* sql`SELECT r.campaign_id,r.campaign_revision,r.snapshot,r.cancelled_at,c.revision FROM marketing_campaign_runs r
      JOIN marketing_campaigns c ON c.id=r.campaign_id AND c.business_id=r.business_id
      WHERE r.id=${input.runId} AND r.business_id=${ctx.businessId} FOR UPDATE OF c,r`)[0]
    if (!run) return yield* Effect.fail(new AgentNotInScope())
    if (run["cancelled_at"]) return yield* refuse("CampaignRunCancelled")
    if (Number(run["revision"]) !== Number(run["campaign_revision"])) return yield* refuse("StaleCampaignRun")
    const brief = yield* Schema.decodeUnknown(CampaignBrief)(run["snapshot"])
    const task: CampaignTask | undefined = brief.tasks.find(t => t.id === input.taskId)
    if (!task || task.channel !== "WEBSITE") return yield* refuse("UnsupportedDeliverable")
    const change = (yield* sql`SELECT id FROM wordpress_changes WHERE id=${input.wordpressChangeId} AND business_id=${ctx.businessId} AND account_id=${ctx.accountId}`)[0]
    if (!change) return yield* Effect.fail(new AgentNotInScope())
    const links = yield* sql`SELECT task_id,wordpress_change_id FROM marketing_campaign_deliveries WHERE run_id=${input.runId}
      AND (task_id=${input.taskId} OR wordpress_change_id=${input.wordpressChangeId})`
    if (links.some(l => l["task_id"] !== input.taskId || l["wordpress_change_id"] !== input.wordpressChangeId)) return yield* refuse("DeliveryAlreadyLinked")
    yield* sql`INSERT INTO marketing_campaign_deliveries(business_id,run_id,task_id,wordpress_change_id,linked_by_user_id)
      VALUES (${ctx.businessId},${input.runId},${input.taskId},${input.wordpressChangeId},${ctx.userId}) ON CONFLICT (run_id,task_id) DO NOTHING`
    return String(run["campaign_id"])
  }))
  return yield* readCampaignRuns(ctx, campaignId)
})
