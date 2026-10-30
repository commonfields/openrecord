// Meta (Facebook and Instagram) ads, read-only through the Marketing API:
// Facebook Login with the ads_read permission only, a long-lived user token
// (about 60 days; Meta issues no refresh token, so the person signs in again),
// the ad accounts that person can read, and account and campaign insights.
// Every call carries appsecret_proof, so a leaked token is useless without the
// app secret. Nothing here can create, change or pause an ad.
import { createHmac } from "node:crypto"
import { adTotals, type AdAccount, type AdCampaignRow, type AdTotals, type SearchWindow } from "@openrecord/contracts"
import { unexpected } from "./errors.js"
import { amount, send, text, type FetchLike } from "./http.js"

export const META_SCOPES = ["ads_read"] as const
export interface MetaConfig {
  readonly appId: string
  readonly appSecret: string
  readonly redirectUri: string
  /** Graph API version, e.g. v23.0. Meta retires versions about two years after release. */
  readonly version: string
  readonly endpoints: { readonly dialog: string; readonly graph: string }
  readonly fetch: FetchLike
}
export const META_ENDPOINTS = { dialog: "https://www.facebook.com", graph: "https://graph.facebook.com" }
export interface MetaTokens { readonly accessToken: string; readonly expiresAt: number | null }

const graph = (c: MetaConfig, path: string) => `${c.endpoints.graph}/${c.version}${path}`
const proof = (c: MetaConfig, token: string) => createHmac("sha256", c.appSecret).update(token).digest("hex")
const get = (c: MetaConfig, token: string, path: string, params: Record<string, string> = {}) =>
  send(c.fetch, `${graph(c, path)}?${new URLSearchParams({ ...params, appsecret_proof: proof(c, token) })}`, { method: "GET", headers: { authorization: `Bearer ${token}`, accept: "application/json" } })
const post = (c: MetaConfig, path: string, values: Record<string, string>) =>
  send(c.fetch, graph(c, path), { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body: new URLSearchParams(values).toString() })

export const metaAuthorizationUrl = (c: MetaConfig, state: string) => `${c.endpoints.dialog}/${c.version}/dialog/oauth?${new URLSearchParams({
  client_id: c.appId, redirect_uri: c.redirectUri, state, response_type: "code", scope: META_SCOPES.join(","),
})}`

const tokens = (raw: unknown, now: number): MetaTokens => {
  const b = raw as { access_token?: unknown; expires_in?: unknown }
  if (typeof b.access_token !== "string" || !b.access_token) throw unexpected()
  const expires = Number(b.expires_in)
  return { accessToken: b.access_token, expiresAt: Number.isFinite(expires) && expires > 0 ? now + expires * 1000 : null }
}

/** The code for a short-lived token, then that for a long-lived one; the short-lived token is never stored. */
export const metaExchangeCode = async (c: MetaConfig, code: string, now = Date.now()): Promise<MetaTokens> => {
  const short = tokens(await post(c, "/oauth/access_token", { client_id: c.appId, client_secret: c.appSecret, redirect_uri: c.redirectUri, code }), now)
  return tokens(await post(c, "/oauth/access_token", { grant_type: "fb_exchange_token", client_id: c.appId, client_secret: c.appSecret, fb_exchange_token: short.accessToken }), now)
}

export const metaIdentity = async (c: MetaConfig, token: string) => {
  const me = await get(c, token, "/me", { fields: "id,name" }) as { id?: unknown; name?: unknown }
  if (typeof me.id !== "string" || !/^\d{1,30}$/.test(me.id)) throw unexpected()
  const perms = await get(c, token, "/me/permissions") as { data?: Array<{ permission?: unknown; status?: unknown }> }
  const granted = (perms.data ?? []).flatMap(p => p.status === "granted" && typeof p.permission === "string" ? [p.permission] : []).sort()
  return { subject: me.id, name: text(me.name, 200) || "Meta user", granted }
}

/** Removes OpenRecord's access on the person's Meta account. */
export const metaRevoke = async (c: MetaConfig, token: string, subject: string) => {
  try { await send(c.fetch, `${graph(c, `/${subject}/permissions`)}?${new URLSearchParams({ appsecret_proof: proof(c, token) })}`, { method: "DELETE", headers: { authorization: `Bearer ${token}` } }); return "CONFIRMED" as const }
  catch { return "UNCONFIRMED" as const }
}

export const metaAdAccounts = async (c: MetaConfig, token: string): Promise<ReadonlyArray<AdAccount>> => {
  const body = await get(c, token, "/me/adaccounts", { fields: "account_id,name,currency,account_status", limit: "100" }) as { data?: Array<Record<string, unknown>> }
  return (body.data ?? []).flatMap(a => {
    const id = text(a["account_id"], 30)
    return /^\d{1,20}$/.test(id) ? [{ externalId: id, name: text(a["name"], 200) || `Ad account ${id}`, currency: text(a["currency"], 3) || null, loginCustomerId: null, active: a["account_status"] === 1 }] : []
  }).sort((a, b) => a.name.localeCompare(b.name))
}

// Meta reports many action types; these pick one count per kind so purchases
// counted by the pixel and by the Conversions API are not added twice.
const PURCHASES = ["omni_purchase", "purchase", "offsite_conversion.fb_pixel_purchase"]
const LEADS = ["lead", "offsite_conversion.fb_pixel_lead", "onsite_conversion.lead_grouped"]
export const META_CONVERSIONS = "Purchases and leads Meta attributed to these ads (its default attribution: 7-day click, 1-day view), from the pixel, the Conversions API and lead forms."
const pick = (list: unknown, types: ReadonlyArray<string>) => {
  const rows = Array.isArray(list) ? list as Array<{ action_type?: unknown; value?: unknown }> : []
  for (const t of types) { const r = rows.find(x => x.action_type === t); if (r) return amount(r.value) }
  return 0
}
const totalsOf = (r: Record<string, unknown>): AdTotals => adTotals({
  spend: amount(r["spend"]), impressions: amount(r["impressions"]), clicks: amount(r["clicks"]),
  conversions: pick(r["actions"], PURCHASES) + pick(r["actions"], LEADS), conversionValue: pick(r["action_values"], PURCHASES),
})
const insights = async (c: MetaConfig, token: string, accountId: string, window: SearchWindow, level: "account" | "campaign") => {
  const body = await get(c, token, `/act_${accountId}/insights`, {
    level, time_range: JSON.stringify({ since: window.start, until: window.end }), limit: "200",
    fields: level === "account" ? "spend,impressions,clicks,actions,action_values" : "campaign_id,campaign_name,spend,impressions,clicks,actions,action_values",
  }) as { data?: Array<Record<string, unknown>> }
  return body.data ?? []
}

export const metaTotals = async (c: MetaConfig, token: string, accountId: string, window: SearchWindow): Promise<AdTotals> => {
  const rows = await insights(c, token, accountId, window, "account")
  return rows[0] ? totalsOf(rows[0]) : adTotals({ spend: 0, impressions: 0, clicks: 0, conversions: 0, conversionValue: 0 })
}
export const metaCampaigns = async (c: MetaConfig, token: string, accountId: string, window: SearchWindow, limit: number): Promise<ReadonlyArray<AdCampaignRow>> =>
  (await insights(c, token, accountId, window, "campaign"))
    .map(r => ({ id: text(r["campaign_id"], 30), name: text(r["campaign_name"], 200), status: null, ...totalsOf(r) }))
    .sort((a, b) => b.spend - a.spend).slice(0, limit)
