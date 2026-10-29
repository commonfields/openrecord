// read_ad_performance: the business's own ad accounts on Meta and Google Ads,
// read live through the operator's connections. Spend, impressions, clicks,
// conversions and conversion value for a window and the window before, cost
// per click and per conversion, return on ad spend, and top campaigns by
// spend. Read-only; an unconnected platform is an answer, never a zero.
import { Effect, JSONSchema, Schema } from "effect"
import { AD_PROVIDER_NAME, AdProvider, type AdTotals } from "@openrecord/contracts"
import type { AgentToolDef, AgentToolResult } from "./agent-tools.js"
import { AdsRefused, adPerformance } from "./ads.js"
import { AgentNotInScope } from "./agent-tool-errors.js"

const Input = Schema.Struct({ days: Schema.optional(Schema.Literal(7, 28, 90)), provider: Schema.optional(AdProvider) })
const money = (n: number, currency: string | null) => currency ? new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 0 }).format(n) : n.toFixed(0)
const change = (now: number, before: number) => before === 0 ? (now === 0 ? "no change" : "new") : `${now >= before ? "+" : ""}${Math.round(((now - before) / before) * 100)}%`
const line = (t: AdTotals, currency: string | null) => `${money(t.spend, currency)} spent, ${t.clicks.toLocaleString("en-US")} clicks, ${Math.round(t.conversions).toLocaleString("en-US")} conversions`
const REASON: Readonly<Record<string, string>> = {
  AdsReauthorizationRequired: "the sign-in expired; reconnect it on the Channels page",
  AdAccountNotAccessible: "the signed-in person can no longer read this ad account",
  ProviderQuota: "the platform's rate limit was reached; try again later",
}

export const readAdPerformance = (accountId: string, businessId: string, input: typeof Input.Type) => Effect.gen(function*() {
  const days = input.days ?? 28
  const read = yield* adPerformance(accountId, businessId, days, input.provider).pipe(Effect.either)
  if (read._tag === "Left") {
    const e: unknown = read.left
    if (e instanceof AdsRefused && e.reason.endsWith("NotFound")) return yield* Effect.fail(new AgentNotInScope())
    return yield* Effect.fail(read.left)
  }
  const { accounts, failures } = read.right
  if (!accounts.length && !failures.length) return {
    summary: `No ad accounts are connected for this business${input.provider ? ` on ${AD_PROVIDER_NAME[input.provider]}` : ""}`, citations: [],
    data: { status: "NOT_CONNECTED", recovery: "Connect Meta Ads or Google Ads on the Channels page to read spend, clicks and conversions. Until then ad performance is unknown, not zero." },
  } satisfies AgentToolResult
  return {
    summary: [
      ...accounts.map(a => `${AD_PROVIDER_NAME[a.provider]} (${a.accountName}), last ${days} days: ${line(a.current.totals, a.currency)} (spend ${change(a.current.totals.spend, a.previous.totals.spend)})`),
      ...failures.map(f => `${AD_PROVIDER_NAME[f.provider]} (${f.accountName}) not read: ${REASON[f.reason] ?? "the platform did not answer"}`),
    ].join("; ").slice(0, 600),
    citations: accounts.map(a => ({ kind: "ad_account", id: `${a.provider}:${a.externalId}`, text: `${AD_PROVIDER_NAME[a.provider]}: ${a.accountName}` })),
    data: {
      source: "The business's own ad accounts, read live from Meta and Google Ads. Each platform counts conversions its own way (see conversionDefinition) and attributes them to its own ads, so their conversions overlap and must not be added up as if they were separate sales.",
      accounts, failures: failures.map(f => ({ ...f, meaning: REASON[f.reason] ?? "The platform did not answer; this account is unknown for now." })),
      note: "Spend is in each account's own currency. ROAS is conversion value divided by spend as the platform reports it. Period changes are descriptive, not proof of cause.",
    },
  } satisfies AgentToolResult
})

export const ADS_AGENT_TOOLS: ReadonlyArray<AgentToolDef> = [{
  name: "read_ad_performance",
  description: "Read this business's connected ad accounts on Meta (Facebook and Instagram) and Google Ads: spend, impressions, clicks, conversions, conversion value, cost per click, cost per conversion and return on ad spend for the last 7, 28 or 90 days (default 28) and the period before, plus top campaigns by spend. Optional provider: meta or google_ads. Read live; data ends yesterday. NOT_CONNECTED means unknown, never zero. Platforms count conversions differently and overlap; never add them up as separate sales. Read-only.",
  parameters: JSONSchema.make(Input),
  decode: raw => Schema.decodeUnknown(Input, { onExcessProperty: "error" })(raw),
  run: readAdPerformance,
}]
