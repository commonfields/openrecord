// Google Ads writes a person approves one at a time: pause or enable a
// campaign, set a campaign's daily budget, and add a responsive search ad to
// an existing ad group. A new ad is always created PAUSED, so nothing new
// spends until a person turns it on in Google Ads or approves enabling it.
// Every write can first run with validateOnly, so Google checks the exact
// change (policy, limits, permissions) before anyone approves it.
import { unexpected } from "./errors.js"
import { amount, send, text } from "./http.js"
import { googleAdsDigits as digits, googleAdsHeaders as headers, googleAdsSearch, type GoogleAdsConfig } from "./google-ads.js"

export interface AdsTarget { readonly customerId: string; readonly loginCustomerId: string | null }
export interface CampaignState {
  readonly campaignId: string; readonly name: string; readonly status: string; readonly channel: string | null
  readonly budget: { readonly resourceName: string; readonly dailyMicros: number; readonly shared: boolean; readonly period: string | null } | null
}
const ID = /^\d{1,20}$/
const need = (ok: boolean) => { if (!ok) throw unexpected() }

const CAMPAIGN_FIELDS = "campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign_budget.resource_name, campaign_budget.amount_micros, campaign_budget.explicitly_shared, campaign_budget.period"
const toCampaign = (r: Record<string, unknown>): CampaignState | null => {
  const c = (r["campaign"] ?? {}) as Record<string, unknown>, b = r["campaignBudget"] as Record<string, unknown> | undefined
  const id = digits(c["id"])
  if (!id) return null
  const resourceName = b ? text(b["resourceName"], 120) : ""
  return { campaignId: id, name: text(c["name"], 200), status: text(c["status"], 30), channel: text(c["advertisingChannelType"], 40) || null,
    budget: /^customers\/\d{1,20}\/campaignBudgets\/\d{1,20}$/.test(resourceName)
      ? { resourceName, dailyMicros: amount(b!["amountMicros"]), shared: b!["explicitlyShared"] === true, period: text(b!["period"], 20) || null } : null }
}

/** Campaigns that are not removed, with their budgets. */
export const googleAdsCampaignList = async (c: GoogleAdsConfig, token: string, t: AdsTarget): Promise<ReadonlyArray<CampaignState>> =>
  (await googleAdsSearch(c, token, t.customerId, t.loginCustomerId, `SELECT ${CAMPAIGN_FIELDS} FROM campaign WHERE campaign.status != 'REMOVED' ORDER BY campaign.name LIMIT 100`))
    .flatMap(r => { const v = toCampaign(r); return v ? [v] : [] })
export const googleAdsCampaign = async (c: GoogleAdsConfig, token: string, t: AdsTarget, campaignId: string): Promise<CampaignState | null> => {
  need(ID.test(campaignId))
  const rows = await googleAdsSearch(c, token, t.customerId, t.loginCustomerId, `SELECT ${CAMPAIGN_FIELDS} FROM campaign WHERE campaign.id = ${campaignId}`)
  return rows[0] ? toCampaign(rows[0]) : null
}
export interface AdGroupState { readonly adGroupId: string; readonly name: string; readonly status: string; readonly type: string | null; readonly campaignId: string }
export const googleAdsAdGroups = async (c: GoogleAdsConfig, token: string, t: AdsTarget, campaignId: string): Promise<ReadonlyArray<AdGroupState>> => {
  need(ID.test(campaignId))
  const rows = await googleAdsSearch(c, token, t.customerId, t.loginCustomerId,
    `SELECT ad_group.id, ad_group.name, ad_group.status, ad_group.type, campaign.id FROM ad_group WHERE campaign.id = ${campaignId} AND ad_group.status != 'REMOVED' LIMIT 50`)
  return rows.flatMap(r => { const g = (r["adGroup"] ?? {}) as Record<string, unknown>; const id = digits(g["id"])
    return id ? [{ adGroupId: id, name: text(g["name"], 200), status: text(g["status"], 30), type: text(g["type"], 40) || null, campaignId }] : [] })
}
export interface AdState { readonly resourceName: string; readonly status: string; readonly approval: string | null; readonly headlines: ReadonlyArray<string>; readonly descriptions: ReadonlyArray<string>; readonly finalUrls: ReadonlyArray<string> }
const AD_RESOURCE = /^customers\/(\d{1,20})\/adGroupAds\/(\d{1,20})~(\d{1,20})$/
export const googleAdsAd = async (c: GoogleAdsConfig, token: string, t: AdsTarget, resourceName: string): Promise<AdState | null> => {
  const m = AD_RESOURCE.exec(resourceName)
  need(!!m && m[1] === t.customerId)
  const rows = await googleAdsSearch(c, token, t.customerId, t.loginCustomerId,
    `SELECT ad_group_ad.resource_name, ad_group_ad.status, ad_group_ad.policy_summary.approval_status, ad_group_ad.ad.final_urls, ad_group_ad.ad.responsive_search_ad.headlines, ad_group_ad.ad.responsive_search_ad.descriptions FROM ad_group_ad WHERE ad_group.id = ${m![2]} AND ad_group_ad.ad.id = ${m![3]}`)
  const a = rows[0]?.["adGroupAd"] as Record<string, unknown> | undefined
  if (!a) return null
  const ad = (a["ad"] ?? {}) as Record<string, unknown>, rsa = (ad["responsiveSearchAd"] ?? {}) as Record<string, unknown>
  const texts = (v: unknown) => (Array.isArray(v) ? v : []).map(x => text((x as Record<string, unknown>)["text"], 120)).filter(Boolean)
  return { resourceName, status: text(a["status"], 30), approval: text(((a["policySummary"] ?? {}) as Record<string, unknown>)["approvalStatus"], 40) || null,
    headlines: texts(rsa["headlines"]), descriptions: texts(rsa["descriptions"]), finalUrls: (Array.isArray(ad["finalUrls"]) ? ad["finalUrls"] : []).map(u => text(u, 2000)) }
}

const mutate = async (c: GoogleAdsConfig, token: string, t: AdsTarget, service: "campaigns" | "campaignBudgets" | "adGroupAds", operations: ReadonlyArray<unknown>, validateOnly: boolean) => {
  need(ID.test(t.customerId))
  const body = await send(c.fetch, `${c.endpoint}/${c.version}/customers/${t.customerId}/${service}:mutate`, {
    method: "POST", headers: headers(c, token, t.loginCustomerId), body: JSON.stringify({ operations, ...(validateOnly ? { validateOnly: true } : {}) }) }) as { results?: Array<{ resourceName?: unknown }> }
  return (body.results ?? []).map(r => text(r.resourceName, 200))
}

export const googleAdsSetCampaignStatus = async (c: GoogleAdsConfig, token: string, t: AdsTarget, campaignId: string, status: "PAUSED" | "ENABLED", validateOnly = false) => {
  need(ID.test(campaignId))
  return mutate(c, token, t, "campaigns", [{ update: { resourceName: `customers/${t.customerId}/campaigns/${campaignId}`, status }, updateMask: "status" }], validateOnly)
}
export const googleAdsSetDailyBudget = async (c: GoogleAdsConfig, token: string, t: AdsTarget, budgetResourceName: string, dailyMicros: number, validateOnly = false) => {
  need(budgetResourceName.startsWith(`customers/${t.customerId}/campaignBudgets/`) && Number.isSafeInteger(dailyMicros) && dailyMicros > 0)
  return mutate(c, token, t, "campaignBudgets", [{ update: { resourceName: budgetResourceName, amountMicros: String(dailyMicros) }, updateMask: "amount_micros" }], validateOnly)
}

export interface SearchAdDraft { readonly headlines: ReadonlyArray<string>; readonly descriptions: ReadonlyArray<string>; readonly finalUrl: string; readonly path1?: string | undefined; readonly path2?: string | undefined }
/** Google's limits for a responsive search ad. */
export const SEARCH_AD_LIMITS = { headlines: [3, 15], headlineChars: 30, descriptions: [2, 4], descriptionChars: 90, pathChars: 15 } as const
export const searchAdProblem = (d: SearchAdDraft): string | null => {
  const L = SEARCH_AD_LIMITS
  if (d.headlines.length < L.headlines[0] || d.headlines.length > L.headlines[1]) return "HEADLINE_COUNT"
  if (d.headlines.some(h => !h.trim() || h.length > L.headlineChars)) return "HEADLINE_LENGTH"
  if (new Set(d.headlines.map(h => h.trim().toLowerCase())).size !== d.headlines.length) return "HEADLINE_DUPLICATE"
  if (d.descriptions.length < L.descriptions[0] || d.descriptions.length > L.descriptions[1]) return "DESCRIPTION_COUNT"
  if (d.descriptions.some(x => !x.trim() || x.length > L.descriptionChars)) return "DESCRIPTION_LENGTH"
  if ([d.path1, d.path2].some(p => p !== undefined && (p.length > L.pathChars || /\s|\//.test(p)))) return "PATH"
  try { if (new URL(d.finalUrl).protocol !== "https:") return "FINAL_URL" } catch { return "FINAL_URL" }
  return null
}
/** Adds a responsive search ad to one ad group, always PAUSED. Returns its resource name. */
export const googleAdsCreateSearchAd = async (c: GoogleAdsConfig, token: string, t: AdsTarget, adGroupId: string, d: SearchAdDraft, validateOnly = false) => {
  need(ID.test(adGroupId) && searchAdProblem(d) === null)
  const names = await mutate(c, token, t, "adGroupAds", [{ create: { adGroup: `customers/${t.customerId}/adGroups/${adGroupId}`, status: "PAUSED", ad: {
    finalUrls: [d.finalUrl], responsiveSearchAd: { headlines: d.headlines.map(text => ({ text })), descriptions: d.descriptions.map(text => ({ text })),
      ...(d.path1 ? { path1: d.path1 } : {}), ...(d.path2 ? { path2: d.path2 } : {}) } } } }], validateOnly)
  return validateOnly ? null : (names.find(n => AD_RESOURCE.test(n)) ?? null)
}
/** Removes an ad OpenRecord created (undo). */
export const googleAdsRemoveAd = async (c: GoogleAdsConfig, token: string, t: AdsTarget, resourceName: string) => {
  const m = AD_RESOURCE.exec(resourceName)
  need(!!m && m[1] === t.customerId)
  return mutate(c, token, t, "adGroupAds", [{ remove: resourceName }], false)
}
