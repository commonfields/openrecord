import { createHash, randomUUID } from "node:crypto"
import { SqlClient } from "@effect/sql"
import { BusinessRepository } from "@openrecord/db"
import { CampaignBrief, CampaignDistribution, campaignTransitionError } from "@openrecord/contracts"
import { Data, Effect, JSONSchema, Schema } from "effect"
import { AgentNotInScope } from "./agent-tool-errors.js"
import type { ToolContext, ToolDeclaration } from "./agent-registry.js"

export class CampaignRevisionRefused extends Data.TaggedError("CampaignRevisionRefused")<{ reason: string }> {}
const refuse = (reason: string) => Effect.fail(new CampaignRevisionRefused({ reason }))
const Text = (max: number) => Schema.String.pipe(Schema.maxLength(max))
const Required = (max: number) => Text(max).pipe(Schema.filter(s => s.trim().length > 0))
const taskFields = {
  title: Schema.optional(Required(200)), owner: Schema.optional(Text(200)), due: Schema.optional(Text(10)), content: Schema.optional(Text(2000)),
}
const Changes = Schema.Struct({
  title: Schema.optional(CampaignBrief.fields.title), goal: Schema.optional(Text(2000)), audience: Schema.optional(Text(2000)), offer: Schema.optional(Text(2000)),
  message: Schema.optional(Text(2000)), hypothesis: Schema.optional(Text(2000)), metric: Schema.optional(Text(500)), baseline: Schema.optional(Text(500)),
  target: Schema.optional(Text(500)), owner: Schema.optional(Text(200)), launchDate: Schema.optional(Text(10)), reviewDate: Schema.optional(Text(10)),
  distribution: Schema.optional(CampaignDistribution),
})
export const CampaignRevisionInput = Schema.Struct({
  campaignId: Schema.UUID, expectedRevision: Schema.Int.pipe(Schema.greaterThanOrEqualTo(1)), reason: Required(1000),
  changes: Changes,
  taskUpdates: Schema.optionalWith(Schema.Array(Schema.Struct({ taskId: Schema.UUID, ...taskFields })).pipe(Schema.maxItems(30)), { default: () => [] }),
  addDeliverables: Schema.optionalWith(Schema.Array(Schema.Struct({ title: Required(200), channel: Schema.Literal("WEBSITE", "EMAIL", "PAID", "SOCIAL", "OTHER"),
    owner: Schema.optional(Text(200)), due: Schema.optional(Text(10)), content: Schema.optional(Text(2000)),
  })).pipe(Schema.maxItems(30)), { default: () => [] }),
})

// Request identity ignores object key order while preserving ordered deliverables.
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value !== null && typeof value === "object"
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, v]) => [key, canonical(v)])) : value

export const campaignRevisionDeclarations: ReadonlyArray<ToolDeclaration> = [{
  name: "record_campaign_revision",
  description: "Apply a requested edit or requested next-step preparation to an existing DRAFT campaign, not a new alternative. Read its current ID, revision and tasks first; pass expectedRevision and a plain reason. Patch only requested fields; unspecified values and task IDs are preserved. Distribution is replaced as a whole, so preserve its unchanged values when refining one part; its budget is not spending authority. Can edit unfinished draft tasks or add deliverables, not remove tasks, mark completion, change campaign stage/results/decisions, approve or publish. Active/review/closed campaigns, completed tasks, stale revisions and campaigns with linked delivery proposals are refused. A successful edit makes old runs stale. Identical retries reuse the recorded revision and never overwrite later edits.",
  parametersJsonSchema: JSONSchema.make(CampaignRevisionInput),
}]

export const reviseCampaign = (ctx: ToolContext, raw: unknown) => Effect.gen(function*() {
  const input = yield* Schema.decodeUnknown(CampaignRevisionInput, { onExcessProperty: "error" })(raw)
  if (!(yield* (yield* BusinessRepository).getScoped(ctx.accountId, ctx.businessId))) return yield* Effect.fail(new AgentNotInScope())
  if (!Object.keys(input.changes).length && !input.taskUpdates.length && !input.addDeliverables.length) return yield* refuse("EmptyRevision")
  if (new Set(input.taskUpdates.map(t => t.taskId)).size !== input.taskUpdates.length) return yield* refuse("DuplicateTaskUpdates")
  const key = createHash("sha256").update(JSON.stringify(canonical([ctx.userId, input]))).digest("hex")
  const sql = yield* SqlClient.SqlClient
  const saved = yield* sql.withTransaction(Effect.gen(function*() {
    const row = (yield* sql`SELECT id,revision,brief FROM marketing_campaigns WHERE business_id=${ctx.businessId} AND id=${input.campaignId} FOR UPDATE`)[0]
    if (!row) return yield* Effect.fail(new AgentNotInScope())
    const replay = (yield* sql`SELECT revision FROM marketing_campaign_revisions WHERE campaign_id=${input.campaignId} AND agent_request_key=${key} AND actor_user_id=${ctx.userId} AND actor='ASSISTANT'`)[0]
    if (replay) return { revision: Number(replay["revision"]), currentRevision: Number(row["revision"]), reused: true }
    if (Number(row["revision"]) !== input.expectedRevision) return yield* refuse("StaleRevision")
    const before = yield* Schema.decodeUnknown(CampaignBrief)(row["brief"])
    if (before.status !== "DRAFT") return yield* refuse("NotDraftCampaign")
    // A changed brief must never silently invalidate a pending publication's approved text.
    const linked = yield* sql`SELECT d.task_id FROM marketing_campaign_deliveries d JOIN marketing_campaign_runs r ON r.id=d.run_id AND r.business_id=d.business_id
      WHERE r.campaign_id=${input.campaignId} AND r.business_id=${ctx.businessId} LIMIT 1`
    if (linked[0]) return yield* refuse("DeliveryAlreadyPrepared")
    for (const update of input.taskUpdates) {
      const task = before.tasks.find(t => t.id === update.taskId)
      if (!task) return yield* refuse("TaskNotFound")
      if (task.status === "DONE") return yield* refuse("CompletedTaskImmutable")
      if (!Object.keys(update).some(k => k !== "taskId")) return yield* refuse("EmptyTaskUpdate")
    }
    const brief = yield* Schema.decodeUnknown(CampaignBrief)({ ...before, ...input.changes, tasks: [
      ...before.tasks.map(task => {
        const update = input.taskUpdates.find(t => t.taskId === task.id)
        if (!update) return task
        return { ...task, title: update.title ?? task.title, owner: update.owner ?? task.owner,
          due: update.due ?? task.due, note: update.content ?? task.note }
      }),
      ...input.addDeliverables.map(t => ({ id: randomUUID(), title: t.title, channel: t.channel, owner: t.owner ?? "", due: t.due ?? "", note: t.content ?? "", status: "TODO" as const })),
    ] })
    if (brief.tasks.length > 30) return yield* refuse("TooManyDeliverables")
    const reason = campaignTransitionError(brief)
    if (reason) return yield* refuse("InvalidCampaignDatesOrTasks")
    const encoded = JSON.stringify(brief), revision = input.expectedRevision + 1
    yield* sql`UPDATE marketing_campaigns SET brief=${encoded}::jsonb,revision=${revision},updated_at=now() WHERE id=${input.campaignId} AND business_id=${ctx.businessId}`
    yield* sql`INSERT INTO marketing_campaign_revisions(campaign_id,revision,actor_user_id,actor,brief,agent_request_key,revision_reason)
      VALUES (${input.campaignId},${revision},${ctx.userId},'ASSISTANT',${encoded}::jsonb,${key},${input.reason})`
    return { revision, currentRevision: revision, reused: false }
  }))
  return { summary: saved.reused ? "Previous campaign edit reused; no later work overwritten" : "Existing campaign draft updated; previous runs are now stale", citations: [],
    data: { campaignId: input.campaignId, ...saved, actor: "ASSISTANT", executed: false, url: `/businesses/${ctx.businessId}/campaigns?campaign=${input.campaignId}`,
      note: "Only planning content changed. Read the current campaign before another edit or run; no approval, delivery, measurement or human decision was changed." } }
})
