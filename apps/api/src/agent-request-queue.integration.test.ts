import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { HttpApp } from "@effect/platform"
import { Effect, Layer, Redacted } from "effect"
import { PgClient } from "@effect/sql-pg"
import { SqlClient } from "@effect/sql"
import { AuthRepositoryLive } from "@openrecord/db"
import pg from "pg"
import { agentRequestApi } from "./agent-request-routes.js"
import { cancelAgentRequest, claimAgentRequest, enqueueAgentRequest, executeAgentRequest, reconcileRequestJobs } from "./agent-request-queue.js"
import { requireSession } from "./router.js"
import type { Responder } from "./agent-conversations.js"
import { withAgentWorkerRuntime } from "./agent-worker-runtime.js"

const url=process.env["TEST_DATABASE_URL"] ?? ""
const suite=url ? describe : describe.skip
suite("durable request submission and worker (no live model)",() => {
  const pool=new pg.Pool({connectionString:url})
  const repos=AuthRepositoryLive.pipe(Layer.provideMerge(PgClient.layer({url:Redacted.make(url)})))
  const web=HttpApp.toWebHandlerLayer(agentRequestApi(run => Effect.flatMap(requireSession,({session}) => run(session))),repos)
  const accounts:string[]=[]
  const run=<A,E>(fx:Effect.Effect<A,E,SqlClient.SqlClient>) => Effect.runPromise(fx.pipe(Effect.provide(repos)))
  beforeAll(async () => {
    for (const name of ["0075_agent_request_queue.sql","0076_agent_worker_runtime.sql"]) {
      await pool.query(readFileSync(new URL(`../../../packages/db/migrations/${name}`,import.meta.url),"utf8"))
    }
  })
  afterEach(async () => { if (accounts.length) await pool.query("DELETE FROM agent_request_jobs WHERE account_id=ANY($1::uuid[])",[accounts.splice(0)]) })
  afterAll(async () => { await web.dispose(); await pool.end() })
  const fixture=async () => {
    const accountId=(await pool.query("INSERT INTO accounts(name) VALUES('TEST queue') RETURNING id")).rows[0].id as string
    accounts.push(accountId)
    const userId=(await pool.query("INSERT INTO users(email,password_hash) VALUES($1,'TEST') RETURNING id",[`queue-${randomUUID()}@example.test`])).rows[0].id as string
    await pool.query("INSERT INTO account_users(account_id,user_id) VALUES($1,$2)",[accountId,userId])
    const businessId=(await pool.query("INSERT INTO businesses(account_id,name) VALUES($1,'TEST queue') RETURNING id",[accountId])).rows[0].id as string
    const conversationId=(await pool.query("INSERT INTO agent_conversations(account_id,user_id,business_id) VALUES($1,$2,$3) RETURNING id",[accountId,userId,businessId])).rows[0].id as string
    const cookie=(await pool.query("INSERT INTO sessions(account_id,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour') RETURNING id",[accountId,userId])).rows[0].id as string
    return {accountId,userId,businessId,conversationId,cookie}
  }
  const body=(conversationId:string) => ({conversationId,requestId:randomUUID(),revision:0,message:"Read saved campaign status"})
  const call=(path:string,cookie?:string,payload?:unknown,origin?:string) => web.handler(new Request(`http://localhost${path}`,{
    method:payload ? "POST" : "GET",headers:{"content-type":"application/json",...(cookie ? {cookie:`or_session=${cookie}`} : {}),...(origin ? {origin} : {})},...(payload ? {body:JSON.stringify(payload)} : {}),
  }))
  const reply:Responder<never>=(_a,_u,_b,_m,_h,_s,assertActive) => assertActive.pipe(Effect.provide(repos),Effect.as({reply:"Saved records reviewed",citations:[],toolCalls:[],usage:[],provider:"fixture",requestedModel:"fixture",outcome:"ANSWERED" as const}))
  it("accepts quickly, replays safely and protects pending work across accounts and origins",async () => {
    const f=await fixture(),other=await fixture(),input=body(f.conversationId),path=`/api/businesses/${f.businessId}/agent/requests`
    expect((await call(path,undefined,input)).status).toBe(401)
    expect((await call(path,f.cookie,input,"https://hostile.test")).status).toBe(403)
    expect((await call(path,other.cookie,input)).status).toBe(404)
    expect((await call(path,f.cookie,input)).status).toBe(202)
    expect((await call(path,f.cookie,input)).status).toBe(202)
    expect((await call(path,f.cookie,{...input,message:"Different request"})).status).toBe(409)
    expect((await call(path,f.cookie,body(f.conversationId))).status).toBe(409)
    const pending=await (await call(`/api/agent/requests?conversationId=${f.conversationId}`,f.cookie)).json() as {request:{request_id:string}}
    expect(pending.request.request_id).toBe(input.requestId)
    expect((await call(`/api/agent/requests/${input.requestId}`,other.cookie)).status).toBe(404)
    expect((await call(`/api/agent/requests/${input.requestId}/cancel`,other.cookie,{})).status).toBe(404)
    expect((await call(`/api/agent/requests/${input.requestId}/cancel`,f.cookie,{})).status).toBe(200)
    expect(await run(claimAgentRequest)).toBeNull()
  })
  it("executes once independently of the submit connection and persists the reply",async () => {
    const f=await fixture(),input=body(f.conversationId)
    await run(enqueueAgentRequest(f,input))
    const claims=await Promise.all([run(claimAgentRequest),run(claimAgentRequest)])
    expect(claims.filter(Boolean)).toHaveLength(1)
    const job=claims.find(j => j !== null)!
    await run(executeAgentRequest(job,reply))
    const response=await call(`/api/agent/requests/${input.requestId}`,f.cookie)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(await response.json()).toMatchObject({status:"COMPLETED",result:{reply:"Saved records reviewed"}})
    expect((await pool.query("SELECT count(*)::int AS n FROM agent_runs WHERE request_id=$1",[input.requestId])).rows[0].n).toBe(1)
    await run(enqueueAgentRequest(f,input))
    expect(await run(claimAgentRequest)).toBeNull()
  })
  it("enforces queue and execution caps across different users in the same account",async () => {
    const f=await fixture()
    const secondUser=(await pool.query("INSERT INTO users(email,password_hash) VALUES($1,'TEST') RETURNING id",[`queue-cap-${randomUUID()}@example.test`])).rows[0].id as string
    await pool.query("INSERT INTO account_users(account_id,user_id) VALUES($1,$2)",[f.accountId,secondUser])
    const conversation=async (userId:string) => (await pool.query("INSERT INTO agent_conversations(account_id,user_id,business_id,archived_at) VALUES($1,$2,$3,now()) RETURNING id",[f.accountId,userId,f.businessId])).rows[0].id as string
    for (let i=0;i<7;i++) await run(enqueueAgentRequest(f,body(await conversation(f.userId))))
    const c1=await conversation(f.userId),c2=await conversation(secondUser)
    const attempts=await Promise.allSettled([run(enqueueAgentRequest(f,body(c1))),run(enqueueAgentRequest({...f,userId:secondUser},body(c2)))])
    expect(attempts.map(a => a.status).sort()).toEqual(["fulfilled","rejected"])
    expect((await pool.query("SELECT count(*)::int AS n FROM agent_request_jobs WHERE account_id=$1",[f.accountId])).rows[0].n).toBe(8)
    const claims=await Promise.all([run(claimAgentRequest),run(claimAgentRequest),run(claimAgentRequest)])
    expect(claims.filter(Boolean)).toHaveLength(2)
  })
  it("recovers committed replies after a crash without rerunning tools, but interrupts ambiguous work",async () => {
    for (const committed of [false,true]) {
      const f=await fixture(),input=body(f.conversationId)
      await run(enqueueAgentRequest(f,input)); const job=await run(claimAgentRequest)
      expect(job).not.toBeNull()
      await pool.query("UPDATE agent_request_jobs SET execution_started_at=now() WHERE request_id=$1",[input.requestId])
      if (committed) await pool.query("UPDATE agent_conversations SET last_request_id=$2,last_reply=$3::jsonb WHERE id=$1",[f.conversationId,input.requestId,JSON.stringify({reply:"Already committed"})])
      await pool.query("UPDATE agent_request_jobs SET lease_until=now()-interval '1 minute' WHERE request_id=$1",[input.requestId])
      await run(reconcileRequestJobs)
      const saved=(await pool.query("SELECT status,result FROM agent_request_jobs WHERE request_id=$1",[input.requestId])).rows[0]
      expect(saved.status).toBe(committed ? "COMPLETED" : "INTERRUPTED")
      if (committed) expect(saved.result.reply).toBe("Already committed")
      expect(await run(claimAgentRequest)).toBeNull()
    }
  })
  it("requeues a clearly unstarted expired claim and fences its old worker",async () => {
    const f=await fixture(),input=body(f.conversationId)
    await run(enqueueAgentRequest(f,input))
    const old=(await run(claimAgentRequest))!
    await pool.query("UPDATE agent_request_jobs SET lease_until=now()-interval '1 minute' WHERE request_id=$1",[input.requestId])
    await run(reconcileRequestJobs)
    expect((await pool.query("SELECT status FROM agent_request_jobs WHERE request_id=$1",[input.requestId])).rows[0].status).toBe("QUEUED")
    const replacement=(await run(claimAgentRequest))!
    expect(replacement.claim_id).not.toBe(old.claim_id)
    let calls=0
    const counted:Responder<never>=(...args) => { calls++; return reply(...args) }
    await run(executeAgentRequest(old,counted))
    expect(calls).toBe(0)
    await run(executeAgentRequest(replacement,counted))
    expect(calls).toBe(1)
  })
  it("does not replay a duplicate execution with the same claim",async () => {
    const f=await fixture(),input=body(f.conversationId)
    await run(enqueueAgentRequest(f,input))
    const job=(await run(claimAgentRequest))!
    await pool.query("UPDATE agent_request_jobs SET execution_started_at=now() WHERE request_id=$1",[input.requestId])
    let calls=0
    const counted:Responder<never>=(...args) => { calls++; return reply(...args) }
    await run(executeAgentRequest(job,counted))
    expect(calls).toBe(0)
    expect((await pool.query("SELECT status FROM agent_request_jobs WHERE request_id=$1",[input.requestId])).rows[0].status).toBe("RUNNING")
  })
  it("registers standalone liveness and marks the worker stopped on failure",async () => {
    let id=""
    await run(withAgentWorkerRuntime("standalone",Effect.gen(function*() {
      const sql=yield* SqlClient.SqlClient
      const row=(yield* sql`SELECT id,mode,stopped_at FROM agent_worker_instances WHERE stopped_at IS NULL ORDER BY started_at DESC LIMIT 1`)[0]!
      id=String(row["id"])
      expect(row["mode"]).toBe("standalone")
      expect(row["stopped_at"]).toBeNull()
      return yield* Effect.fail("fixture failure")
    })).pipe(Effect.exit))
    expect((await pool.query("SELECT stopped_at IS NOT NULL AS stopped FROM agent_worker_instances WHERE id=$1",[id])).rows[0].stopped).toBe(true)
    await pool.query("DELETE FROM agent_worker_instances WHERE id=$1",[id])
  })
  it("cancels an in-flight request and refuses a late answer commit",async () => {
    const f=await fixture(),input=body(f.conversationId)
    await run(enqueueAgentRequest(f,input)); const job=(await run(claimAgentRequest))!
    let started!:()=>void,release!:()=>void
    const ready=new Promise<void>(resolve => {started=resolve}),gate=new Promise<void>(resolve => {release=resolve})
    const waiting:Responder<never>=() => Effect.sync(started).pipe(Effect.andThen(Effect.promise(() => gate)),Effect.as({reply:"Too late",citations:[],toolCalls:[],usage:[],provider:"fixture",requestedModel:"fixture"}))
    const executing=run(executeAgentRequest(job,waiting))
    await ready
    await run(cancelAgentRequest(f.accountId,f.userId,input.requestId)); release(); await executing
    expect((await pool.query("SELECT status,result FROM agent_request_jobs WHERE request_id=$1",[input.requestId])).rows[0]).toMatchObject({status:"CANCELLED",result:null})
    expect((await pool.query("SELECT messages FROM agent_conversations WHERE id=$1",[f.conversationId])).rows[0].messages).toEqual([])
  })
})
