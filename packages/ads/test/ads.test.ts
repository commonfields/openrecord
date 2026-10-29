// Meta and Google Ads readers against scripted platform responses: what is
// requested, how totals and campaigns are read, and how failures are classed.
import { createHmac } from "node:crypto"
import { describe, expect, it } from "vitest"
import { adWindows } from "@openrecord/contracts"
import {
  AdsError, adsConfigFromEnv, googleAdsAccounts, googleAdsCampaigns, googleAdsTotals, metaAdAccounts, metaAuthorizationUrl, metaCampaigns, metaExchangeCode, metaTotals,
  type GoogleAdsConfig, type MetaConfig,
} from "../src/index.js"

type Call = { url: string; init: RequestInit }
const fake = (respond: (url: string, init: RequestInit) => { status?: number; body: unknown }) => {
  const calls: Call[] = []
  const f = async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    const r = respond(url, init)
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { "content-type": "application/json" } })
  }
  return { f, calls }
}
const meta = (f: MetaConfig["fetch"]): MetaConfig => ({ appId: "111", appSecret: "app-secret", redirectUri: "https://api.test/api/ads/oauth/callback", version: "v23.0", endpoints: { dialog: "https://fb.test", graph: "https://graph.test" }, fetch: f })
const google = (f: GoogleAdsConfig["fetch"]): GoogleAdsConfig => ({ developerToken: "dev-token", version: "v21", endpoint: "https://ads.test", authorize: "https://accounts.test/auth", fetch: f })
const window = { start: "2026-10-01", end: "2026-10-28" }

describe("Meta ads", () => {
  it("asks only for ads_read, and trades the code for a long-lived token", async () => {
    const url = new URL(metaAuthorizationUrl(meta(fetch), "state123"))
    expect(url.searchParams.get("scope")).toBe("ads_read")
    expect(url.pathname).toBe("/v23.0/dialog/oauth")
    const { f, calls } = fake((_u, init) => ({ body: String(init.body).includes("fb_exchange_token") ? { access_token: "long", expires_in: 5_184_000 } : { access_token: "short", expires_in: 3600 } }))
    const t = await metaExchangeCode(meta(f), "code", 0)
    expect(t).toEqual({ accessToken: "long", expiresAt: 5_184_000_000 })
    expect(String(calls[1]!.init.body)).toContain("fb_exchange_token=short")
    // Secrets go in the POST body, never the URL.
    expect(calls.every(c => !c.url.includes("app-secret"))).toBe(true)
  })

  it("reads ad accounts, totals and campaigns with appsecret_proof and the token in a header", async () => {
    const { f, calls } = fake(url => {
      if (url.includes("/me/adaccounts")) return { body: { data: [{ account_id: "222", name: "Northstar", currency: "USD", account_status: 1 }, { account_id: "bad", name: "x" }] } }
      if (url.includes("level=account")) return { body: { data: [{ spend: "120.50", impressions: "10000", clicks: "250",
        actions: [{ action_type: "purchase", value: "4" }, { action_type: "omni_purchase", value: "5" }, { action_type: "lead", value: "3" }],
        action_values: [{ action_type: "omni_purchase", value: "600" }] }] } }
      return { body: { data: [{ campaign_id: "1", campaign_name: "Small", spend: "20" }, { campaign_id: "2", campaign_name: "Big", spend: "100.5", clicks: "200" }] } }
    })
    const c = meta(f)
    expect(await metaAdAccounts(c, "tok")).toEqual([{ externalId: "222", name: "Northstar", currency: "USD", loginCustomerId: null, active: true }])
    const totals = await metaTotals(c, "tok", "222", window)
    // omni_purchase is preferred over purchase so a purchase is never counted twice.
    expect(totals).toMatchObject({ spend: 120.5, impressions: 10000, clicks: 250, conversions: 8, conversionValue: 600, ctr: 0.025, roas: 600 / 120.5 })
    expect((await metaCampaigns(c, "tok", "222", window, 10)).map(r => r.name)).toEqual(["Big", "Small"])
    const proof = createHmac("sha256", "app-secret").update("tok").digest("hex")
    for (const call of calls) {
      expect(call.url).toContain(`appsecret_proof=${proof}`)
      expect(call.url).not.toContain("tok&")
      expect((call.init.headers as Record<string, string>)["authorization"]).toBe("Bearer tok")
      expect(call.init.method).toBe("GET")
    }
    expect(decodeURIComponent(calls[1]!.url)).toContain('time_range={"since":"2026-10-01","until":"2026-10-28"}')
  })

  it("classes an expired token, a rate limit and a permission error", async () => {
    const err = (code: number) => fake(() => ({ status: 400, body: { error: { message: "secret detail", code } } })).f
    const kind = async (code: number) => (await metaTotals(meta(err(code)), "t", "1", window).catch(e => e)) as AdsError
    expect((await kind(190)).kind).toBe("AUTH")
    expect((await kind(17)).kind).toBe("QUOTA")
    expect((await kind(200)).kind).toBe("FORBIDDEN")
    expect((await kind(190)).message).not.toContain("secret detail")
  })
})

describe("Google Ads", () => {
  it("lists accounts directly and through a manager, sending the developer token and login-customer-id", async () => {
    const { f, calls } = fake((url, init) => {
      if (url.endsWith("customers:listAccessibleCustomers")) return { body: { resourceNames: ["customers/100", "customers/900"] } }
      const body = JSON.parse(String(init.body)) as { query: string }
      expect(body.query.startsWith("SELECT")).toBe(true)
      if (url.includes("/customers/900/")) return { body: { results: [
        { customerClient: { id: "900", descriptiveName: "Agency MCC", manager: true } },
        { customerClient: { id: "300", descriptiveName: "Client B", currencyCode: "EUR", manager: false, status: "ENABLED" } },
        { customerClient: { id: "100", descriptiveName: "Client A", currencyCode: "USD", manager: false, status: "ENABLED" } }] } }
      return { body: { results: [{ customerClient: { id: "100", descriptiveName: "Client A", currencyCode: "USD", manager: false, status: "ENABLED" } }] } }
    })
    const accounts = await googleAdsAccounts(google(f), "tok")
    expect(accounts).toEqual([
      { externalId: "100", name: "Client A", currency: "USD", loginCustomerId: null, active: true },
      { externalId: "300", name: "Client B", currency: "EUR", loginCustomerId: "900", active: true },
    ])
    const h = calls[2]!.init.headers as Record<string, string>
    expect(h["developer-token"]).toBe("dev-token")
    expect(h["login-customer-id"]).toBe("900")
    // Only listing and search are ever called: both read.
    expect(calls.every(c => c.url.endsWith("customers:listAccessibleCustomers") || c.url.endsWith("googleAds:search"))).toBe(true)
  })

  it("reads totals from cost in micros and int64 strings, and campaigns by spend", async () => {
    const { f, calls } = fake((_u, init) => String(init.body).includes("FROM campaign")
      ? { body: { results: [{ campaign: { id: "7", name: "Brand", status: "ENABLED" }, metrics: { costMicros: "50000000", clicks: "100", impressions: "2000", conversions: 4, conversionsValue: 200 } }] } }
      : { body: { results: [{ metrics: { costMicros: "75500000", impressions: "3000", clicks: "150", conversions: 5.5, conversionsValue: 300 } }] } })
    const c = google(f)
    expect(await googleAdsTotals(c, "tok", "100", null, window)).toMatchObject({ spend: 75.5, impressions: 3000, clicks: 150, conversions: 5.5, conversionValue: 300, cpc: 75.5 / 150 })
    expect(await googleAdsCampaigns(c, "tok", "100", null, window, 10)).toMatchObject([{ id: "7", name: "Brand", status: "ENABLED", spend: 50, costPerConversion: 12.5 }])
    expect(JSON.parse(String(calls[0]!.init.body)).query).toContain("segments.date BETWEEN '2026-10-01' AND '2026-10-28'")
  })

  it("classes a missing permission and a revoked sign-in", async () => {
    const res = (status: number, body: unknown) => fake(() => ({ status, body })).f
    expect(((await googleAdsTotals(google(res(403, { error: { status: "PERMISSION_DENIED" } })), "t", "1", null, window).catch(e => e)) as AdsError).kind).toBe("FORBIDDEN")
    expect(((await googleAdsTotals(google(res(401, { error: { status: "UNAUTHENTICATED" } })), "t", "1", null, window).catch(e => e)) as AdsError).kind).toBe("AUTH")
  })
})

describe("configuration and windows", () => {
  const base = { ADS_OAUTH_REDIRECT_URI: "https://api.test/api/ads/oauth/callback", GA4_TOKEN_ENCRYPTION_KEYS: `k1:${Buffer.alloc(32, 1).toString("base64")}` }
  it("turns each platform on only with its credentials", () => {
    const none = adsConfigFromEnv(base)
    expect(none.meta).toEqual({ configured: false, reason: "MISSING_APP" })
    expect(none.googleAds).toEqual({ configured: false, reason: "MISSING_APP" })
    const both = adsConfigFromEnv({ ...base, META_APP_ID: "1", META_APP_SECRET: "s", GOOGLE_OAUTH_CLIENT_ID: "c", GOOGLE_OAUTH_CLIENT_SECRET: "s" })
    expect(both.meta.configured).toBe(true)
    expect(both.googleAds).toEqual({ configured: false, reason: "MISSING_DEVELOPER_TOKEN" })
    expect(adsConfigFromEnv({ ...base, ADS_OAUTH_REDIRECT_URI: "https://api.test/other" }).meta).toEqual({ configured: false, reason: "MISSING_REDIRECT_URI" })
  })
  it("ends the window yesterday and compares it with the same number of days before", () => {
    expect(adWindows(Date.UTC(2026, 9, 29, 15), 7)).toEqual({ current: { start: "2026-10-22", end: "2026-10-28" }, previous: { start: "2026-10-15", end: "2026-10-21" } })
  })
})
