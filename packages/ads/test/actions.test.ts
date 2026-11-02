// Approved writes against scripted platform responses: the exact request
// each write sends, new ads always paused, and limits checked before sending.
import { describe, expect, it } from "vitest"
import {
  googleAdsCampaign, googleAdsCreateSearchAd, googleAdsRemoveAd, googleAdsSetCampaignStatus, googleAdsSetDailyBudget, googleBusinessDeleteReply,
  googleBusinessReply, googleBusinessReviewList, searchAdProblem, type GoogleAdsConfig, type GoogleBusinessConfig,
} from "../src/index.js"

type Call = { url: string; init: RequestInit }
const fake = (respond: (url: string, init: RequestInit) => { status?: number; body: unknown }) => {
  const calls: Call[] = []
  const f = async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    const r = respond(url, init)
    return new Response(r.body === "" ? "" : JSON.stringify(r.body), { status: r.status ?? 200 })
  }
  return { f, calls }
}
const google = (f: GoogleAdsConfig["fetch"]): GoogleAdsConfig => ({ developerToken: "dev-token", version: "v21", endpoint: "https://ads.test", authorize: "https://accounts.test/auth", fetch: f })
const gbp = (f: GoogleBusinessConfig["fetch"]): GoogleBusinessConfig => ({ authorize: "https://accounts.test/auth", fetch: f,
  endpoints: { accounts: "https://acct.test/v1", information: "https://info.test/v1", performance: "https://perf.test/v1", reviews: "https://reviews.test/v4" } })
const target = { customerId: "100", loginCustomerId: "900" }

describe("Google Business Profile review replies", () => {
  it("lists reviews with IDs and replies, and writes and removes one reply", async () => {
    const { f, calls } = fake((url, init) => ({ body: init.method === "DELETE" ? "" : url.includes("/reviews?") ? { reviews: [
      { reviewId: "r1", reviewer: { displayName: "Ana" }, starRating: "TWO", comment: "Waited an hour", createTime: "2026-10-30T10:00:00Z", updateTime: "2026-10-30T10:00:00Z" },
      { reviewId: "r2", reviewer: { isAnonymous: true }, starRating: "FIVE", comment: "Great", createTime: "2026-10-29T10:00:00Z", updateTime: "2026-10-29T11:00:00Z", reviewReply: { comment: "Thanks!", updateTime: "2026-10-29T11:00:00Z" } },
      { reviewId: "../bad", starRating: "ONE" }] } : { comment: "We are sorry", updateTime: "2026-11-02T10:00:00Z" } }))
    const c = gbp(f)
    expect(await googleBusinessReviewList(c, "tok", "111", "2222")).toMatchObject([
      { reviewId: "r1", reviewer: "Ana", rating: 2, reply: null }, { reviewId: "r2", reviewer: "Anonymous", rating: 5, reply: { comment: "Thanks!" } }])
    await googleBusinessReply(c, "tok", "111", "2222", "r1", "We are sorry")
    expect(calls[1]).toMatchObject({ url: "https://reviews.test/v4/accounts/111/locations/2222/reviews/r1/reply", init: { method: "PUT", body: JSON.stringify({ comment: "We are sorry" }) } })
    await googleBusinessDeleteReply(c, "tok", "111", "2222", "r1")
    expect(calls[2]).toMatchObject({ url: "https://reviews.test/v4/accounts/111/locations/2222/reviews/r1/reply", init: { method: "DELETE" } })
    await expect(googleBusinessReply(c, "tok", "111", "2222", "../x", "Hi")).rejects.toMatchObject({ kind: "UNEXPECTED" })
    await expect(googleBusinessReply(c, "tok", "111", "2222", "r1", " ")).rejects.toMatchObject({ kind: "UNEXPECTED" })
  })
})

describe("Google Ads approved changes", () => {
  it("reads a campaign with its budget, and sends status and budget updates with the exact mask", async () => {
    const { f, calls } = fake(url => ({ body: url.endsWith("googleAds:search")
      ? { results: [{ campaign: { id: "7", name: "Brand", status: "ENABLED", advertisingChannelType: "SEARCH" }, campaignBudget: { resourceName: "customers/100/campaignBudgets/55", amountMicros: "20000000", explicitlyShared: false, period: "DAILY" } }] }
      : { results: [{ resourceName: "customers/100/campaigns/7" }] } }))
    const c = google(f)
    expect(await googleAdsCampaign(c, "tok", target, "7")).toEqual({ campaignId: "7", name: "Brand", status: "ENABLED", channel: "SEARCH",
      budget: { resourceName: "customers/100/campaignBudgets/55", dailyMicros: 20_000_000, shared: false, period: "DAILY" } })
    await googleAdsSetCampaignStatus(c, "tok", target, "7", "PAUSED", true)
    expect(calls[1]!.url).toBe("https://ads.test/v21/customers/100/campaigns:mutate")
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({ operations: [{ update: { resourceName: "customers/100/campaigns/7", status: "PAUSED" }, updateMask: "status" }], validateOnly: true })
    expect((calls[1]!.init.headers as Record<string, string>)["login-customer-id"]).toBe("900")
    await googleAdsSetDailyBudget(c, "tok", target, "customers/100/campaignBudgets/55", 30_000_000)
    expect(JSON.parse(String(calls[2]!.init.body))).toEqual({ operations: [{ update: { resourceName: "customers/100/campaignBudgets/55", amountMicros: "30000000" }, updateMask: "amount_micros" }] })
    // Another customer's budget, or a bad campaign ID, is never sent.
    await expect(googleAdsSetDailyBudget(c, "tok", target, "customers/200/campaignBudgets/55", 1)).rejects.toMatchObject({ kind: "UNEXPECTED" })
    await expect(googleAdsSetCampaignStatus(c, "tok", target, "7 OR 1=1", "ENABLED")).rejects.toMatchObject({ kind: "UNEXPECTED" })
    expect(calls).toHaveLength(3)
  })

  it("creates a responsive search ad paused, within Google's limits, and can remove it", async () => {
    const { f, calls } = fake(() => ({ body: { results: [{ resourceName: "customers/100/adGroupAds/8~99" }] } }))
    const c = google(f)
    const draft = { headlines: ["Moderation for any app", "Text, image and video", "Start free today"], descriptions: ["Catch harmful content before users see it.", "One API for every content type."], finalUrl: "https://example.com/start", path1: "moderation" }
    expect(searchAdProblem(draft)).toBeNull()
    expect(searchAdProblem({ ...draft, headlines: ["a", "b"] })).toBe("HEADLINE_COUNT")
    expect(searchAdProblem({ ...draft, headlines: [...draft.headlines.slice(0, 2), "x".repeat(31)] })).toBe("HEADLINE_LENGTH")
    expect(searchAdProblem({ ...draft, finalUrl: "http://example.com" })).toBe("FINAL_URL")
    expect(await googleAdsCreateSearchAd(c, "tok", target, "8", draft)).toBe("customers/100/adGroupAds/8~99")
    const op = JSON.parse(String(calls[0]!.init.body)).operations[0].create
    expect(op).toMatchObject({ adGroup: "customers/100/adGroups/8", status: "PAUSED", ad: { finalUrls: ["https://example.com/start"], responsiveSearchAd: { path1: "moderation" } } })
    await googleAdsRemoveAd(c, "tok", target, "customers/100/adGroupAds/8~99")
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({ operations: [{ remove: "customers/100/adGroupAds/8~99" }] })
    await expect(googleAdsRemoveAd(c, "tok", target, "customers/200/adGroupAds/8~99")).rejects.toMatchObject({ kind: "UNEXPECTED" })
  })
})
