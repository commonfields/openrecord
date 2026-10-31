import { randomUUID } from "node:crypto"
import { describe, expect, it } from "vitest"
import type { HarnessJob } from "@openrecord/contracts"
import { BridgeFailure } from "./process.js"
import { IDLE_MS, MAX_SESSIONS, SessionPool, continuationOf, continuationPrompt, type WarmProcess } from "./sessions.js"

type Contents = HarnessJob["input"]["contents"]
const user = (text: string) => ({ role: "user" as const, parts: [{ text }] })
const model = (name: string) => ({ role: "model" as const, parts: [{ functionCall: { name, args: {} } }] })
const result = (text: string) => ({ role: "user" as const, parts: [{ functionResponse: { name: "read", response: { text } } }] })
const job = (contents: Contents, overrides: Partial<HarnessJob["input"]> = {}): HarnessJob => ({
  id: randomUUID(), lease: randomUUID(), localId: "11111111-1111-4111-8111-111111111111", driver: "claude", model: "sonnet",
  input: { system: "TEST system", tools: [{ name: "read" }], contents, ...overrides },
})

/** A fake provider process that records what it was sent. */
function fake() {
  const started: Array<{ sent: string[]; closed: boolean }> = []
  const start = async (): Promise<WarmProcess> => {
    const record = { sent: [] as string[], closed: false }
    started.push(record)
    return {
      step: async (text) => { record.sent.push(text); if (text.includes("FAIL")) throw new BridgeFailure("TIMEOUT"); return `answer ${record.sent.length}` },
      close: () => { record.closed = true },
    }
  }
  return { started, start }
}

describe("warm session pool", () => {
  const signal = AbortSignal.timeout(5000)
  const first: Contents = [user("TEST question")]
  const second: Contents = [...first, model("read"), result("TEST tool result")]

  it("continues the same turn on one process, sending only the entries after its answer", async () => {
    const pool = new SessionPool(), f = fake()
    expect(await pool.run("a", job(first), f.start, "FULL PROMPT", signal)).toEqual({ answer: "answer 1", warm: false })
    expect(await pool.run("a", job(second), f.start, "FULL PROMPT", signal)).toEqual({ answer: "answer 2", warm: true })
    expect(f.started).toHaveLength(1)
    expect(f.started[0]!.sent[0]).toBe("FULL PROMPT")
    expect(f.started[0]!.sent[1]).toBe(continuationPrompt([result("TEST tool result")]))
    expect(f.started[0]!.sent[1]).not.toContain("TEST question")
    pool.closeAll()
  })

  it("starts fresh for a different conversation, model, instructions or tools", async () => {
    const pool = new SessionPool(), f = fake()
    await pool.run("a", job(first), f.start, "P", signal)
    // Earlier entries changed (the server compacted or it is another chat).
    await pool.run("a", job([user("TEST other"), model("read"), result("TEST tool result")]), f.start, "P", signal)
    await pool.run("a", job(second, { system: "TEST other system" }), f.start, "P", signal)
    await pool.run("a", job(second, { tools: [] }), f.start, "P", signal)
    await pool.run("b", job(second), f.start, "P", signal)
    expect(f.started).toHaveLength(5)
    expect(f.started.every(p => p.sent.length === 1)).toBe(true)
    pool.closeAll()
  })

  it("closes a session whose step failed instead of reusing it", async () => {
    const pool = new SessionPool(), f = fake()
    await pool.run("a", job(first), f.start, "P", signal)
    await expect(pool.run("a", job([...first, model("read"), result("FAIL")]), f.start, "P", signal)).rejects.toMatchObject({ reason: "TIMEOUT" })
    expect(f.started[0]!.closed).toBe(true)
    expect(pool.size).toBe(0)
    expect((await pool.run("a", job(second), f.start, "P", signal)).warm).toBe(false)
    pool.closeAll()
  })

  it("closes idle sessions, keeps at most a fixed number, and closes all on shutdown", async () => {
    let now = 0
    const pool = new SessionPool(() => now), f = fake()
    for (let i = 0; i < MAX_SESSIONS + 2; i++) await pool.run("a", job([user(`TEST ${i}`)]), f.start, "P", signal)
    expect(pool.size).toBe(MAX_SESSIONS)
    expect(f.started.filter(p => p.closed)).toHaveLength(2)
    now = IDLE_MS + 1
    pool.sweep()
    expect(pool.size).toBe(0)
    await pool.run("a", job(first), f.start, "P", signal)
    pool.closeAll()
    expect(f.started.every(p => p.closed)).toBe(true)
  })

  it("only continues when the job extends the session with the model's answer and something new", () => {
    expect(continuationOf(first, 0, "")).toBeNull()
    expect(continuationOf([...first, model("read")], 1, "x")).toBeNull()
    expect(continuationOf([...first, user("TEST not an answer"), result("x")], 1, "x")).toBeNull()
  })
})
