// Research gateway client: OpenRecord's server-side reads of external marketing
// research (search rankings, backlinks, estimated traffic history, competing
// domains, search results) through an operator-configured, metered research
// gateway. Nothing here is reachable by the model directly: the agent picks an
// operation from a closed list, OpenRecord builds the request, and only the
// operations below can ever be sent.
//
// The gateway contract this client relies on:
//   POST <base>/call/<endpoint id>  with the provider's JSON body passed through
//   <prefix>token                   the operator's gateway credential
//   <prefix>route-max-cost          per-call ceiling in USD; above it the gateway
//                                   refuses with 402 and charges nothing
//   Idempotency-Key                 a replay of the same request costs nothing
//   <prefix>meta                    up to five key=value tags set by OpenRecord
//   <prefix>cost-micro              what the call was charged, integer micro-USD
//   <prefix>call-id                 the gateway's call record
//   <prefix>error: 1                the refusal is the gateway's, not the provider's
//   <prefix>upstream-failed         the provider answered 2xx but said it failed
// The header prefix and the endpoint id behind each operation are operator
// configuration, so the provider choice lives in deployment settings.
//
// The data source behind every operation answers with a task envelope: HTTP 200
// even on failure, an envelope status_code, and exactly one task with its own
// status_code (20000 means OK on both). A failed task is a failure, never an
// empty result. Every value the provider computes (search volume, estimated
// traffic, rank) is labelled ESTIMATED; only what was listed on a date (a
// result's position for a query) is SEEN.
import { createHash } from "node:crypto"
import { defaultTransport, isForbiddenIp, readCapped, type HttpTransport } from "@openrecord/representation"

export const RESEARCH_OPERATIONS = ["ranked_keywords", "backlink_profile", "traffic_history", "competing_domains", "search_results"] as const
export type ResearchOperation = typeof RESEARCH_OPERATIONS[number]

/** Markets OpenRecord can ask about: ISO country to the public Google geo target id and a default language. */
export const MARKETS: Readonly<Record<string, { readonly location: number; readonly language: string }>> = {
  US: { location: 2840, language: "en" }, GB: { location: 2826, language: "en" }, CA: { location: 2124, language: "en" },
  AU: { location: 2036, language: "en" }, IN: { location: 2356, language: "en" }, SG: { location: 2702, language: "en" },
  ID: { location: 2360, language: "id" }, MY: { location: 2458, language: "en" }, DE: { location: 2276, language: "de" },
  FR: { location: 2250, language: "fr" }, NL: { location: 2528, language: "nl" }, ES: { location: 2724, language: "es" },
  BR: { location: 2076, language: "pt" }, JP: { location: 2392, language: "ja" },
}

export interface GatewayConfig {
  readonly baseUrl: string
  readonly token: string
  readonly headerPrefix: string
  /** Operation to the gateway endpoint id that serves it; an operation without one is not available. */
  readonly routes: Readonly<Partial<Record<ResearchOperation, string>>>
  /** Per-call ceiling passed to the gateway. */
  readonly maxCallMicro: number
  /** Per business per UTC day. Zero means no research budget was approved. */
  readonly dailyBudgetMicro: number
}

const usdToMicro = (raw: string | undefined, fallback: number) => {
  const n = raw === undefined || raw.trim() === "" ? NaN : Number(raw)
  return Number.isFinite(n) && n >= 0 && n <= 1000 ? Math.round(n * 1_000_000) : fallback
}
const ENDPOINT_ID = /^[a-z0-9][a-z0-9._-]{1,160}$/i

/**
 * RESEARCH_GATEWAY_URL (https), RESEARCH_GATEWAY_TOKEN, RESEARCH_GATEWAY_ROUTES
 * (JSON object, operation to endpoint id), RESEARCH_GATEWAY_HEADER_PREFIX,
 * RESEARCH_MAX_CALL_USD (default 0.05) and RESEARCH_DAILY_BUDGET_USD (default 0,
 * meaning no billable research until an operator approves a budget).
 * Null when the gateway is not configured.
 */
export const gatewayConfigFromEnv = (env: NodeJS.ProcessEnv): GatewayConfig | null => {
  const baseUrl = env["RESEARCH_GATEWAY_URL"]?.trim(), token = env["RESEARCH_GATEWAY_TOKEN"]?.trim()
  if (!baseUrl || !token) return null
  let url: URL
  try { url = new URL(baseUrl) } catch { return null }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return null
  const routes: Partial<Record<ResearchOperation, string>> = {}
  try {
    const parsed = JSON.parse(env["RESEARCH_GATEWAY_ROUTES"] ?? "{}") as Record<string, unknown>
    for (const op of RESEARCH_OPERATIONS) { const id = parsed[op]; if (typeof id === "string" && ENDPOINT_ID.test(id)) routes[op] = id }
  } catch { /* no routes: every operation reads as not available */ }
  const prefix = (env["RESEARCH_GATEWAY_HEADER_PREFIX"]?.trim() || "x-gateway-").toLowerCase()
  return {
    baseUrl: `${url.origin}${url.pathname.replace(/\/+$/, "")}`, token, routes,
    headerPrefix: /^[a-z][a-z0-9-]{0,30}-$/.test(prefix) ? prefix : "x-gateway-",
    maxCallMicro: usdToMicro(env["RESEARCH_MAX_CALL_USD"], 50_000),
    dailyBudgetMicro: usdToMicro(env["RESEARCH_DAILY_BUDGET_USD"], 0),
  }
}

// ---------------------------------------------------------------- requests

export interface ResearchInput {
  readonly domain: string
  readonly market: string
  readonly keyword?: string | undefined
  readonly months?: number | undefined
  readonly limit?: number | undefined
}

/** A public hostname as the provider expects it: lowercase, no scheme, www or path. Null when it is not one. */
export const normalizeDomain = (raw: string): string | null => {
  const s = raw.trim().toLowerCase()
  let host: string
  try { host = new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(s) ? s : `https://${s}`).hostname } catch { return null }
  host = host.replace(/^www\./, "").replace(/\.$/, "")
  if (!/^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host)) return null
  if (/(^|\.)(localhost|local|internal|test|example|invalid|onion)$/.test(host)) return null
  return host
}

const utcDate = (d: Date) => d.toISOString().slice(0, 10)
/** The provider's task body: an array of exactly one task. */
export const buildTask = (op: ResearchOperation, input: ResearchInput, now = new Date()): unknown[] => {
  const market = MARKETS[input.market] ?? MARKETS["US"]!
  const base = { location_code: market.location, language_code: market.language }
  const limit = input.limit ?? 20
  switch (op) {
    case "ranked_keywords": return [{ target: input.domain, ...base, limit, order_by: ["keyword_data.keyword_info.search_volume,desc"] }]
    case "backlink_profile": return [{ target: input.domain, internal_list_limit: 10 }]
    case "traffic_history": {
      const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (input.months ?? 12), 1))
      return [{ target: input.domain, ...base, date_from: utcDate(from), date_to: utcDate(now) }]
    }
    case "competing_domains": return [{ target: input.domain, ...base, limit: Math.min(limit, 20) }]
    case "search_results": return [{ keyword: input.keyword ?? "", ...base, depth: Math.min(Math.max(limit, 10), 30) }]
  }
}

// ---------------------------------------------------------------- the call

export type GatewayFailure =
  | "NOT_PUBLIC" | "OVER_CALL_LIMIT" | "BALANCE_EXHAUSTED" | "RATE_LIMITED" | "AUTH" | "PROVIDER_FAILED"
  | "IN_FLIGHT" | "KEY_CONFLICT" | "UNAVAILABLE" | "MALFORMED"
export type GatewayAnswer =
  | { readonly ok: true; readonly json: unknown; readonly costMicro: number; readonly callId: string | null; readonly replay: boolean }
  | { readonly ok: false; readonly failure: GatewayFailure; readonly costMicro: number; readonly callId: string | null; readonly retryAfterS: number | null }

const MAX_RESPONSE = 4_000_000
const shortHash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16)

/** Tags the gateway records on the call: hashed tenant ids and the operation, never names or text. */
export const callMeta = (accountId: string, businessId: string, op: ResearchOperation) =>
  `tenant=${shortHash(`account:${accountId}`)},business=${shortHash(`business:${businessId}`)},op=${op},app=openrecord`

export async function gatewayCall(config: GatewayConfig, endpointId: string, body: unknown,
  opts: { readonly idempotencyKey: string; readonly meta: string }, transport: HttpTransport = defaultTransport(30_000)): Promise<GatewayAnswer> {
  const url = new URL(`${config.baseUrl}/call/${encodeURIComponent(endpointId)}`)
  const fail = (failure: GatewayFailure, costMicro = 0, callId: string | null = null, retryAfterS: number | null = null): GatewayAnswer =>
    ({ ok: false, failure, costMicro, callId, retryAfterS })
  let addresses: string[]
  try { addresses = await transport.lookup(url.hostname) } catch { return fail("UNAVAILABLE") }
  if (!addresses.length || addresses.some(isForbiddenIp)) return fail("NOT_PUBLIC")
  const p = config.headerPrefix
  const headers: Record<string, string> = {
    accept: "application/json", "content-type": "application/json", "user-agent": "OpenRecord-Research/1",
    [`${p}token`]: config.token, [`${p}route-max-cost`]: (config.maxCallMicro / 1_000_000).toFixed(6),
    [`${p}meta`]: opts.meta, "idempotency-key": opts.idempotencyKey,
  }
  let res
  try {
    res = await transport.fetch(url.toString(), { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(35_000), connectIp: addresses[0]!, servername: url.hostname })
  } catch { return fail("UNAVAILABLE") }
  const h = res.headers
  const costMicro = /^\d{1,12}$/.test(h[`${p}cost-micro`] ?? "") ? Number(h[`${p}cost-micro`]) : 0
  const callId = /^[A-Za-z0-9._:-]{1,120}$/.test(h[`${p}call-id`] ?? "") ? h[`${p}call-id`]! : null
  const read = await readCapped(res.body, MAX_RESPONSE).catch(() => null)
  if (!read) return fail("UNAVAILABLE", costMicro, callId)
  let json: unknown = null
  try { json = JSON.parse(Buffer.from(read.bytes).toString("utf8")) } catch { json = null }
  const ownError = h[`${p}error`] === "1"
  const detail = (json && typeof json === "object" ? ((json as { detail?: unknown }).detail ?? json) : null) as { error?: unknown } | null
  const code = detail && typeof detail === "object" && typeof detail.error === "string" ? detail.error : ""
  const retryAfter = Number(h["retry-after"])
  const retryAfterS = Number.isFinite(retryAfter) && retryAfter >= 0 ? Math.min(Math.ceil(retryAfter), 3600) : null
  if (res.status === 402) return fail(code === "route_max_cost" ? "OVER_CALL_LIMIT" : ownError ? "BALANCE_EXHAUSTED" : "PROVIDER_FAILED", costMicro, callId)
  if (res.status === 429) return fail("RATE_LIMITED", costMicro, callId, retryAfterS)
  if (res.status === 401 || res.status === 403) return fail(ownError ? "AUTH" : "PROVIDER_FAILED", costMicro, callId)
  if (res.status === 409) return fail("IN_FLIGHT", costMicro, callId, retryAfterS)
  if (res.status === 422 && ownError) return fail("KEY_CONFLICT", costMicro, callId)
  if (res.status < 200 || res.status >= 300) return fail(res.status >= 500 || ownError ? "UNAVAILABLE" : "PROVIDER_FAILED", costMicro, callId)
  if (h[`${p}capacity`] === "exhausted") return fail("UNAVAILABLE", costMicro, callId)
  if (h[`${p}upstream-failed`]) return fail("PROVIDER_FAILED", costMicro, callId)
  if (read.truncated || json === null) return fail("MALFORMED", costMicro, callId)
  return { ok: true, json, costMicro, callId, replay: Boolean(h[`${p}idempotent-replay`]) }
}

// ---------------------------------------------------------------- answers

/** Third-party text is shortened and stripped of control characters; it stays quoted data. */
export const clean = (v: unknown, max = 200): string | null => typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, " ").replace(/\s+/g, " ").trim().slice(0, max) || null : null
const num = (v: unknown): number | null => typeof v === "number" && Number.isFinite(v) ? v : null
const obj = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {}
const arr = (v: unknown): unknown[] => Array.isArray(v) ? v : []
const urlOf = (v: unknown): string | null => { const s = clean(v, 500); if (!s) return null; try { const u = new URL(s); return /^https?:$/.test(u.protocol) ? u.href : null } catch { return null } }

export interface ParsedFindings {
  readonly status: "OBSERVED" | "NO_DATA"
  readonly findings: Record<string, unknown>
  readonly coverage: Record<string, unknown>
  /** The provider's own reported cost in micro-USD, when it reports one. */
  readonly providerCostMicro: number | null
}
export type ParseResult = ParsedFindings | { readonly failed: "PROVIDER_FAILED" | "MALFORMED" }

/** Checks the task envelope and returns the one task's first result. */
const taskResult = (json: unknown): { result: Record<string, unknown> | null; cost: number | null } | { failed: "PROVIDER_FAILED" | "MALFORMED" } => {
  const env = obj(json)
  if (typeof env["status_code"] !== "number" || !Array.isArray(env["tasks"])) return { failed: "MALFORMED" }
  if (env["status_code"] !== 20000) return { failed: "PROVIDER_FAILED" }
  const tasks = arr(env["tasks"])
  if (tasks.length !== 1) return { failed: "MALFORMED" }
  const task = obj(tasks[0])
  if (task["status_code"] !== 20000) return { failed: "PROVIDER_FAILED" }
  const cost = num(task["cost"]) ?? num(env["cost"])
  return { result: arr(task["result"]).length ? obj(arr(task["result"])[0]) : null, cost: cost === null ? null : Math.round(cost * 1_000_000) }
}

const ESTIMATE = "Provider estimate from its own keyword database and click models; not measured visits, sales or rankings in any search engine's own reports."

export const parseFindings = (op: ResearchOperation, json: unknown, input: ResearchInput, observedAt: Date): ParseResult => {
  const t = taskResult(json)
  if ("failed" in t) return t
  const r = t.result
  const base = { market: input.market, observedAt: observedAt.toISOString() }
  const empty = (why: string): ParsedFindings => ({ status: "NO_DATA", findings: {}, coverage: { ...base, note: `${why} Not seen is not zero: the provider's database may not cover this subject.` }, providerCostMicro: t.cost })
  if (!r) return empty("The provider returned no result.")
  const items = arr(r["items"])
  switch (op) {
    case "ranked_keywords": {
      if (!items.length) return empty("No ranked keywords were returned.")
      const keywords = items.slice(0, 50).map(raw => {
        const it = obj(raw), kd = obj(it["keyword_data"]), info = obj(kd["keyword_info"]), serp = obj(obj(it["ranked_serp_element"])["serp_item"])
        return { keyword: clean(kd["keyword"], 120), searchVolume: num(info["search_volume"]), position: num(serp["rank_group"]), type: clean(serp["type"], 30),
          url: urlOf(serp["url"]), intent: clean(obj(kd["search_intent_info"])["main_intent"], 30), checkedAt: clean(obj(kd["serp_info"])["last_updated_time"], 40) }
      })
      return { status: "OBSERVED", providerCostMicro: t.cost,
        findings: { label: "ESTIMATED", keywords },
        coverage: { ...base, sampleSize: keywords.length, totalAvailable: num(r["total_count"]), ordering: "highest estimated search volume first",
          note: `${ESTIMATE} Positions are the provider's last check of each result page, dated per keyword.` } }
    }
    case "backlink_profile": {
      return { status: "OBSERVED", providerCostMicro: t.cost,
        findings: { label: "ESTIMATED", backlinks: num(r["backlinks"]), referringDomains: num(r["referring_domains"]), referringMainDomains: num(r["referring_main_domains"]),
          brokenBacklinks: num(r["broken_backlinks"]), providerRank: num(r["rank"]), spamScore: num(r["backlinks_spam_score"]), firstSeen: clean(r["first_seen"], 40) },
        coverage: { ...base, note: "Counted from the provider's own web crawl; other crawlers report different totals. providerRank is the provider's 0 to 1000 scale, not a search engine metric." } }
    }
    case "traffic_history": {
      if (!items.length) return empty("No monthly history was returned.")
      const months = items.slice(0, 36).map(raw => {
        const it = obj(raw), m = obj(it["metrics"]), org = obj(m["organic"]), paid = obj(m["paid"])
        return { year: num(it["year"]), month: num(it["month"]), organicEstimatedTraffic: num(org["etv"]), organicKeywords: num(org["count"]),
          top3Keywords: (num(org["pos_1"]) ?? 0) + (num(org["pos_2_3"]) ?? 0), paidEstimatedTraffic: num(paid["etv"]), paidKeywords: num(paid["count"]) }
      }).filter(m => m.year !== null && m.month !== null).sort((a, b) => (a.year! - b.year!) || (a.month! - b.month!))
      return { status: months.length ? "OBSERVED" : "NO_DATA", providerCostMicro: t.cost,
        findings: { label: "ESTIMATED", months },
        coverage: { ...base, months: months.length, from: months[0] ? `${months[0].year}-${String(months[0].month).padStart(2, "0")}` : null,
          to: months.at(-1) ? `${months.at(-1)!.year}-${String(months.at(-1)!.month).padStart(2, "0")}` : null,
          note: `${ESTIMATE} A change between months can come from the provider refreshing its database or a search engine update as well as from the company's own work. Never present it as visits or as caused by an event.` } }
    }
    case "competing_domains": {
      const domains = items.slice(0, 20).map(raw => {
        const it = obj(raw), org = obj(obj(it["full_domain_metrics"] ?? it["metrics"])["organic"])
        return { domain: clean(it["domain"], 120), sharedKeywords: num(it["intersections"]), averagePosition: num(it["avg_position"]), organicEstimatedTraffic: num(org["etv"]) }
      }).filter(d => d.domain && d.domain !== input.domain)
      if (!domains.length) return empty("No competing domains were returned.")
      return { status: "OBSERVED", providerCostMicro: t.cost, findings: { label: "ESTIMATED", domains },
        coverage: { ...base, sampleSize: domains.length, note: "Competitors by shared ranking keywords in the provider's database: search overlap, not proof that buyers compare them." } }
    }
    case "search_results": {
      const results = items.filter(raw => obj(raw)["type"] === "organic").slice(0, 30).map(raw => {
        const it = obj(raw)
        return { position: num(it["rank_group"]), domain: clean(it["domain"], 120), url: urlOf(it["url"]), title: clean(it["title"], 160) }
      })
      if (!results.length) return empty("No organic results were returned.")
      return { status: "OBSERVED", providerCostMicro: t.cost, findings: { label: "SEEN", keyword: clean(r["keyword"], 120) ?? input.keyword ?? null, checkedAt: clean(r["datetime"], 40), results },
        coverage: { ...base, sampleSize: results.length, note: "One results page fetched once, for one location and language. Results vary by person, device and time; this is a snapshot, not a ranking report." } }
    }
  }
}
