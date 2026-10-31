import { chmod, copyFile, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { type HarnessDriver, type HarnessJob, type HarnessReport } from "@openrecord/contracts"
import { execute, parseAnswer, probe, type LocalInstance } from "./adapters.js"
import { capture, driverEnvironment, failureReason } from "./process.js"
import { reportBatch, serverOrigin } from "./client.js"
import { sessions } from "./sessions.js"

describe("local harness protocol boundary (fixture binaries; no provider calls)", () => {
  let directory: string, binary: string
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "openrecord-bridge-test-"))
    binary = join(directory, "fixture")
    await copyFile(fileURLToPath(new URL("../test/fixtures/harness.mjs", import.meta.url)), binary)
    await chmod(binary, 0o700)
  })
  afterAll(async () => {
    sessions.closeAll()
    await rm(directory, { recursive: true, force: true })
  })
  const instance = (driver: HarnessDriver): LocalInstance => ({
    id: randomUUID(),
    driver,
    name: `TEST ${driver}`,
    binary
  })
  const job = (i: LocalInstance): HarnessJob => ({
    id: randomUUID(),
    lease: randomUUID(),
    localId: i.id,
    driver: i.driver,
    model: "fixture-model",
    input: { system: "TEST", contents: [{ role: "user", parts: [{ text: "TEST message" }] }], tools: [] }
  })
  for (const driver of ["codex", "claude", "opencode", "cursor"] as const) {
    it(`discovers and executes the ${driver} protocol with local tools refused`, async () => {
      const i = instance(driver)
      const status = await probe(i)
      expect(status).toMatchObject({ installed: true, version: "9.9.9", state: "ready" })
      expect(status.models.length).toBeGreaterThan(0)
      const reply = await execute(i, job(i), AbortSignal.timeout(10000))
      expect(reply.kind).toBe("text")
      expect(reply).toMatchObject({
        text: driver === "codex" ? "TEST Codex reply" : driver === "claude" ? "TEST Claude reply" : "TEST ACP reply"
      })
    }, 20000)
  }
  it("discovers supported reasoning levels and passes the selected level to Codex", async () => {
    const i = instance("codex")
    const status = await probe(i)
    expect(status.models[0]?.reasoningEfforts).toEqual(["low", "high"])
    const request = job(i)
    expect(await execute(i, { ...request, input: { ...request.input, reasoningEffort: "high" } }, AbortSignal.timeout(10000))).toMatchObject({ text: "TEST Codex reply (high)" })
    const unsupported = instance("cursor")
    const other = job(unsupported)
    await expect(execute(unsupported, { ...other, input: { ...other.input, reasoningEffort: "high" } }, AbortSignal.timeout(10000))).rejects.toMatchObject({ reason: "UNAVAILABLE" })
  }, 20000)

  it("discovers OpenCode reasoning per model and applies native effort before prompting", async () => {
    const i = instance("opencode")
    const status = await probe(i)
    expect(status.models).toEqual([
      { id: "fixture-model", name: "TEST model", reasoningEfforts: ["none", "low", "high", "max"] },
      { id: "fixture-thinking", name: "TEST thinking model", reasoningEfforts: ["none", "thinking"] }
    ])
    const request = job(i)
    for (const [model, reasoningEffort] of [["fixture-model", "max"], ["fixture-thinking", "thinking"]] as const) {
      expect(await execute(i, { ...request, model, input: { ...request.input, reasoningEffort } }, AbortSignal.timeout(10000))).toMatchObject({ text: `TEST ACP reply (${reasoningEffort})` })
    }
    await expect(execute(i, { ...request, model: "fixture-thinking", input: { ...request.input, reasoningEffort: "high" } }, AbortSignal.timeout(10000))).rejects.toMatchObject({ reason: "UNAVAILABLE" })
  }, 20000)

  for (const driver of ["claude", "opencode"] as const) {
    it(`continues a ${driver} turn on its warm session, sending only the new entries`, async () => {
      const i = instance(driver), first = job(i)
      await probe(i)
      const thoughts: string[] = []
      expect(await execute(i, first, AbortSignal.timeout(10000), t => thoughts.push(t))).toMatchObject({ kind: "text" })
      const next: HarnessJob = { ...first, id: randomUUID(), lease: randomUUID(), input: { ...first.input, contents: [
        ...first.input.contents,
        { role: "model", parts: [{ functionCall: { name: "read_open_issues", args: {} } }] },
        { role: "user", parts: [{ functionResponse: { name: "read_open_issues", response: { text: "TEST tool result" } } }] },
      ] } }
      // The fixture exits if a continuation repeats the full prompt or lacks the new entry.
      expect(await execute(i, next, AbortSignal.timeout(10000))).toMatchObject({ kind: "text", text: driver === "claude" ? "TEST Claude continued 2" : "TEST ACP continued 2" })
      if (driver === "claude") expect(thoughts.at(-1)).toBe("TEST thinking 1")
      sessions.closeAll()
    }, 20000)
  }
  it("lists Claude's real models and plan through the Agent SDK, and passes a reasoning level", async () => {
    const i = instance("claude")
    const status = await probe(i)
    expect(status).toMatchObject({ state: "ready", auth: "authenticated", accountLabel: "fixture@example.test" })
    expect(status.models).toEqual([{ id: "fixture-model", name: "TEST model", reasoningEfforts: ["low", "high"] }, { id: "fixture-fast", name: "TEST fast" }])
    const request = job(i)
    expect(await execute(i, { ...request, input: { ...request.input, reasoningEffort: "high" } }, AbortSignal.timeout(10000))).toMatchObject({ kind: "text", text: "TEST Claude reply" })
    sessions.closeAll()
  }, 20000)
  it("closes a warm session whose step is cancelled, and starts fresh next time", async () => {
    const i = instance("claude"), first = job(i)
    await probe(i)
    await execute(i, first, AbortSignal.timeout(10000))
    const controller = new AbortController()
    controller.abort()
    const next: HarnessJob = { ...first, input: { ...first.input, contents: [...first.input.contents, { role: "model", parts: [{ text: "x" }] }, { role: "user", parts: [{ text: "TEST tool result" }] }] } }
    await expect(execute(i, next, controller.signal)).rejects.toMatchObject({ reason: "CANCELLED" })
    expect(sessions.size).toBe(0)
    expect(await execute(i, first, AbortSignal.timeout(10000))).toMatchObject({ text: "TEST Claude reply" })
    sessions.closeAll()
  }, 20000)
  it("does not inherit application or unrelated provider secrets", () => {
    const source = {
      PATH: "/bin",
      HOME: "/fixture",
      DATABASE_URL: "PRIVATE-db",
      SESSION_SECRET: "PRIVATE-session",
      ANTHROPIC_API_KEY: "PRIVATE-claude",
      OPENAI_API_KEY: "PRIVATE-openai",
      CURSOR_API_KEY: "PRIVATE-cursor"
    }
    const env = driverEnvironment("codex", source)
    expect(env["OPENAI_API_KEY"]).toBe("PRIVATE-openai")
    expect(env).not.toHaveProperty("DATABASE_URL")
    expect(env).not.toHaveProperty("SESSION_SECRET")
    expect(env).not.toHaveProperty("ANTHROPIC_API_KEY")
    expect(env).not.toHaveProperty("CURSOR_API_KEY")
  })
  it("bounds hung and oversized child output and honours cancellation", async () => {
    await expect(
      capture(
        process.execPath,
        ["-e", "setInterval(()=>{},1000)"],
        directory,
        driverEnvironment("codex"),
        "",
        AbortSignal.timeout(100)
      )
    ).rejects.toMatchObject({ reason: "TIMEOUT" })
    await expect(
      capture(
        process.execPath,
        ["-e", "process.stdout.write('x'.repeat(600000))"],
        directory,
        driverEnvironment("codex")
      )
    ).rejects.toMatchObject({ reason: "MALFORMED" })
    const controller = new AbortController()
    const pending = capture(
      process.execPath,
      ["-e", "setInterval(()=>{},1000)"],
      directory,
      driverEnvironment("codex"),
      "",
      controller.signal
    )
    controller.abort()
    await expect(pending).rejects.toMatchObject({ reason: "CANCELLED" })
  })
  it("rejects remote HTTP, embedded credentials and malformed model output", () => {
    expect(serverOrigin("https://app.example.test")).toBe("https://app.example.test")
    expect(serverOrigin("http://127.0.0.1:3000")).toBe("http://127.0.0.1:3000")
    for (const url of [
      "http://remote.test",
      "https://user:secret@app.test",
      "https://app.test/path",
      "https://app.test/?secret=x"
    ])
      expect(() => serverOrigin(url)).toThrow()
    expect(() => parseAnswer('{"kind":"execute","command":"remove files"}')).toThrow()
    expect(() => parseAnswer('{"kind":"tools","calls":[]}')).toThrow()
  })
  it("decodes structured tool arguments and normalizes private provider failures", () => {
    expect(
      parseAnswer(
        JSON.stringify({ kind: "tools", text: "", calls: [{ name: "read_record", argsJson: '{"id":"TEST"}' }] })
      )
    ).toEqual({ kind: "tools", calls: [{ name: "read_record", args: { id: "TEST" } }] })
    expect(() =>
      parseAnswer(JSON.stringify({ kind: "tools", calls: [{ name: "read_record", argsJson: "[]" }] }))
    ).toThrow()
    expect(failureReason("quota_exhausted private details")).toBe("RATE_LIMITED")
    expect(failureReason("authentication_required private details")).toBe("UNAUTHENTICATED")
  })
  it("rotates large catalogs within UTF-8 report and request budgets without losing instances", () => {
    const reports: HarnessReport[] = Array.from({ length: 32 }, () => ({
      localId: randomUUID(),
      driver: "opencode",
      name: "TEST",
      installed: true,
      version: "TEST",
      auth: "unknown",
      state: "ready",
      models: Array.from({ length: 500 }, (_, i) => ({ id: `${i}${"m".repeat(195)}`, name: "界".repeat(200) }))
    }))
    const seen = new Set<string>()
    let cursor = 0
    for (let i = 0; i < 32; i++) {
      const batch = reportBatch(reports, cursor)
      cursor = batch.next
      expect(Buffer.byteLength(JSON.stringify({ reports: batch.reports, acceptJob: true }), "utf8")).toBeLessThan(
        150000
      )
      for (const report of batch.reports) {
        seen.add(report.localId)
        expect(report.modelsTruncated).toBe(true)
        expect(Buffer.byteLength(JSON.stringify(report), "utf8")).toBeLessThanOrEqual(125000)
      }
    }
    expect(seen.size).toBe(32)
    expect(reports[0]?.models).toHaveLength(500)
  })
})
