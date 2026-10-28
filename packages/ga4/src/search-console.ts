// Read-only Search Console calls through the same Google connection as GA4:
// the sites the identity can read, and Search Analytics totals and top rows
// for a date window. Both only read; nothing here can change a property.
import { SEARCH_PERFORMANCE_ROWS, type SearchConsoleSite, type SearchPerformanceRow, type SearchTotals, type SearchWindow } from "@openrecord/contracts"
import { parseJson, send, unexpected } from "./http.js"
import type { Ga4ApiConfig } from "./api.js"

const READABLE = new Set(["siteOwner", "siteFullUser", "siteRestrictedUser"])
const auth = (accessToken: string) => ({ authorization: `Bearer ${accessToken}`, accept: "application/json" })

export const listSearchConsoleSites = async (config: Ga4ApiConfig, accessToken: string): Promise<ReadonlyArray<SearchConsoleSite>> => {
  const result = await send(config.fetch, `${config.endpoints.searchConsole}/sites`, { method: "GET", headers: auth(accessToken) })
  const body = parseJson(result.text) as { siteEntry?: unknown }
  const entries = Array.isArray(body.siteEntry) ? body.siteEntry as Array<Record<string, unknown>> : []
  return entries.flatMap(e => typeof e["siteUrl"] === "string" && typeof e["permissionLevel"] === "string" && READABLE.has(e["permissionLevel"]) && e["siteUrl"].length <= 2048
    ? [{ siteUrl: e["siteUrl"], permissionLevel: e["permissionLevel"] }] : [])
    .sort((a, b) => a.siteUrl.localeCompare(b.siteUrl))
}

const num = (v: unknown): number => {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw unexpected()
  return v
}
const row = (raw: Record<string, unknown>, key: string): SearchPerformanceRow => {
  const impressions = num(raw["impressions"])
  return { key, clicks: num(raw["clicks"]), impressions, ctr: num(raw["ctr"]), position: impressions > 0 ? num(raw["position"]) : null }
}
const query = async (config: Ga4ApiConfig, accessToken: string, siteUrl: string, window: SearchWindow, dimension: "query" | "page" | null) => {
  const body = { startDate: window.start, endDate: window.end, type: "web", ...(dimension ? { dimensions: [dimension], rowLimit: SEARCH_PERFORMANCE_ROWS } : {}) }
  const result = await send(config.fetch, `${config.endpoints.searchConsole}/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`, {
    method: "POST", headers: { ...auth(accessToken), "content-type": "application/json" }, body: JSON.stringify(body),
  })
  const parsed = parseJson(result.text) as { rows?: unknown }
  return Array.isArray(parsed.rows) ? parsed.rows as Array<Record<string, unknown>> : []
}
const EMPTY: SearchTotals = { clicks: 0, impressions: 0, ctr: 0, position: null }

/** Totals for a window: one aggregated row, or none when Google has no data for it. */
export const searchTotals = async (config: Ga4ApiConfig, accessToken: string, siteUrl: string, window: SearchWindow): Promise<SearchTotals> => {
  const rows = await query(config, accessToken, siteUrl, window, null)
  if (!rows.length) return EMPTY
  const { key: _key, ...totals } = row(rows[0]!, "")
  return totals
}
/** The top rows by clicks for one dimension. */
export const searchTopRows = async (config: Ga4ApiConfig, accessToken: string, siteUrl: string, window: SearchWindow, dimension: "query" | "page"): Promise<ReadonlyArray<SearchPerformanceRow>> => {
  const rows = await query(config, accessToken, siteUrl, window, dimension)
  return rows.slice(0, SEARCH_PERFORMANCE_ROWS).map(r => {
    const keys = r["keys"]
    if (!Array.isArray(keys) || typeof keys[0] !== "string") throw unexpected()
    return row(r, keys[0].slice(0, 500))
  })
}
