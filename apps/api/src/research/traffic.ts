// AI crawler and AI referral traffic from the business's own server logs.
// The team uploads an access log (common or combined format, or JSON lines
// with the same fields); OpenRecord counts requests from AI crawlers and AI
// assistants fetching pages for a user, and visits referred by AI assistants,
// by day, page and status. Only aggregates are kept: no IP address, raw line
// or query string is stored.
//
// User agents are as claimed by the requester and are not verified against
// the crawler operators' published address ranges. Four different events are
// kept apart and never added together: a crawler fetching a page for
// training or search indexing, an assistant fetching a page while answering
// someone, a person arriving from an assistant (referral), and a customer.
import { createHash } from "node:crypto"
import { SqlClient } from "@effect/sql"
import { Effect, Schema } from "effect"
import { clean } from "./html.js"
import type { AnyCapability, Observed } from "./types.js"

export interface Bot { readonly agent: RegExp; readonly name: string; readonly owner: string; readonly kind: "TRAINING" | "SEARCH_INDEX" | "USER_FETCH" }
export const AI_AGENTS: ReadonlyArray<Bot> = [
  { agent: /GPTBot/i, name: "GPTBot", owner: "OpenAI", kind: "TRAINING" }, { agent: /OAI-SearchBot/i, name: "OAI-SearchBot", owner: "OpenAI", kind: "SEARCH_INDEX" },
  { agent: /ChatGPT-User/i, name: "ChatGPT-User", owner: "OpenAI", kind: "USER_FETCH" },
  { agent: /ClaudeBot/i, name: "ClaudeBot", owner: "Anthropic", kind: "TRAINING" }, { agent: /Claude-SearchBot/i, name: "Claude-SearchBot", owner: "Anthropic", kind: "SEARCH_INDEX" },
  { agent: /Claude-User/i, name: "Claude-User", owner: "Anthropic", kind: "USER_FETCH" }, { agent: /anthropic-ai/i, name: "anthropic-ai", owner: "Anthropic", kind: "TRAINING" },
  { agent: /PerplexityBot/i, name: "PerplexityBot", owner: "Perplexity", kind: "SEARCH_INDEX" }, { agent: /Perplexity-User/i, name: "Perplexity-User", owner: "Perplexity", kind: "USER_FETCH" },
  { agent: /Google-CloudVertexBot/i, name: "Google-CloudVertexBot", owner: "Google", kind: "TRAINING" }, { agent: /GoogleOther/i, name: "GoogleOther", owner: "Google", kind: "TRAINING" },
  { agent: /Applebot-Extended/i, name: "Applebot-Extended", owner: "Apple", kind: "TRAINING" }, { agent: /Applebot/i, name: "Applebot", owner: "Apple", kind: "SEARCH_INDEX" },
  { agent: /meta-externalagent/i, name: "meta-externalagent", owner: "Meta", kind: "TRAINING" }, { agent: /meta-externalfetcher/i, name: "meta-externalfetcher", owner: "Meta", kind: "USER_FETCH" },
  { agent: /Bytespider/i, name: "Bytespider", owner: "ByteDance", kind: "TRAINING" }, { agent: /Amazonbot/i, name: "Amazonbot", owner: "Amazon", kind: "SEARCH_INDEX" },
  { agent: /CCBot/i, name: "CCBot", owner: "Common Crawl", kind: "TRAINING" }, { agent: /DuckAssistBot/i, name: "DuckAssistBot", owner: "DuckDuckGo", kind: "USER_FETCH" },
  { agent: /MistralAI-User/i, name: "MistralAI-User", owner: "Mistral", kind: "USER_FETCH" }, { agent: /cohere-ai|cohere-training-data-crawler/i, name: "Cohere", owner: "Cohere", kind: "TRAINING" },
  { agent: /YouBot/i, name: "YouBot", owner: "You.com", kind: "SEARCH_INDEX" }, { agent: /Diffbot/i, name: "Diffbot", owner: "Diffbot", kind: "TRAINING" },
  { agent: /bingbot/i, name: "bingbot", owner: "Microsoft", kind: "SEARCH_INDEX" }, { agent: /Googlebot/i, name: "Googlebot", owner: "Google", kind: "SEARCH_INDEX" },
]
export const AI_REFERRERS: ReadonlyArray<readonly [RegExp, string]> = [
  [/(^|\.)chatgpt\.com$|(^|\.)chat\.openai\.com$/, "ChatGPT"], [/(^|\.)perplexity\.ai$/, "Perplexity"], [/(^|\.)claude\.ai$/, "Claude"],
  [/(^|\.)gemini\.google\.com$|(^|\.)bard\.google\.com$/, "Gemini"], [/(^|\.)copilot\.microsoft\.com$/, "Copilot"], [/(^|\.)meta\.ai$/, "Meta AI"],
  [/(^|\.)you\.com$/, "You.com"], [/(^|\.)chat\.deepseek\.com$/, "DeepSeek"], [/(^|\.)grok\.com$/, "Grok"], [/(^|\.)chat\.mistral\.ai$/, "Mistral"],
]

const MONTHS: Readonly<Record<string, string>> = { Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06", Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12" }
interface Line { readonly day: string; readonly path: string; readonly status: number; readonly referrer: string; readonly agent: string }
const COMBINED = /^\S+ \S+ \S+ \[(\d{2})\/(\w{3})\/(\d{4}):[^\]]+\] "(?:[A-Z]+) ([^ "]+)[^"]*" (\d{3}) \S+(?: "([^"]*)" "([^"]*)")?/
export const parseLine = (raw: string): Line | null => {
  const m = raw.match(COMBINED)
  if (m) return { day: `${m[3]}-${MONTHS[m[2]!] ?? "01"}-${m[1]}`, path: m[4]!.split("?")[0]!.slice(0, 300), status: Number(m[5]), referrer: m[6] ?? "", agent: m[7] ?? "" }
  if (raw.trimStart().startsWith("{")) {
    try {
      const j = JSON.parse(raw) as Record<string, unknown>
      const t = Date.parse(String(j["time"] ?? j["timestamp"] ?? j["@timestamp"] ?? ""))
      const path = String(j["path"] ?? j["uri"] ?? j["request_uri"] ?? j["url"] ?? "")
      if (!Number.isFinite(t) || !path) return null
      return { day: new Date(t).toISOString().slice(0, 10), path: path.replace(/^https?:\/\/[^/]+/, "").split("?")[0]!.slice(0, 300), status: Number(j["status"] ?? j["status_code"] ?? 0),
        referrer: String(j["referrer"] ?? j["referer"] ?? j["http_referer"] ?? ""), agent: String(j["user_agent"] ?? j["userAgent"] ?? j["http_user_agent"] ?? "") }
    } catch { return null }
  }
  return null
}

export const summariseLog = (text: string) => {
  let lines = 0, parsed = 0
  const bots = new Map<string, { owner: string; kind: Bot["kind"]; requests: number; ok: number; blocked: number; pages: Map<string, number>; days: Map<string, number> }>()
  const refs = new Map<string, { visits: number; pages: Map<string, number>; days: Map<string, number> }>()
  let first: string | null = null, last: string | null = null
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim()) continue
    lines++
    const l = parseLine(raw)
    if (!l) continue
    parsed++
    if (!first || l.day < first) first = l.day
    if (!last || l.day > last) last = l.day
    const bot = AI_AGENTS.find(b => b.agent.test(l.agent))
    if (bot) {
      const b = bots.get(bot.name) ?? { owner: bot.owner, kind: bot.kind, requests: 0, ok: 0, blocked: 0, pages: new Map(), days: new Map() }
      b.requests++; if (l.status >= 200 && l.status < 300) b.ok++; if (l.status === 401 || l.status === 403 || l.status === 429) b.blocked++
      b.pages.set(l.path, (b.pages.get(l.path) ?? 0) + 1); b.days.set(l.day, (b.days.get(l.day) ?? 0) + 1)
      bots.set(bot.name, b)
      continue
    }
    let host = ""
    try { host = l.referrer && l.referrer !== "-" ? new URL(l.referrer).hostname.toLowerCase() : "" } catch { host = "" }
    const ref = AI_REFERRERS.find(([re]) => re.test(host))
    if (ref && l.status < 400) {
      const r = refs.get(ref[1]) ?? { visits: 0, pages: new Map(), days: new Map() }
      r.visits++; r.pages.set(l.path, (r.pages.get(l.path) ?? 0) + 1); r.days.set(l.day, (r.days.get(l.day) ?? 0) + 1)
      refs.set(ref[1], r)
    }
  }
  const top = (m: Map<string, number>, n = 10) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([path, count]) => ({ path: clean(path, 300), count }))
  const byDay = (m: Map<string, number>) => [...m.entries()].sort().map(([day, count]) => ({ day, count }))
  return {
    lines, parsed, from: first, to: last,
    crawlers: [...bots.entries()].sort((a, b) => b[1].requests - a[1].requests).map(([name, b]) => ({ name, owner: b.owner, kind: b.kind, requests: b.requests, ok: b.ok, blocked: b.blocked, topPages: top(b.pages), byDay: byDay(b.days) })),
    referrals: [...refs.entries()].sort((a, b) => b[1].visits - a[1].visits).map(([assistant, r]) => ({ assistant, visits: r.visits, topLandingPages: top(r.pages), byDay: byDay(r.days) })),
  }
}

export const MAX_LOG_BYTES = 25_000_000
/** Saves one upload's aggregates as research evidence for the business. */
export const importTrafficLog = (ctx: { accountId: string; userId: string; businessId: string }, text: string, fileName: string | null) => Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const s = summariseLog(text)
  if (!s.parsed) return { saved: false as const, reason: "UNRECOGNIZED_FORMAT", lines: s.lines }
  const key = createHash("sha256").update(`traffic-log:${ctx.businessId}:${text}`).digest("hex")
  const findings = { label: "SEEN", ...s, fileName: clean(fileName, 120) }
  const coverage = { from: s.from, to: s.to, linesRead: s.lines, linesParsed: s.parsed,
    note: "From the uploaded log only. User agents are as claimed and not verified. Crawler requests, assistant page fetches, AI referral visits and customers are different events with different denominators; never add them up or read one as another." }
  const rows = yield* sql`INSERT INTO research_observations(account_id, business_id, request_key, source, operation, subject, question, params, status, findings, coverage, requested_by_user_id, observed_at)
    VALUES (${ctx.accountId}, ${ctx.businessId}, ${key}, 'TEAM_UPLOAD', 'ai.traffic_log', ${`log ${s.from ?? "?"} to ${s.to ?? "?"}`}, 'Server log upload: AI crawler and referral traffic',
      ${JSON.stringify({ fileName: clean(fileName, 120), bytes: Buffer.byteLength(text) })}::jsonb, 'OBSERVED', ${JSON.stringify(findings)}::jsonb, ${JSON.stringify(coverage)}::jsonb, ${ctx.userId}, now())
    ON CONFLICT (business_id, request_key) DO UPDATE SET updated_at = now() RETURNING id`
  return { saved: true as const, observationId: String(rows[0]!["id"]), from: s.from, to: s.to, linesParsed: s.parsed, crawlers: s.crawlers.length, referralAssistants: s.referrals.length }
})

const TrafficInput = Schema.Struct({ observationId: Schema.optional(Schema.UUID) })
export const TRAFFIC_CAPABILITIES: ReadonlyArray<AnyCapability> = [
  { id: "ai.traffic", platform: "ai-visibility", title: "AI crawler and AI referral traffic (uploaded logs)", source: "TEAM_UPLOAD", label: "SEEN", cache: "none",
    description: "From the server logs the team uploaded: requests by each AI crawler and assistant fetcher (training, search indexing, fetching for a user) with status and top pages, and visits referred by AI assistants (ChatGPT, Perplexity, Claude, Gemini, Copilot and others) with landing pages, by day.",
    input: TrafficInput, subject: () => "ai traffic",
    run: (ctx, i: typeof TrafficInput.Type) => Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const r = (yield* sql`SELECT id, findings, coverage, observed_at FROM research_observations WHERE business_id = ${ctx.businessId} AND operation = 'ai.traffic_log' AND status = 'OBSERVED'
        AND (${i.observationId ?? null}::uuid IS NULL OR id = ${i.observationId ?? null}::uuid) ORDER BY observed_at DESC LIMIT 1`)[0]
      if (!r) return { status: "NO_DATA", findings: {}, coverage: { note: "No server log uploaded yet. The team can upload an access log on the Channels page. AI crawler and referral traffic is unknown until then, not zero." } } satisfies Observed
      return { status: "OBSERVED", citations: [], findings: { ...(r["findings"] as object), uploadId: String(r["id"]) }, coverage: { ...(r["coverage"] as object), uploadedAt: new Date(r["observed_at"] as string).toISOString() } } satisfies Observed
    }) },
]
