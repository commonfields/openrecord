import { describe, expect, it } from "vitest"
import { realtimeSnapshot, standInEndpoints } from "../src/index.js"

describe("realtime", () => {
  it("reads active users now, by country, page and minute", async () => {
    const bodies: unknown[] = []
    const fetch = async (url: string, init?: RequestInit) => {
      expect(url).toMatch(/properties\/123:runRealtimeReport$/)
      const body = JSON.parse(String(init?.body)) as { dimensions?: Array<{ name: string }> }
      bodies.push(body)
      const dims = body.dimensions?.map(d => d.name).join(",") ?? ""
      const rows = dims === "" ? [{ metricValues: [{ value: "12" }] }]
        : dims === "countryId,country" ? [{ dimensionValues: [{ value: "id" }, { value: "Indonesia" }], metricValues: [{ value: "3" }] }, { dimensionValues: [{ value: "US" }, { value: "United States" }], metricValues: [{ value: "9" }] }]
        : dims === "unifiedScreenName" ? [{ dimensionValues: [{ value: "Pricing" }], metricValues: [{ value: "5" }] }]
        : [{ dimensionValues: [{ value: "0" }], metricValues: [{ value: "2" }] }, { dimensionValues: [{ value: "29" }], metricValues: [{ value: "1" }] }]
      return new Response(JSON.stringify({ rows }), { status: 200, headers: { "content-type": "application/json" } })
    }
    const s = await realtimeSnapshot({ endpoints: standInEndpoints("http://127.0.0.1")!, fetch }, "tok", "properties/123")
    expect(s.activeUsers).toBe(12)
    expect(s.countries).toEqual([{ code: "US", name: "United States", users: 9 }, { code: "ID", name: "Indonesia", users: 3 }])
    expect(s.pages).toEqual([{ title: "Pricing", users: 5 }])
    expect(s.perMinute).toHaveLength(30)
    expect([s.perMinute[0], s.perMinute[29]]).toEqual([1, 2])
    expect(bodies).toHaveLength(4)
  })
})
