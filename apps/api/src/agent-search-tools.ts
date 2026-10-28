// read_search_performance: Google Search Console for the business's bound site,
// read live through the operator's Google connection. Clicks, impressions,
// click-through rate and average position for a window and the window before
// it, plus top queries and pages. Read-only; a missing connection is an answer
// ("not connected"), never a zero.
import { Effect, JSONSchema, Option, Schema } from "effect"
import { GrowthGa4Refused, GrowthGa4Repository, SearchConsoleRepository } from "@openrecord/db"
import type { SearchTotals } from "@openrecord/contracts"
import { AgentNotInScope } from "./agent-tool-errors.js"
import type { AgentToolDef, AgentToolResult } from "./agent-tools.js"
import { searchPerformance } from "./search-console-routes.js"

const Input = Schema.Struct({ days: Schema.optional(Schema.Literal(7, 28, 90)) })

const change = (now: number, before: number) => before === 0 ? (now === 0 ? "no change" : "new") : `${now >= before ? "+" : ""}${Math.round(((now - before) / before) * 100)}%`
const totalsLine = (t: SearchTotals) => `${t.clicks.toLocaleString("en-US")} clicks, ${t.impressions.toLocaleString("en-US")} impressions`
const answer = (status: string, summary: string, recovery: string): AgentToolResult => ({ summary, citations: [], data: { status, recovery } })

export const readSearchPerformance = (accountId: string, businessId: string, input: typeof Input.Type) => Effect.gen(function*() {
  const sc = yield* Effect.serviceOption(SearchConsoleRepository)
  const ga4 = yield* Effect.serviceOption(GrowthGa4Repository)
  if (Option.isNone(sc) || Option.isNone(ga4)) return answer("UNAVAILABLE", "Search Console is not available on this server", "Search performance cannot be read here.")
  const days = input.days ?? 28
  const read = yield* searchPerformance(accountId, businessId, days).pipe(
    Effect.provideService(SearchConsoleRepository, sc.value), Effect.provideService(GrowthGa4Repository, ga4.value), Effect.either)
  if (read._tag === "Left") {
    const e = read.left
    if (!(e instanceof GrowthGa4Refused)) return yield* Effect.fail(e)
    if (e.reason === "GrowthNotFound" || e.reason === "InvalidRequest") return yield* Effect.fail(new AgentNotInScope())
    if (e.reason === "Ga4NotConfigured") return answer("UNAVAILABLE", "Search Console is not available on this server", "Google sign-in is not configured on this server.")
    if (e.reason === "Ga4ReauthorizationRequired") return answer("RECONNECT_REQUIRED", "Google access for Search Console needs to be reconnected", "Reconnect Google on the Channels page.")
    if (e.reason === "PropertyNotAccessible") return answer("SITE_NOT_ACCESSIBLE", "The connected Google account can no longer read this Search Console site", "Choose another site or reconnect on the Channels page.")
    return yield* Effect.fail(e)
  }
  const p = read.right
  if (!p) return answer("NOT_CONNECTED", "Search Console is not connected for this business", "Connect Google Search Console on the Channels page to read search clicks and queries.")
  const c = p.current.totals, b = p.previous.totals
  return {
    summary: `Search Console, last ${days} days: ${totalsLine(c)} (clicks ${change(c.clicks, b.clicks)} vs the previous ${days} days)`,
    citations: [{ kind: "search_console", id: businessId, text: `Google Search Console: ${p.siteUrl}` }],
    data: {
      source: "Google Search Console (Google Search only; says nothing about AI answers or other search engines)",
      site: p.siteUrl, current: p.current, previous: p.previous, topQueries: p.topQueries, topPages: p.topPages, collectedAt: p.collectedAt,
      note: "Average position is impression-weighted and lower is better. Period changes are descriptive; they do not show what caused them.",
    },
  } satisfies AgentToolResult
})

export const SEARCH_AGENT_TOOLS: ReadonlyArray<AgentToolDef> = [{
  name: "read_search_performance",
  description: "Read Google Search Console for this business's connected site: clicks, impressions, click-through rate and average position for the last 7, 28 or 90 days (default 28) and the period before, plus the top search queries and pages by clicks. Google Search only, read live; data ends three days ago. NOT_CONNECTED means unknown, never zero. Changes between periods are descriptive, never proof of cause. Read-only.",
  parameters: JSONSchema.make(Input),
  decode: raw => Schema.decodeUnknown(Input, { onExcessProperty: "error" })(raw),
  run: readSearchPerformance,
}]
