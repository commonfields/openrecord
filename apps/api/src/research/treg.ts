// The treg tool catalog (treg.to) as a research source: thousands of
// third-party data APIs (SEO and backlinks, social, people and company data,
// ads libraries, scraping) behind one relay, each priced per call. OpenRecord
// uses treg as a service with the business's own token, connected on the
// Channels page, and every call is billed to that team's treg balance. Nothing
// of treg is embedded or copied here.
//
//   treg.search   find endpoints by what they do, with price and reliability
//   treg.call     run one endpoint's data read and save the answer as evidence
//
// treg.call reads the endpoint's entry first and runs only data reads: never an
// action (publishing, sending, changing an account), never a tool another team
// published, never a method that changes something, never an endpoint without a
// known price or above the per-call ceiling. The token never reaches the model,
// a saved observation or a log.
import { Effect, Option, Schema } from "effect"
import { credentialFor } from "./endpoints/run.js"
import { prepare, scrub, send } from "./endpoints/http.js"
import { provider as providerOf } from "./endpoints/providers.js"
import { refuse, type AnyCapability, type Observed, type Refused } from "./types.js"
import { ResearchHttp } from "./net.js"

const BASE = "https://treg.to"
/** The most one call may cost, in USD, unless the server sets TREG_MAX_CALL_USD. */
export const TREG_MAX_CALL_USD = () => {
  const n = Number(process.env["TREG_MAX_CALL_USD"])
  return Number.isFinite(n) && n > 0 && n <= 5 ? n : 0.25
}
const READ_KINDS = new Set(["data", "utility", "routed"])
// Currency, precision, and presentation fields describe the scalar USD
// price. Any billing extension needs a separate review before we run it.
const FIXED_PRICE_FIELDS = new Set(["type", "value", "currency", "per", "unit", "usd", "source", "source_url", "checked", "confidence", "note",
  "display", "display_usd", "display_unit", "display_prefix", "display_suffix", "trial_calls_per_team_day", "bills_miss"])
const ID = /^[a-z0-9][a-z0-9_.-]{2,199}$/

const tregProvider = () => providerOf("treg")!
const transport = Effect.map(Effect.serviceOption(ResearchHttp), Option.getOrUndefined)

/** One request to treg with the business's token; the token is scrubbed from what comes back. */
const ask = (token: string | null, req: { path: string; query?: Record<string, string | number | boolean | undefined>; headers?: Record<string, string> }) => Effect.gen(function*() {
  const p = tregProvider()
  const prepared = prepare(p, { method: "GET", url: `${BASE}${req.path}`, ...(req.query ? { query: req.query } : {}), ...(req.headers ? { headers: req.headers } : {}) }, { secret: token, bearer: null }, process.env)
  if ("refused" in prepared) return { ok: false as const, failure: "NOT_CONFIGURED" as const }
  const http = yield* transport
  const r = yield* Effect.promise(() => send(p, prepared, http))
  return r.ok && token ? { ...r, json: scrub(r.json, [token]), headers: scrub(r.headers, [token]) } : r
})

const NOT_CONNECTED = (): Refused => refuse("NOT_CONNECTED", "treg is not connected for this business. The team can add its own treg token on the Channels page; until then these sources are unknown, not zero.")
const failed = (failure: string): Refused => failure === "AUTH" ? refuse("RECONNECT_REQUIRED", "treg refused the business's token. Reconnect treg on the Channels page.")
  : failure === "PAYMENT_REQUIRED" ? refuse("PAYMENT_REQUIRED", "treg declined this charge. Check the team's balance or choose a cheaper read.")
  : failure === "RATE_LIMITED" ? refuse("RATE_LIMITED", "treg or the provider behind it is busy. Try again later.")
  : failure === "NOT_FOUND" ? refuse("UNKNOWN_ENDPOINT", "treg has no endpoint with that id. Search with treg.search and use an id it returns.")
  : refuse(failure, "treg did not answer this read.")

type Row = Record<string, unknown>
const Row = Schema.Record({ key: Schema.String, value: Schema.Unknown })
const parseRow = Schema.decodeUnknownEither(Row)
const cost = (row: Row): Row | null => {
  const parsed = parseRow(row["cost"])
  return parsed._tag === "Right" ? parsed.right : null
}
/** What the agent sees of one endpoint: enough to choose, never the raw catalog row. */
const brief = (row: Row) => {
  const c = cost(row)
  return { endpointId: String(row["id"]), provider: String(row["provider_display"] ?? row["provider"] ?? ""), name: String(row["name"] || row["summary"] || "").slice(0, 200),
    method: String(row["method"] ?? ""), kind: String(row["kind"] ?? ""), priceUsd: typeof c?.["usd"] === "number" ? c["usd"] : null, priceFor: c?.["type"] ?? null,
    verified: row["verified"] ?? null, observed: row["observed"] ?? null, runnable: readable(row) === null }
}

/** Why OpenRecord will not run this endpoint, or null when it is a data read it may run. */
export const readable = (row: Row): string | null => {
  const kind = String(row["kind"] ?? ""), method = String(row["method"] ?? "").toUpperCase(), c = cost(row)
  if (!READ_KINDS.has(kind)) return kind === "action" ? "It changes something (an action); OpenRecord only reads." : kind === "hub" ? "It is a tool another team published; OpenRecord only runs catalog reads." : `Its kind (${kind}) is not a data read.`
  if (method !== "GET") return "Only the catalog's GET endpoints are eligible for relay calls."
  if (row["async"] || row["platform_eligible"] === false) return "This endpoint needs a deferred job or another provider account."
  if (row["status"] && row["status"] !== "active") return "treg has paused or retired it."
  const usd = c?.["usd"], type = c?.["type"]
  if (typeof usd !== "number" || !Number.isFinite(usd) || usd < 0) return "treg lists no valid price for this endpoint."
  if (!c || (type !== "per_call" && type !== "per_success" && !(type === "free" && usd === 0))
    || (type !== "free" && c["currency"] !== "USD") || Object.keys(c).some(field => c[field] != null && !FIXED_PRICE_FIELDS.has(field)))
    return "treg does not list a fixed maximum charge for one call."
  if (usd > TREG_MAX_CALL_USD()) return `Its listed charge exceeds the $${TREG_MAX_CALL_USD()} per-call ceiling.`
  return null
}

const SearchInput = Schema.Struct({ need: Schema.String.pipe(Schema.minLength(2), Schema.maxLength(200)), limit: Schema.optional(Schema.Int.pipe(Schema.between(1, 20))) })
const CallInput = Schema.Struct({
  endpointId: Schema.String.pipe(Schema.pattern(ID)),
  query: Schema.optional(Schema.Record({ key: Schema.String.pipe(Schema.maxLength(80)), value: Schema.Union(Schema.String.pipe(Schema.maxLength(2000)), Schema.Number, Schema.Boolean) })
    .pipe(Schema.filter(query => Object.keys(query).length <= 30 && JSON.stringify(query).length <= 6000))),
})

const endpoint = (endpointId: string) => ask(null, { path: `/catalog/endpoints/${encodeURIComponent(endpointId)}` }).pipe(Effect.map(result => {
  if (!result.ok) return result
  const envelope = parseRow(result.json)
  if (envelope._tag === "Left") return { ok: false as const, failure: "MALFORMED" }
  const parsed = parseRow(envelope.right["endpoint"])
  return parsed._tag === "Right" && parsed.right["id"] === endpointId
    ? { ok: true as const, row: parsed.right } : { ok: false as const, failure: "MALFORMED" }
}))

/** Endpoints treg lists for a need, with price, reliability and whether OpenRecord may run each. */
export const tregSearch = (businessId: string, need: string, limit = 8) => Effect.gen(function*() {
  const token = yield* credentialFor(businessId, "treg")
  if (!token) return null
  const r = yield* ask(null, { path: "/catalog/search", query: { q: need, limit } })
  if (!r.ok) return null
  const parsed = parseRow(r.json)
  if (parsed._tag === "Left" || !Array.isArray(parsed.right["results"])) return null
  return parsed.right["results"].slice(0, limit).flatMap(item => {
    const row = parseRow(item)
    return row._tag === "Right" && typeof row.right["id"] === "string" && ID.test(row.right["id"]) ? [brief(row.right)] : []
  })
}).pipe(Effect.orElseSucceed(() => null))

export const TREG_CAPABILITIES: ReadonlyArray<AnyCapability> = [
  { id: "treg.search", platform: "treg", title: "Find a third-party data API in the treg catalog", source: "CONNECTED_ACCOUNT", label: "SEEN", cache: "day",
    description: "Searches treg's catalog of thousands of third-party data APIs (SEO and backlinks, social, people and company data, ad libraries, scraping) by what you need, with each endpoint's provider, price per call and measured reliability. Free. Run one with treg.call. Needs the business's own treg token on the Channels page.",
    input: SearchInput, subject: (i: typeof SearchInput.Type) => i.need.toLowerCase().slice(0, 200),
    availability: (ctx: { businessId: string }) => Effect.map(credentialFor(ctx.businessId, "treg").pipe(Effect.orElseSucceed(() => null)), t => t ? null : "Needs the business's own treg token on the Channels page"),
    availabilityKey: "treg",
    run: (ctx, i: typeof SearchInput.Type) => Effect.gen(function*() {
      const rows = yield* tregSearch(ctx.businessId, i.need, i.limit ?? 8)
      if (rows === null) return (yield* credentialFor(ctx.businessId, "treg")) ? failed("UNAVAILABLE") : NOT_CONNECTED()
      if (!rows.length) return { status: "NO_DATA", findings: {}, coverage: { provider: "treg", note: "treg lists nothing for this need. Unknown, not zero." } } satisfies Observed
      return { status: "OBSERVED", findings: { endpoints: rows }, coverage: { provider: "treg", note: "Prices are treg's, per call or per result as shown, billed to the team's treg balance. runnable: false means OpenRecord will not run it (why is given when you try)." } } satisfies Observed
    }) },
  { id: "treg.endpoint", platform: "treg", title: "Inspect one treg endpoint's inputs", source: "PUBLIC_API", label: "SEEN", cache: "day",
    description: "Read a treg endpoint's documented inputs, listed price and eligibility for OpenRecord relay calls.",
    input: Schema.Struct({ endpointId: Schema.String.pipe(Schema.pattern(ID)) }), subject: i => i.endpointId,
    run: (_ctx, i) => Effect.gen(function*() {
      const entry = yield* endpoint(i.endpointId)
      if (!entry.ok) return failed(entry.failure)
      return { status: "OBSERVED", findings: { endpoint: brief(entry.row), parameters: entry.row["input"] ?? null,
        eligibility: readable(entry.row) }, coverage: { provider: "treg" } } satisfies Observed
    }) },
  { id: "treg.call", platform: "treg", title: "Run one treg catalog data read", source: "CONNECTED_ACCOUNT", label: "SEEN", cache: "day",
    description: "Runs one eligible GET endpoint from treg.search with endpointId and the catalog's query parameters. Read treg.endpoint first. Eligible endpoints have a listed bounded price. The relay may bill the team's treg balance.",
    input: CallInput, subject: (i: typeof CallInput.Type) => i.endpointId,
    availability: (ctx: { businessId: string }) => Effect.map(credentialFor(ctx.businessId, "treg").pipe(Effect.orElseSucceed(() => null)), t => t ? null : "Needs the business's own treg token on the Channels page"),
    availabilityKey: "treg",
    run: (ctx, i: typeof CallInput.Type) => Effect.gen(function*() {
      const token = yield* credentialFor(ctx.businessId, "treg")
      if (!token) return NOT_CONNECTED()
      // The entry decides: read it before anything is called.
      const entry = yield* endpoint(i.endpointId)
      if (!entry.ok) return failed(entry.failure)
      // The details answer nests the endpoint's row under `endpoint`.
      const row = entry.row
      const why = readable(row)
      if (why) return refuse("NOT_A_READ", `Not run: ${why}`, { endpoint: brief(row) })
      // A routed endpoint may try several providers; treg stops it at this ceiling.
      const r = yield* ask(token, { path: `/call/${encodeURIComponent(i.endpointId)}`, ...(i.query ? { query: i.query } : {}),
        headers: { "x-treg-route-max-cost": String(TREG_MAX_CALL_USD()), ...(ctx.observationId ? { "idempotency-key": ctx.observationId } : {}) } })
      if (!r.ok) return failed(r.failure)
      const receipt = r.headers["x-treg-original-cost-micro"] ?? r.headers["x-treg-cost-micro"]
      const charged = receipt && /^\d+$/.test(receipt) ? Number(receipt) : Number.NaN
      // Long texts are shortened so one answer cannot crowd out the rest of the evidence.
      const answer = JSON.parse(JSON.stringify(r.json, (_k, v) => typeof v === "string" && v.length > 2000 ? `${v.slice(0, 2000)}…` : v)) as unknown
      return { status: "OBSERVED", findings: { endpointId: i.endpointId, answer },
        coverage: { provider: "treg", endpoint: brief(row), charged: Number.isFinite(charged) ? `$${(charged / 1_000_000).toFixed(4)}` : "unknown", callId: r.headers["x-treg-call-id"] ?? null,
          note: `${String(row["provider_display"] ?? row["provider"])}'s data through treg, billed to the team's treg balance. Estimates are that provider's, not OpenRecord's.` } } satisfies Observed
    }) },
]
