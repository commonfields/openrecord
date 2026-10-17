import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Effect, Layer, Redacted } from "effect"
import { PgClient } from "@effect/sql-pg"
import { AcquisitionRepositoryLive, AgentProposalRepositoryLive, BusinessRepositoryLive, DiscoveryScopeRepositoryLive, FactRepositoryLive, ProductReadRepositoryLive, QuestionRepositoryLive, RecordRepositoryLive } from "@openrecord/db"
import pg from "pg"
import { deleteConversation, loadConversation, sendConversation, type ConversationScope } from "./agent-conversations.js"
import { AgentModelError } from "./agent-model.js"
import type { AgentToolDeps } from "./agent-tools.js"

const url = process.env["TEST_DATABASE_URL"] ?? ""
const suite = url ? describe : describe.skip
suite("private durable conversations (disposable TEST fixtures)", () => {
  let pool: pg.Pool
  const repos = Layer.mergeAll(AcquisitionRepositoryLive, AgentProposalRepositoryLive, BusinessRepositoryLive, DiscoveryScopeRepositoryLive, FactRepositoryLive, ProductReadRepositoryLive, QuestionRepositoryLive, RecordRepositoryLive)
    .pipe(Layer.provideMerge(PgClient.layer({ url: Redacted.make(url) })))
  const run = <A, E>(effect: Effect.Effect<A, E, AgentToolDeps>) => Effect.runPromise(Effect.either(effect.pipe(Effect.provide(repos))))
  const respond = () => Effect.succeed({ reply: "Stored evidence only", citations: [], toolCalls: [], usage: [], provider: "gemini" as const, requestedModel: "fixture" })
  beforeAll(() => { pool = new pg.Pool({ connectionString: url }) })
  afterAll(async () => { await pool.end() })
  const fixture = async (): Promise<ConversationScope> => {
    const accountId = (await pool.query("INSERT INTO accounts(name) VALUES ('TEST conversation') RETURNING id")).rows[0].id as string
    const userId = (await pool.query("INSERT INTO users(email,password_hash) VALUES ($1,'TEST-only') RETURNING id", [`conversation-${randomUUID()}@example.test`])).rows[0].id as string
    await pool.query("INSERT INTO account_users(account_id,user_id) VALUES ($1,$2)", [accountId, userId])
    const businessId = (await pool.query("INSERT INTO businesses(account_id,name) VALUES ($1,'TEST Client') RETURNING id", [accountId])).rows[0].id as string
    return { accountId, userId, businessId }
  }
  it("persists messages, replays the same request, rejects stale revisions, and deletes", async () => {
    const f = await fixture()
    const body = { message: "Why?", requestId: randomUUID(), revision: 0 }
    expect((await run(sendConversation(f, body, respond)))._tag).toBe("Right")
    expect((await run(sendConversation(f, body, () => Effect.die("replayed inference"))))._tag).toBe("Right")
    const saved = await run(loadConversation(f))
    expect(saved).toMatchObject({ _tag: "Right", right: { revision: 1, messages: [{ role: "user", text: "Why?" }, { role: "agent" }] } })
    expect(await run(sendConversation(f, { ...body, requestId: randomUUID() }, respond))).toMatchObject({ _tag: "Left", left: { reason: "STALE" } })
    expect((await run(deleteConversation(f)))._tag).toBe("Right")
    expect(await run(loadConversation(f))).toMatchObject({ _tag: "Right", right: null })
  })
  it("refuses foreign business, conversation and same-account user histories", async () => {
    const a = await fixture(), b = await fixture()
    const body = { message: "Read", requestId: randomUUID(), revision: 0 }
    await run(sendConversation(a, body, respond))
    expect(await run(sendConversation({ ...b, businessId: a.businessId }, body, respond))).toMatchObject({ _tag: "Left", left: { reason: "NOT_FOUND" } })
    expect(await run(sendConversation(a, { ...body, requestId: randomUUID(), conversationId: randomUUID(), revision: 1 }, respond))).toMatchObject({ _tag: "Left", left: { reason: "NOT_FOUND" } })
    expect(await run(loadConversation({ ...a, userId: b.userId }))).toMatchObject({ _tag: "Right", right: null })
  })
  it("serializes concurrent turns without holding a transaction through inference", async () => {
    const f = await fixture()
    let release: () => void = () => {}
    const waiting = new Promise<void>(resolve => { release = resolve })
    let started: () => void = () => {}
    const ready = new Promise<void>(resolve => { started = resolve })
    const first = run(sendConversation(f, { message: "First", requestId: randomUUID(), revision: 0 }, () => Effect.gen(function*() {
      started(); yield* Effect.promise(() => waiting); return yield* respond()
    })))
    await ready
    expect(await run(sendConversation(f, { message: "Second", requestId: randomUUID(), revision: 0 }, respond))).toMatchObject({ _tag: "Left", left: { reason: "BUSY" } })
    release()
    expect((await first)._tag).toBe("Right")
  })
  it("releases leases after provider failure and rejects expired histories", async () => {
    const f = await fixture(), body = { message: "Read", requestId: randomUUID(), revision: 0 }
    expect((await run(sendConversation(f, body, () => Effect.fail(new AgentModelError({ reason: "UNAVAILABLE" })))))._tag).toBe("Left")
    expect((await run(sendConversation(f, body, respond)))._tag).toBe("Right")
    await pool.query("UPDATE agent_conversations SET expires_at = now() - interval '1 second' WHERE business_id=$1", [f.businessId])
    expect(await run(loadConversation(f))).toMatchObject({ _tag: "Right", right: null })
  })
})
