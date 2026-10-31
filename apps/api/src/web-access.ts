// Web access for the agent: public pages through the shared SSRF-safe fetcher,
// robots.txt honoured for OpenRecord's agent token, and optional search and
// JavaScript rendering through context.dev when CONTEXT_DEV_API_KEY is set.
// Without context.dev, search can run through Gemini's Google Search
// grounding (geminiSearch below).
//
// Everything fetched is untrusted third-party content. It is returned to the
// model as quoted data and never changes what the agent may do. context.dev
// and Gemini receive only the URL or search query; no business data is sent.
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

// Gemini with Google Search grounding: Gemini searches Google and reports the
// pages it used. Each source arrives as a Google redirect link titled with its
// domain; the link is resolved (only on Google's grounding host, one hop,
// never followed further) to the page's own address, and its description is
// the text Gemini attributed to that source. Only the query is sent.
interface GeminiSearchOptions { readonly apiKey: string; readonly model: string; readonly fetch?: typeof fetch }
const GROUNDING_REDIRECT_HOST = "vertexaisearch.cloud.google.com"
export const geminiSearch = (opts: GeminiSearchOptions) => {
  if (!/^[a-z0-9][a-z0-9.-]{0,99}$/.test(opts.model)) throw new Error("invalid Gemini search model")
  const call = opts.fetch ?? fetch
  const resolve = async (uri: string): Promise<string | null> => {
    try {
      const u = new URL(uri)
      if (u.protocol !== "https:") return null
      if (u.hostname !== GROUNDING_REDIRECT_HOST) return publicHttpUrl(uri)
      const res = await call(uri, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(8_000) })
      await res.body?.cancel().catch(() => {})
      return res.status >= 300 && res.status < 400 ? publicHttpUrl(res.headers.get("location")) : null
    } catch { return null }
  }
  return {
    search: async (query: string, limit: number): Promise<ReadonlyArray<WebSearchResult>> => {
      const res = await call(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(opts.model)}:generateContent`, {
        method: "POST", signal: AbortSignal.timeout(45_000), redirect: "error",
        headers: { "content-type": "application/json", "x-goog-api-key": opts.apiKey },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: `Search the web for: ${query}\nFor each of the most relevant pages, one sentence on what it says.` }] }],
          tools: [{ google_search: {} }],
        }),
      })
      if (!res.ok) throw new Error(`Gemini search answered ${res.status}`)
      const text = await res.text()
      if (text.length > 4_000_000) throw new Error("Gemini search response too large")
      const raw = JSON.parse(text) as { candidates?: Array<{ groundingMetadata?: { groundingChunks?: Array<{ web?: { uri?: unknown; title?: unknown } }>; groundingSupports?: Array<{ segment?: { text?: unknown }; groundingChunkIndices?: unknown }> } }> }
      const meta = raw.candidates?.[0]?.groundingMetadata
      const chunks = (meta?.groundingChunks ?? []).slice(0, 20)
      const said = new Map<number, string[]>()
      for (const s of meta?.groundingSupports ?? []) {
        const segment = str(s.segment?.text, 400).replace(/\*\*/g, "")
        if (!segment || !Array.isArray(s.groundingChunkIndices)) continue
        for (const i of s.groundingChunkIndices) if (typeof i === "number") said.set(i, [...(said.get(i) ?? []), segment])
      }
      const urls = await Promise.all(chunks.map(c => typeof c.web?.uri === "string" ? resolve(c.web.uri) : Promise.resolve(null)))
      const seen = new Set<string>(), results: WebSearchResult[] = []
      urls.forEach((url, i) => {
        if (!url || seen.has(url) || results.length >= limit) return
        seen.add(url)
        results.push({ url, title: str(chunks[i]?.web?.title, 200) || new URL(url).hostname, description: str((said.get(i) ?? []).join(" "), 300) })
      })
      return results
    },
  }
}

export const makeWebAccess = (opts: { readonly transport?: HttpTransport; readonly contextDev?: ContextDevOptions | null; readonly geminiSearch?: GeminiSearchOptions | null } = {}): WebAccessService => {
  const cd = opts.contextDev ? contextDev(opts.contextDev) : null
  // context.dev searches when configured; otherwise Gemini's Google Search grounding.
  const gs = !cd && opts.geminiSearch ? geminiSearch(opts.geminiSearch) : null
  return { fetch: makeSafeFetcher(opts.transport), search: cd?.search ?? gs?.search ?? null, render: cd?.render ?? null,
    provider: cd ? "context.dev" : gs ? "Google Search through Gemini" : null }
}

/** Gemini search settings: an explicit GEMINI_SEARCH_API_KEY, or the hosted
 * Gemini agent model's key when its external processing is consented to. */
export const geminiSearchFromEnv = (env: NodeJS.ProcessEnv): GeminiSearchOptions | null => {
  const explicit = env["GEMINI_SEARCH_API_KEY"]?.trim()
  const agentGemini = (env["AGENT_PROVIDER"]?.trim() || "gemini") === "gemini"
  const consented = env["AGENT_EXTERNAL_PROCESSING_ENABLED"]?.trim() === "true"
  const apiKey = explicit || (agentGemini && consented ? env["AGENT_API_KEY"]?.trim() : undefined)
  if (!apiKey) return null
  // A light model is enough to search and attribute sources, and much faster.
  const model = env["GEMINI_SEARCH_MODEL"]?.trim() || "gemini-3.5-flash-lite"
  return { apiKey, model }
}

let live: WebAccessService | null = null
export const liveWebAccess = (): WebAccessService => {
  const key = process.env["CONTEXT_DEV_API_KEY"]?.trim()
  const baseUrl = process.env["CONTEXT_DEV_BASE_URL"]?.trim()
  return live ??= makeWebAccess({ contextDev: key ? { apiKey: key, ...(baseUrl ? { baseUrl } : {}) } : null, geminiSearch: geminiSearchFromEnv(process.env) })
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
