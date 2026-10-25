import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Effect, Layer, Redacted } from "effect"
import { PgClient } from "@effect/sql-pg"
import { AcquisitionRepositoryLive, GrowthRepositoriesLive, AgentProposalRepositoryLive, BusinessRepositoryLive, DiscoveryScopeRepositoryLive, FactRepositoryLive, ProductReadRepositoryLive, QuestionRepositoryLive, RecordRepositoryLive } from "@openrecord/db"
import pg from "pg"
import { deleteConversation, listConversations, loadConversation, sendConversation, type ConversationScope } from "./agent-conversations.js"
import { AgentModelError } from "./agent-model.js"
import type { AgentToolDeps } from "./agent-tools.js"
import { activateHarness, authenticateBridge, cancelHarnessConversation, completeHarnessJob, createPair, harnessCatalog, pollHarnessJobs, registerBridge } from "./harness-store.js"

const url = process.env["TEST_DATABASE_URL"] ?? ""
const suite = url ? describe : describe.skip
suite("private durable conversations (disposable TEST fixtures)", () => {
  let pool: pg.Pool
  const repos = Layer.mergeAll(AcquisitionRepositoryLive, GrowthRepositoriesLive, AgentProposalRepositoryLive, BusinessRepositoryLive, DiscoveryScopeRepositoryLive, FactRepositoryLive, ProductReadRepositoryLive, QuestionRepositoryLive, RecordRepositoryLive)
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
  it("lists only the user's own non-empty conversations, newest first, titled by the first question", async () => {
    const a = await fixture(), b = await fixture()
    const second = (await pool.query("INSERT INTO businesses(account_id,name) VALUES ($1,'TEST Second') RETURNING id", [a.accountId])).rows[0].id as string
    await run(sendConversation(a, { message: "  First   question  ", requestId: randomUUID(), revision: 0 }, respond))
    await run(sendConversation(a, { message: "Follow-up", requestId: randomUUID(), revision: 1 }, respond))
    await run(sendConversation({ ...a, businessId: second }, { message: "Other business", requestId: randomUUID(), revision: 0 }, respond))
    await run(sendConversation(b, { message: "Someone else", requestId: randomUUID(), revision: 0 }, respond))
    const listed = await run(listConversations(a))
    expect(listed).toMatchObject({ _tag: "Right", right: [
      { businessId: second, businessName: "TEST Second", title: "Other business", messages: 2, isClient: false },
      { businessId: a.businessId, title: "First question", messages: 4 },
    ] })
    expect(listed._tag === "Right" && listed.right.length).toBe(2)
    await run(deleteConversation(a))
    expect(await run(listConversations(a))).toMatchObject({ _tag: "Right", right: [{ businessId: second }] })
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
  it("runs a selected harness through the real conversation loop and binds replay to its model", async () => {
    const f=await fixture()
    const execute=<A,E>(fx:Effect.Effect<A,E,AgentToolDeps>)=>Effect.runPromise(fx.pipe(Effect.provide(repos)))
    const paired=await execute(createPair(f,"TEST bridge"))
    const registered=await execute(registerBridge(paired.code))
    const bridge=await execute(authenticateBridge(registered.token))
    const report={localId:randomUUID(),driver:"opencode" as const,name:"TEST OpenCode",installed:true,version:"TEST",auth:"authenticated" as const,state:"ready" as const,
      models:[{id:"fixture/first",name:"TEST First"},{id:"fixture/second",name:"TEST Second"}]}
    await execute(pollHarnessJobs(bridge,[report]))
    const instance=(await execute(harnessCatalog(f))).instances[0]!
    await execute(activateHarness(f,instance.id,true))
    const body={message:"TEST first model",requestId:randomUUID(),revision:0,selection:{instanceId:instance.id,model:"fixture/first"}}
    const response=run(sendConversation(f,body))
    let job:Awaited<ReturnType<typeof poll>>["job"]=null
    async function poll(){return execute(pollHarnessJobs(bridge,[report]))}
    for(let i=0;i<50;i++){
      job=(await poll()).job
      if(job)break
      await new Promise(resolve=>setTimeout(resolve,20))
    }
    if(!job)throw new Error("TEST bridge did not receive the conversation")
    expect(job.model).toBe("fixture/first")
    expect(job.input.contents).toEqual([{role:"user",parts:[{text:body.message}]}])
    await execute(completeHarnessJob(bridge,job.id,{lease:job.lease,kind:"completed",answer:{kind:"tools",calls:[{name:"read_business_truth",args:{}}]}}))
    job=null
    for(let i=0;i<50;i++){
      job=(await poll()).job
      if(job)break
      await new Promise(resolve=>setTimeout(resolve,20))
    }
    if(!job)throw new Error("TEST bridge did not receive the server tool result")
    expect(job.input.contents).toMatchObject([{role:"user"},{role:"model",parts:[{functionCall:{name:"read_business_truth",args:{}}}]},{role:"user",parts:[{functionResponse:{name:"read_business_truth",response:{untrustedEvidence:{summary:"0 approved facts read"}}}}]}])
    await execute(completeHarnessJob(bridge,job.id,{lease:job.lease,kind:"completed",answer:{kind:"text",text:"TEST harness answer"}}))
    expect(await response).toMatchObject({_tag:"Right",right:{provider:"opencode",requestedModel:"fixture/first",instanceId:instance.id,revision:1,reply:"TEST harness answer"}})
    expect(await run(loadConversation(f))).toMatchObject({_tag:"Right",right:{messages:[{role:"user"},{inference:{provider:"opencode",requestedModel:"fixture/first",instanceId:instance.id}}]}})
    expect(await run(sendConversation(f,body))).toMatchObject({_tag:"Right",right:{reply:"TEST harness answer"}})
    expect(await run(sendConversation(f,{...body,selection:{...body.selection,model:"fixture/second"}}))).toMatchObject({_tag:"Left",left:{reason:"STALE"}})
    const second=run(sendConversation(f,{message:"TEST next model",requestId:randomUUID(),revision:1,selection:{instanceId:instance.id,model:"fixture/second"}}))
    job=null
    for(let i=0;i<50;i++){
      job=(await poll()).job
      if(job)break
      await new Promise(resolve=>setTimeout(resolve,20))
    }
    if(!job)throw new Error("TEST bridge did not receive the switched model")
    expect(job.model).toBe("fixture/second")
    expect(job.input.contents).toMatchObject([{role:"user"},{role:"model",parts:[{text:"TEST harness answer"}]},{role:"user",parts:[{text:"TEST next model"}]}])
    await execute(completeHarnessJob(bridge,job.id,{lease:job.lease,kind:"completed",answer:{kind:"text",text:"TEST second model answer"}}))
    expect(await second).toMatchObject({_tag:"Right",right:{requestedModel:"fixture/second",revision:2}})
    const cancelled=run(sendConversation(f,{message:"TEST stop this turn",requestId:randomUUID(),revision:2,selection:body.selection}))
    job=null
    for(let i=0;i<50;i++){
      job=(await poll()).job
      if(job)break
      await new Promise(resolve=>setTimeout(resolve,20))
    }
    if(!job)throw new Error("TEST bridge did not receive the cancellable turn")
    await execute(cancelHarnessConversation(f))
    expect(await cancelled).toMatchObject({_tag:"Left"})
    expect(await run(loadConversation(f))).toMatchObject({_tag:"Right",right:{revision:2}})
  })
})
