import { Effect, JSONSchema, Schema } from "effect"
import { BusinessRepository } from "@openrecord/db"
import type { AgentToolDef, AgentToolResult } from "./agent-tools.js"
import { AgentNotInScope } from "./agent-tool-errors.js"
import { readRobots, webAccess } from "./web-access.js"

const Input = Schema.Struct({ url: Schema.String.pipe(Schema.maxLength(2000), Schema.filter(raw => {
  try { const u = new URL(raw); return ["https:", "http:"].includes(u.protocol) && !u.username && !u.password && !u.search && !u.hash } catch { return false }
})), strategy: Schema.optional(Schema.Literal("mobile", "desktop")) })
const NumberValue = Schema.Number.pipe(Schema.filter(Number.isFinite), Schema.greaterThanOrEqualTo(0))
const Audit = Schema.Struct({ numericValue: Schema.optional(Schema.NullOr(NumberValue)) })
const ResponseBody = Schema.Struct({ lighthouseResult: Schema.optional(Schema.Struct({
  fetchTime: Schema.String,
  lighthouseVersion: Schema.String,
  finalUrl: Schema.String.pipe(Schema.maxLength(2000)),
  audits: Schema.Record({ key: Schema.String, value: Audit }),
  runtimeError: Schema.optional(Schema.Unknown),
  runWarnings: Schema.optional(Schema.Array(Schema.Unknown)),
})) })

const METRICS = [
  { id: "first-contentful-paint", name: "First contentful paint", unit: "ms" },
  { id: "largest-contentful-paint", name: "Largest contentful paint", unit: "ms" },
  { id: "cumulative-layout-shift", name: "Cumulative layout shift", unit: "unitless" },
  { id: "total-blocking-time", name: "Total blocking time", unit: "ms" },
  { id: "speed-index", name: "Speed index", unit: "ms" },
] as const

export const decodeLabPerformance = (raw: unknown) => {
  const decoded = Schema.decodeUnknownEither(ResponseBody)(raw)
  if (decoded._tag === "Left") return null
  const result = decoded.right.lighthouseResult
  if (!result || result.runtimeError != null || Number.isNaN(Date.parse(result.fetchTime))) return null
  let finalUrl: string
  try {
    const final = new URL(result.finalUrl)
    if (!["http:", "https:"].includes(final.protocol) || final.username || final.password) return null
    finalUrl = `${final.origin}${final.pathname}`
  } catch { return null }
  const metrics = METRICS.map(metric => ({ ...metric, value: result.audits[metric.id]?.numericValue ?? null }))
  if (metrics.every(m => m.value === null)) return null
  return { measuredAt: result.fetchTime, finalUrl, finalUrlQueryOmitted: true, lighthouseVersion: result.lighthouseVersion.slice(0, 80), metrics,
    hasWarnings: (result.runWarnings?.length ?? 0) > 0 }
}

/** Only allowlisted numeric measurements leave the provider boundary. */
const requestLabPerformance = async (url: string, strategy: "mobile" | "desktop", key: string) => {
  const endpoint = new URL("https://www.googleapis.com/pagespeedonline/v5/runPagespeed")
  endpoint.searchParams.set("url", url); endpoint.searchParams.set("strategy", strategy)
  endpoint.searchParams.set("category", "performance"); endpoint.searchParams.set("key", key)
  try {
    const response = await fetch(endpoint, { redirect: "error", signal: AbortSignal.timeout(60_000) })
    if (!response.ok || !response.body) { await response.body?.cancel(); return null }
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let bytes = 0
    try {
      for (;;) {
        const part = await reader.read()
        if (part.done) break
        bytes += part.value.byteLength
        if (bytes > 5_000_000) { await reader.cancel(); return null }
        chunks.push(part.value)
      }
    } finally { reader.releaseLock() }
    return decodeLabPerformance(JSON.parse(Buffer.concat(chunks).toString("utf8")))
  } catch { return null }
}

const unavailable = (status: string, summary: string, recovery: string): AgentToolResult => ({ summary, citations: [], data: { status, recovery } })

export const PERFORMANCE_AGENT_TOOLS: ReadonlyArray<AgentToolDef> = [{
  name: "measure_web_performance",
  description: "Measure one public page with Google's PageSpeed Insights Lighthouse lab run, only when performance matters to the assignment and the server has PAGESPEED_API_KEY. Sends the public URL to Google, takes up to a minute. URL must have no credentials, query or fragment. Returns lab LCP, CLS, FCP, speed index and total blocking time; these are not real-user Core Web Vitals, and blocking time is not INP. Not a ranking or conversion prediction. Read-only.",
  parameters: JSONSchema.make(Input),
  decode: raw => Schema.decodeUnknown(Input, { onExcessProperty: "error" })(raw),
  run: (accountId, businessId, input: typeof Input.Type) => Effect.gen(function*() {
    if (!(yield* (yield* BusinessRepository).getScoped(accountId, businessId))) return yield* Effect.fail(new AgentNotInScope())
    const key = process.env["PAGESPEED_API_KEY"]?.trim()
    if (!key) return unavailable("NOT_CONFIGURED", "Browser performance measurements are not configured", "Static page assessment and site audit still work. Do not present HTML download time as browser performance.")
    const web = yield* webAccess
    const robots = yield* Effect.tryPromise(() => readRobots(web, new URL(input.url).origin))
    if (robots.state === "NOT_PUBLIC") return unavailable("NOT_PUBLIC", "Performance measurement refused for this address", "Use a public website address.")
    if (!robots.allows(input.url) || robots.state === "DENIED" || robots.state === "UNAVAILABLE") return unavailable("ROBOTS_REFUSED", "Performance measurement could not access this page under the site's crawling rules", "Do not infer performance from a page that could not be measured.")
    const strategy = input.strategy ?? "mobile"
    const measurement = yield* Effect.promise(() => requestLabPerformance(input.url, strategy, key))
    if (!measurement) return unavailable("MEASUREMENT_UNAVAILABLE", "The browser performance run did not return usable measurements", "The page may be unavailable or the provider may have refused or timed out. Do not report missing metrics as zero.")
    return { summary: `Read ${strategy} lab performance measurements`, citations: [{ kind: "web", id: input.url, text: "PageSpeed Insights lab measurement" }],
      data: { source: "Google PageSpeed Insights / Lighthouse", basis: "LAB", requestedUrl: input.url, strategy, ...measurement,
        limitations: "One lab run, not real-user field data or evidence of a conversion or ranking effect. Results can vary between runs. Total blocking time is not INP. Null metrics are unavailable, not zero." } }
  }),
}]
