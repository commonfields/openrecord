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

describe("local harness protocol boundary (fixture binaries; no provider calls)", () => {
  let directory: string, binary: string
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "openrecord-bridge-test-"))
    binary = join(directory, "fixture")
    await copyFile(fileURLToPath(new URL("../test/fixtures/harness.mjs", import.meta.url)), binary)
    await chmod(binary, 0o700)
  })
  afterAll(async () => {
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
