// Web access for the agent: public pages through the shared SSRF-safe fetcher,
// robots.txt honoured for OpenRecord's agent token, and optional search and
// JavaScript rendering through context.dev when CONTEXT_DEV_API_KEY is set.
//
// Everything fetched is untrusted third-party content. It is returned to the
// model as quoted data and never changes what the agent may do. context.dev
// receives only the URL or search query; no business data is sent with it.
import { Context, Effect, Option } from "effect"
import { safeFetch, type HttpTransport } from "@openrecord/representation"
import { isAllowed, parseRobots } from "@openrecord/discovery"

export const AGENT_USER_AGENT = "OpenRecord-Agent/1.0"
export const AGENT_ROBOTS_TOKEN = "OpenRecord-Agent"

export type WebKind = "page" | "text" | "xml"
export interface WebDocument {
  readonly requestedUrl: string
  readonly finalUrl: string
  readonly status: number | null
  readonly contentType: string | null
  readonly headers: Readonly<Record<string, string>>
  readonly body: string | null
  readonly bytes: number
  /** null when a 2xx document arrived; otherwise why not. */
  readonly failure: string | null
  readonly redirectChain: ReadonlyArray<string>
  readonly elapsedMs: number
}
export interface WebSearchResult { readonly url: string; readonly title: string; readonly description: string }
export interface RenderedPage { readonly finalUrl: string; readonly title: string | null; readonly markdown: string }

export interface WebAccessService {
  readonly fetch: (url: string, kind: WebKind) => Promise<WebDocument>
  /** null when no search provider is configured. */
  readonly search: ((query: string, limit: number) => Promise<ReadonlyArray<WebSearchResult>>) | null
  /** Renders JavaScript-built pages; null when no provider is configured. */
  readonly render: ((url: string) => Promise<RenderedPage | null>) | null
  readonly provider: string | null
}
export class WebAccess extends Context.Tag("WebAccess")<WebAccess, WebAccessService>() {}

const ACCEPT: Readonly<Record<WebKind, ReadonlyArray<string>>> = {
  page: ["text/html", "application/xhtml+xml", "text/plain"],
  text: ["text/plain"],
  xml: ["application/xml", "text/xml", "application/rss+xml", "application/atom+xml"],
}
const MAX_BYTES: Readonly<Record<WebKind, number>> = { page: 1_000_000, text: 256_000, xml: 2_000_000 }

export const makeSafeFetcher = (transport?: HttpTransport) => async (url: string, kind: WebKind): Promise<WebDocument> => {
  const ev = await safeFetch(url, {
    ...(transport ? { transport } : {}),
    userAgent: AGENT_USER_AGENT,
    limits: { timeoutMs: 8000, maxRedirects: 5, maxBytes: MAX_BYTES[kind], acceptedContentTypes: ACCEPT[kind], allowMissingContentType: kind === "text" },
  })
  const elapsedMs = Math.max(0, Date.parse(ev.completedAt) - Date.parse(ev.startedAt))
  const ok = ev.failure === null && ev.body !== null
  return {
    requestedUrl: ev.requestedUrl, finalUrl: ev.finalUrl, status: ev.status, contentType: ev.contentType, headers: ev.headers,
    body: ok ? new TextDecoder().decode(ev.body!) : null, bytes: ev.bodyBytes,
    failure: ok ? null : ev.status !== null && (ev.status < 200 || ev.status >= 300) ? `HTTP_${ev.status}` : ev.failure ?? "NETWORK_ERROR",
    redirectChain: ev.redirectChain, elapsedMs,
  }
}

// context.dev: https://docs.context.dev (POST /v1/web/search, POST /v1/web/scrape).
interface ContextDevOptions { readonly apiKey: string; readonly baseUrl?: string; readonly fetch?: typeof fetch }
const str = (v: unknown, max: number) => typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : ""
const publicHttpUrl = (v: unknown) => {
  if (typeof v !== "string" || v.length > 2000) return null
  try { const u = new URL(v); return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null } catch { return null }
}
export const contextDev = (opts: ContextDevOptions) => {
  const base = (opts.baseUrl ?? "https://api.context.dev/v1").replace(/\/+$/, "")
  if (!/^https:\/\//.test(base)) throw new Error("context.dev base URL must use HTTPS")
  const call = async (path: string, body: unknown): Promise<unknown> => {
    const res = await (opts.fetch ?? fetch)(`${base}${path}`, {
      method: "POST", body: JSON.stringify(body), signal: AbortSignal.timeout(20_000),
      headers: { authorization: `Bearer ${opts.apiKey}`, "content-type": "application/json" },
    })
    if (!res.ok) throw new Error(`context.dev ${path} answered ${res.status}`)
    const text = await res.text()
    if (text.length > 4_000_000) throw new Error("context.dev response too large")
    return JSON.parse(text) as unknown
  }
  return {
    search: async (query: string, limit: number): Promise<ReadonlyArray<WebSearchResult>> => {
      const raw = await call("/web/search", { query, numResults: limit, descriptionMaxCharacters: 300 }) as { results?: unknown }
      const results = Array.isArray(raw.results) ? raw.results : []
      return results.flatMap((r): WebSearchResult[] => {
        const o = (r ?? {}) as Record<string, unknown>
        const url = publicHttpUrl(o["url"])
        return url ? [{ url, title: str(o["title"], 200), description: str(o["description"], 300) }] : []
      }).slice(0, limit)
    },
    render: async (url: string): Promise<RenderedPage | null> => {
      const raw = await call("/web/scrape", { url, formats: { markdown: true }, sharedParams: { mainContentOnly: true } }) as Record<string, unknown>
      const md = (raw["markdown"] ?? {}) as Record<string, unknown>
      const meta = (raw["metadata"] ?? {}) as Record<string, unknown>
      const markdown = typeof md["data"] === "string" ? md["data"] : typeof raw["markdown"] === "string" ? raw["markdown"] : ""
      if (!markdown.trim()) return null
      return { finalUrl: publicHttpUrl(meta["url"]) ?? url, title: str(meta["title"], 300) || null, markdown }
    },
  }
}

export const makeWebAccess = (opts: { readonly transport?: HttpTransport; readonly contextDev?: ContextDevOptions | null } = {}): WebAccessService => {
  const cd = opts.contextDev ? contextDev(opts.contextDev) : null
  return { fetch: makeSafeFetcher(opts.transport), search: cd?.search ?? null, render: cd?.render ?? null, provider: cd ? "context.dev" : null }
}

let live: WebAccessService | null = null
export const liveWebAccess = (): WebAccessService => {
  const key = process.env["CONTEXT_DEV_API_KEY"]?.trim()
  const baseUrl = process.env["CONTEXT_DEV_BASE_URL"]?.trim()
  return live ??= makeWebAccess({ contextDev: key ? { apiKey: key, ...(baseUrl ? { baseUrl } : {}) } : null })
}
/** The configured web access: a provided WebAccess (tests), else the live one. */
export const webAccess = Effect.map(Effect.serviceOption(WebAccess), o => Option.getOrElse(o, liveWebAccess))

export type RobotsState = "PRESENT" | "ABSENT" | "DENIED" | "UNAVAILABLE" | "NOT_PUBLIC"
export interface SiteRobots {
  readonly state: RobotsState
  readonly text: string
  /** Whether OpenRecord's agent may fetch a path. False unless robots.txt was read or absent. */
  readonly allows: (url: string) => boolean
  readonly sitemaps: ReadonlyArray<string>
}
/** robots.txt for an origin, with the discovery crawler's semantics: 404/410
 * allow everything, 401/403 deny everything, other failures fail closed. */
export const readRobots = async (web: WebAccessService, origin: string): Promise<SiteRobots> => {
  const doc = await web.fetch(`${origin}/robots.txt`, "text")
  const closed = (state: RobotsState): SiteRobots => ({ state, text: "", allows: () => false, sitemaps: [] })
  if (doc.failure === "SECURITY_REJECTED" || doc.failure === "INVALID_URL") return closed("NOT_PUBLIC")
  if (doc.status === 404 || doc.status === 410) return { state: "ABSENT", text: "", allows: () => true, sitemaps: [] }
  if (doc.status === 401 || doc.status === 403) return closed("DENIED")
  if (doc.body === null) {
    // A robots.txt served as HTML by a catch-all route is treated as absent.
    if (doc.failure === "UNSUPPORTED_CONTENT_TYPE" && doc.status !== null && doc.status >= 200 && doc.status < 300) return { state: "ABSENT", text: "", allows: () => true, sitemaps: [] }
    return closed("UNAVAILABLE")
  }
  const rules = parseRobots(doc.body, [AGENT_ROBOTS_TOKEN, "*"])
  return {
    state: "PRESENT", text: doc.body, sitemaps: rules.sitemaps,
    allows: url => { try { const u = new URL(url); return u.origin === origin && isAllowed(`${u.pathname}${u.search}`, rules) } catch { return false } },
  }
}
