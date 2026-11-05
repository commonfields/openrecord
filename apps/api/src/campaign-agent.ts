import { createHash, randomUUID } from "node:crypto"
import { SqlClient } from "@effect/sql"
import { BusinessRepository } from "@openrecord/db"
import { CampaignBrief, campaignTransitionError } from "@openrecord/contracts"
import { Effect, JSONSchema, Schema } from "effect"
import { AgentNotInScope } from "./agent-tool-errors.js"
import { AgentInvalidInput } from "./agent-tools.js"
import type { ToolContext, ToolDeclaration } from "./agent-registry.js"

const OptionalText = (max: number) => Schema.optionalWith(Schema.String.pipe(Schema.maxLength(max)), { default: () => "" })
export const CampaignDraftInput = Schema.Struct({
  title: CampaignBrief.fields.title,
  goal: OptionalText(2000), audience: OptionalText(2000), offer: OptionalText(2000), message: OptionalText(2000), hypothesis: OptionalText(2000),
  metric: OptionalText(500), baseline: OptionalText(500), target: OptionalText(500), owner: OptionalText(200), launchDate: OptionalText(10), reviewDate: OptionalText(10),
  deliverables: Schema.Array(Schema.Struct({ title: CampaignBrief.fields.title,
    channel: Schema.Literal("WEBSITE", "EMAIL", "PAID", "SOCIAL", "OTHER"), owner: OptionalText(200), due: OptionalText(10),
    content: OptionalText(2000),
  })).pipe(Schema.minItems(1), Schema.maxItems(30)),
})

export const campaignDraftDeclarations: ReadonlyArray<ToolDeclaration> = [{
  name: "record_campaign_draft",
  description: "Save an assistant-authored campaign draft and concrete draft deliverables in the selected business. Use when asked to create/prepare a campaign, including /campaign. Read business context and existing campaigns first. Leave unknown fields empty; label proposed targets/hypotheses as suggestions. Deliverable content is private draft copy or a specific handoff, not published work. All tasks are server-set TODO; never approves, schedules, spends, publishes, sends or marks completion. Identical inputs reuse the existing draft. Return its link. For a requested alternative, save a clearly named new draft; never claim the original was changed.",
  parametersJsonSchema: JSONSchema.make(CampaignDraftInput),
}]

export const draftMarketingCampaign = (ctx: ToolContext, raw: unknown) => Effect.gen(function*() {
  const input = yield* Schema.decodeUnknown(CampaignDraftInput, { onExcessProperty: "error" })(raw)
  if (!(yield* (yield* BusinessRepository).getScoped(ctx.accountId, ctx.businessId))) return yield* Effect.fail(new AgentNotInScope())
  const { deliverables, ...fields } = input
  const brief: CampaignBrief = { ...fields, status: "DRAFT", result: "", decision: "UNDECIDED", learning: "", nextMove: "",
    tasks: deliverables.map(t => ({ id: randomUUID(), title: t.title, channel: t.channel, owner: t.owner, due: t.due, status: "TODO", note: t.content })),
  }
  const reason = campaignTransitionError(brief)
  if (reason) return yield* Effect.fail(new AgentInvalidInput({ tool: "record_campaign_draft" }))
  // Decode before hashing: property order, defaults and generated task IDs do not change identity.
  const key = createHash("sha256").update(JSON.stringify([ctx.userId, input])).digest("hex")
  const sql = yield* SqlClient.SqlClient
  const saved = yield* sql.withTransaction(Effect.gen(function*() {
    // One lock per business also makes concurrent duplicate requests replay-safe.
    yield* sql`SELECT id FROM businesses WHERE id=${ctx.businessId} AND account_id=${ctx.accountId} FOR UPDATE`
    const existing = yield* sql`SELECT id,revision,brief->>'status' AS status FROM marketing_campaigns WHERE business_id=${ctx.businessId} AND draft_key=${key}`
    if (existing[0]) return { row: existing[0], reused: true }
    const rows = yield* sql`INSERT INTO marketing_campaigns(business_id,created_by_user_id,created_by_actor,draft_key,brief)
      VALUES (${ctx.businessId},${ctx.userId},'ASSISTANT',${key},${JSON.stringify(brief)}::jsonb) RETURNING id,revision,brief->>'status' AS status`
    const row = rows[0]!
    yield* sql`INSERT INTO marketing_campaign_revisions(campaign_id,revision,actor_user_id,actor,brief)
      VALUES (${row["id"]},1,${ctx.userId},'ASSISTANT',${JSON.stringify(brief)}::jsonb)`
    return { row, reused: false }
  }))
  return { summary: saved.reused ? "Existing campaign draft reused; nothing launched" : "Campaign and deliverable drafts saved; nothing launched", citations: [],
    data: { campaignId: saved.row["id"], revision: saved.row["revision"], status: saved.row["status"], actor: "ASSISTANT", reused: saved.reused,
      url: `/businesses/${ctx.businessId}/campaigns`, executed: false,
      note: "A private planning draft only. Unknown fields remain empty. Review the brief and use supported proposal tools for external actions; approval and independent verification remain required." } }
})
