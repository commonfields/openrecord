// Network access for OpenRecord's research capabilities. Three kinds:
//
//   page(url)   a public website page, through the agent's SSRF-safe fetcher
//               and only where the site's robots.txt allows OpenRecord's agent;
//   api(url)    a documented public endpoint (web archive, domain registry
//               lookups, public feeds and job boards), only on the hosts listed
//               in PUBLIC_API_HOSTS, through the same SSRF-safe fetcher;
//   dns         public DNS records, through Node's resolver.
//
// Nothing here carries a business's data out: requests contain only the
// public domain, page or name being researched. Everything that comes back is
// untrusted third-party data.
import { promises as dns } from "node:dns"
import { Context, Effect, Option } from "effect"
import { safeFetch, type HttpTransport } from "@openrecord/representation"
import { AGENT_USER_AGENT, readRobots, webAccess, type WebAccessService } from "../web-access.js"

export type PageState = "OK" | "NOT_PUBLIC" | "BLOCKED_BY_ROBOTS" | "ROBOTS_UNAVAILABLE" | "UNREADABLE"
export interface PageResult { readonly state: PageState; readonly url: string; readonly finalUrl: string; readonly status: number | null; readonly body: string | null; readonly headers: Readonly<Record<string, string>>; readonly contentType: string | null
  /** Set when the page was read from the public web archive: the capture date. */
  readonly archivedAt?: string | null }
export interface ApiResult { readonly status: number | null; readonly body: string | null; readonly failure: string | null; readonly finalUrl?: string }
export interface DnsRecords { readonly mx: ReadonlyArray<string>; readonly txt: ReadonlyArray<string>; readonly ns: ReadonlyArray<string>; readonly cname: ReadonlyArray<string> }

export interface ResearchNetService {
  readonly page: (url: string, kind?: "page" | "xml") => Promise<PageResult>
  readonly api: (url: string, accept: "json" | "xml" | "html") => Promise<ApiResult>
  readonly dns: (host: string) => Promise<DnsRecords>
  /** Pages this network read from the public web archive because the site blocked automated reading. */
  readonly archivedReads?: () => ReadonlyArray<{ readonly url: string; readonly capturedAt: string | null }>
}
export class ResearchNet extends Context.Tag("ResearchNet")<ResearchNet, ResearchNetService>() {}
/** Transport for public endpoints; tests provide a fake. */
export class ResearchHttp extends Context.Tag("ResearchHttp")<ResearchHttp, HttpTransport>() {}

/** Hosts whose documented public endpoints research may call. A suffix entry starts with a dot. */
export const PUBLIC_API_HOSTS: ReadonlyArray<string> = [
  "web.archive.org", "archive.org", "data.iana.org", ".rdap.org", "rdap.org", ".nic", ".registry",
  "hn.algolia.com", "public.api.bsky.app", "www.youtube.com", "boards-api.greenhouse.io", "api.lever.co", "api.ashbyhq.com", "apply.workable.com",
  "graph.facebook.com",
]
/** RDAP servers come from IANA's bootstrap file; any https host it names is a registry and may be asked. */
const rdapHosts = new Set<string>()
export const allowRdapHost = (host: string) => { rdapHosts.add(host.toLowerCase()) }
export const isPublicApiHost = (host: string) => {
  const h = host.toLowerCase()
  return rdapHosts.has(h) || PUBLIC_API_HOSTS.some(p => p.startsWith(".") ? h.endsWith(p) : h === p)
}

export const PAGE_MAX_BYTES = 6_000_000
const ACCEPT: Readonly<Record<"json" | "xml" | "html", ReadonlyArray<string>>> = {
  json: ["application/json", "application/rdap+json", "text/json", "text/plain", "application/javascript"],
  xml: ["application/xml", "text/xml", "application/rss+xml", "application/atom+xml", "text/plain"],
  html: ["text/html", "application/xhtml+xml", "text/plain"],
}

// Public pages read in the last few minutes are reused across research runs, so one
// investigation does not fetch the same home page once per capability. Public
// content only; nothing business-specific is cached here.
const PAGE_TTL_MS = 10 * 60_000, PAGE_CACHE_MAX = 200
const pageCache = new Map<string, { at: number; result: PageResult }>()
/** Clears the shared page cache (tests). */
export const clearPageCache = () => pageCache.clear()

export const makeResearchNet = (web: WebAccessService, transport?: HttpTransport): ResearchNetService => {
  const robotsCache = new Map<string, Promise<Awaited<ReturnType<typeof readRobots>>>>()
  const read = async (url: string, kind: "page" | "xml"): Promise<PageResult> => {
      let origin: string
      try { origin = new URL(url).origin } catch { return { state: "NOT_PUBLIC", url, finalUrl: url, status: null, body: null, headers: {}, contentType: null } }
      const robots = await (robotsCache.get(origin) ?? (() => { const p = readRobots(web, origin); robotsCache.set(origin, p); return p })())
      const empty = (state: PageState): PageResult => ({ state, url, finalUrl: url, status: null, body: null, headers: {}, contentType: null })
      if (robots.state === "NOT_PUBLIC") return empty("NOT_PUBLIC")
      if (robots.state === "DENIED" || robots.state === "UNAVAILABLE") return empty("ROBOTS_UNAVAILABLE")
      if (!robots.allows(url)) return empty("BLOCKED_BY_ROBOTS")
      // Marketing sites often ship several megabytes of HTML; research reads up to PAGE_MAX_BYTES, through the same SSRF-safe fetcher.
      const ev = await safeFetch(url, {
        ...(transport ? { transport } : {}), userAgent: AGENT_USER_AGENT,
        limits: { timeoutMs: 15_000, maxRedirects: 5, maxBytes: PAGE_MAX_BYTES, acceptedContentTypes: kind === "xml" ? ACCEPT.xml : ACCEPT.html, allowMissingContentType: kind === "xml" },
      })
      const body = ev.failure === null && ev.body ? Buffer.from(ev.body).toString("utf8") : null
      if (body !== null && ev.finalUrl !== url) {
        // A redirect to another site is read only where that site's robots.txt allows it too.
        const target = new URL(ev.finalUrl).origin
        if (target !== origin) {
          const r2 = await (robotsCache.get(target) ?? (() => { const p = readRobots(web, target); robotsCache.set(target, p); return p })())
          if (r2.state === "NOT_PUBLIC") return empty("NOT_PUBLIC")
          if (r2.state !== "ABSENT" && r2.state !== "PRESENT") return empty("ROBOTS_UNAVAILABLE")
          if (!r2.allows(ev.finalUrl)) return empty("BLOCKED_BY_ROBOTS")
        }
      }
      return { state: body === null ? (ev.failure === "SECURITY_REJECTED" || ev.failure === "INVALID_URL" ? "NOT_PUBLIC" : "UNREADABLE") : "OK", url, finalUrl: ev.finalUrl, status: ev.status, body, headers: ev.headers, contentType: ev.contentType }
  }
  const archived: Array<{ url: string; capturedAt: string | null }> = []
  /** The latest public-archive copy of a page whose site blocked automated reading (never one robots.txt disallows). */
  const fromArchive = async (url: string, kind: "page" | "xml"): Promise<PageResult | null> => {
    const r = await net.api(`https://web.archive.org/web/2id_/${url}`, kind === "xml" ? "xml" : "html")
    if (!r.body || r.status !== 200) return null
    const ts = r.finalUrl?.match(/\/web\/(\d{14})id_\//)?.[1] ?? null
    const capturedAt = ts ? `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}` : null
    archived.push({ url, capturedAt })
    return { state: "OK", url, finalUrl: url, status: 200, body: r.body, headers: {}, contentType: kind === "xml" ? "application/xml" : "text/html", archivedAt: capturedAt }
  }
  const net: ResearchNetService = {
    archivedReads: () => archived,
    page: async (url, kind = "page") => {
      const key = `${kind}:${url}`, hit = pageCache.get(key)
      if (hit && Date.now() - hit.at < PAGE_TTL_MS) return hit.result
      let result = await read(url, kind)
      if (result.state === "ROBOTS_UNAVAILABLE" || (result.state === "UNREADABLE" && (result.status === null || [401, 403, 429, 503].includes(result.status)))) result = (await fromArchive(url, kind)) ?? result
      if (result.state === "OK") {
        if (pageCache.size >= PAGE_CACHE_MAX) pageCache.delete(pageCache.keys().next().value!)
        pageCache.set(key, { at: Date.now(), result })
      }
      return result
    },
    api: async (url, accept) => {
      let host: string
      try { const u = new URL(url); if (u.protocol !== "https:") return { status: null, body: null, failure: "NOT_ALLOWED" }; host = u.hostname } catch { return { status: null, body: null, failure: "INVALID_URL" } }
      if (!isPublicApiHost(host)) return { status: null, body: null, failure: "NOT_ALLOWED" }
      const ev = await safeFetch(url, {
        ...(transport ? { transport } : {}), userAgent: AGENT_USER_AGENT,
        limits: { timeoutMs: 15_000, maxRedirects: 3, maxBytes: 3_000_000, acceptedContentTypes: ACCEPT[accept], allowMissingContentType: true },
        redirectPolicy: { maxRedirects: 3, allowCrossOrigin: true, isAllowedRedirect: (next: string) => { try { const u = new URL(next); return u.protocol === "https:" && isPublicApiHost(u.hostname) } catch { return false } } },
      })
      return { status: ev.status, body: ev.body ? Buffer.from(ev.body).toString("utf8") : null, failure: ev.failure, finalUrl: ev.finalUrl }
    },
    dns: async host => {
      const safe = async <A>(f: () => Promise<A[]>) => { try { return await f() } catch { return [] as A[] } }
      const [mx, txt, ns, cname] = await Promise.all([
        safe(() => dns.resolveMx(host)).then(r => r.sort((a, b) => a.priority - b.priority).map(x => x.exchange.toLowerCase())),
        safe(() => dns.resolveTxt(host)).then(r => r.map(parts => parts.join(""))),
        safe(() => dns.resolveNs(host)).then(r => r.map(x => x.toLowerCase())),
        safe(() => dns.resolveCname(`www.${host}`)).then(r => r.map(x => x.toLowerCase())),
      ])
      return { mx, txt, ns, cname }
    },
  }
  return net
}

export const researchNet = Effect.gen(function*() {
  const given = yield* Effect.serviceOption(ResearchNet)
  if (Option.isSome(given)) return given.value
  const web = yield* webAccess
  const transport = Option.getOrUndefined(yield* Effect.serviceOption(ResearchHttp))
  return makeResearchNet(web, transport)
})
