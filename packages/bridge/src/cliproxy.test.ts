import { createServer, type IncomingMessage, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import type { HarnessJob } from "@openrecord/contracts"
import { cliProxyOrigin, executeCliProxy, probeCliProxy } from "./cliproxy.js"
import { execute, probe, type LocalInstance } from "./adapters.js"

// A loopback stand-in for CLIProxyAPI's OpenAI-compatible surface. No provider is called.
describe("CLIProxyAPI driver (loopback stand-in; no provider calls)", () => {
  let server: Server, url: string
  let reply: { status: number; body: unknown } = { status: 200, body: {} }
  const seen: Array<{ path: string; auth: string | undefined; body: unknown }> = []
  const read = async (req: IncomingMessage) => { let raw = ""; for await (const c of req) raw += String(c); return raw ? JSON.parse(raw) : null }
  beforeAll(async () => {
    server = createServer(async (req, res) => {
      seen.push({ path: req.url ?? "", auth: req.headers["authorization"], body: await read(req) })
      if (req.url === "/v1/models" && reply.status === 200 && !("choices" in (reply.body as object)))
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ object: "list", data: [{ id: "claude-sonnet-5-5", owned_by: "anthropic" }, { id: "gpt-6-luna" }] }))
      else res.writeHead(reply.status, { "content-type": "application/json" }).end(JSON.stringify(reply.body))
    })
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(() => new Promise<void>(resolve => server.close(() => resolve())))
  beforeEach(() => { seen.length = 0; reply = { status: 200, body: {} } })
  const instance = (over: Partial<LocalInstance> = {}): LocalInstance => ({ id: randomUUID(), driver: "cliproxy", name: "TEST CLIProxyAPI", baseUrl: url, apiKeyEnv: "TEST_CLIPROXY_KEY", ...over })
  const env = { TEST_CLIPROXY_KEY: "local-client-key" }
  const job = (i: LocalInstance): HarnessJob => ({ id: randomUUID(), lease: randomUUID(), localId: i.id, driver: "cliproxy", model: "claude-sonnet-5-5",
    input: { system: "system", tools: [{ name: "read_open_issues", description: "Read", parametersJsonSchema: { type: "object", properties: {} } }],
      contents: [{ role: "user", parts: [{ text: "What is open?" }] }] } })

  it("discovers models with the local client key", async () => {
    const i = instance()
    const report = await probeCliProxy(i, env)
    expect(report).toMatchObject({ localId: i.id, driver: "cliproxy", installed: true, auth: "authenticated", state: "ready",
      models: [{ id: "claude-sonnet-5-5", name: "claude-sonnet-5-5" }, { id: "gpt-6-luna", name: "gpt-6-luna" }] })
    expect(seen[0]).toMatchObject({ path: "/v1/models", auth: "Bearer local-client-key" })
  })
  it("reports a refused key as signed out and an unreachable proxy as not running", async () => {
    reply = { status: 401, body: { error: "invalid key" } }
    expect(await probeCliProxy(instance(), env)).toMatchObject({ installed: true, auth: "unauthenticated", state: "unavailable" })
    expect(await probeCliProxy(instance({ baseUrl: "http://127.0.0.1:1" }), env)).toMatchObject({ installed: false, state: "unavailable" })
  })
  it("sends native tools and returns requested calls", async () => {
    const i = instance()
    reply = { status: 200, body: { choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "read_open_issues", arguments: "{}" } }] } }] } }
    expect(await executeCliProxy(i, job(i), AbortSignal.timeout(5000), env)).toEqual({ kind: "tools", calls: [{ name: "read_open_issues", args: {} }] })
    expect(seen[0]).toMatchObject({ path: "/v1/chat/completions", body: { model: "claude-sonnet-5-5", tool_choice: "auto",
      messages: [{ role: "system", content: "system" }, { role: "user", content: "What is open?" }] } })
  })
  it("returns text through the generic adapter entry points", async () => {
    const i = instance()
    reply = { status: 200, body: { choices: [{ finish_reason: "stop", message: { content: "Two issues are open." } }] } }
    expect(await execute(i, job(i), AbortSignal.timeout(5000))).toEqual({ kind: "text", text: "Two issues are open." })
    expect((await probe({ ...i, baseUrl: "ftp://example.test" })).state).toBe("error")
  })
  it.each([[429, "RATE_LIMITED"], [403, "UNAUTHENTICATED"], [500, "UNAVAILABLE"]])("maps HTTP %i to %s", async (status, reason) => {
    const i = instance()
    reply = { status, body: { error: "x" } }
    await expect(executeCliProxy(i, job(i), AbortSignal.timeout(5000), env)).rejects.toMatchObject({ reason })
  })
  it("refuses malformed answers", async () => {
    const i = instance()
    reply = { status: 200, body: { choices: [{ finish_reason: "length", message: { content: "Half an answ" } }] } }
    await expect(executeCliProxy(i, job(i), AbortSignal.timeout(5000), env)).rejects.toMatchObject({ reason: "MALFORMED" })
  })
  it("accepts HTTPS anywhere and plain HTTP only on loopback", () => {
    expect(cliProxyOrigin("https://proxy.example.test/v1/").href).toBe("https://proxy.example.test/")
    expect(cliProxyOrigin("http://localhost:8317").host).toBe("localhost:8317")
    for (const bad of ["http://192.168.1.3:8317", "http://user:pw@127.0.0.1:8317", "file:///tmp/x", "not a url"])
      expect(() => cliProxyOrigin(bad)).toThrow()
  })
})
