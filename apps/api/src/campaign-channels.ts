// Channels the owner sends themselves: an outreach email, a LinkedIn or
// community post. OpenRecord does not send them. It gives each one its own
// link to the campaign page, so views and inquiries can be read by source,
// and records the owner's own report that it went out.
import { randomBytes } from "node:crypto"
import { HttpRouter } from "@effect/platform"
import { SqlClient } from "@effect/sql"
import { BusinessRepository } from "@openrecord/db"
import { decodeRouteId } from "@openrecord/contracts"
import { Data, Effect, JSONSchema, Schema } from "effect"
import { AgentNotInScope } from "./agent-tool-errors.js"
import type { ToolContext, ToolDeclaration } from "./agent-registry.js"
import { decode, json, operatorSessionFor, readJson, type WithSession } from "./record-routes.js"

export class ChannelRefused extends Data.TaggedError("ChannelRefused")<{ readonly reason: string }> {}
const refuse = (reason: string) => Effect.fail(new ChannelRefused({ reason }))
const PRIVATE = { "cache-control": "no-store" }
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789"
const code = () => [...randomBytes(10)].map(b => ALPHABET[b % ALPHABET.length]).join("")

const LinkInput = Schema.Struct({ publicationId: Schema.UUID, taskId: Schema.UUID })

/** A link to a campaign page for one email or post deliverable of the same campaign. Asking again returns the same link. */
export const createCampaignLink = (ctx: ToolContext, raw: unknown) => Effect.gen(function*() {
  const input = yield* Schema.decodeUnknown(LinkInput, { onExcessProperty: "error" })(raw)
  if (!(yield* (yield* BusinessRepository).getScoped(ctx.accountId, ctx.businessId))) return yield* Effect.fail(new AgentNotInScope())
  const sql = yield* SqlClient.SqlClient
  const page = (yield* sql`SELECT p.id, p.destination, p.status, b.campaign_id, c.brief FROM campaign_publications p
    JOIN campaign_artifact_bindings b ON b.id=p.binding_id JOIN marketing_campaigns c ON c.id=b.campaign_id
    WHERE p.id=${input.publicationId} AND p.business_id=${ctx.businessId}`)[0]
  if (!page) return yield* Effect.fail(new AgentNotInScope())
  if (!["PREPARED", "PUBLISHED"].includes(String(page["status"]))) return yield* refuse("PageNotAvailable")
  const task = ((page["brief"] as { tasks?: ReadonlyArray<{ id: string; title: string; channel: string }> }).tasks ?? []).find(t => t.id === input.taskId)
  if (!task) return yield* refuse("NotThisCampaign")
  if (task.channel === "WEBSITE") return yield* refuse("NotASendableDeliverable")
  const existing = (yield* sql`SELECT code FROM campaign_links WHERE publication_id=${input.publicationId} AND task_id=${input.taskId}`)[0]
  const linkCode = existing ? String(existing["code"]) : String((yield* sql`INSERT INTO campaign_links(business_id,publication_id,task_id,code,label,created_by_user_id)
    VALUES (${ctx.businessId},${input.publicationId},${input.taskId},${code()},${task.title.slice(0, 300)},${ctx.userId})
    ON CONFLICT (publication_id, task_id) DO UPDATE SET label=campaign_links.label RETURNING code`)[0]!["code"])
  return { url: `${String(page["destination"])}?s=${linkCode}`, label: task.title, reused: Boolean(existing), live: page["status"] === "PUBLISHED" }
})

export const channelDeclarations: ReadonlyArray<ToolDeclaration> = [
  { name: "create_campaign_link", description: "Give an email or post deliverable its own link to the campaign page, so the page's views and inquiries can be read by source. Put the returned URL in that deliverable's artifact (edit_artifact) as its link to the page. The owner sends or posts it; OpenRecord does not. Asking again returns the same link.", parametersJsonSchema: JSONSchema.make(LinkInput) },
]
export const dispatchChannel = (ctx: ToolContext, _name: string, raw: unknown) => Effect.map(createCampaignLink(ctx, raw), data => ({
  summary: data.reused ? "Existing tracked link returned" : "Tracked link created for the deliverable; nothing was sent", citations: [], data,
}))

const Handoff = Schema.Struct({
  campaignId: Schema.UUID, taskId: Schema.UUID, status: Schema.Literal("SENT", "POSTED"),
  publicUrl: Schema.optional(Schema.NullOr(Schema.String.pipe(Schema.maxLength(1000), Schema.pattern(/^https:\/\/\S+$/)))),
})

/** The owner's own report that a deliverable went out. Only a person can make it; the agent has no tool for it. */
export const channelsApi = (withSession: WithSession) => {
  const operator = operatorSessionFor(withSession)
  return HttpRouter.empty.pipe(
    HttpRouter.post("/api/businesses/:id/campaign-handoffs", operator(session => Effect.gen(function*() {
      const { params } = yield* HttpRouter.RouteContext
      const businessId = params["id"] ?? ""
      if (decodeRouteId(businessId)._tag === "Left") return yield* json(404, { _tag: "NotFound" }, PRIVATE)
      if (!(yield* (yield* BusinessRepository).getScoped(session.accountId, businessId))) return yield* json(404, { _tag: "NotFound" }, PRIVATE)
      const input = decode(Handoff, yield* readJson)
      if (!input) return yield* json(422, { _tag: "InvalidRequest" }, PRIVATE)
      const sql = yield* SqlClient.SqlClient
      const campaign = (yield* sql`SELECT brief FROM marketing_campaigns WHERE id=${input.campaignId} AND business_id=${businessId}`)[0]
      const task = ((campaign?.["brief"] as { tasks?: ReadonlyArray<{ id: string; channel: string }> } | undefined)?.tasks ?? []).find(t => t.id === input.taskId)
      if (!task) return yield* json(404, { _tag: "NotFound" }, PRIVATE)
      if (task.channel === "WEBSITE") return yield* json(409, { _tag: "ChannelRefused", reason: "NotASendableDeliverable" }, PRIVATE)
      const rows = yield* sql`INSERT INTO campaign_handoffs(business_id,campaign_id,task_id,status,public_url,reported_by_user_id)
        VALUES (${businessId},${input.campaignId},${input.taskId},${input.status},${input.publicUrl ?? null},${session.userId})
        ON CONFLICT (campaign_id, task_id) DO UPDATE SET status=EXCLUDED.status, public_url=EXCLUDED.public_url, reported_by_user_id=EXCLUDED.reported_by_user_id, reported_at=now()
        RETURNING status, public_url, reported_at`
      return yield* json(200, { handoff: { status: rows[0]!["status"], publicUrl: rows[0]!["public_url"], reportedAt: rows[0]!["reported_at"], reportedBy: "OWNER" } }, PRIVATE)
    })).pipe(Effect.catchAll(e => json(typeof e === "object" && e !== null && "_tag" in e && e._tag === "NotAuthenticated" ? 401 : 503, { _tag: "HandoffUnavailable" }, PRIVATE)))),
  )
}
