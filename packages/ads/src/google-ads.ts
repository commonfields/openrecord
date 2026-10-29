// Google Ads, read through the Google Ads API with GAQL search only. Google
// offers no read-only Ads scope: the one scope (adwords) could change
// campaigns, so this module only ever calls customers:listAccessibleCustomers
// and googleAds:search, which read. A developer token from the deployment is
// required on every call; manager (MCC) access sends login-customer-id.
import { pkceChallenge } from "@openrecord/ga4"
import { adTotals, type AdAccount, type AdCampaignRow, type AdTotals, type SearchWindow } from "@openrecord/contracts"
import { unexpected } from "./errors.js"
import { amount, send, text, type FetchLike } from "./http.js"

export const GOOGLE_ADS_SCOPE = "https://www.googleapis.com/auth/adwords"
export const GOOGLE_ADS_SCOPES = ["openid", "email", GOOGLE_ADS_SCOPE] as const
export const GOOGLE_ADS_ACCEPTED_SCOPES: ReadonlyArray<string> = [...GOOGLE_ADS_SCOPES, "https://www.googleapis.com/auth/userinfo.email"]
export interface GoogleAdsConfig {
  readonly developerToken: string
  /** Google Ads API version, e.g. v21. Google retires versions about a year after release. */
  readonly version: string
  readonly endpoint: string
  readonly authorize: string
  readonly fetch: FetchLike
}
export const GOOGLE_ADS_ENDPOINT = "https://googleads.googleapis.com"

export const googleAdsAuthorizationUrl = (c: Pick<GoogleAdsConfig, "authorize">, client: { clientId: string; redirectUri: string }, state: string, verifier: string) =>
  `${c.authorize}?${new URLSearchParams({
    client_id: client.clientId, redirect_uri: client.redirectUri, response_type: "code", scope: GOOGLE_ADS_SCOPES.join(" "),
    access_type: "offline", prompt: "consent", state, code_challenge: pkceChallenge(verifier), code_challenge_method: "S256",
  })}`

const headers = (c: GoogleAdsConfig, token: string, loginCustomerId: string | null) => ({
  authorization: `Bearer ${token}`, "developer-token": c.developerToken, accept: "application/json", "content-type": "application/json",
  ...(loginCustomerId ? { "login-customer-id": loginCustomerId } : {}),
})
const digits = (v: unknown) => { const s = text(v, 20).replace(/-/g, ""); return /^\d{1,20}$/.test(s) ? s : null }

/** One GAQL query; every page up to a bound. */
export const googleAdsSearch = async (c: GoogleAdsConfig, token: string, customerId: string, loginCustomerId: string | null, query: string): Promise<Array<Record<string, unknown>>> => {
  if (!/^\s*SELECT\s/i.test(query)) throw unexpected()
  const rows: Array<Record<string, unknown>> = []
  let pageToken: string | undefined
  for (let page = 0; page < 5; page++) {
    const body = await send(c.fetch, `${c.endpoint}/${c.version}/customers/${customerId}/googleAds:search`, {
      method: "POST", headers: headers(c, token, loginCustomerId), body: JSON.stringify({ query, ...(pageToken ? { pageToken } : {}) }),
    }) as { results?: unknown; nextPageToken?: unknown }
    if (Array.isArray(body.results)) rows.push(...body.results as Array<Record<string, unknown>>)
    if (typeof body.nextPageToken !== "string" || !body.nextPageToken) break
    pageToken = body.nextPageToken
  }
  return rows
}

/** The ad accounts this sign-in reaches, directly or through a manager account (one level down). */
export const googleAdsAccounts = async (c: GoogleAdsConfig, token: string): Promise<ReadonlyArray<AdAccount>> => {
  const body = await send(c.fetch, `${c.endpoint}/${c.version}/customers:listAccessibleCustomers`, { method: "GET", headers: headers(c, token, null) }) as { resourceNames?: unknown }
  const roots = (Array.isArray(body.resourceNames) ? body.resourceNames : []).flatMap(n => typeof n === "string" && /^customers\/\d{1,20}$/.test(n) ? [n.slice(10)] : []).slice(0, 20)
  const found = new Map<string, AdAccount>()
  for (const root of roots) {
    const rows = await googleAdsSearch(c, token, root, root,
      "SELECT customer_client.id, customer_client.descriptive_name, customer_client.currency_code, customer_client.manager, customer_client.status FROM customer_client WHERE customer_client.level <= 1").catch(() => [])
    for (const r of rows) {
      const cc = (r["customerClient"] ?? {}) as Record<string, unknown>
      const id = digits(cc["id"])
      if (!id || cc["manager"] === true) continue
      // Direct access wins over access through a manager.
      if (found.has(id) && id !== root) continue
      found.set(id, { externalId: id, name: text(cc["descriptiveName"], 200) || `Google Ads ${id}`, currency: text(cc["currencyCode"], 3) || null,
        loginCustomerId: root === id ? null : root, active: cc["status"] === undefined || cc["status"] === "ENABLED" })
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export const GOOGLE_ADS_CONVERSIONS = "Conversions as Google Ads counts them: the account's primary conversion actions, by its own attribution model."
const totalsOf = (m: Record<string, unknown>): AdTotals => adTotals({
  spend: amount(m["costMicros"]) / 1_000_000, impressions: amount(m["impressions"]), clicks: amount(m["clicks"]),
  conversions: amount(m["conversions"]), conversionValue: amount(m["conversionsValue"]),
})
const between = (w: SearchWindow) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(w.start) || !/^\d{4}-\d{2}-\d{2}$/.test(w.end)) throw unexpected()
  return `segments.date BETWEEN '${w.start}' AND '${w.end}'`
}
const METRICS = "metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions, metrics.conversions_value"

export const googleAdsTotals = async (c: GoogleAdsConfig, token: string, customerId: string, loginCustomerId: string | null, window: SearchWindow): Promise<AdTotals> => {
  const rows = await googleAdsSearch(c, token, customerId, loginCustomerId, `SELECT ${METRICS} FROM customer WHERE ${between(window)}`)
  // Rows can come per day; add them up.
  const sum = { costMicros: 0, impressions: 0, clicks: 0, conversions: 0, conversionsValue: 0 }
  for (const r of rows) {
    const m = (r["metrics"] ?? {}) as Record<string, unknown>
    sum.costMicros += amount(m["costMicros"]); sum.impressions += amount(m["impressions"]); sum.clicks += amount(m["clicks"])
    sum.conversions += amount(m["conversions"]); sum.conversionsValue += amount(m["conversionsValue"])
  }
  return totalsOf(sum)
}

export const googleAdsCampaigns = async (c: GoogleAdsConfig, token: string, customerId: string, loginCustomerId: string | null, window: SearchWindow, limit: number): Promise<ReadonlyArray<AdCampaignRow>> => {
  const rows = await googleAdsSearch(c, token, customerId, loginCustomerId,
    `SELECT campaign.id, campaign.name, campaign.status, ${METRICS} FROM campaign WHERE ${between(window)} AND metrics.cost_micros > 0 ORDER BY metrics.cost_micros DESC LIMIT ${Math.max(1, Math.min(50, limit))}`)
  return rows.map(r => {
    const camp = (r["campaign"] ?? {}) as Record<string, unknown>
    return { id: digits(camp["id"]) ?? "", name: text(camp["name"], 200), status: text(camp["status"], 30) || null, ...totalsOf((r["metrics"] ?? {}) as Record<string, unknown>) }
  })
}
