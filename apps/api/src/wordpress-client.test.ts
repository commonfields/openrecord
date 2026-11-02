import { describe, expect, it } from "vitest"
import type { FetchInit, HttpTransport } from "@openrecord/representation"
import { WpError, faqBlock, normalizeSiteUrl, planChange, seoPluginOf, stored, toPost, wpRequest, type WpPost } from "./wordpress-client.js"

const post = (over: Partial<WpPost> = {}): WpPost => ({ id: 7, title: "Wedding DJs", content: "<!-- wp:paragraph -->\n<p>Hi</p>\n<!-- /wp:paragraph -->", link: "https://cueup.test/djs/", modified: "2026-10-01T00:00:00", status: "publish", meta: {}, ...over })

/** A transport that answers from a function, recording what was sent. */
const fake = (answer: (url: string, init: FetchInit) => { status: number; body: unknown }, ips = ["93.184.216.34"]) => {
  const sent: Array<{ url: string; init: FetchInit }> = []
  const transport: HttpTransport = {
    lookup: async () => ips,
    fetch: async (url, init) => { sent.push({ url, init }); const a = answer(url, init); return { status: a.status, headers: {}, body: new TextEncoder().encode(JSON.stringify(a.body)), peerIp: ips[0]! } },
  }
  return { transport, sent }
}

describe("WordPress site address and plugin", () => {
  it("keeps only https site addresses without credentials, query or trailing slash", () => {
    expect(normalizeSiteUrl("https://cueup.test/blog/")).toBe("https://cueup.test/blog")
    expect(normalizeSiteUrl("http://cueup.test")).toBeNull()
    expect(normalizeSiteUrl("https://user:pw@cueup.test")).toBeNull()
    expect(normalizeSiteUrl("https://cueup.test/?x=1")).toBeNull()
    expect(normalizeSiteUrl("https://localhost")).toBeNull()
  })
  it("recognizes Yoast and Rank Math from the REST namespaces", () => {
    expect(seoPluginOf(["wp/v2", "yoast/v1"])).toBe("YOAST")
    expect(seoPluginOf(["wp/v2", "rankmath/v1"])).toBe("RANK_MATH")
    expect(seoPluginOf(["wp/v2"])).toBe("NONE")
  })
})

describe("WordPress requests", () => {
  it("authenticates over the pinned connection and returns JSON", async () => {
    const f = fake(() => ({ status: 200, body: { ok: true } }))
    expect(await wpRequest({ siteUrl: "https://cueup.test", username: "ana", password: "abcd efgh" }, "POST", "/wp/v2/pages/7", { title: "x" }, f.transport)).toEqual({ ok: true })
    expect(f.sent[0]!.url).toBe("https://cueup.test/wp-json/wp/v2/pages/7")
    expect(f.sent[0]!.init).toMatchObject({ method: "POST", body: '{"title":"x"}', connectIp: "93.184.216.34", servername: "cueup.test" })
    expect(f.sent[0]!.init.headers["authorization"]).toBe(`Basic ${Buffer.from("ana:abcd efgh").toString("base64")}`)
  })
  it("refuses private networks, redirects and failed sign-ins without passing WordPress text on", async () => {
    const reason = async (p: Promise<unknown>) => { try { await p; return "ok" } catch (e) { return e instanceof WpError ? e.reason : "other" } }
    expect(await reason(wpRequest({ siteUrl: "https://cueup.test" }, "GET", "/", undefined, fake(() => ({ status: 200, body: {} }), ["10.0.0.5"]).transport))).toBe("NOT_PUBLIC")
    expect(await reason(wpRequest({ siteUrl: "https://cueup.test" }, "GET", "/", undefined, fake(() => ({ status: 200, body: {} }), ["93.184.216.34", "127.0.0.1"]).transport))).toBe("NOT_PUBLIC")
    expect(await reason(wpRequest({ siteUrl: "https://cueup.test" }, "GET", "/x", undefined, fake(() => ({ status: 302, body: {} })).transport))).toBe("REDIRECTED")
    expect(await reason(wpRequest({ siteUrl: "https://cueup.test" }, "GET", "/x", undefined, fake(() => ({ status: 401, body: { message: "secret detail" } })).transport))).toBe("AUTH")
    expect(await reason(wpRequest({ siteUrl: "https://cueup.test" }, "GET", "/", undefined, fake(() => ({ status: 404, body: {} })).transport))).toBe("REST_UNAVAILABLE")
  })
})

describe("WordPress changes", () => {
  it("updates only the copy that differs, and refuses a change that changes nothing", () => {
    expect(planChange({ kind: "UPDATE_COPY", title: "Wedding DJs in Bali" }, post(), "NONE", false)).toEqual({ before: { title: "Wedding DJs" }, after: { title: "Wedding DJs in Bali" } })
    expect(planChange({ kind: "UPDATE_COPY", title: "Wedding DJs" }, post(), "NONE", false)).toEqual({ refused: "NOTHING_TO_CHANGE" })
  })
  it("writes SEO fields through the site's plugin, and refuses without one", () => {
    expect(planChange({ kind: "SET_SEO", seoDescription: "Book a wedding DJ" }, post({ meta: { _yoast_wpseo_metadesc: "old" } }), "YOAST", false))
      .toEqual({ before: { meta: { _yoast_wpseo_metadesc: "old" } }, after: { meta: { _yoast_wpseo_metadesc: "Book a wedding DJ" } } })
    expect(planChange({ kind: "SET_SEO", seoTitle: "DJs" }, post(), "RANK_MATH", false)).toMatchObject({ after: { meta: { rank_math_title: "DJs" } } })
    expect(planChange({ kind: "SET_SEO", seoTitle: "DJs" }, post(), "NONE", false)).toEqual({ refused: "SEO_PLUGIN_MISSING" })
  })
  it("appends an escaped FAQ, with structured data only when scripts are allowed, that cannot break out of its script", () => {
    const faq = [{ question: "Do you <travel>?", answer: "Yes, across Bali </script><script>alert(1)</script>" }]
    const withData = planChange({ kind: "ADD_FAQ", faq }, post(), "NONE", true)
    if ("refused" in withData) throw new Error("refused")
    expect(withData.after.content).toContain("<h3 class=\"wp-block-heading\">Do you &lt;travel&gt;?</h3>")
    expect(withData.after.content).toContain('"@type": "FAQPage"')
    expect(withData.after.content).not.toContain("</script><script>")
    expect(faqBlock(faq, false)).not.toContain("application/ld+json")
  })
  it("creates a post as published, and confirms only what was stored exactly", () => {
    expect(planChange({ kind: "CREATE_POST", title: "Hiring a DJ", content: "<p>Body</p>" }, null, "NONE", false)).toEqual({ before: {}, after: { title: "Hiring a DJ", content: "<p>Body</p>", status: "publish" } })
    expect(stored(post({ title: "New" }), { title: "New" })).toBe(true)
    expect(stored(post(), { meta: { _yoast_wpseo_title: "x" } })).toBe(false)
    expect(toPost({ id: 3, title: { raw: "T" }, content: { raw: "C" }, meta: { a: "b", n: 1 } })).toMatchObject({ id: 3, title: "T", content: "C", meta: { a: "b" } })
  })
})
