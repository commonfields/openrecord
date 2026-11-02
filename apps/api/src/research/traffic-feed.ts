// Live AI crawler and AI referral traffic from the business's own host: a log
// drain posts access-log records continuously to the feed's URL with its
// secret token. Each request is classified with the same rules as uploaded
// logs (traffic.ts) and only daily aggregates per agent and page are kept.
//
//   POST   /api/businesses/:id/ai-traffic-feeds         create a feed (token shown once)
//   GET    /api/businesses/:id/ai-traffic-feeds         list feeds (never tokens)
//   DELETE /api/businesses/:id/ai-traffic-feeds/:feed   revoke
//   POST   /api/ai-traffic/feeds/:feed                  the drain: NDJSON, a JSON array or text log lines;
//                                                       gzip accepted; Authorization: Bearer <token>
//                                                       (or ?token= for drains that cannot set headers)
import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { gunzipSync } from "node:zlib"
import { SqlClient } from "@effect/sql"
import { HttpRouter, HttpServerRequest, type HttpServerResponse } from "@effect/platform"
import { Effect, Schema } from "effect"
import { BusinessRepository, type Session } from "@openrecord/db"
import { decode, json, operatorSessionFor, readJson, type WithSession } from "../record-routes.js"
import { AI_AGENTS, classify, parseLine, parseRecord, type Line } from "./traffic.js"
import type { AnyCapability, Observed } from "./types.js"

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex")
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const MAX_DRAIN_BYTES = 10_000_000
/** Distinct pages kept per agent and day in one delivery; the rest are counted under "(other pages)". */
const PAGES_PER_AGENT_DAY = 200

/** Records in one delivery: a JSON array, newline-delimited JSON, or text log lines. */
export const recordsOf = (text: string): { lines: Line[]; unrecognized: number } => {
  const lines: Line[] = []
  let unrecognized = 0
  const trimmed = text.trim()
  if (trimmed.startsWith("[")) {
    try {
      for (const r of JSON.parse(trimmed) as unknown[]) {
        const l = r && typeof r === "object" ? parseRecord(r as Record<string, unknown>) : null
        if (l) lines.push(l); else unrecognized++
      }
      return { lines, unrecognized }
    } catch { /* not one JSON array: read line by line */ }
  }
  for (const raw of trimmed.split(/\r?\n/)) {
    if (!raw.trim()) continue
    const l = parseLine(raw)
    if (l) lines.push(l); else unrecognized++
  }
  return { lines, unrecognized }
}

interface Agg { day: string; event: "CRAWLER" | "REFERRAL"; name: string; path: string; requests: number; ok: number; blocked: number }
/** Daily aggregates per event, agent and page; AI-unrelated requests are dropped. */
export const aggregate = (lines: ReadonlyArray<Line>): Agg[] => {
  const rows = new Map<string, Agg>()
  const pages = new Map<string, Set<string>>()
  for (const l of lines) {
    const c = classify(l)
    if (!c) continue
    const group = `${l.day}|${c.event}|${c.name}`
    const seen = pages.get(group) ?? new Set<string>()
    pages.set(group, seen)
    const path = seen.has(l.path) || seen.size < PAGES_PER_AGENT_DAY ? l.path : "(other pages)"
    seen.add(path)
    const key = `${group}|${path}`
    const a = rows.get(key) ?? { day: l.day, event: c.event, name: c.name, path, requests: 0, ok: 0, blocked: 0 }
    a.requests++
    if (l.status >= 200 && l.status < 300) a.ok++
    if (l.status === 401 || l.status === 403 || l.status === 429) a.blocked++
    rows.set(key, a)
  }
  return [...rows.values()]
}

const feedFor = (feedId: string, token: string) => Effect.gen(function*() {
  if (!UUID.test(feedId) || !/^orf_[A-Za-z0-9_-]{20,100}$/.test(token)) return null
  const sql = yield* SqlClient.SqlClient
  const r = (yield* sql`SELECT business_id, token_sha256 FROM ai_traffic_feeds WHERE id = ${feedId} AND revoked_at IS NULL`)[0]
  if (!r) return null
  const a = Buffer.from(String(r["token_sha256"]), "hex"), b = Buffer.from(sha256(token), "hex")
  return a.length === b.length && timingSafeEqual(a, b) ? { businessId: String(r["business_id"]) } : null
})

const ingest = (feedId: string, businessId: string, text: string) => Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const { lines, unrecognized } = recordsOf(text)
  const rows = aggregate(lines)
  yield* sql.withTransaction(Effect.gen(function*() {
    for (const a of rows) yield* sql`INSERT INTO ai_traffic_daily(business_id, day, event, name, path, requests, ok, blocked)
      VALUES (${businessId}, ${a.day}::date, ${a.event}, ${a.name}, ${a.path}, ${a.requests}, ${a.ok}, ${a.blocked})
      ON CONFLICT (business_id, day, event, name, path) DO UPDATE SET requests = ai_traffic_daily.requests + EXCLUDED.requests,
        ok = ai_traffic_daily.ok + EXCLUDED.ok, blocked = ai_traffic_daily.blocked + EXCLUDED.blocked`
    yield* sql`UPDATE ai_traffic_feeds SET last_received_at = now(), records_received = records_received + ${lines.length}, records_unrecognized = records_unrecognized + ${unrecognized} WHERE id = ${feedId}`
  }))
  return { received: lines.length + unrecognized, recognized: lines.length, unrecognized, aiEvents: rows.reduce((n, a) => n + a.requests, 0) }
})

const listFeeds = (accountId: string, businessId: string) => Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const iso = (v: unknown) => v ? new Date(v as string).toISOString() : null
  const rows = yield* sql`SELECT id, label, token_hint, created_at, revoked_at, last_received_at, records_received, records_unrecognized FROM ai_traffic_feeds
    WHERE account_id = ${accountId} AND business_id = ${businessId} ORDER BY created_at DESC LIMIT 20`
  return rows.map(r => ({ id: String(r["id"]), label: String(r["label"]), hint: String(r["token_hint"]), createdAt: iso(r["created_at"]), revokedAt: iso(r["revoked_at"]),
    lastReceivedAt: iso(r["last_received_at"]), recordsReceived: Number(r["records_received"]), recordsUnrecognized: Number(r["records_unrecognized"]), active: !r["revoked_at"] }))
})
const CreateFeed = Schema.Struct({ label: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(80)) })

export const aiTrafficFeedApi = (withSession: WithSession) => {
  const operator = operatorSessionFor(withSession)
  const scoped = <E, R>(run: (session: Session, businessId: string, feedId: string) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) =>
    operator((session: Session) => Effect.gen(function*() {
      const { params } = yield* HttpRouter.RouteContext
      const businessId = params["id"] ?? ""
      if (!UUID.test(businessId)) return yield* json(422, { _tag: "InvalidRequest" })
      if (!(yield* (yield* BusinessRepository).getScoped(session.accountId, businessId))) return yield* json(404, { _tag: "BusinessNotFound" })
      return yield* run(session, businessId, params["feed"] ?? "")
    })).pipe(Effect.catchAll(e => json(typeof e === "object" && e !== null && "_tag" in e && e._tag === "NotAuthenticated" ? 401 : 500, { _tag: "FeedsUnavailable" })))
  return HttpRouter.empty.pipe(
    HttpRouter.get("/api/businesses/:id/ai-traffic-feeds", scoped((s, businessId) => Effect.flatMap(listFeeds(s.accountId, businessId), feeds => json(200, { feeds }, { "cache-control": "no-store" })))),
    HttpRouter.post("/api/businesses/:id/ai-traffic-feeds", scoped((s, businessId) => Effect.gen(function*() {
      const body = decode(CreateFeed, yield* readJson)
      if (!body) return yield* json(422, { _tag: "InvalidRequest" })
      const token = `orf_${randomBytes(32).toString("base64url")}`
      const sql = yield* SqlClient.SqlClient
      const id = String((yield* sql`INSERT INTO ai_traffic_feeds(account_id, business_id, label, token_sha256, token_hint, created_by_user_id)
        VALUES (${s.accountId}, ${businessId}, ${body.label.trim()}, ${sha256(token)}, ${token.slice(-4)}, ${s.userId}) RETURNING id`)[0]!["id"])
      const req = yield* HttpServerRequest.HttpServerRequest
      const host = req.headers["x-forwarded-host"] ?? req.headers["host"] ?? "localhost:3001"
      const scheme = req.headers["x-forwarded-proto"] ?? (/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host) ? "http" : "https")
      return yield* json(201, { id, token, url: `${scheme}://${host}/api/ai-traffic/feeds/${id}`,
        note: "Shown once. Point the host's log drain at this URL with the header Authorization: Bearer <token> (or append ?token=<token> when the drain cannot set headers). Only daily counts per AI agent and page are kept." },
        { "cache-control": "no-store" })
    }))),
    HttpRouter.del("/api/businesses/:id/ai-traffic-feeds/:feed", scoped((s, businessId, feedId) => Effect.gen(function*() {
      if (!UUID.test(feedId)) return yield* json(422, { _tag: "InvalidRequest" })
      const sql = yield* SqlClient.SqlClient
      const done = yield* sql`UPDATE ai_traffic_feeds SET revoked_at = now() WHERE id = ${feedId} AND account_id = ${s.accountId} AND business_id = ${businessId} AND revoked_at IS NULL RETURNING id`
      return yield* json(done.length ? 200 : 404, done.length ? { revoked: feedId } : { _tag: "FeedNotFound" })
    }))),
    // The drain itself: authenticated by the feed's token only (no session, no browser origin).
    HttpRouter.post("/api/ai-traffic/feeds/:feed", Effect.gen(function*() {
      const { params } = yield* HttpRouter.RouteContext
      const req = yield* HttpServerRequest.HttpServerRequest
      const url = new URL(req.url, "http://localhost")
      const token = /^Bearer (\S+)$/.exec(req.headers["authorization"] ?? "")?.[1] ?? url.searchParams.get("token") ?? ""
      const feed = yield* feedFor(params["feed"] ?? "", token)
      if (!feed) return yield* json(401, { _tag: "FeedTokenRefused" })
      if (Number(req.headers["content-length"] ?? 0) > MAX_DRAIN_BYTES) return yield* json(413, { _tag: "DeliveryTooLarge", maxBytes: MAX_DRAIN_BYTES })
      const bytes = Buffer.from(yield* req.arrayBuffer)
      if (bytes.length > MAX_DRAIN_BYTES) return yield* json(413, { _tag: "DeliveryTooLarge", maxBytes: MAX_DRAIN_BYTES })
      let text: string
      try { text = (req.headers["content-encoding"] === "gzip" || (bytes[0] === 0x1f && bytes[1] === 0x8b) ? gunzipSync(bytes, { maxOutputLength: 5 * MAX_DRAIN_BYTES }) : bytes).toString("utf8") }
      catch { return yield* json(400, { _tag: "UnreadableDelivery" }) }
      // Some drains verify the URL with an empty request before sending.
      if (!text.trim()) return yield* json(200, { received: 0 })
      return yield* json(200, yield* ingest(params["feed"]!, feed.businessId, text))
    }).pipe(Effect.catchAll(() => json(500, { _tag: "FeedUnavailable" })))),
  )
}

// ---------------------------------------------------------------- capability

const LiveInput = Schema.Struct({ days: Schema.optional(Schema.Int.pipe(Schema.between(1, 365))) })
const OWNER = new Map(AI_AGENTS.map(b => [b.name, { owner: b.owner, kind: b.kind }]))
export const LIVE_TRAFFIC_CAPABILITIES: ReadonlyArray<AnyCapability> = [
  { id: "ai.traffic_live", platform: "ai-visibility", title: "Live AI crawler and AI referral traffic (log feed)", source: "CONNECTED_ACCOUNT", label: "SEEN", cache: "none",
    description: "From the business's live log feed over the last N days (default 28): requests by each AI crawler and assistant fetcher with successes, blocked responses and top pages, and visits referred by AI assistants with landing pages, by day.",
    input: LiveInput, subject: (i: typeof LiveInput.Type) => `ai traffic live ${i.days ?? 28}d`,
    run: (ctx, i: typeof LiveInput.Type) => Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const days = i.days ?? 28
      const feeds = yield* sql`SELECT count(*) FILTER (WHERE revoked_at IS NULL)::int AS active, max(last_received_at) AS last FROM ai_traffic_feeds WHERE business_id = ${ctx.businessId}`
      const active = Number(feeds[0]?.["active"] ?? 0), last = feeds[0]?.["last"] ? new Date(feeds[0]["last"] as string).toISOString() : null
      const rows = yield* sql`SELECT to_char(day, 'YYYY-MM-DD') AS day, event, name, path, requests, ok, blocked FROM ai_traffic_daily
        WHERE business_id = ${ctx.businessId} AND day >= (now() AT TIME ZONE 'UTC')::date - ${days}::int ORDER BY day`
      if (!rows.length) return { status: "NO_DATA", findings: {}, coverage: { activeFeeds: active, lastReceivedAt: last,
        note: active ? "The feed is connected but no AI crawler or AI referral request arrived in this period. That is what the feed saw, not proof of none elsewhere (other hosts or CDNs)." : "No live log feed is connected. The team can create one on the Channels page; until then this is unknown, not zero." } } satisfies Observed
      const group = (event: string) => {
        const by = new Map<string, { requests: number; ok: number; blocked: number; pages: Map<string, number>; days: Map<string, number> }>()
        for (const r of rows.filter(r => r["event"] === event)) {
          const name = String(r["name"]), g = by.get(name) ?? { requests: 0, ok: 0, blocked: 0, pages: new Map(), days: new Map() }
          const n = Number(r["requests"])
          g.requests += n; g.ok += Number(r["ok"]); g.blocked += Number(r["blocked"])
          g.pages.set(String(r["path"]), (g.pages.get(String(r["path"])) ?? 0) + n); g.days.set(String(r["day"]), (g.days.get(String(r["day"])) ?? 0) + n)
          by.set(name, g)
        }
        return [...by.entries()].sort((a, b) => b[1].requests - a[1].requests)
      }
      const top = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([path, count]) => ({ path, count }))
      const byDay = (m: Map<string, number>) => [...m.entries()].sort().map(([day, count]) => ({ day, count }))
      return { status: "OBSERVED", findings: { label: "SEEN", days,
        crawlers: group("CRAWLER").map(([name, g]) => ({ name, ...(OWNER.get(name) ?? {}), requests: g.requests, ok: g.ok, blocked: g.blocked, topPages: top(g.pages), byDay: byDay(g.days) })),
        referrals: group("REFERRAL").map(([assistant, g]) => ({ assistant, visits: g.requests, topLandingPages: top(g.pages), byDay: byDay(g.days) })) },
        coverage: { activeFeeds: active, lastReceivedAt: last, note: "From the business's live log feed only (the host that sends it). User agents are as claimed, not verified. Crawler requests, assistant page fetches, AI referral visits and customers are different events; never add them up or read one as another." } } satisfies Observed
    }) },
]
