import { describe, expect, it } from "vitest"
import { SEO_ENDPOINTS } from "./defs-seo.js"
import { platformServes, priceOf, route, usd } from "./metering.js"
import { provider } from "./providers.js"

const serp = SEO_ENDPOINTS.find(e => e.id === "seo.serp")!
const seo = provider("seo_data")!
const env = (o: Record<string, string>) => o as NodeJS.ProcessEnv

describe("research call metering", () => {
  it("walks the credential ladder: own connection, public, platform when priced, else refused", () => {
    const priced = env({ OPENRECORD_SEO_DATA_CREDENTIAL: "p:secret12", RESEARCH_PRICES_MICRO: "seo.serp=5000" })
    expect(route(serp, seo, "own:secret12", true, priced)).toEqual({ kind: "serve", source: "BUSINESS", secret: "own:secret12", costMicro: 0 })
    expect(route(serp, seo, null, false, priced)).toEqual({ kind: "serve", source: "PUBLIC", secret: null, costMicro: 0 })
    expect(route(serp, seo, null, true, priced)).toEqual({ kind: "serve", source: "PLATFORM", secret: "p:secret12", costMicro: 5000 })
    expect(route(serp, seo, null, true, env({ OPENRECORD_SEO_DATA_CREDENTIAL: "p:secret12" }))).toEqual({ kind: "refuse", reason: "UNPRICED" })
    expect(route(serp, seo, null, true, env({ RESEARCH_PRICES_MICRO: "seo.serp=5000" }))).toEqual({ kind: "refuse", reason: "NOT_CONNECTED" })
  })
  it("reads prices from the server setting, ignoring malformed entries", () => {
    expect(priceOf(serp, env({ RESEARCH_PRICES_MICRO: "seo.backlinks=9, seo.serp = 7000" }))).toBe(7000)
    for (const bad of ["seo.serp=0", "seo.serp=-5", "seo.serp=1.5", "seo.serp=", "seo.serp"]) expect(priceOf(serp, env({ RESEARCH_PRICES_MICRO: bad }))).toBeNull()
    expect(priceOf({ ...serp, price: { microUsd: 3000 } }, env({}))).toBe(3000)
    expect(platformServes(serp, seo, env({ RESEARCH_PRICES_MICRO: "seo.serp=5000" }))).toBe(false)
  })
  it("formats micro-dollars", () => {
    expect(usd(5000)).toBe("$0.0050")
    expect(usd(1_000_000)).toBe("$1.00")
    expect(usd(0)).toBe("$0.00")
  })
})
