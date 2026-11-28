import { describe, expect, it } from "vitest"
import { LINKEDIN_ENDPOINTS, linkedinAuthorizationUrl, linkedinAuthors, linkedinCommentary, linkedinCreatePost, linkedinExchangeCode, linkedinPostStats, type LinkedInConfig } from "../src/linkedin.js"

const config = (fetch: LinkedInConfig["fetch"], organizations = true): LinkedInConfig => ({
  clientId: "cid", clientSecret: "SECRET", redirectUri: "https://api.example.test/api/ads/oauth/callback", version: "202611", organizations, endpoints: LINKEDIN_ENDPOINTS, fetch,
})
const json = (b: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(b), { status: 200, ...init })

describe("LinkedIn post text", () => {
  it("escapes reserved characters so nothing becomes a mention or breaks the post", () => {
    expect(linkedinCommentary("Pricing (new) for @teams_and *you* ~ <now> [x] {y} | a\\b"))
      .toBe("Pricing \\(new\\) for \\@teams\\_and \\*you\\* \\~ \\<now\\> \\[x\\] \\{y\\} \\| a\\\\b")
  })
  it("keeps #words as hashtags and leaves other # alone", () => {
    expect(linkedinCommentary("#Launch day: see issue#4 and #AI_tools.")).toBe("{hashtag|\\#|Launch} day: see issue\\#4 and {hashtag|\\#|AI\\_tools}.")
    expect(linkedinCommentary("Plain text, no symbols.")).toBe("Plain text, no symbols.")
  })
})

describe("LinkedIn sign-in", () => {
  it("asks for page scopes only when the app has page access", () => {
    expect(new URL(linkedinAuthorizationUrl(config(fetch, false), "S")).searchParams.get("scope")).toBe("openid profile w_member_social")
    expect(new URL(linkedinAuthorizationUrl(config(fetch, true), "S")).searchParams.get("scope")).toBe("openid profile w_member_social w_organization_social r_organization_social rw_organization_admin")
  })
  it("reads the granted scopes LinkedIn returns with the token", async () => {
    const t = await linkedinExchangeCode(config(async () => json({ access_token: "TOKEN", expires_in: 5184000, scope: "openid,profile,w_member_social" })), "code", 1000)
    expect(t).toEqual({ accessToken: "TOKEN", expiresAt: 1000 + 5184000 * 1000, refreshToken: null, scopes: ["openid", "profile", "w_member_social"] })
  })
})

describe("LinkedIn authors and posts", () => {
  it("lists pages the member may post for, then their own profile", async () => {
    const calls: string[] = []
    const fetch = async (url: string, init: RequestInit) => {
      calls.push(url)
      expect((init.headers as Record<string, string>)["linkedin-version"]).toBe("202611")
      if (url.includes("/organizationAcls")) return json({ elements: [
        { organization: "urn:li:organization:11", role: "ADMINISTRATOR", state: "APPROVED" },
        { organization: "urn:li:organization:12", role: "ANALYST", state: "APPROVED" },
        { organizationTarget: "urn:li:organization:13", role: "CONTENT_ADMIN", state: "APPROVED" },
      ] })
      if (url.endsWith("/organizations/11")) return json({ localizedName: "Zeta Co" })
      if (url.endsWith("/organizations/13")) return json({ localizedName: "Acme" })
      return json({}, { status: 404 })
    }
    const authors = await linkedinAuthors(config(fetch), "T", { subject: "aB3", name: "Sam" }, ["w_member_social", "w_organization_social"])
    expect(authors.map(a => [a.externalId, a.name])).toEqual([["urn:li:organization:13", "Acme"], ["urn:li:organization:11", "Zeta Co"], ["urn:li:person:aB3", "Sam (profile)"]])
    // Without page access, no page call is made.
    calls.length = 0
    expect((await linkedinAuthors(config(fetch), "T", { subject: "aB3", name: "Sam" }, ["w_member_social"])).length).toBe(1)
    expect(calls).toEqual([])
  })

  it("posts publicly and returns the URN LinkedIn puts in x-restli-id", async () => {
    let sent: Record<string, unknown> = {}
    const fetch = async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body))
      return new Response("", { status: 201, headers: { "x-restli-id": "urn:li:share:7001" } })
    }
    expect(await linkedinCreatePost(config(fetch), "T", "urn:li:organization:11", "Hello (world)")).toBe("urn:li:share:7001")
    expect(sent).toMatchObject({ author: "urn:li:organization:11", commentary: "Hello \\(world\\)", visibility: "PUBLIC", lifecycleState: "PUBLISHED" })
    await expect(linkedinCreatePost(config(async () => new Response("", { status: 201 })), "T", "urn:li:organization:11", "x")).rejects.toThrow()
    await expect(linkedinCreatePost(config(fetch), "T", "urn:li:company:11", "x")).rejects.toThrow()
  })

  it("reads lifetime page statistics, with silent posts as zeros", async () => {
    const urls: string[] = []
    const fetch = async (url: string) => {
      urls.push(url)
      return json({ elements: [{ share: "urn:li:share:1", totalShareStatistics: { impressionCount: 900, uniqueImpressionsCount: 700, clickCount: 30, likeCount: 12, commentCount: 3, shareCount: 2, engagement: 0.052 } }] })
    }
    const stats = await linkedinPostStats(config(fetch), "T", "urn:li:organization:11", ["urn:li:share:1", "urn:li:share:2", "not-a-urn"])
    expect(stats.get("urn:li:share:1")).toEqual({ impressions: 900, uniqueImpressions: 700, clicks: 30, likes: 12, comments: 3, shares: 2, engagement: 0.052 })
    expect(stats.get("urn:li:share:2")).toEqual({ impressions: 0, uniqueImpressions: 0, clicks: 0, likes: 0, comments: 0, shares: 0, engagement: 0 })
    expect(stats.has("not-a-urn")).toBe(false)
    expect(urls[0]).toContain("organizationalEntity=urn%3Ali%3Aorganization%3A11&shares=List(urn%3Ali%3Ashare%3A1,urn%3Ali%3Ashare%3A2)")
  })
})
