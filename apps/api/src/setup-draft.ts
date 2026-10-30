// The agent drafts the setup brief from the website: what the business sells,
// to whom, why customers pick it, the likely marketing goal and what to count,
// and its main competitors. The person checks and confirms it in the setup
// flow; until then it is only a suggestion and nothing in it becomes a fact,
// a goal or a competitor list. Written once per setup, in its own chat.
import { randomUUID } from "node:crypto"
import { SqlClient } from "@effect/sql"
import { Cause, Effect, Either, Schema } from "effect"
import { SetupDraft } from "@openrecord/contracts"
import { lastSelection, production, type BriefSender } from "./growth-brief.js"

type Scope = { readonly accountId: string; readonly userId: string; readonly businessId: string }
export type DraftState = { readonly status: "RUNNING" } | { readonly status: "FAILED" } | { readonly status: "READY"; readonly value: SetupDraft }

export const DRAFT_PROMPT = (url: string) => `Draft the setup for this business from its website, ${url}.

First read the home page and up to four key pages (pricing, services or products, about) with read_web_pages; use map_website if you need to find them. If web search is available, search for its main competitors.

Then reply with only one JSON object and no other text:
{"businessName": "...", "category": "what it sells, in a few words", "audience": "who buys it, as specifically as the site shows", "valueProposition": "why customers pick it, one or two sentences in the business's own terms", "goalStatement": "the most likely marketing goal, such as More booked appointments", "conversionKind": "LEAD" or "SIGNUP" or "PURCHASE" or "BOOKING", "metricLabel": "what to count, such as Booked appointments", "competitors": [{"name": "...", "website": "https://..."}]}

Use only what the website and search results show. List up to five competitors that sell the same thing to the same buyers, or none if you can't tell. Don't save anything and don't start helpers.`

const cut = (v: unknown, n: number) => typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, n) : v
/** The draft from a model reply: the first JSON object in it, tidied to the schema's limits. */
export const parseDraft = (reply: string): SetupDraft | null => {
  const start = reply.indexOf("{"), end = reply.lastIndexOf("}")
  if (start < 0 || end <= start) return null
  let raw: Record<string, unknown>
  try { raw = JSON.parse(reply.slice(start, end + 1)) as Record<string, unknown> } catch { return null }
  const competitors = Array.isArray(raw["competitors"]) ? raw["competitors"].flatMap(c => {
    const o = c as Record<string, unknown>
    const name = cut(o?.["name"], 120), website = cut(o?.["website"], 300)
    return typeof name === "string" && name ? [{ name, ...(typeof website === "string" && /^https?:\/\/\S+$/.test(website) ? { website } : {}) }] : []
  }).slice(0, 8) : []
  const decoded = Schema.decodeUnknownEither(SetupDraft)({
    businessName: cut(raw["businessName"], 200), category: cut(raw["category"], 300), audience: cut(raw["audience"], 1000),
    valueProposition: cut(raw["valueProposition"], 2000), goalStatement: cut(raw["goalStatement"], 1000),
    conversionKind: typeof raw["conversionKind"] === "string" ? raw["conversionKind"].toUpperCase() : raw["conversionKind"],
    metricLabel: cut(raw["metricLabel"], 120), competitors,
  })
  return Either.isRight(decoded) ? decoded.right : null
}

/** The draft's state for a setup, starting it once the website has been read and before the brief is confirmed. */
export const setupDraft = <R = Effect.Effect.Context<ReturnType<typeof production>>>(scope: Scope, setupId: string, sender: BriefSender<R> = production as unknown as BriefSender<R>) => Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  // A server restart can interrupt the detached writer. Two model turns can
  // each last nine minutes, so only settle drafts older than both turn limits.
  yield* sql`UPDATE business_setups SET draft_status = 'FAILED'
    WHERE id = ${setupId} AND account_id = ${scope.accountId} AND business_id = ${scope.businessId}
      AND brief IS NULL AND draft_status = 'RUNNING' AND (draft_started_at IS NULL OR draft_started_at < now() - interval '25 minutes')`
  const row = (yield* sql`SELECT website_url, website_host, discovery_status, brief, draft, draft_status FROM business_setups WHERE id = ${setupId} AND account_id = ${scope.accountId} AND business_id = ${scope.businessId}`)[0]
  if (!row || row["brief"] !== null) return undefined
  if (row["draft_status"] === "READY") return { status: "READY", value: row["draft"] as SetupDraft } as DraftState
  if (row["draft_status"] === "RUNNING" || row["draft_status"] === "FAILED") return { status: row["draft_status"] } as DraftState
  if (row["discovery_status"] !== "DONE") return undefined
  const conversationId = randomUUID()
  const claimed = yield* sql.withTransaction(Effect.gen(function*() {
    const won = yield* sql`UPDATE business_setups SET draft_status = 'RUNNING', draft_started_at = now() WHERE id = ${setupId} AND draft_status IS NULL AND brief IS NULL RETURNING id`
    if (!won.length) return false
    yield* sql`INSERT INTO agent_conversations(id, account_id, business_id, user_id, archived_at, last_reply)
      VALUES (${conversationId}, ${scope.accountId}, ${scope.businessId}, ${scope.userId}, now(), ${JSON.stringify({ title: `Setting up ${String(row["website_host"])}` })}::jsonb)`
    yield* sql`UPDATE business_setups SET draft_conversation_id = ${conversationId} WHERE id = ${setupId}`
    return true
  }))
  if (claimed) yield* Effect.forkDaemon(writeDraft(scope, setupId, conversationId, String(row["website_url"]), sender))
  return { status: "RUNNING" } as DraftState
})

const writeDraft = <R>(scope: Scope, setupId: string, conversationId: string, url: string, sender: BriefSender<R>) => Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const selection = yield* lastSelection(scope)
  const send = (s: typeof selection) => sender(scope, { message: DRAFT_PROMPT(url), requestId: randomUUID(), conversationId, revision: 0, selection: s })
  let result: Either.Either<unknown, unknown> = yield* send(selection).pipe(Effect.either)
  if (Either.isLeft(result) && selection) result = yield* send(undefined).pipe(Effect.either)
  const reply = Either.isRight(result) ? (result.right as { reply?: unknown }).reply : null
  const draft = typeof reply === "string" ? parseDraft(reply) : null
  yield* draft
    ? sql`UPDATE business_setups SET draft_status = 'READY', draft = ${JSON.stringify(draft)}::jsonb WHERE id = ${setupId} AND draft_conversation_id = ${conversationId} AND brief IS NULL AND draft_status = 'RUNNING'`
    : sql`UPDATE business_setups SET draft_status = 'FAILED' WHERE id = ${setupId} AND draft_conversation_id = ${conversationId} AND brief IS NULL AND draft_status = 'RUNNING'`
}).pipe(Effect.catchAllCause(cause => Effect.gen(function*() {
  yield* Effect.logWarning("setup draft failed").pipe(Effect.annotateLogs({ setup: setupId, cause: Cause.pretty(cause).slice(0, 400) }))
  const sql = yield* SqlClient.SqlClient
  yield* sql`UPDATE business_setups SET draft_status = 'FAILED' WHERE id = ${setupId} AND draft_conversation_id = ${conversationId} AND brief IS NULL AND draft_status = 'RUNNING'`
}).pipe(Effect.ignore)))
