// The site audit and web access against a scripted website: robots.txt is read
// before any page, AI search crawlers are told apart from training crawlers,
// and private addresses never get a request.
import { describe, expect, it } from "vitest"
import type { HttpTransport } from "@openrecord/representation"
import { auditSite } from "./site-audit.js"
import { contextDev, makeSafeFetcher, makeWebAccess, readRobots, type WebAccessService, type WebDocument, type WebKind } from "./web-access.js"

type Route = { status: number; type?: string; body?: string; ms?: number; location?: string }
const site = (routes: Record<string, Route>) => {
  const requested: string[] = []
  const web: WebAccessService = {
    provider: null, search: null, render: null,
    fetch: async (url: string, kind: WebKind): Promise<WebDocument> => {
      requested.push(url)
      const r = routes[url] ?? { status: 404, type: "text/html", body: "missing" }
      const type = r.type ?? (kind === "xml" ? "application/xml" : kind === "text" ? "text/plain" : "text/html")
      const ok = r.status >= 200 && r.status < 300
      const final = r.location ?? url
      return { requestedUrl: url, finalUrl: final, status: r.status, contentType: type, headers: { "content-type": type }, body: ok ? r.body ?? "" : null,
        bytes: (r.body ?? "").length, failure: ok ? null : `HTTP_${r.status}`, redirectChain: r.location ? [url, final] : [url], elapsedMs: r.ms ?? 100 }
    },
  }
  return { web, requested }
}
const html = (title: string, body: string, head = "") => `<!doctype html><html lang="en"><head><title>${title}</title>
  <meta name="description" content="Online booking for small clinics, with reminders, payments and a calendar your front desk will like.">
  <link rel="canonical" href="https://northstar.test/"><meta property="og:title" content="${title}">${head}</head><body>${body}</body></html>`
const words = (n: number) => "<p>" + "booking ".repeat(n) + "</p>"
const ORG = `<script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"Northstar"}</script>`

describe("site audit", () => {
  it("audits the sitemap's pages and reports search, AI-answer and content issues with fixes and checks", async () => {
    const { web, requested } = site({
      "https://northstar.test/robots.txt": { status: 200, body: "User-agent: GPTBot\nDisallow: /\n\nUser-agent: OAI-SearchBot\nDisallow: /\n\nUser-agent: *\nDisallow: /admin\nSitemap: https://northstar.test/sitemap.xml" },
      "https://northstar.test/": { status: 200, body: html("Northstar clinic scheduling software", `<h1>Scheduling</h1>${words(400)}<a href="/admin/x">Admin</a>`) },
      "https://northstar.test/sitemap.xml": { status: 200, body: `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://northstar.test/pricing</loc></url><url><loc>https://northstar.test/app</loc></url><url><loc>https://northstar.test/gone</loc></url></urlset>` },
      "https://northstar.test/pricing": { status: 200, ms: 2600, body: html("Northstar clinic scheduling software", `<h1>Pricing</h1>${words(120)}`) },
      "https://northstar.test/app": { status: 200, body: html("Northstar app for clinics and practices", `<div id="root"></div><script src="/app.js"></script>`) },
    })
    const audit = await auditSite(web, { url: "https://northstar.test/" })
    if ("refused" in audit) throw new Error("refused")
    expect(requested[0]).toBe("https://northstar.test/robots.txt")
    expect(requested).not.toContain("https://northstar.test/admin/x")
    expect(audit.gaps).toContain("1 pages skipped because robots.txt disallows OpenRecord's agent")
    expect(audit).toMatchObject({ site: "https://northstar.test", robots: "PRESENT", sitemap: { found: true, urls: 3 }, llmsTxt: false, pagesRead: 3, pagesFailed: 1 })
    const checks = Object.fromEntries(audit.issues.map(i => [i.check, i]))
    // OAI-SearchBot decides ChatGPT search results; GPTBot is training only and is the business's choice.
    expect(checks["AI_SEARCH_CRAWLER_BLOCKED"]).toMatchObject({ priority: "HIGH", area: "AI answers", title: "robots.txt blocks OAI-SearchBot" })
    expect(audit.aiCrawlers.find(c => c.agent === "GPTBot")).toMatchObject({ allowed: false, use: "training" })
    expect(checks["CONTENT_NEEDS_JAVASCRIPT"]).toMatchObject({ priority: "HIGH", examples: ["https://northstar.test/app"] })
    expect(checks["NOT_FOUND"]).toMatchObject({ examples: ["https://northstar.test/gone"] })
    expect(checks["NO_ORGANIZATION_DATA"]).toMatchObject({ priority: "MEDIUM", examples: ["https://northstar.test/"] })
    expect(checks["DUPLICATE_TITLE"]?.pages).toBe(2)
    expect(checks["THIN_CONTENT"]?.examples).toEqual(["https://northstar.test/pricing"])
    expect(checks["SLOW_RESPONSE"]?.examples).toEqual(["https://northstar.test/pricing"])
    for (const i of audit.issues) { expect(i.fix.length).toBeGreaterThan(10); expect(i.verify.length).toBeGreaterThan(10) }
    // Highest priority first.
    expect(audit.issues.map(i => i.priority)).toEqual([...audit.issues.map(i => i.priority)].sort((a, b) => ["CRITICAL", "HIGH", "MEDIUM", "LOW"].indexOf(a) - ["CRITICAL", "HIGH", "MEDIUM", "LOW"].indexOf(b)))
    expect(JSON.stringify(audit).length).toBeLessThan(18000)
  })

  it("stops before any page when robots.txt does not answer, and treats a missing robots.txt as allow-all", async () => {
    const down = site({ "https://northstar.test/robots.txt": { status: 503 } })
    const none = await auditSite(down.web, { url: "https://northstar.test/" })
    expect(none).toMatchObject({ pagesRead: 0, gaps: ["robots.txt could not be read (no answer), so no pages were audited"] })
    expect(down.requested).toEqual(["https://northstar.test/robots.txt"])

    const open = site({ "https://northstar.test/": { status: 200, body: html("Northstar clinic scheduling software", `<h1>Hi</h1>${words(300)}${ORG}`) } })
    const audit = await auditSite(open.web, { url: "https://northstar.test/" })
    if ("refused" in audit) throw new Error("refused")
    expect(audit).toMatchObject({ robots: "ABSENT", pagesRead: 1 })
    expect(audit.aiCrawlers.every(c => c.allowed)).toBe(true)
    expect(audit.issues.map(i => i.check)).toEqual(["SITEMAP_MISSING"])
  })

  it("follows the home page to its final origin and reads that origin's robots.txt", async () => {
    const { web, requested } = site({
      "http://northstar.test/robots.txt": { status: 404 },
      "http://northstar.test/": { status: 200, location: "https://www.northstar.test/", body: html("Northstar clinic scheduling software", `<h1>Hi</h1>${words(300)}${ORG}`) },
      "https://www.northstar.test/robots.txt": { status: 200, body: "User-agent: *\nAllow: /" },
    })
    const audit = await auditSite(web, { url: "http://northstar.test" })
    if ("refused" in audit) throw new Error("refused")
    expect(audit.site).toBe("https://www.northstar.test")
    expect(requested).toContain("https://www.northstar.test/robots.txt")
  })
})

describe("web access", () => {
  const transport = (ip: string, status = 200, body = "User-agent: *\nDisallow:"): HttpTransport & { calls: number } => {
    const t = {
      calls: 0,
      lookup: async () => [ip],
      fetch: async () => { t.calls += 1; return { status, headers: { "content-type": "text/plain" }, body: new TextEncoder().encode(body), peerIp: ip } },
    }
    return t
  }

  it("refuses private and internal addresses before any request", async () => {
    const t = transport("10.0.0.5")
    const web = makeWebAccess({ transport: t })
    expect((await readRobots(web, "http://intranet.local")).state).toBe("NOT_PUBLIC")
    expect(await auditSite(web, { url: "http://intranet.local/" })).toEqual({ refused: "NOT_PUBLIC" })
    expect(t.calls).toBe(0)
  })

  it("reads robots.txt with the discovery crawler's semantics", async () => {
    const at = async (status: number, body?: string) => readRobots(makeWebAccess({ transport: transport("93.184.216.34", status, body) }), "https://northstar.test")
    expect((await at(404)).state).toBe("ABSENT")
    expect((await at(403)).state).toBe("DENIED")
    expect((await at(500)).state).toBe("UNAVAILABLE")
    const rules = await at(200, "User-agent: OpenRecord-Agent\nDisallow: /private\n\nUser-agent: *\nDisallow: /")
    expect(rules.allows("https://northstar.test/pricing")).toBe(true)
    expect(rules.allows("https://northstar.test/private/a")).toBe(false)
    expect(rules.allows("https://other.test/pricing")).toBe(false)
  })

  it("sends a user agent and decodes page bodies", async () => {
    let headers: Record<string, string> = {}
    const fetcher = makeSafeFetcher({ lookup: async () => ["93.184.216.34"], fetch: async (_u, init) => { headers = init.headers; return { status: 200, headers: { "content-type": "text/html; charset=utf-8" }, body: new TextEncoder().encode("<p>héllo</p>"), peerIp: "93.184.216.34" } } })
    const doc = await fetcher("https://northstar.test/", "page")
    expect(doc).toMatchObject({ status: 200, body: "<p>héllo</p>", failure: null })
    expect(headers["user-agent"]).toBe("OpenRecord-Agent/1.0")
  })

  it("parses context.dev search and scrape answers and keeps only http(s) result URLs", async () => {
    const calls: Array<{ url: string; body: unknown; auth: string | null }> = []
    const fake = (async (url: string, init?: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init?.body)), auth: new Headers(init?.headers).get("authorization") })
      const body = url.endsWith("/web/search")
        ? { results: [{ url: "https://a.test/x", title: " A ", description: "First" }, { url: "javascript:alert(1)", title: "bad" }] }
        : { markdown: { data: "# Hello" }, metadata: { title: "Hello page", url: "https://a.test/final" } }
      return new Response(JSON.stringify(body), { status: 200 })
    }) as typeof fetch
    const cd = contextDev({ apiKey: "k", fetch: fake })
    expect(await cd.search("clinic booking", 5)).toEqual([{ url: "https://a.test/x", title: "A", description: "First" }])
    expect(await cd.render("https://a.test/")).toEqual({ finalUrl: "https://a.test/final", title: "Hello page", markdown: "# Hello" })
    expect(calls[0]).toEqual({ url: "https://api.context.dev/v1/web/search", body: { query: "clinic booking", numResults: 5, descriptionMaxCharacters: 300 }, auth: "Bearer k" })
    expect(calls[1]?.body).toEqual({ url: "https://a.test/", formats: { markdown: true }, sharedParams: { mainContentOnly: true } })
    expect(() => contextDev({ apiKey: "k", baseUrl: "http://api.context.dev/v1" })).toThrow()
  })
})
