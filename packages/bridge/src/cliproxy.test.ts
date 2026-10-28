import { createServer, type IncomingMessage, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import type { HarnessJob } from "@openrecord/contracts"
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { cliProxyConfigKey, cliProxyConfigPaths, findCliProxy, resetCliProxyStart, cliProxyOrigin, executeCliProxy, probeCliProxy } from "./cliproxy.js"
import { codexReasoning, execute, probe, type LocalInstance } from "./adapters.js"

// A loopback stand-in for CLIProxyAPI's OpenAI-compatible surface. No provider is called.
describe("CLIProxyAPI driver (loopback stand-in; no provider calls)", () => {
  let server: Server, url: string
  let reply: { status: number; body: unknown } = { status: 200, body: {} }
  const seen: Array<{ path: string; auth: string | undefined; body: unknown }> = []
  const read = async (req: IncomingMessage) => { let raw = ""; for await (const c of req) raw += String(c); return raw ? JSON.parse(raw) : null }
  beforeAll(async () => {
    server = createServer(async (req, res) => {
      seen.push({ path: req.url ?? "", auth: req.headers["authorization"], body: await read(req) })
      if (reply.status === 200 && typeof reply.body === "string") {
        res.writeHead(200, { "content-type": "text/event-stream" })
        for (const line of reply.body.split("\n")) { res.write(`${line}\n`); await new Promise(r => setTimeout(r, 5)) }
        return void res.end()
      }
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
  it("streams the model's reasoning while it works and returns it with the answer", async () => {
    const i = instance()
    const chunk = (delta: unknown, finish: string | null = null) => `data: ${JSON.stringify({ model: "claude-sonnet-5-5", choices: [{ index: 0, delta, finish_reason: finish }] })}\n`
    reply = { status: 200, body: [chunk({ reasoning_content: "Check the " }), chunk({ reasoning_content: "open issues." }),
      chunk({ tool_calls: [{ index: 0, id: "c", type: "function", function: { name: "read_open_issues", arguments: "{" } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: "}" } }] }), chunk({}, "tool_calls"), "data: [DONE]"].join("\n") }
    const seenThoughts: string[] = []
    const answer = await executeCliProxy(i, job(i), AbortSignal.timeout(5000), env, t => seenThoughts.push(t))
    expect(answer).toEqual({ kind: "tools", calls: [{ name: "read_open_issues", args: {} }], thought: "Check the open issues." })
    expect(seenThoughts).toEqual(["Check the", "Check the open issues."])
    expect(seen[0]?.body).toMatchObject({ stream: true, stream_options: { include_usage: true } })
  })
  it("reads Codex reasoning events and ignores everything else", () => {
    const events = [
      JSON.stringify({ type: "thread.started" }),
      JSON.stringify({ type: "item.completed", item: { id: "1", type: "reasoning", text: "First, list the issues." } }),
      "not json",
      JSON.stringify({ type: "item.completed", item: { id: "2", type: "agent_message", text: "{\"kind\":\"text\"}" } }),
      JSON.stringify({ type: "item.completed", item: { id: "3", type: "reasoning", summary: [{ text: "Then answer." }] } }),
    ].join("\n")
    expect(codexReasoning(events)).toBe("First, list the issues.\n\nThen answer.")
    expect(codexReasoning("")).toBe("")
  })

  describe("CLIProxyAPI client key from its own config", () => {
    it("reads the first access.api-keys entry, or a top-level list from older versions", () => {
      expect(cliProxyConfigKey(`port: 8317\naccess:\n  # API keys for authentication\n  api-keys:\n    - "key-one"\n    - "key-two"\n`)).toBe("key-one")
      expect(cliProxyConfigKey(`api-keys:\n  - plain-key # comment\n`)).toBe("plain-key")
      // Upstream provider keys are not client keys.
      expect(cliProxyConfigKey(`claude:\n  api-keys:\n    - "sk-upstream"\naccess:\n  api-keys: []\n`)).toBeNull()
      expect(cliProxyConfigKey(`access:\n  api-keys:\nport: 8317\n`)).toBeNull()
    })

    it("uses the config key for the local proxy only, and an explicit key first", async () => {
      const dir = mkdtempSync(join(tmpdir(), "cliproxy-")), config = join(dir, "config.yaml")
      writeFileSync(config, `access:\n  api-keys:\n    - "from-config"\n`)
      const env = { CLIPROXY_CONFIG: config }
      expect(cliProxyConfigPaths(env, "/home/x")[0]).toBe(config)
      seen.length = 0
      reply = { status: 200, body: {} }
      await probeCliProxy({ id: randomUUID(), name: "CLIProxyAPI", baseUrl: url }, env)
      expect(seen.at(-1)?.auth).toBe("Bearer from-config")
      await probeCliProxy({ id: randomUUID(), name: "CLIProxyAPI", baseUrl: url }, { ...env, CLIPROXY_API_KEY: "from-env" })
      expect(seen.at(-1)?.auth).toBe("Bearer from-env")
    })
  })

  it("starts an installed CLIProxyAPI in the background when it is not running", async () => {
    const home = mkdtempSync(join(tmpdir(), "cliproxy-home-")), bin = join(home, "bin")
    const port = 20000 + Math.floor(Math.random() * 20000)
    mkdirSync(join(home, ".cli-proxy-api"), { recursive: true }); mkdirSync(bin)
    const config = join(home, ".cli-proxy-api", "config.yaml")
    writeFileSync(config, `port: ${port}\naccess:\n  api-keys:\n    - "started-key"\n`)
    // A stand-in proxy: reads its port from -config, answers /v1/models, exits after a few seconds.
    writeFileSync(join(bin, "cli-proxy-api"), `#!${process.execPath}
const fs = require("node:fs"); const http = require("node:http")
const cfg = fs.readFileSync(process.argv[process.argv.indexOf("-config") + 1], "utf8")
const port = Number(cfg.match(/port: (\\d+)/)[1])
const s = http.createServer((req, res) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ object: "list", data: [{ id: "claude-sonnet-5-5" }], auth: req.headers.authorization })))
s.listen(port, "127.0.0.1"); setTimeout(() => process.exit(0), 4000)
`)
    chmodSync(join(bin, "cli-proxy-api"), 0o755)
    const instance = { id: randomUUID(), name: "CLIProxyAPI", baseUrl: `http://127.0.0.1:${port}` }
    const env = { PATH: bin, CLIPROXY_CONFIG: config }
    expect(findCliProxy(env, home)).toEqual({ binary: join(bin, "cli-proxy-api"), config })
    resetCliProxyStart()
    const report = await probeCliProxy(instance, env, home)
    expect(report).toMatchObject({ installed: true, state: "ready", auth: "authenticated", models: [{ id: "claude-sonnet-5-5" }] })
    // Not installed: nothing to start, and it stays not running.
    resetCliProxyStart()
    expect(await probeCliProxy({ ...instance, baseUrl: "http://127.0.0.1:1" }, { PATH: "" }, mkdtempSync(join(tmpdir(), "empty-")))).toMatchObject({ installed: false })
  }, 20000)
})
