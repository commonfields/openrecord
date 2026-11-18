import { randomUUID } from "node:crypto"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { HarnessJob } from "@openrecord/contracts"

// A stand-in for Cursor's SDK: no network, no sign-in, no agent process.
const sdk = vi.hoisted(() => ({
  status: { status: "logged-in", backendUrl: "https://example.test", email: "person@example.test" } as { status: string; email?: string; backendUrl?: string },
  models: [{ id: "composer-2.5", displayName: "Composer 2.5" }, { id: "bad id!", displayName: "x" }, { id: "composer-2.5", displayName: "duplicate" }] as unknown[],
  modelsError: null as Error | null,
  created: [] as unknown[],
  sent: [] as string[],
}))

vi.mock("@cursor/sdk", () => ({
  emptyFs: () => ({ empty: true }),
  Cursor: {
    auth: { status: async () => sdk.status },
    models: { list: async () => { if (sdk.modelsError) throw sdk.modelsError; return sdk.models } },
    me: async () => ({ apiKeyName: "key" }),
  },
  Agent: {
    create: async (options: unknown) => {
      sdk.created.push(options)
      return {
        close: () => undefined,
        send: async (text: string) => {
          sdk.sent.push(text)
          const answer = JSON.stringify({ kind: "text", text: `TEST Cursor reply ${sdk.sent.length}`, calls: [] })
          return {
            cancel: async () => undefined,
            stream: async function* () {
              yield { type: "thinking", text: "Thinking it over" }
              yield { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: answer }] } }
            },
            wait: async () => ({ status: "finished", result: answer }),
          }
        },
      }
    },
  },
}))

const { execute, probe } = await import("./adapters.js")
const { sessions } = await import("./sessions.js")

describe("Cursor through its official SDK (stand-in SDK; no provider calls)", () => {
  afterEach(() => { sessions.closeAll(); sdk.modelsError = null; sdk.status = { status: "logged-in", backendUrl: "https://example.test", email: "person@example.test" } })
  const instance = { id: randomUUID(), driver: "cursor" as const, name: "Cursor" }
  const job = (contents: HarnessJob["input"]["contents"]): HarnessJob => ({
    id: randomUUID(), lease: randomUUID(), localId: instance.id, driver: "cursor", model: "composer-2.5",
    input: { system: "TEST", contents, tools: [] },
  })

  it("lists the signed-in account's models, Composer included", async () => {
    expect(await probe(instance)).toMatchObject({
      installed: true, auth: "authenticated", accountLabel: "person@example.test", state: "ready",
      models: [{ id: "composer-2.5", name: "Composer 2.5" }],
    })
  })

  it("says so when nobody is signed in, and when the plan's usage runs out", async () => {
    sdk.status = { status: "logged-out" }
    expect(await probe(instance)).toMatchObject({ auth: "unauthenticated", state: "unavailable", models: [] })
    sdk.status = { status: "logged-in" }
    sdk.modelsError = new Error("usage limit reached for this plan")
    expect(await probe(instance)).toMatchObject({ auth: "authenticated", state: "usage_limited" })
  })

  it("runs a turn on one locked-down agent, sending only what is new on the next step", async () => {
    const first = [{ role: "user" as const, parts: [{ text: "TEST message" }] }]
    const thoughts: string[] = []
    const reply = await execute(instance, job(first), AbortSignal.timeout(10000), t => thoughts.push(t))
    expect(reply).toMatchObject({ kind: "text", text: "TEST Cursor reply 1", thought: "Thinking it over" })
    expect(thoughts).toContain("Thinking it over")
    expect(sdk.created).toHaveLength(1)
    expect(sdk.created[0]).toMatchObject({
      model: { id: "composer-2.5" }, tools: [], mcpServers: {},
      local: { fs: { empty: true }, settingSources: [] },
    })
    expect((sdk.created[0] as { systemPrompt: string }).systemPrompt).toContain("You are the model transport for OpenRecord")
    expect(sdk.sent[0]).toContain("TEST message")

    const next = [...first, { role: "model" as const, parts: [{ text: "TEST Cursor reply 1" }] }, { role: "user" as const, parts: [{ text: "TEST follow-up" }] }]
    await execute(instance, job(next), AbortSignal.timeout(10000))
    expect(sdk.created).toHaveLength(1)
    expect(sdk.sent[1]).toContain("TEST follow-up")
    expect(sdk.sent[1]).not.toContain("TEST message")
  })
})
