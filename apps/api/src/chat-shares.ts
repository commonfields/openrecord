// Shared chats: one agent conversation as a revocable, read-only page for a
// client or teammate without an account.
//
//   POST   /api/businesses/:id/agent/conversations/:conversation/shares   create a link (shown once)
//   GET    /api/businesses/:id/agent/conversations/:conversation/shares   list links (never tokens)
//   DELETE /api/businesses/:id/agent/conversations/:conversation/shares/:share   revoke
//   GET    /api/shared/chats/:token                                       the public, read-only view
//
// Only the person who owns the conversation can share it. The public view
// reads the conversation as it is now, so later messages appear until the
// link expires or is revoked. It carries each message's author, text and
// citation labels: never the model's reasoning, tool internals, attachment
// contents, helper sessions or internal ids.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { SqlClient } from "@effect/sql"
import { HttpRouter, type HttpServerResponse } from "@effect/platform"
import { Effect, Schema } from "effect"
import { BusinessRepository, type Session } from "@openrecord/db"
import { decode, json, operatorSessionFor, readJson, type WithSession } from "./record-routes.js"

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex")
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const TOKEN = /^orc_[A-Za-z0-9_-]{30,80}$/
const PUBLIC_HEADERS = { "cache-control": "no-store", "x-robots-tag": "noindex, nofollow", "referrer-policy": "no-referrer" }

type Stored = { role?: unknown; text?: unknown; citations?: unknown; attachments?: unknown; origin?: unknown }
/** What a shared page may show of one stored message. */
export const publicMessage = (m: Stored) => {
  const role = m.role === "user" ? "user" : "agent"
  const citations = Array.isArray(m.citations) ? (m.citations as Array<{ kind?: unknown; text?: unknown }>).slice(0, 12)
    .map(c => ({ kind: String(c.kind ?? ""), text: String(c.text ?? "").slice(0, 300) })).filter(c => c.text) : []
  const files = Array.isArray(m.attachments) ? (m.attachments as Array<{ name?: unknown }>).map(a => String(a.name ?? "file").slice(0, 120)) : []
  return { role, text: String(m.text ?? "").slice(0, 20_000), citations, files }
}

const Create = Schema.Struct({ days: Schema.optional(Schema.Int.pipe(Schema.between(1, 90))) })

export const chatSharesApi = (withSession: WithSession) => {
  const operator = operatorSessionFor(withSession)
  /** The caller's own conversation in this business, or a refusal. */
  const owned = <E, R>(run: (s: Session, businessId: string, conversationId: string, shareId: string) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
    operator((s: Session) => Effect.gen(function*() {
      const { params } = yield* HttpRouter.RouteContext
      const businessId = params["id"] ?? "", conversationId = params["conversation"] ?? ""
      if (!UUID.test(businessId) || !UUID.test(conversationId)) return yield* json(422, { _tag: "InvalidRequest" })
      if (!(yield* (yield* BusinessRepository).getScoped(s.accountId, businessId))) return yield* json(404, { _tag: "BusinessNotFound" })
      const sql = yield* SqlClient.SqlClient
      const mine = yield* sql`SELECT 1 FROM agent_conversations WHERE id = ${conversationId} AND account_id = ${s.accountId} AND user_id = ${s.userId} AND business_id = ${businessId}`
      if (!mine.length) return yield* json(404, { _tag: "ConversationNotFound" })
      return yield* run(s, businessId, conversationId, params["share"] ?? "")
    })).pipe(Effect.catchAll(e => json(typeof e === "object" && e !== null && "_tag" in e && e._tag === "NotAuthenticated" ? 401 : 500, { _tag: "SharesUnavailable" })))
  const list = (conversationId: string) => Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const iso = (v: unknown) => v ? new Date(v as string).toISOString() : null
    const rows = yield* sql`SELECT id, token_hint, created_at, expires_at, revoked_at, last_viewed_at FROM agent_chat_shares WHERE conversation_id = ${conversationId} ORDER BY created_at DESC LIMIT 20`
    return rows.map(r => ({ id: String(r["id"]), hint: String(r["token_hint"]), createdAt: iso(r["created_at"]), expiresAt: iso(r["expires_at"]), lastViewedAt: iso(r["last_viewed_at"]),
      active: !r["revoked_at"] && Date.parse(String(iso(r["expires_at"]))) > Date.now() }))
  })
  const base = "/api/businesses/:id/agent/conversations/:conversation/shares"
  return HttpRouter.empty.pipe(
    HttpRouter.get(base, owned((_s, _b, conversationId) => Effect.flatMap(list(conversationId), shares => json(200, { shares }, { "cache-control": "no-store" })))),
    HttpRouter.post(base, owned((s, businessId, conversationId) => Effect.gen(function*() {
      const body = decode(Create, (yield* readJson) ?? {})
      if (!body) return yield* json(422, { _tag: "InvalidRequest" })
      const token = `orc_${randomBytes(32).toString("base64url")}`
      const sql = yield* SqlClient.SqlClient
      const r = (yield* sql`INSERT INTO agent_chat_shares(account_id, business_id, conversation_id, created_by_user_id, token_sha256, token_hint, expires_at)
        VALUES (${s.accountId}, ${businessId}, ${conversationId}, ${s.userId}, ${sha256(token)}, ${token.slice(-4)}, now() + make_interval(days => ${body.days ?? 14})) RETURNING id, expires_at`)[0]!
      return yield* json(201, { id: String(r["id"]), token, path: `/shared/${token}`, expiresAt: new Date(r["expires_at"] as string).toISOString() }, { "cache-control": "no-store" })
    }))),
    HttpRouter.del(`${base}/:share`, owned((_s, _b, conversationId, shareId) => Effect.gen(function*() {
      if (!UUID.test(shareId)) return yield* json(422, { _tag: "InvalidRequest" })
      const sql = yield* SqlClient.SqlClient
      const done = yield* sql`UPDATE agent_chat_shares SET revoked_at = now() WHERE id = ${shareId} AND conversation_id = ${conversationId} AND revoked_at IS NULL RETURNING id`
      return yield* json(done.length ? 200 : 404, done.length ? { shares: yield* list(conversationId) } : { _tag: "ShareNotFound" })
    }))),
    // The public view: the token is the only credential.
    HttpRouter.get("/api/shared/chats/:token", Effect.gen(function*() {
      const { params } = yield* HttpRouter.RouteContext
      const token = params["token"] ?? ""
      const notFound = json(404, { _tag: "SharedChatNotFound" }, PUBLIC_HEADERS)
      if (!TOKEN.test(token)) return yield* notFound
      const sql = yield* SqlClient.SqlClient
      const r = (yield* sql`SELECT s.id, s.token_sha256, s.expires_at, c.messages, c.last_reply->>'title' AS title, b.name AS business
        FROM agent_chat_shares s JOIN agent_conversations c ON c.id = s.conversation_id JOIN businesses b ON b.id = s.business_id
        WHERE s.token_sha256 = ${sha256(token)} AND s.revoked_at IS NULL AND s.expires_at > now() AND c.expires_at > now()`)[0]
      if (!r) return yield* notFound
      const a = Buffer.from(String(r["token_sha256"]), "hex"), b = Buffer.from(sha256(token), "hex")
      if (a.length !== b.length || !timingSafeEqual(a, b)) return yield* notFound
      yield* sql`UPDATE agent_chat_shares SET last_viewed_at = now() WHERE id = ${String(r["id"])}`
      // Messages another agent session posted are internal coordination, not the conversation.
      const messages = (Array.isArray(r["messages"]) ? r["messages"] as Stored[] : []).filter(m => !m.origin).map(publicMessage)
      return yield* json(200, { business: String(r["business"]), title: (r["title"] as string | null) ?? null, expiresAt: new Date(r["expires_at"] as string).toISOString(), messages,
        note: "Shared from OpenRecord. The agent's replies are AI-generated research and suggestions, not verified facts or completed work." }, PUBLIC_HEADERS)
    }).pipe(Effect.catchAll(() => json(500, { _tag: "SharedChatUnavailable" }, PUBLIC_HEADERS)))),
  )
}
