import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import { findCapabilities } from "../catalog.js"
import { BUSINESS_ENDPOINTS } from "./defs-business.js"
import { clientToken, hostAllowed, prepare } from "./http.js"
import { provider } from "./providers.js"

const endpoint = (id: string) => BUSINESS_ENDPOINTS.find(e => e.id === id)!
const now = new Date("2026-11-11T00:00:00Z")

describe("business accounts", () => {
  it("are all reads on their provider's documented API", () => {
    for (const e of BUSINESS_ENDPOINTS) {
      expect(provider(e.provider), e.id).not.toBeNull()
      expect(e.docs).toMatch(/^https:\/\//)
    }
  })

  it("send a Shopify call to the store in the credential, with the token as its header", () => {
    const p = provider("shopify")!
    const req = endpoint("revenue.shopify.orders").request({ from: "2026-10-01", to: "2026-10-31" }, now)
    const out = prepare(p, req, { secret: "acme-goods.myshopify.com:shpat_0123456789abcdef0123" }, {}) as { url: string; headers: Record<string, string> }
    expect(new URL(out.url).hostname).toBe("acme-goods.myshopify.com")
    expect(out.headers["x-shopify-access-token"]).toBe("shpat_0123456789abcdef0123")
    expect(hostAllowed(p, out.url)).toBe(true)
  })

  it("refuse a store host that is not a Shopify store", () => {
    const p = provider("shopify")!
    const req = endpoint("revenue.shopify.shop").request({}, now)
    expect(prepare(p, req, { secret: "evil.example.com:shpat_0123456789abcdef0123" }, {})).toEqual({ refused: "NOT_CONFIGURED" })
    expect(hostAllowed(p, "https://evil.example.com/admin")).toBe(false)
  })

  it("find Mailchimp's data centre from the key", () => {
    const p = provider("mailchimp")!
    const out = prepare(p, endpoint("email.mailchimp.lists").request({}, now), { secret: "notarealkeynotarealkeyxyz-us21" }, {}) as { url: string; headers: Record<string, string> }
    expect(new URL(out.url).hostname).toBe("us21.api.mailchimp.com")
    expect(Buffer.from(out.headers["authorization"]!.replace("Basic ", ""), "base64").toString()).toBe("openrecord:notarealkeynotarealkeyxyz-us21")
  })

  it("send Klaviyo's key with its own scheme and API revision", () => {
    const out = prepare(provider("klaviyo")!, endpoint("email.klaviyo.lists").request({}, now), { secret: "pk_0123456789abcdef0123" }, {}) as { headers: Record<string, string> }
    expect(out.headers["authorization"]).toBe("Klaviyo-API-Key pk_0123456789abcdef0123")
    expect(out.headers["revision"]).toBe("2024-10-15")
  })

  it("ask Ramp for a token with read scopes", async () => {
    let body = ""
    const transport = { lookup: async () => ["93.184.216.34"], fetch: async (_u: string, init: { body?: string }) => { body = init.body ?? ""; return { status: 200, headers: {}, body: new Blob([JSON.stringify({ access_token: "tok" })]).stream() } } }
    const token = await clientToken(provider("ramp")!, "https://api.ramp.com/developer/v1/token", "id_12345678:secret_0123456789abcdef", transport as never, "transactions:read business:read")
    expect(token).toBe("tok")
    expect(body).toBe("grant_type=client_credentials&scope=transactions%3Aread%20business%3Aread")
  })

  it("only accept a PostHog SELECT", () => {
    const e = endpoint("analytics.posthog.query")
    expect(Schema.is(e.input)({ project: "123", query: "SELECT count() FROM events" })).toBe(true)
    expect(Schema.is(e.input)({ project: "123", query: "DELETE FROM events" })).toBe(false)
    expect(Schema.is(e.input)({ project: "123", query: "SELECT 1; DROP TABLE x" })).toBe(false)
  })

  it("are found by need in the agent's catalog", () => {
    expect(findCapabilities("subscription revenue mrr").map(c => c.id)).toContain("revenue.revenuecat.overview")
    expect(findCapabilities("card spend transactions").map(c => c.id)).toContain("finance.ramp.transactions")
    expect(findCapabilities("email campaign reports").map(c => c.id)).toEqual(expect.arrayContaining(["email.mailchimp.reports"]))
  })
})
