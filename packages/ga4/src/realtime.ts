// GA4's realtime report: who is on the site now (the last 30 minutes), by
// country and by page, and minute by minute. Read-only, like runReport.
import type { RealtimeSnapshot } from "@openrecord/contracts"
import { parseJson, send, unexpected } from "./http.js"
import type { Ga4ApiConfig } from "./api.js"

const run = async (config: Ga4ApiConfig, token: string, property: string, body: unknown) => {
  if (!/^properties\/[0-9]{1,20}$/.test(property)) throw unexpected()
  const r = await send(config.fetch, `${config.endpoints.data}/${property}:runRealtimeReport`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body),
  })
  const rows = (parseJson(r.text) as { rows?: unknown }).rows
  return Array.isArray(rows) ? rows as Array<{ dimensionValues?: Array<{ value?: string }>; metricValues?: Array<{ value?: string }> }> : []
}
const users = (r: { metricValues?: Array<{ value?: string }> }) => {
  const n = Number(r.metricValues?.[0]?.value)
  if (!Number.isFinite(n) || n < 0) throw unexpected()
  return n
}
const dim = (r: { dimensionValues?: Array<{ value?: string }> }, i: number) => (r.dimensionValues?.[i]?.value ?? "").slice(0, 200)

export const realtimeSnapshot = async (config: Ga4ApiConfig, token: string, property: string): Promise<RealtimeSnapshot> => {
  const metric = [{ name: "activeUsers" }]
  const [total, countries, pages, minutes] = await Promise.all([
    run(config, token, property, { metrics: metric }),
    run(config, token, property, { dimensions: [{ name: "countryId" }, { name: "country" }], metrics: metric, limit: 50 }),
    run(config, token, property, { dimensions: [{ name: "unifiedScreenName" }], metrics: metric, limit: 10 }),
    run(config, token, property, { dimensions: [{ name: "minutesAgo" }], metrics: metric, limit: 30 }),
  ])
  const perMinute = Array.from({ length: 30 }, () => 0)
  for (const r of minutes) { const m = Number(dim(r, 0)); if (Number.isInteger(m) && m >= 0 && m < 30) perMinute[29 - m] = users(r) }
  return {
    activeUsers: total[0] ? users(total[0]) : 0,
    countries: countries.map(r => ({ code: dim(r, 0).toUpperCase(), name: dim(r, 1), users: users(r) })).filter(c => /^[A-Z]{2}$/.test(c.code)).sort((a, b) => b.users - a.users),
    pages: pages.map(r => ({ title: dim(r, 0), users: users(r) })).sort((a, b) => b.users - a.users),
    perMinute,
    collectedAt: new Date().toISOString(),
  }
}
