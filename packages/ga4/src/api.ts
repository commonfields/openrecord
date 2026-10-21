// Read-only Google Analytics calls. Admin API v1beta: account summaries (the
// properties this identity can read), one property (time zone), its key
// events. Data API v1beta: one runReport. Nothing here can change analytics
// configuration: every call is a GET except runReport, which only reads.
import type { Ga4KeyEventChoice, Ga4PropertyChoice } from "@openrecord/contracts"
import { parseJson, send, unexpected, type FetchLike, type Ga4Endpoints } from "./http.js"

export interface Ga4ApiConfig { readonly endpoints: Ga4Endpoints; readonly fetch: FetchLike }
export interface Ga4PropertyInfo {
  readonly property: string
  readonly displayName: string
  readonly timeZone: string
  readonly account: string | null
}
/** Bounded pagination: an identity with more than this many pages of accounts is truncated, never polled forever. */
const MAX_PAGES = 10

const get = async (config: Ga4ApiConfig, accessToken: string, url: string): Promise<unknown> => {
  const result = await send(config.fetch, url, { method: "GET", headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" } })
  return parseJson(result.text)
}
const str = (v: unknown): string | null => typeof v === "string" ? v : null

export const listAccessibleProperties = async (config: Ga4ApiConfig, accessToken: string): Promise<{ readonly properties: ReadonlyArray<Ga4PropertyChoice>; readonly truncated: boolean }> => {
  const out: Ga4PropertyChoice[] = []
  let pageToken: string | null = null
  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({ pageSize: "200" })
    if (pageToken) params.set("pageToken", pageToken)
    const body = await get(config, accessToken, `${config.endpoints.admin}/accountSummaries?${params}`) as { accountSummaries?: unknown; nextPageToken?: unknown }
    const summaries = Array.isArray(body.accountSummaries) ? body.accountSummaries : []
    for (const s of summaries as Array<Record<string, unknown>>) {
      const account = str(s["account"]) ?? "", accountDisplayName = str(s["displayName"]) ?? ""
      for (const p of (Array.isArray(s["propertySummaries"]) ? s["propertySummaries"] : []) as Array<Record<string, unknown>>) {
        const property = str(p["property"])
        if (!property || !/^properties\/[0-9]{1,20}$/.test(property)) continue
        out.push({ property, displayName: str(p["displayName"]) ?? property, account, accountDisplayName, propertyType: str(p["propertyType"]) ?? "PROPERTY_TYPE_UNSPECIFIED" })
      }
    }
    pageToken = str(body.nextPageToken)
    if (!pageToken) return { properties: out, truncated: false }
  }
  return { properties: out, truncated: true }
}

export const getProperty = async (config: Ga4ApiConfig, accessToken: string, property: string): Promise<Ga4PropertyInfo> => {
  if (!/^properties\/[0-9]{1,20}$/.test(property)) throw unexpected()
  const body = await get(config, accessToken, `${config.endpoints.admin}/${property}`) as Record<string, unknown>
  const timeZone = str(body["timeZone"])
  if (str(body["name"]) !== property || !timeZone) throw unexpected()
  return { property, displayName: str(body["displayName"]) ?? property, timeZone, account: str(body["parent"]) }
}

export const listKeyEvents = async (config: Ga4ApiConfig, accessToken: string, property: string): Promise<ReadonlyArray<Ga4KeyEventChoice>> => {
  if (!/^properties\/[0-9]{1,20}$/.test(property)) throw unexpected()
  const out: Ga4KeyEventChoice[] = []
  let pageToken: string | null = null
  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({ pageSize: "200" })
    if (pageToken) params.set("pageToken", pageToken)
    const body = await get(config, accessToken, `${config.endpoints.admin}/${property}/keyEvents?${params}`) as { keyEvents?: unknown; nextPageToken?: unknown }
    for (const k of (Array.isArray(body.keyEvents) ? body.keyEvents : []) as Array<Record<string, unknown>>) {
      const eventName = str(k["eventName"])
      if (eventName) out.push({ eventName, countingMethod: str(k["countingMethod"]) })
    }
    pageToken = str(body.nextPageToken)
    if (!pageToken) break
  }
  return out.sort((a, b) => a.eventName.localeCompare(b.eventName))
}

/** One page of runReport. The caller builds the body (see report.ts) and checks every row. */
export const runReport = async (config: Ga4ApiConfig, accessToken: string, property: string, body: unknown): Promise<{ readonly json: unknown; readonly text: string }> => {
  if (!/^properties\/[0-9]{1,20}$/.test(property)) throw unexpected()
  const result = await send(config.fetch, `${config.endpoints.data}/${property}:runReport`, {
    method: "POST", headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body),
  })
  return { json: parseJson(result.text), text: result.text }
}
