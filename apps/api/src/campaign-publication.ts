import { createHash, randomBytes } from "node:crypto"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "@effect/platform"
import { SqlClient } from "@effect/sql"
import { Data, Effect, JSONSchema, Option, Schema } from "effect"
import { BusinessRepository, type Session } from "@openrecord/db"
import { decodeRouteId } from "@openrecord/contracts"
import { makeTokenCipher, parseCipherKeys } from "@openrecord/ga4"
import { artifactDocument, PREVIEW_HEADERS, readArtifact } from "./artifacts.js"
import { json, operatorSessionFor, readJson, type WithSession } from "./record-routes.js"
import type { ToolContext, ToolDeclaration } from "./agent-registry.js"
import { blockingCount, checkDeliverable, type Finding } from "./deliverable-checks.js"

const digest = (text: string) => createHash("sha256").update(text).digest("hex")
const token = () => randomBytes(32).toString("base64url")
const TOKEN = /^[A-Za-z0-9_-]{43}$/
const PRIVATE = { "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" }
export class PublicationRefused extends Data.TaggedError("PublicationRefused")<{ reason: string }> {}
const refuse = (reason: string) => Effect.fail(new PublicationRefused({ reason }))
const ScopeInput = Schema.Struct({ campaignId: Schema.UUID })
const BindInput = Schema.Struct({ campaignId: Schema.UUID, campaignRevision: Schema.Int.pipe(Schema.positive()), taskId: Schema.UUID, artifactId: Schema.UUID, artifactVersion: Schema.Int.pipe(Schema.positive()) })
const PrepareInput = Schema.Struct({ bindingId: Schema.UUID, ctaLabel: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(120)), privacyNotice: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(1000)) })
const PublicationInput = Schema.Struct({ publicationId: Schema.UUID })
const Approval = Schema.Struct({ artifactVersion: Schema.Int, contentDigest: Schema.String.pipe(Schema.pattern(/^[a-f0-9]{64}$/)), destination: Schema.String })
const Contact = Schema.Struct({ email: Schema.String.pipe(Schema.maxLength(254), Schema.pattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)), message: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(2000)), consent: Schema.Literal("yes") })
const cipher = () => { const keys = parseCipherKeys(process.env["ADS_TOKEN_ENCRYPTION_KEYS"] || process.env["GA4_TOKEN_ENCRYPTION_KEYS"]); return keys ? makeTokenCipher(keys) : null }
export const publicationOrigin = () => {
  try {
    if (process.env["NODE_ENV"] === "production" && !process.env["CAMPAIGN_PUBLIC_BASE_URL"]) return null
    const u = new URL(process.env["CAMPAIGN_PUBLIC_BASE_URL"] ?? "http://localhost:3001")
    if (u.username || u.password || u.pathname !== "/" || u.search || u.hash || !(u.protocol === "https:" || (u.protocol === "http:" && ["localhost", "127.0.0.1"].includes(u.hostname)))) return null
    return u.origin
  } catch { return null }
}
const scoped = (ctx: Pick<ToolContext, "accountId" | "businessId">) => Effect.gen(function*() {
  if (!(yield* (yield* BusinessRepository).getScoped(ctx.accountId, ctx.businessId))) return yield* refuse("NotFound")
})
export const bindCampaignArtifact = (ctx: ToolContext, raw: unknown) => Effect.gen(function*() {
  const input = yield* Schema.decodeUnknown(BindInput, { onExcessProperty: "error" })(raw)
  yield* scoped(ctx)
  const sql = yield* SqlClient.SqlClient
  return yield* sql.withTransaction(Effect.gen(function*() {
    const campaigns = yield* sql`SELECT revision,brief FROM marketing_campaigns WHERE id=${input.campaignId} AND business_id=${ctx.businessId} FOR UPDATE`
    if (!campaigns[0]) return yield* refuse("NotFound")
    if (Number(campaigns[0]["revision"]) !== input.campaignRevision) return yield* refuse("StaleCampaign")
    const task = yield* sql`SELECT t FROM marketing_campaigns c, jsonb_array_elements(c.brief->'tasks') t
      WHERE c.id=${input.campaignId} AND t->>'id'=${input.taskId} AND c.brief->>'status'='DRAFT'`
    if (!task.length) return yield* refuse("TaskNotEditable")
    const artifact = yield* readArtifact(ctx.accountId, ctx.businessId, input.artifactId, input.artifactVersion)
    if (!artifact || artifact.version !== input.artifactVersion) return yield* refuse("StaleArtifact")
    const existing = yield* sql`SELECT id FROM campaign_artifact_bindings WHERE campaign_id=${input.campaignId} AND campaign_revision=${input.campaignRevision}
      AND task_id=${input.taskId} AND artifact_id=${input.artifactId} AND artifact_version=${input.artifactVersion}`
    if (existing[0]) return { bindingId: String(existing[0]["id"]), reused: true }
    const rows = yield* sql`INSERT INTO campaign_artifact_bindings(business_id,campaign_id,campaign_revision,task_id,artifact_id,artifact_version,content_digest,created_by_user_id)
      VALUES (${ctx.businessId},${input.campaignId},${input.campaignRevision},${input.taskId},${input.artifactId},${input.artifactVersion},${digest(artifact.content)},${ctx.userId}) RETURNING id`
    return { bindingId: String(rows[0]!["id"]), reused: false }
  }))
})

/** Every receipt is read against the current business and the exact pinned versions. */
export const campaignDeliveryProgress = (ctx: Pick<ToolContext, "accountId" | "businessId">, campaignId: string) => Effect.gen(function*() {
  yield* scoped(ctx)
  const sql = yield* SqlClient.SqlClient
  const campaigns = yield* sql`SELECT revision,brief FROM marketing_campaigns WHERE id=${campaignId} AND business_id=${ctx.businessId}`
  if (!campaigns[0]) return yield* refuse("NotFound")
  const rows = yield* sql`SELECT DISTINCT ON (b.task_id) b.id AS "bindingId",b.task_id AS "taskId",b.artifact_id AS "artifactId",b.artifact_version AS "artifactVersion",
      v.title AS title,b.content_digest AS "contentDigest",b.campaign_revision AS "campaignRevision",a.version AS "currentArtifactVersion",a.archived_at AS "archivedAt",
      p.id AS "publicationId",p.status,p.destination,p.cta_label AS "ctaLabel",p.privacy_notice AS "privacyNotice",p.published_at AS "publishedAt",
      EXISTS(SELECT 1 FROM campaign_inquiries i WHERE i.publication_id=p.id AND i.purpose='TEST') AS "trackingTested",
      (SELECT count(*)::int FROM campaign_inquiries i WHERE i.publication_id=p.id AND i.purpose='PRODUCTION') AS "inquiries",
      k.findings AS "checks", COALESCE(k.blocking,0) AS "blocking",
      (SELECT pp.destination || '?s=' || l.code FROM campaign_links l JOIN campaign_publications pp ON pp.id=l.publication_id
        WHERE l.task_id=b.task_id AND pp.status IN ('PREPARED','PUBLISHED') ORDER BY l.created_at DESC LIMIT 1) AS "trackedLink",
      h.status AS "handoffStatus", h.public_url AS "handoffUrl", h.reported_at AS "handoffAt"
    FROM campaign_artifact_bindings b LEFT JOIN campaign_deliverable_checks k ON k.binding_id=b.id
    LEFT JOIN campaign_handoffs h ON h.campaign_id=b.campaign_id AND h.task_id=b.task_id JOIN agent_artifacts a ON a.id=b.artifact_id
    JOIN agent_artifact_versions v ON v.artifact_id=b.artifact_id AND v.version=b.artifact_version
    LEFT JOIN campaign_publications p ON p.binding_id=b.id
    WHERE b.business_id=${ctx.businessId} AND b.campaign_id=${campaignId} ORDER BY b.task_id,b.created_at DESC,b.id DESC`
  const channels = new Map(((campaigns[0]["brief"] as { tasks?: ReadonlyArray<{ id: string; channel: string }> } | null)?.tasks ?? []).map(t => [t.id, t.channel]))
  const deliverables = rows.map(r => {
    // Only a website deliverable can become a hosted page; an email or a post is handed to the owner to send.
    const web = (channels.get(String(r["taskId"])) ?? "WEBSITE") === "WEBSITE"
    const stale = Number(r["campaignRevision"]) !== Number(campaigns[0]!["revision"]) || Number(r["artifactVersion"]) !== Number(r["currentArtifactVersion"]) || r["archivedAt"] !== null
    const state = stale ? "NEEDS_REVISION" : r["status"] === "PUBLISHED" ? "LIVE" : r["status"] === "REJECTED" || r["status"] === "WITHDRAWN" ? r["status"] : !r["publicationId"] ? (r["handoffStatus"] ? "OWNER_REPORTED_SENT" : "DRAFT_READY") : Number(r["blocking"] ?? 0) > 0 ? "NEEDS_FIXES" : r["trackingTested"] === true ? "AWAITING_APPROVAL" : "NEEDS_TRACKING_TEST"
    return { ...r, bindingId: String(r["bindingId"]), taskId: String(r["taskId"]), title: String(r["title"]), artifactId: String(r["artifactId"]), artifactVersion: Number(r["artifactVersion"]), publicationId: r["publicationId"] ? String(r["publicationId"]) : null, trackingTested: r["trackingTested"] === true, state, stale, liveUrl: r["status"] === "PUBLISHED" ? r["destination"] : null, inquiries: Number(r["inquiries"] ?? 0), nextAction: stale ? "Review the edited draft and prepare a new publication" : state === "LIVE" ? "Share the page and review recorded inquiries" : state === "NEEDS_FIXES" ? "Fix the blocking checks in a new revision, link it and prepare it again" : state === "NEEDS_TRACKING_TEST" ? "Submit the prelaunch inquiry test" : state === "AWAITING_APPROVAL" ? "Review and approve publication in Needs you" : web ? "Prepare the linked artifact for publication" : r["handoffStatus"] ? `The owner reported it ${String(r["handoffStatus"]).toLowerCase()}; read its source in the campaign results` : r["trackedLink"] ? "Ready for the owner to send or post with its tracked link, then mark it sent" : "Ready for the owner to send or post; give it a tracked link to the campaign page first (create_campaign_link)",
      channel: channels.get(String(r["taskId"])) ?? "WEBSITE", trackedLink: (r["trackedLink"] as string | null) ?? null,
      handoff: r["handoffStatus"] ? { status: String(r["handoffStatus"]), publicUrl: (r["handoffUrl"] as string | null) ?? null, reportedAt: new Date(r["handoffAt"] as string).toISOString(), reportedBy: "OWNER" } : null }
  })
  return { campaignId, revision: Number(campaigns[0]["revision"]), deliverables, note: "Inquiries are recorded submissions, not qualified leads, revenue or causal lift. Test submissions are excluded. Existing published versions remain live when a draft changes, until withdrawn or separately replaced." }
})

/** Runs the pre-launch checks on a linked revision once and keeps them; the same revision is never checked twice. */
const checkBinding = (ctx: Pick<ToolContext, "accountId" | "businessId">, bindingId: string) => Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const kept = (yield* sql`SELECT findings FROM campaign_deliverable_checks WHERE binding_id=${bindingId} AND business_id=${ctx.businessId}`)[0]
  if (kept) return kept["findings"] as ReadonlyArray<Finding>
  const row = (yield* sql`SELECT b.content_digest,v.content,a.format FROM campaign_artifact_bindings b JOIN agent_artifact_versions v ON v.artifact_id=b.artifact_id AND v.version=b.artifact_version
    JOIN agent_artifacts a ON a.id=b.artifact_id WHERE b.id=${bindingId} AND b.business_id=${ctx.businessId}`)[0]
  if (!row) return yield* refuse("NotFound")
  const facts = (yield* sql`SELECT predicate,value_text FROM authoritative_facts WHERE business_id=${ctx.businessId} AND status='ACTIVE' LIMIT 500`).map(f => `${f["predicate"]}: ${f["value_text"]}`)
  const avoid = (yield* sql`SELECT avoid_phrases FROM marketing_strategy_versions WHERE business_id=${ctx.businessId} AND status='APPROVED'`)[0]?.["avoid_phrases"] as string[] | undefined
  const findings = (yield* checkDeliverable(row["format"] === "HTML" ? "HTML" : "MARKDOWN", String(row["content"]), facts, true, avoid ?? [])).slice(0, 60)
  yield* sql`INSERT INTO campaign_deliverable_checks(binding_id,business_id,content_digest,findings,blocking)
    VALUES (${bindingId},${ctx.businessId},${String(row["content_digest"])},${JSON.stringify(findings)}::jsonb,${blockingCount(findings)}) ON CONFLICT (binding_id) DO NOTHING`
  return findings
})

export const prepareCampaignPublication = (ctx: ToolContext, raw: unknown) => Effect.gen(function*() {
  const input = yield* Schema.decodeUnknown(PrepareInput, { onExcessProperty: "error" })(raw)
  yield* scoped(ctx)
  const origin = publicationOrigin()
  if (!origin || !cipher()) return yield* refuse("PublishingNotConfigured")
  const sql = yield* SqlClient.SqlClient
  const binding = (yield* sql`SELECT b.*,a.format FROM campaign_artifact_bindings b JOIN agent_artifacts a ON a.id=b.artifact_id WHERE b.id=${input.bindingId} AND b.business_id=${ctx.businessId}`)[0]
  if (!binding) return yield* refuse("NotFound")
  const progress = yield* campaignDeliveryProgress(ctx, String(binding["campaign_id"]))
  const current = progress.deliverables.find(d => d["bindingId"] === input.bindingId)
  if (!current || current.stale) return yield* refuse("StaleBinding")
  if (current.channel !== "WEBSITE") return yield* refuse("NotAWebsiteDeliverable")
  const findings = yield* checkBinding(ctx, input.bindingId)
  const page = token(), destination = `${origin}/p/${page}`
  const rows = yield* sql`INSERT INTO campaign_publications(business_id,binding_id,page_token,destination,cta_label,privacy_notice,prepared_by_user_id)
    VALUES (${ctx.businessId},${input.bindingId},${page},${destination},${input.ctaLabel.trim()},${input.privacyNotice.trim()},${ctx.userId})
    ON CONFLICT(binding_id) DO NOTHING RETURNING id`
  const publication = (yield* sql`SELECT id,destination,status,cta_label,privacy_notice FROM campaign_publications WHERE binding_id=${input.bindingId}`)[0]!
  if (publication["cta_label"] !== input.ctaLabel.trim() || publication["privacy_notice"] !== input.privacyNotice.trim()) return yield* refuse("PreparationChanged")
  const blocking = blockingCount(findings)
  return { publicationId: String(publication["id"]), destination: String(publication["destination"]), status: String(publication["status"]), reused: !rows.length, published: publication["status"] === "PUBLISHED",
    checks: { blocking, findings },
    nextAction: blocking ? "Approval is blocked by the checks below. Fix them with edit_artifact, link the new revision and prepare it again." : "Open the prelaunch test, submit a test inquiry, then review exact publication in Needs you. Preparing does not publish." }
})

const ownedPublication = (ctx: Pick<ToolContext, "accountId" | "businessId">, id: string) => Effect.gen(function*() {
  yield* scoped(ctx)
  const sql = yield* SqlClient.SqlClient
  const row = (yield* sql`SELECT p.*,b.artifact_id,b.artifact_version,b.content_digest,b.campaign_id,b.campaign_revision,b.task_id,v.title,v.content,a.format,a.version AS current_artifact_version,c.revision AS current_campaign_revision,a.archived_at
    FROM campaign_publications p JOIN campaign_artifact_bindings b ON b.id=p.binding_id JOIN agent_artifact_versions v ON v.artifact_id=b.artifact_id AND v.version=b.artifact_version
    JOIN agent_artifacts a ON a.id=b.artifact_id JOIN marketing_campaigns c ON c.id=b.campaign_id
    WHERE p.id=${id} AND p.business_id=${ctx.businessId}`)[0]
  if (!row) return yield* refuse("NotFound")
  return row
})
export const approveCampaignPublication = (session: Session, businessId: string, id: string, raw: unknown) => Effect.gen(function*() {
  const input = yield* Schema.decodeUnknown(Approval, { onExcessProperty: "error" })(raw)
  const ctx = { ...session, businessId }
  yield* scoped(ctx)
  const sql = yield* SqlClient.SqlClient
  return yield* sql.withTransaction(Effect.gen(function*() {
    const p = yield* ownedPublication(ctx, id)
    // Lock the campaign and artifact so an edit cannot slip between freshness and approval.
    yield* sql`SELECT id FROM marketing_campaigns WHERE id=${p["campaign_id"] as string} FOR UPDATE`
    yield* sql`SELECT id FROM agent_artifacts WHERE id=${p["artifact_id"] as string} FOR UPDATE`
    const current = yield* ownedPublication(ctx, id)
    if (input.artifactVersion !== Number(current["artifact_version"]) || input.contentDigest !== current["content_digest"] || input.destination !== current["destination"]) return yield* refuse("ApprovalMismatch")
    if (current["status"] === "PUBLISHED") return { published: true, destination: String(current["destination"]), reused: true }
    if (current["status"] !== "PREPARED") return yield* refuse("AlreadyDecided")
    if (Number(current["current_artifact_version"]) !== Number(current["artifact_version"]) || Number(current["current_campaign_revision"]) !== Number(current["campaign_revision"]) || current["archived_at"] !== null) return yield* refuse("StaleBinding")
    if (input.artifactVersion !== Number(current["artifact_version"]) || input.contentDigest !== current["content_digest"] || input.destination !== current["destination"]) return yield* refuse("ApprovalMismatch")
    if (!cipher()) return yield* refuse("PublishingNotConfigured")
    const latest = yield* campaignDeliveryProgress(ctx, String(current["campaign_id"]))
    if (!latest.deliverables.some(d => d["bindingId"] === current["binding_id"] && !d.stale)) return yield* refuse("StaleBinding")
    const checks = (yield* sql`SELECT blocking FROM campaign_deliverable_checks WHERE binding_id=${current["binding_id"] as string}`)[0]
    if (!checks) return yield* refuse("ChecksMissing")
    if (Number(checks["blocking"]) > 0) return yield* refuse("ChecksBlocking")
    const tested = yield* sql`SELECT 1 FROM campaign_inquiries WHERE publication_id=${id} AND purpose='TEST'`
    if (!tested.length) return yield* refuse("TrackingNotTested")
    const rows = yield* sql`UPDATE campaign_publications SET status='PUBLISHED',published_at=now(),decided_at=now(),decided_by_user_id=${session.userId}
      WHERE id=${id} AND status='PREPARED' RETURNING destination`
    if (!rows.length) return yield* refuse("AlreadyDecided")
    return { published: true, destination: String(rows[0]!["destination"]), reused: false }
  }))
})

const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
const html = (body: string, extra: Record<string, string> = {}) => HttpServerResponse.text(body, { headers: { ...PRIVATE, "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'", ...extra } })
const ticket = (publicationId: string, purpose: "TEST" | "PRODUCTION", linkId: string | null = null) => Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const value = token()
  yield* sql`DELETE FROM campaign_form_tickets WHERE expires_at<now() AND consumed_at IS NULL`
  yield* sql.withTransaction(Effect.gen(function*() {
    yield* sql`SELECT id FROM campaign_publications WHERE id=${publicationId} FOR UPDATE`
    const recent = yield* sql`SELECT count(*)::int AS n FROM campaign_form_tickets WHERE publication_id=${publicationId} AND created_at>now()-interval '1 minute'`
    if (Number(recent[0]!["n"]) >= 60) return yield* refuse("RateLimited")
    yield* sql`INSERT INTO campaign_form_tickets(token_digest,publication_id,purpose,link_id) VALUES (${digest(value)},${publicationId},${purpose},${linkId})`
  }))
  return value
})
export const testCampaignPublication = (ctx: ToolContext, id: string) => Effect.gen(function*() {
  const p = yield* ownedPublication(ctx, id)
  if (p["status"] !== "PREPARED") return yield* refuse("AlreadyDecided")
  const t = yield* ticket(id, "TEST")
  return { publicationId: id, testUrl: `${publicationOrigin()}/p/${p["page_token"]}?test=${t}`, note: "Submit this test form yourself. The agent cannot attest tracking or create the test event. Test contact details are discarded." }
})

export const campaignPublicationDeclarations: ReadonlyArray<ToolDeclaration> = [
  { name: "bind_campaign_artifact", description: "Link a real saved artifact revision to a campaign deliverable. Read the campaign and artifact first. Notes alone are not finished deliverables. Repeating the same link reuses it; edits require a new exact revision link. Never publishes or approves.", parametersJsonSchema: JSONSchema.make(BindInput) },
  { name: "prepare_campaign_publication", description: "Prepare the exact linked artifact as an OpenRecord-hosted campaign page with an inquiry form, no repository or CMS connection required. This is a campaign URL, not the business's main website. Provide the CTA label and a truthful notice explaining how the business will use an inquiry. Requires operator prelaunch test and exact approval in Needs you. Never publishes, submits tests or approves.", parametersJsonSchema: JSONSchema.make(PrepareInput) },
  { name: "read_campaign_delivery", description: "Read exact artifact revisions, publication status, test readiness and recorded inquiry counts for a campaign. A draft or approval is not a marketing outcome. Counts exclude prelaunch tests and do not establish qualified leads or lift.", parametersJsonSchema: JSONSchema.make(ScopeInput) },
  { name: "open_campaign_prelaunch_test", description: "Issue a prelaunch test URL for the operator to open and submit. Uses the same page and form handler as publication. The test proves server receipt of a test inquiry, not production delivery or marketing impact. Never submit it on behalf of the user or claim tested from issuing a link.", parametersJsonSchema: JSONSchema.make(PublicationInput) },
]
export const dispatchCampaignPublication = (ctx: ToolContext, name: string, raw: unknown) => Effect.gen(function*() {
  const data = name === "bind_campaign_artifact" ? yield* bindCampaignArtifact(ctx, raw)
    : name === "prepare_campaign_publication" ? yield* prepareCampaignPublication(ctx, raw)
    : name === "read_campaign_delivery" ? yield* campaignDeliveryProgress(ctx, (yield* Schema.decodeUnknown(ScopeInput)(raw)).campaignId)
    : yield* testCampaignPublication(ctx, (yield* Schema.decodeUnknown(PublicationInput)(raw)).publicationId)
  return { summary: "Campaign delivery record read or prepared; publication requires operator approval", citations: [], data }
})

/** Operator feed: contact data deliberately does not enter the agent tool registry. */
export const pendingCampaignPublications = (accountId: string, businessId: string) => Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  return yield* sql`SELECT p.id,p.prepared_at AS "createdAt",p.destination,p.cta_label AS "ctaLabel",p.privacy_notice AS "privacyNotice",
      b.artifact_id AS "artifactId",b.artifact_version AS "artifactVersion",b.content_digest AS "contentDigest",v.title,
      EXISTS(SELECT 1 FROM campaign_inquiries i WHERE i.publication_id=p.id AND i.purpose='TEST') AS "trackingTested",
      COALESCE(k.findings,'[]'::jsonb) AS "checks", COALESCE(k.blocking,0) AS "blocking", k.binding_id IS NOT NULL AS "checked",
      (a.version<>b.artifact_version OR a.archived_at IS NOT NULL OR c.revision<>b.campaign_revision OR EXISTS(
        SELECT 1 FROM campaign_artifact_bindings newer WHERE newer.campaign_id=b.campaign_id AND newer.task_id=b.task_id
          AND (newer.created_at,newer.id)>(b.created_at,b.id))) AS stale
    FROM campaign_publications p JOIN campaign_artifact_bindings b ON b.id=p.binding_id
    JOIN agent_artifact_versions v ON v.artifact_id=b.artifact_id AND v.version=b.artifact_version
    JOIN agent_artifacts a ON a.id=b.artifact_id JOIN marketing_campaigns c ON c.id=b.campaign_id
    LEFT JOIN campaign_deliverable_checks k ON k.binding_id=b.id
    JOIN businesses biz ON biz.id=p.business_id WHERE p.business_id=${businessId} AND biz.account_id=${accountId} AND p.status='PREPARED'`
})
const cleanupContacts = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql`UPDATE campaign_inquiries SET contact_ciphertext=NULL,purged_at=now() WHERE expires_at<now() AND purged_at IS NULL AND contact_ciphertext IS NOT NULL`
})
const publicationFailure = (e: unknown) => {
  if (typeof e === "object" && e !== null && "_tag" in e && e._tag === "NotAuthenticated") return json(401, { _tag: "NotAuthenticated" }, PRIVATE)
  if (e instanceof PublicationRefused) return json(e.reason === "NotFound" ? 404 : e.reason === "RateLimited" ? 429 : 409, { _tag: "PublicationRefused", reason: e.reason }, PRIVATE)
  if (typeof e === "object" && e !== null && "_tag" in e && e._tag === "ParseError") return json(422, { _tag: "InvalidRequest" }, PRIVATE)
  return json(503, { _tag: "PublicationUnavailable" }, PRIVATE)
}
export const campaignPublicationApi = (withSession: WithSession) => {
  const operator = operatorSessionFor(withSession)
  const scopedRoute = <E, R>(run: (ctx: ToolContext, id: string) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
    operator(session => Effect.gen(function*() {
      const { params } = yield* HttpRouter.RouteContext
      const businessId = params["id"] ?? "", id = params["publicationId"] ?? ""
      if (decodeRouteId(businessId)._tag === "Left" || (id && decodeRouteId(id)._tag === "Left")) return yield* refuse("NotFound")
      const ctx = { ...session, businessId }
      yield* scoped(ctx)
      return yield* run(ctx, id)
    })).pipe(Effect.catchAll(publicationFailure))
  const base = "/api/businesses/:id/campaign-publications"
  const publicPage = (content: boolean) => Effect.gen(function*() {
    const { params } = yield* HttpRouter.RouteContext
    const page = params["page"] ?? ""
    if (!TOKEN.test(page)) return yield* refuse("NotFound")
    const request = yield* HttpServerRequest.HttpServerRequest
    const test = new URL(request.url, "http://localhost").searchParams.get("test")
    const sql = yield* SqlClient.SqlClient
    const p = (yield* sql`SELECT p.*,a.format,v.title,v.content FROM campaign_publications p
      JOIN campaign_artifact_bindings b ON b.id=p.binding_id JOIN agent_artifact_versions v ON v.artifact_id=b.artifact_id AND v.version=b.artifact_version
      JOIN agent_artifacts a ON a.id=b.artifact_id WHERE p.page_token=${page}`)[0]
    if (!p || p["status"] === "WITHDRAWN" || p["status"] === "REJECTED") return yield* refuse("NotFound")
    const id = String(p["id"])
    if (test !== null) {
      if (!TOKEN.test(test)) return yield* refuse("NotFound")
      const allowed = yield* sql`SELECT 1 FROM campaign_form_tickets WHERE token_digest=${digest(test)} AND publication_id=${id} AND purpose='TEST' AND expires_at>now() AND consumed_at IS NULL`
      if (!allowed.length) return yield* refuse("NotFound")
    } else if (p["status"] !== "PUBLISHED") return yield* refuse("NotFound")
    if (content) return HttpServerResponse.text(artifactDocument({ format: p["format"] === "HTML" ? "HTML" : "MARKDOWN", title: String(p["title"]), content: String(p["content"]) }), { headers: PREVIEW_HEADERS })
    // A visit through an email's or post's own link is counted for that source too, and its inquiry carries the source.
    const source = new URL(request.url, "http://localhost").searchParams.get("s")
    const link = test === null && source && /^[A-Za-z0-9]{10}$/.test(source)
      ? (yield* sql`SELECT id FROM campaign_links WHERE code=${source} AND publication_id=${id}`)[0]?.["id"] as string | undefined : undefined
    if (test === null) yield* sql`INSERT INTO campaign_page_days(publication_id, day, views) VALUES (${id}, current_date, 1)
      ON CONFLICT (publication_id, day) DO UPDATE SET views = campaign_page_days.views + 1`
    if (link) yield* sql`INSERT INTO campaign_link_days(link_id, day, views) VALUES (${link}, current_date, 1)
      ON CONFLICT (link_id, day) DO UPDATE SET views = campaign_link_days.views + 1`
    const t = test ?? (yield* ticket(id, "PRODUCTION", link ?? null))
    const iframe = `/p/${page}/content${test ? `?test=${test}` : ""}`
    return html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(String(p["title"]))}</title><style>body{margin:0;font:17px/1.6 system-ui;color:#202020;background:#fff}iframe{display:block;width:100%;height:75vh;min-height:500px;border:0}section{max-width:680px;margin:32px auto;padding:24px}label,input,textarea{display:block;width:100%;box-sizing:border-box}input,textarea,button{font:inherit;padding:12px;margin:8px 0 20px}button{cursor:pointer}small{display:block}.consent{display:flex;gap:12px}.consent input{width:auto}h1{font-size:26px}</style></head><body>${test ? '<section role="status">Prelaunch test. Nothing is published. Test inquiries are excluded from results.</section>' : ""}<iframe sandbox title="Campaign content" src="${iframe}"></iframe><section><h1>${escape(String(p["cta_label"]))}</h1><form method="post" action="/p/${page}/inquiries"><input type="hidden" name="ticket" value="${t}"><label>Email<input type="email" name="email" maxlength="254" required autocomplete="email"></label><label>Your inquiry<textarea name="message" maxlength="2000" required></textarea></label><label class="consent"><input type="checkbox" name="consent" value="yes" required><span>${escape(String(p["privacy_notice"]))}</span></label><button type="submit">${escape(String(p["cta_label"]))}</button><small>This form records an inquiry for the business. Do not include sensitive information.</small></form></section></body></html>`, { "x-robots-tag": test ? "noindex, nofollow" : "index, follow" })
  }).pipe(Effect.catchAll(publicationFailure))
  return HttpRouter.empty.pipe(
    HttpRouter.get(`${base}/campaigns/:campaignId`, scopedRoute((ctx) => Effect.gen(function*() {
      const { params } = yield* HttpRouter.RouteContext
      const id = params["campaignId"] ?? ""
      if (decodeRouteId(id)._tag === "Left") return yield* refuse("NotFound")
      return yield* json(200, yield* campaignDeliveryProgress(ctx, id), PRIVATE)
    }))),
    HttpRouter.post(`${base}/:publicationId/test`, scopedRoute((ctx, id) => Effect.flatMap(testCampaignPublication(ctx, id), r => json(200, r, PRIVATE)))),
    HttpRouter.post(`${base}/:publicationId/approve`, scopedRoute((ctx, id) => Effect.gen(function*() { return yield* json(200, yield* approveCampaignPublication(ctx, ctx.businessId, id, yield* readJson), PRIVATE) }))),
    HttpRouter.post(`${base}/:publicationId/reject`, scopedRoute((ctx, id) => Effect.gen(function*() {
      yield* ownedPublication(ctx, id)
      const sql = yield* SqlClient.SqlClient
      const rows = yield* sql`UPDATE campaign_publications SET status='REJECTED',decided_at=now(),decided_by_user_id=${ctx.userId} WHERE id=${id} AND status='PREPARED' RETURNING id`
      if (!rows.length) return yield* refuse("AlreadyDecided")
      return yield* json(200, { rejected: true }, PRIVATE)
    }))),
    HttpRouter.post(`${base}/:publicationId/withdraw`, scopedRoute((ctx, id) => Effect.gen(function*() {
      yield* ownedPublication(ctx, id)
      const sql = yield* SqlClient.SqlClient
      const rows = yield* sql`UPDATE campaign_publications SET status='WITHDRAWN',withdrawn_at=now() WHERE id=${id} AND status='PUBLISHED' RETURNING id`
      return yield* json(200, { withdrawn: rows.length > 0 }, PRIVATE)
    }))),
    HttpRouter.get(`${base}/:publicationId/inquiries`, scopedRoute((ctx, id) => Effect.gen(function*() {
      yield* ownedPublication(ctx, id)
      yield* cleanupContacts
      const c = cipher()
      if (!c) return yield* refuse("PublishingNotConfigured")
      const sql = yield* SqlClient.SqlClient
      const rows = yield* sql`SELECT id,created_at,contact_ciphertext,ticket_digest FROM campaign_inquiries WHERE publication_id=${id} AND purpose='PRODUCTION' AND contact_ciphertext IS NOT NULL ORDER BY created_at DESC LIMIT 100`
      const inquiries = rows.map(r => ({ id: String(r["id"]), createdAt: r["created_at"], contact: c.decrypt(String(r["contact_ciphertext"]), `campaign-inquiry:${id}:${r["ticket_digest"]}`) }))
      return yield* json(200, { inquiries, coverage: "Latest 100 retained inquiries; contacts expire after 30 days" }, PRIVATE)
    }))),
    HttpRouter.get("/p/:page", publicPage(false)),
    HttpRouter.get("/p/:page/content", publicPage(true)),
    HttpRouter.post("/p/:page/inquiries", Effect.gen(function*() {
      const request = yield* HttpServerRequest.HttpServerRequest
      const { params } = yield* HttpRouter.RouteContext
      const page = params["page"] ?? ""
      if (!TOKEN.test(page)) return yield* refuse("NotFound")
      if (!request.headers["content-type"]?.startsWith("application/x-www-form-urlencoded")) return yield* refuse("InvalidSubmission")
      const body = yield* request.text
      if (Buffer.byteLength(body) > 12_000) return yield* refuse("InvalidSubmission")
      const fields = new URLSearchParams(body), t = fields.get("ticket") ?? ""
      if (!TOKEN.test(t)) return yield* refuse("InvalidSubmission")
      const contact = yield* Schema.decodeUnknown(Contact)({ email: fields.get("email"), message: fields.get("message"), consent: fields.get("consent") })
      const sql = yield* SqlClient.SqlClient
      yield* cleanupContacts
      const result = yield* sql.withTransaction(Effect.gen(function*() {
        const p = (yield* sql`SELECT id,status FROM campaign_publications WHERE page_token=${page} FOR UPDATE`)[0]
        if (!p || !["PREPARED", "PUBLISHED"].includes(String(p["status"]))) return yield* refuse("NotFound")
        const id = String(p["id"]), td = digest(t)
        const tickets = yield* sql`SELECT purpose,consumed_at,link_id FROM campaign_form_tickets WHERE token_digest=${td} AND publication_id=${id} AND expires_at>now()`
        const current = tickets[0]
        if (!current) return yield* refuse("InvalidSubmission")
        if (current["purpose"] === "PRODUCTION" && p["status"] !== "PUBLISHED") return yield* refuse("NotFound")
        if (current["consumed_at"] !== null) return { test: current["purpose"] === "TEST", reused: true }
        const count = yield* sql`SELECT count(*)::int AS n FROM campaign_inquiries WHERE publication_id=${id} AND created_at>now()-interval '1 hour'`
        if (Number(count[0]!["n"]) >= 100) return yield* refuse("RateLimited")
        const c = cipher()
        if (!c) return yield* refuse("PublishingNotConfigured")
        const test = current["purpose"] === "TEST"
        yield* sql`INSERT INTO campaign_inquiries(publication_id,ticket_digest,purpose,contact_ciphertext,link_id)
          VALUES (${id},${td},${test ? "TEST" : "PRODUCTION"},${test ? null : c.encrypt(JSON.stringify(contact), `campaign-inquiry:${id}:${td}`)},${test ? null : (current["link_id"] as string | null) ?? null})`
        yield* sql`UPDATE campaign_form_tickets SET consumed_at=now() WHERE token_digest=${td}`
        return { test, reused: false }
      }))
      return html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Inquiry received</title></head><body><main><h1>${result.test ? "Test inquiry received" : "Inquiry received"}</h1><p>${result.test ? "Tracking test recorded. This is excluded from campaign results. Return to OpenRecord to review publication." : "Your inquiry was recorded for the business."}</p></main></body></html>`, { "x-robots-tag": "noindex, nofollow" })
    }).pipe(HttpServerRequest.withMaxBodySize(Option.some(12_000)), Effect.catchAll(publicationFailure))),
  )
}
