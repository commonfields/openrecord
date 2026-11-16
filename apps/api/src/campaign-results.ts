// Campaign results and the next experiment, for hosted campaign pages.
//
// read_campaign_results gives the agent the server's own reading of each live
// page: views and recorded inquiries since it went live, the last seven days
// against the seven before, the campaign's stated target, and whether that is
// enough to judge. propose_campaign_review saves a keep, change, stop or
// inconclusive verdict with the next experiment for a person to decide; the
// evidence stored with it is the server's reading at that moment, and any
// verdict but INCONCLUSIVE is refused while the evidence is not enough.
//
// Inquiries are recorded form submissions: not qualified leads, revenue or
// lift, and nothing here attributes a change in them to the campaign.
import { createHash } from "node:crypto"
import { HttpRouter } from "@effect/platform"
import { SqlClient } from "@effect/sql"
import { BusinessRepository, type Session } from "@openrecord/db"
import { decodeRouteId } from "@openrecord/contracts"
import { Data, Effect, JSONSchema, Schema } from "effect"
import { AgentNotInScope } from "./agent-tool-errors.js"
import type { ToolContext, ToolDeclaration } from "./agent-registry.js"
import { json, operatorSessionFor, type WithSession } from "./record-routes.js"

export class CampaignReviewRefused extends Data.TaggedError("CampaignReviewRefused")<{ readonly reason: string }> {}
const refuse = (reason: string) => Effect.fail(new CampaignReviewRefused({ reason }))
const PRIVATE = { "cache-control": "no-store" }

/** Enough to judge: a week live and a hundred views. Below that, the honest verdict is inconclusive. */
export const MIN_DAYS_LIVE = 7
export const MIN_VIEWS = 100

const CampaignInput = Schema.Struct({ campaignId: Schema.UUID })
const ReviewInput = Schema.Struct({
  campaignId: Schema.UUID,
  verdict: Schema.Literal("KEEP", "CHANGE", "STOP", "INCONCLUSIVE"),
  summary: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(2000)),
  nextExperiment: Schema.Struct({
    hypothesis: Schema.String.pipe(Schema.maxLength(1000)),
    change: Schema.String.pipe(Schema.maxLength(1000)),
  }),
})

export interface SourceReading { readonly label: string; readonly views: number; readonly inquiries: number }
export interface PageReading {
  readonly sources: ReadonlyArray<SourceReading>
  readonly publicationId: string; readonly title: string; readonly liveUrl: string; readonly liveSince: string; readonly daysLive: number
  readonly views: number; readonly inquiries: number; readonly inquiryRate: number | null
  readonly last7: { readonly views: number; readonly inquiries: number }; readonly previous7: { readonly views: number; readonly inquiries: number }
}
export interface Sufficiency { readonly sufficient: boolean; readonly reasons: ReadonlyArray<string> }

/** Whether the readings can support a verdict, and why not when they cannot. */
export const sufficiencyOf = (pages: ReadonlyArray<Pick<PageReading, "daysLive" | "views">>): Sufficiency => {
  if (!pages.length) return { sufficient: false, reasons: ["No campaign page is live, so there is nothing to read yet."] }
  const days = Math.max(...pages.map(p => p.daysLive)), views = pages.reduce((n, p) => n + p.views, 0)
  const reasons = [
    ...(days < MIN_DAYS_LIVE ? [`Live for ${days} ${days === 1 ? "day" : "days"}; at least ${MIN_DAYS_LIVE} are needed to judge.`] : []),
    ...(views < MIN_VIEWS ? [`${views} ${views === 1 ? "view" : "views"} recorded; at least ${MIN_VIEWS} are needed to judge.`] : []),
  ]
  return { sufficient: reasons.length === 0, reasons }
}

/** The first whole number in a target like "Suggested: 10 qualified demo requests", or null. */
export const targetNumber = (target: string): number | null => {
  const m = target.replace(/,/g, "").match(/\b\d+\b/)
  return m ? Number(m[0]) : null
}

const LIMITS = [
  "Views are page loads, not people; automated visits are included.",
  "Inquiries are recorded form submissions, not qualified leads, revenue or lift.",
  "Prelaunch test views and inquiries are excluded.",
  "Nothing here shows the campaign caused a change; other traffic and timing can explain it.",
]

const scoped = (accountId: string, businessId: string) => Effect.gen(function*() {
  if (!(yield* (yield* BusinessRepository).getScoped(accountId, businessId))) return yield* Effect.fail(new AgentNotInScope())
})

/** The server's reading of a campaign's live pages, as of now. */
export const campaignResults = (ctx: Pick<ToolContext, "accountId" | "businessId">, campaignId: string) => Effect.gen(function*() {
  yield* scoped(ctx.accountId, ctx.businessId)
  const sql = yield* SqlClient.SqlClient
  const campaign = (yield* sql`SELECT brief FROM marketing_campaigns WHERE id=${campaignId} AND business_id=${ctx.businessId}`)[0]
  if (!campaign) return yield* Effect.fail(new AgentNotInScope())
  const brief = campaign["brief"] as { title?: string; metric?: string; target?: string; reviewDate?: string }
  const rows = yield* sql`SELECT p.id, p.destination, p.published_at, v.title,
      GREATEST(1, (current_date - p.published_at::date) + 1) AS days_live,
      COALESCE((SELECT sum(views) FROM campaign_page_days d WHERE d.publication_id=p.id), 0)::int AS views,
      (SELECT count(*) FROM campaign_inquiries i WHERE i.publication_id=p.id AND i.purpose='PRODUCTION')::int AS inquiries,
      COALESCE((SELECT sum(views) FROM campaign_page_days d WHERE d.publication_id=p.id AND d.day > current_date - 7), 0)::int AS views_last7,
      (SELECT count(*) FROM campaign_inquiries i WHERE i.publication_id=p.id AND i.purpose='PRODUCTION' AND i.created_at::date > current_date - 7)::int AS inquiries_last7,
      COALESCE((SELECT sum(views) FROM campaign_page_days d WHERE d.publication_id=p.id AND d.day > current_date - 14 AND d.day <= current_date - 7), 0)::int AS views_prev7,
      (SELECT count(*) FROM campaign_inquiries i WHERE i.publication_id=p.id AND i.purpose='PRODUCTION' AND i.created_at::date > current_date - 14 AND i.created_at::date <= current_date - 7)::int AS inquiries_prev7
    FROM campaign_publications p JOIN campaign_artifact_bindings b ON b.id=p.binding_id
    JOIN agent_artifact_versions v ON v.artifact_id=b.artifact_id AND v.version=b.artifact_version
    WHERE b.campaign_id=${campaignId} AND p.business_id=${ctx.businessId} AND p.status='PUBLISHED' ORDER BY p.published_at`
  const ids = rows.map(r => String(r["id"]))
  const sourceRows = ids.length ? yield* sql`SELECT l.publication_id, l.label, COALESCE((SELECT sum(views) FROM campaign_link_days d WHERE d.link_id=l.id),0)::int AS views,
      (SELECT count(*) FROM campaign_inquiries i WHERE i.link_id=l.id AND i.purpose='PRODUCTION')::int AS inquiries
    FROM campaign_links l WHERE l.publication_id IN (SELECT unnest(${`{${ids.join(",")}}`}::uuid[])) ORDER BY l.created_at` : []
  const pages: PageReading[] = rows.map(r => {
    const views = Number(r["views"]), inquiries = Number(r["inquiries"])
    const tracked = sourceRows.filter(x => String(x["publication_id"]) === String(r["id"])).map((x): SourceReading => ({ label: String(x["label"]), views: Number(x["views"]), inquiries: Number(x["inquiries"]) }))
    // Everything not through a tracked link: shared directly, typed in, or from a source without its own link.
    const direct = { label: "Other visits (no tracked link)", views: Math.max(0, views - tracked.reduce((n, x) => n + x.views, 0)), inquiries: Math.max(0, inquiries - tracked.reduce((n, x) => n + x.inquiries, 0)) }
    return { sources: [...tracked, direct], publicationId: String(r["id"]), title: String(r["title"]), liveUrl: String(r["destination"]), liveSince: new Date(r["published_at"] as string).toISOString(),
      daysLive: Number(r["days_live"]), views, inquiries, inquiryRate: views > 0 ? Math.round(inquiries / views * 10000) / 10000 : null,
      last7: { views: Number(r["views_last7"]), inquiries: Number(r["inquiries_last7"]) }, previous7: { views: Number(r["views_prev7"]), inquiries: Number(r["inquiries_prev7"]) } }
  })
  const inquiries = pages.reduce((n, p) => n + p.inquiries, 0)
  const target = targetNumber(brief.target ?? "")
  const latest = (yield* sql`SELECT id, verdict, summary, next_hypothesis, next_change, status, created_at, decided_at FROM campaign_reviews
    WHERE campaign_id=${campaignId} AND business_id=${ctx.businessId} ORDER BY created_at DESC LIMIT 1`)[0]
  return {
    campaignId, asOf: new Date().toISOString(), metric: brief.metric ?? "", target: brief.target ?? "", reviewDate: brief.reviewDate ?? "",
    pages, totals: { views: pages.reduce((n, p) => n + p.views, 0), inquiries },
    againstTarget: target === null ? null : { target, recordedInquiries: inquiries, note: "Recorded inquiries are compared with the stated target; the target may count qualified requests, which are not recorded here." },
    sufficiency: sufficiencyOf(pages), limitations: LIMITS,
    latestReview: latest ? { id: String(latest["id"]), verdict: String(latest["verdict"]), status: String(latest["status"]), summary: String(latest["summary"]),
      nextExperiment: { hypothesis: String(latest["next_hypothesis"]), change: String(latest["next_change"]) } } : null,
  }
})

export const proposeCampaignReview = (ctx: ToolContext, raw: unknown) => Effect.gen(function*() {
  const input = yield* Schema.decodeUnknown(ReviewInput, { onExcessProperty: "error" })(raw)
  const evidence = yield* campaignResults(ctx, input.campaignId)
  if (!evidence.sufficiency.sufficient && input.verdict !== "INCONCLUSIVE") return yield* refuse("EvidenceInsufficient")
  if (input.verdict === "CHANGE" && !input.nextExperiment.hypothesis.trim()) return yield* refuse("NextExperimentRequired")
  const sql = yield* SqlClient.SqlClient
  const key = createHash("sha256").update(JSON.stringify(["campaign-review-v1", ctx.userId, input])).digest("hex")
  return yield* sql.withTransaction(Effect.gen(function*() {
    yield* sql`SELECT id FROM marketing_campaigns WHERE id=${input.campaignId} AND business_id=${ctx.businessId} FOR UPDATE`
    const replay = (yield* sql`SELECT id FROM campaign_reviews WHERE request_key=${key} AND business_id=${ctx.businessId}`)[0]
    if (replay) return { reviewId: String(replay["id"]), reused: true }
    if ((yield* sql`SELECT 1 FROM campaign_reviews WHERE campaign_id=${input.campaignId} AND status='PROPOSED'`)[0]) return yield* refuse("ReviewAlreadyWaiting")
    const rows = yield* sql`INSERT INTO campaign_reviews(business_id,campaign_id,verdict,summary,next_hypothesis,next_change,evidence,evidence_sufficient,proposed_by_user_id,request_key)
      VALUES (${ctx.businessId},${input.campaignId},${input.verdict},${input.summary.trim()},${input.nextExperiment.hypothesis.trim()},${input.nextExperiment.change.trim()},
        ${JSON.stringify(evidence)}::jsonb,${evidence.sufficiency.sufficient},${ctx.userId},${key}) RETURNING id`
    return { reviewId: String(rows[0]!["id"]), reused: false }
  }))
})

export const campaignResultsDeclarations: ReadonlyArray<ToolDeclaration> = [
  { name: "read_campaign_results", description: "Read a campaign's live page views and recorded inquiries. It gives views and inquiries since live, the last 7 days against the 7 before, the stated target, whether the evidence is enough to judge (at least 7 days live and 100 views), and its limits. Inquiries are recorded submissions, not qualified leads, revenue or lift. Read-only.", parametersJsonSchema: JSONSchema.make(CampaignInput) },
  { name: "propose_campaign_review", description: "Propose a campaign verdict for the owner to decide. Give KEEP, CHANGE, STOP or INCONCLUSIVE, a short summary of what the evidence shows and what it cannot, and the next experiment (hypothesis and the one change to make). Read read_campaign_results first. Any verdict but INCONCLUSIVE is refused while the evidence is not enough. The server stores its own reading as the evidence. Never claims the campaign caused a result.", parametersJsonSchema: JSONSchema.make(ReviewInput) },
]
export const dispatchCampaignResults = (ctx: ToolContext, name: string, raw: unknown) => Effect.gen(function*() {
  if (name === "read_campaign_results") {
    const data = yield* campaignResults(ctx, (yield* Schema.decodeUnknown(CampaignInput, { onExcessProperty: "error" })(raw)).campaignId)
    return { summary: `${data.pages.length} live campaign page${data.pages.length === 1 ? "" : "s"} read; ${data.sufficiency.sufficient ? "enough evidence to judge" : "not enough evidence to judge yet"}`, citations: [], data }
  }
  const data = yield* proposeCampaignReview(ctx, raw)
  return { summary: data.reused ? "Existing campaign review reused" : "Campaign review proposed for the owner to decide; nothing changed", citations: [], data: { ...data, campaignReviewId: data.reviewId } }
})

/** Reviews waiting for a person, for Needs you. */
export const pendingCampaignReviews = (accountId: string, businessId: string) => Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  return yield* sql`SELECT r.id, r.campaign_id AS "campaignId", c.brief->>'title' AS "campaignTitle", r.verdict, r.summary, r.next_hypothesis AS "nextHypothesis",
      r.next_change AS "nextChange", r.evidence, r.evidence_sufficient AS "evidenceSufficient", r.created_at AS "createdAt"
    FROM campaign_reviews r JOIN marketing_campaigns c ON c.id=r.campaign_id JOIN businesses b ON b.id=r.business_id
    WHERE r.business_id=${businessId} AND b.account_id=${accountId} AND r.status='PROPOSED' ORDER BY r.created_at`
})

const failure = (e: unknown) => {
  if (typeof e === "object" && e !== null && "_tag" in e && e._tag === "NotAuthenticated") return json(401, { _tag: "NotAuthenticated" }, PRIVATE)
  if (e instanceof CampaignReviewRefused) return json(409, { _tag: "CampaignReviewRefused", reason: e.reason }, PRIVATE)
  if (e instanceof AgentNotInScope) return json(404, { _tag: "NotFound" }, PRIVATE)
  return json(503, { _tag: "CampaignReviewUnavailable" }, PRIVATE)
}
export const campaignResultsApi = (withSession: WithSession) => {
  const operator = operatorSessionFor(withSession)
  const route = <E, R>(run: (session: Session, businessId: string, id: string) => Effect.Effect<import("@effect/platform").HttpServerResponse.HttpServerResponse, E, R>) =>
    operator(session => Effect.gen(function*() {
      const { params } = yield* HttpRouter.RouteContext
      const businessId = params["id"] ?? "", id = params["reviewId"] ?? params["campaignId"] ?? ""
      if (decodeRouteId(businessId)._tag === "Left" || decodeRouteId(id)._tag === "Left") return yield* Effect.fail(new AgentNotInScope())
      yield* scoped(session.accountId, businessId)
      return yield* run(session, businessId, id)
    })).pipe(Effect.catchAll(failure))
  const decide = (status: "APPROVED" | "REJECTED") => route((session, businessId, id) => Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql`UPDATE campaign_reviews SET status=${status}, decided_by_user_id=${session.userId}, decided_at=now()
      WHERE id=${id} AND business_id=${businessId} AND status='PROPOSED' RETURNING id`
    if (!rows.length) return yield* refuse("AlreadyDecided")
    return yield* json(200, { status }, PRIVATE)
  }))
  return HttpRouter.empty.pipe(
    HttpRouter.get("/api/businesses/:id/campaign-results/:campaignId", route((session, businessId, id) =>
      Effect.flatMap(campaignResults({ accountId: session.accountId, businessId }, id), r => json(200, r, PRIVATE)))),
    HttpRouter.post("/api/businesses/:id/campaign-reviews/:reviewId/approve", decide("APPROVED")),
    HttpRouter.post("/api/businesses/:id/campaign-reviews/:reviewId/reject", decide("REJECTED")),
  )
}
