// Local demo only (not committed): the Google stand-in over loopback HTTP, with
// a consent page that approves at once, so the real browser flow can run.
import { createServer } from "node:http"
import { fixtureGoogle } from "@openrecord/ga4"

const day = (offset: number) => new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10)
const days: Record<string, { clicks: number; impressions: number; position: number }> = {}
for (let i = 0; i < 200; i++) days[day(i)] = { clicks: i < 35 ? 14 + (i % 5) : 9 + (i % 4), impressions: i < 35 ? 420 + (i % 7) * 10 : 380 + (i % 6) * 8, position: i < 35 ? 7.4 : 9.1 }
const g = fixtureGoogle({
  clientId: "demo-client", clientSecret: "demo-secret", redirectUri: "http://localhost:3010/api/growth/ga4/oauth/callback",
  identities: [{ sub: "1001", email: "owner@copperline.test", properties: [], sites: [{ siteUrl: "sc-domain:copperline.test" }, { siteUrl: "https://blog.example.test/", permissionLevel: "siteFullUser" }] }],
  properties: [],
  sites: [{ siteUrl: "sc-domain:copperline.test", days,
    queries: [{ key: "specialty coffee beans online", clicks: 120, impressions: 3100, position: 6.2 }, { key: "copperline coffee", clicks: 96, impressions: 410, position: 1.3 },
      { key: "best espresso subscription", clicks: 41, impressions: 2600, position: 11.8 }, { key: "single origin ethiopia beans", clicks: 33, impressions: 980, position: 8.4 }],
    pages: [{ key: "https://copperline.test/", clicks: 150, impressions: 2900, position: 4.1 }, { key: "https://copperline.test/subscriptions", clicks: 70, impressions: 3400, position: 9.6 },
      { key: "https://copperline.test/beans/ethiopia", clicks: 40, impressions: 1100, position: 8.2 }] },
    { siteUrl: "https://blog.example.test/", days: {} }],
})
createServer(async (req, res) => {
  const url = `http://127.0.0.1:65535${req.url}`
  if (req.url?.startsWith("/o/oauth2/v2/auth")) { res.writeHead(302, { location: g.consent(url, { sub: "1001" }) }); res.end(); return }
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  const response = await g.handle(new Request(url, { method: req.method ?? "GET", headers: req.headers as Record<string, string>, ...(chunks.length && req.method !== "GET" ? { body: Buffer.concat(chunks) } : {}) }))
  res.writeHead(response.status, Object.fromEntries(response.headers))
  res.end(Buffer.from(await response.arrayBuffer()))
}).listen(3099, "127.0.0.1", () => console.log("google stand-in on 3099"))
