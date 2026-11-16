import { generateKeyPairSync, verify } from "node:crypto"
import { afterEach, expect, it, vi } from "vitest"
import { appRequest, appJwt, boundedJson, githubAppConfig, installationToken } from "../src/github-app.js"

const pair = generateKeyPairSync("rsa", { modulusLength: 2048 })
const config = { appId: "17", clientId: "fixture", clientSecret: "fixture-secret", slug: "fixture", privateKey: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(), callbackUrl: "https://api.example.test/api/github/callback" }
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })
it("signs a short-lived app JWT with the configured RSA identity", () => {
  const jwt = appJwt(config, 1_800_000_000_000)
  const [header, body, signature] = jwt.split(".")
  expect(JSON.parse(Buffer.from(body!, "base64url").toString())).toEqual({ iat: 1_799_999_940, exp: 1_800_000_540, iss: "17" })
  expect(verify("RSA-SHA256", Buffer.from(`${header}.${body}`), pair.publicKey, Buffer.from(signature!, "base64url"))).toBe(true)
})
it("fails closed on malformed configuration and untrusted callback addresses", () => {
  for (const [key, value] of Object.entries({ GITHUB_APP_ID: config.appId, GITHUB_APP_CLIENT_ID: config.clientId, GITHUB_APP_CLIENT_SECRET: config.clientSecret, GITHUB_APP_SLUG: config.slug, GITHUB_APP_PRIVATE_KEY: config.privateKey, GITHUB_APP_CALLBACK_URL: config.callbackUrl })) vi.stubEnv(key, value)
  expect(githubAppConfig()).not.toBeNull()
  for (const callback of ["http://public.example.test/api/github/callback", "https://user:pass@example.test/api/github/callback", "https://api.example.test/other", "https://api.example.test/api/github/callback?token=x"]) {
    vi.stubEnv("GITHUB_APP_CALLBACK_URL", callback)
    expect(githubAppConfig()).toBeNull()
  }
})
it("refuses tokens with insufficient permissions and bounds provider responses", async () => {
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ token: "fixture", permissions: { contents: "read", pull_requests: "write" } })))
  await expect(installationToken(config, "101", "202")).rejects.toThrow()
  await expect(boundedJson(new Response("x".repeat(2_000_001)))).rejects.toThrow("too large")
})

it("keeps rate limits distinct from revoked repository access", async () => {
  vi.stubGlobal("fetch", async () => new Response("{}", { status: 403, headers: { "retry-after": "30" } }))
  await expect(appRequest("/app/installations/101/access_tokens", "fixture", {})).rejects.toMatchObject({ kind: "RATE_LIMITED", retryAfterSeconds: 30 })
})
