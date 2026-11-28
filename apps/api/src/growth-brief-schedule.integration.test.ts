import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { HttpApp } from "@effect/platform"
import { Effect, Layer, Redacted } from "effect"
import { SqlClient } from "@effect/sql"
import { claimAgentRequest, executeAgentRequest } from "./agent-request-queue.js"
import type { Responder } from "./agent-conversations.js"
import { PgClient } from "@effect/sql-pg"
import {
  GrowthRepositoriesLive, AgentProposalRepositoryLive, AuthRepositoryLive,
  DiscoveryMatchRepositoryLive, DiscoveryObservationRepositoryLive,
  EvidenceLineageRepositoryLive, InterventionBindingRepositoryLive, InterventionRepositoryLive,
  RecordRepositoryLive, AcquisitionRepositoryLive, SourceTargetRepositoryLive,
} from "@openrecord/db"
import pg from "pg"
import { makeRouter, RepoLayers } from "./router.js"

const url = process.env["TEST_DATABASE_URL"] ?? ""
const suite = url ? describe : describe.skip
suite("weekly brief schedule controls (disposable PostgreSQL, no model calls)", () => {
  const pool = new pg.Pool({ connectionString: url })
  const repos = Layer.mergeAll(
    RepoLayers.SetupRepositoryLive, GrowthRepositoriesLive, AgentProposalRepositoryLive,
    AuthRepositoryLive, RecordRepositoryLive, AcquisitionRepositoryLive,
    InterventionRepositoryLive, InterventionBindingRepositoryLive, SourceTargetRepositoryLive,
    EvidenceLineageRepositoryLive, DiscoveryObservationRepositoryLive, DiscoveryMatchRepositoryLive,
    RepoLayers.AssayRepositoryLive,
    RepoLayers.AssayReviewRepositoryLive,
    RepoLayers.BusinessRepositoryLive,
    RepoLayers.FactRepositoryLive,
    RepoLayers.QuestionRepositoryLive,
    RepoLayers.CheckRunRepositoryLive,
    RepoLayers.ObservationRepositoryLive,
    RepoLayers.ClaimRepositoryLive,
    RepoLayers.JudgmentRepositoryLive,
    RepoLayers.ReobservationIntentRepositoryLive,
    RepoLayers.ReobservationRepositoryLive,
    RepoLayers.ProductReadRepositoryLive,
    RepoLayers.DiscoveryScopeRepositoryLive,
    RepoLayers.DiscoveryRunRepositoryLive,
    RepoLayers.DiscoveryFrontierRepositoryLive,
    RepoLayers.SiteTargetRepositoryLive,
    RepoLayers.SiteRunRepositoryLive,
    RepoLayers.SitePageObservationRepositoryLive,
    RepoLayers.SiteFindingRepositoryLive,
    RepoLayers.SiteFindingEventRepositoryLive,
    RepoLayers.SiteFixProposalRepositoryLive,
    RepoLayers.SiteMutationRepositoryLive,
    RepoLayers.SiteVerificationRepositoryLive,
    RepoLayers.SiteOperatorEventRepositoryLive,
    RepoLayers.SiteGscRepositoryLive,
    RepoLayers.GrowthMeasurementRepositoryLive,
  ).pipe(
    Layer.provideMerge(PgClient.layer({ url: Redacted.make(url) })),
  )
  const web = HttpApp.toWebHandlerLayer(makeRouter(), repos)
  const run = <A,E>(fx: Effect.Effect<A,E,SqlClient.SqlClient>) => Effect.runPromise(fx.pipe(Effect.provide(repos)))
  beforeAll(async () => { await pool.query("SELECT 1") })
  afterAll(async () => { await web.dispose(); await pool.end() })
  const fixture = async () => {
    const account = String((await pool.query("INSERT INTO accounts(name) VALUES('TEST brief schedule') RETURNING id")).rows[0].id)
    const user = String((await pool.query("INSERT INTO users(email,password_hash) VALUES($1,'TEST') RETURNING id", [`schedule-${randomUUID()}@example.test`])).rows[0].id)
    await pool.query("INSERT INTO account_users(account_id,user_id) VALUES($1,$2)", [account,user])
    const session = String((await pool.query("INSERT INTO sessions(id,account_id,user_id,expires_at,token_digest) SELECT u,$1::uuid,$2::uuid,now()+interval '1 hour',encode(sha256(convert_to(u::text,'UTF8')),'hex') FROM gen_random_uuid() u RETURNING id", [account,user])).rows[0].id)
    const business = String((await pool.query("INSERT INTO businesses(account_id,name) VALUES($1,'TEST Schedule') RETURNING id", [account])).rows[0].id)
    return { business, session }
  }
  const call = (business: string, session: string | null, body?: unknown, origin?: string) => web.handler(new Request(`http://localhost/api/businesses/${business}/brief/schedule`, {
    method: body === undefined ? "GET" : "POST",
    headers: { ...(session ? {cookie:`or_session=${session}`} : {}), ...(body === undefined ? {} : {"content-type":"application/json"}), ...(origin ? {origin} : {}) },
    body: body === undefined ? null : JSON.stringify(body),
  }))
  it("reads without creating a schedule, chat, or brief; persists off and on without running a brief", async () => {
    const f = await fixture()
    expect(await (await call(f.business, f.session)).json()).toEqual({schedule:null})
    expect((await pool.query("SELECT count(*)::int n FROM growth_brief_schedules WHERE business_id=$1", [f.business])).rows[0].n).toBe(0)
    for (const enabled of [false, false, true, false]) {
      const response = await call(f.business, f.session, {enabled})
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({schedule:{enabled}})
      expect(await (await call(f.business, f.session)).json()).toMatchObject({schedule:{enabled}})
    }
    expect((await pool.query("SELECT count(*)::int n FROM growth_briefs WHERE business_id=$1", [f.business])).rows[0].n).toBe(0)
    expect((await pool.query("SELECT count(*)::int n FROM agent_conversations WHERE business_id=$1", [f.business])).rows[0].n).toBe(0)
  })
  it("enforces session, tenant, origin, and payload boundaries", async () => {
    const a = await fixture(), b = await fixture()
    expect((await call(a.business, null)).status).toBe(401)
    expect((await call(a.business, b.session)).status).toBe(404)
    expect((await call(a.business, b.session, {enabled:false})).status).toBe(404)
    expect((await call(a.business, a.session, {enabled:false}, "https://untrusted.example")).status).toBe(403)
    expect((await call(a.business, a.session, {enabled:"false"})).status).toBe(422)
    expect(await (await call(a.business, a.session)).json()).toEqual({schedule:null})
  })
  const conversation = async (f: { business: string; session: string }) => String((await pool.query(
    "INSERT INTO agent_conversations(account_id,user_id,business_id) SELECT account_id,user_id,$2 FROM sessions WHERE id=$1 RETURNING id", [f.session,f.business],
  )).rows[0].id)
  it("binds the control to its session and atomically queues one agent acknowledgement per change", async () => {
    const f = await fixture(), id = await conversation(f)
    const on = {enabled:true,notify:{conversationId:id,revision:0,requestId:randomUUID()}}
    const response = await call(f.business,f.session,on)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({schedule:{enabled:true,conversationId:id},request:{requestId:on.notify.requestId},message:expect.stringContaining("Turn on weekly briefs")})
    expect((await call(f.business,f.session,on)).status).toBe(200)
    expect((await pool.query("SELECT count(*)::int n FROM agent_request_jobs WHERE conversation_id=$1",[id])).rows[0].n).toBe(1)
    await pool.query("UPDATE agent_request_jobs SET status='COMPLETED',result='{}'::jsonb,finished_at=now() WHERE request_id=$1",[on.notify.requestId])
    const off = {enabled:false,notify:{conversationId:id,revision:0,requestId:randomUUID()}}
    expect((await call(f.business,f.session,off)).status).toBe(200)
    expect(await (await call(f.business,f.session)).json()).toMatchObject({schedule:{enabled:false,conversationId:id}})
    // A delayed replay of the original on request must not re-enable the policy.
    expect((await call(f.business,f.session,on)).status).toBe(200)
    expect(await (await call(f.business,f.session)).json()).toMatchObject({schedule:{enabled:false,conversationId:id}})
    const job=(await pool.query("SELECT payload FROM agent_request_jobs WHERE request_id=$1",[off.notify.requestId])).rows[0]
    expect(job.payload.message).toContain("Turn off weekly briefs")
    const claimed = await run(claimAgentRequest)
    expect(claimed?.request_id).toBe(off.notify.requestId)
    if (!claimed) throw new Error("Missing queued acknowledgement")
    const responder: Responder<never> = (_a,_u,_b,_m,_h,_s,assertActive) => assertActive.pipe(Effect.provide(repos), Effect.as({
      reply:"Weekly briefs are off for this session.",citations:[],toolCalls:[],usage:[],provider:"fixture",requestedModel:"fixture",
    }))
    await run(executeAgentRequest(claimed,responder))
    const messages=(await pool.query("SELECT messages FROM agent_conversations WHERE id=$1",[id])).rows[0].messages
    expect(messages).toMatchObject([{role:"user",text:expect.stringContaining("Turn off weekly briefs")},{role:"agent",text:"Weekly briefs are off for this session."}])
    expect((await pool.query("SELECT count(*)::int n FROM growth_briefs WHERE business_id=$1",[f.business])).rows[0].n).toBe(0)
  })
  it("rolls back the setting if the target chat is foreign or cannot accept a turn", async () => {
    const a=await fixture(), b=await fixture(), foreign=await conversation(b), own=await conversation(a)
    expect((await call(a.business,a.session,{enabled:true,notify:{conversationId:foreign,revision:0,requestId:randomUUID()}})).status).toBe(404)
    await pool.query("UPDATE agent_conversations SET lease_until=now()+interval '5 minutes' WHERE id=$1",[own])
    expect((await call(a.business,a.session,{enabled:true,notify:{conversationId:own,revision:0,requestId:randomUUID()}})).status).toBe(409)
    expect(await (await call(a.business,a.session)).json()).toEqual({schedule:null})
    expect((await pool.query("SELECT count(*)::int n FROM agent_request_jobs WHERE conversation_id=$1",[own])).rows[0].n).toBe(0)
  })
  it("backfills an existing schedule to its own weekly brief chat and safely replays the migration", async () => {
    const f=await fixture(), id=await conversation(f)
    await pool.query("INSERT INTO growth_briefs(account_id,user_id,business_id,trigger,conversation_id,status,text,finished_at) SELECT account_id,user_id,$2,'SCHEDULE',$3,'READY','TEST completed brief',now() FROM sessions WHERE id=$1",[f.session,f.business,id])
    expect((await call(f.business,f.session,{enabled:true})).status).toBe(200)
    const migration=readFileSync(new URL("../../../packages/db/migrations/0088_brief_schedule_session.sql",import.meta.url),"utf8")
    for (let n=0;n<2;n++) {
      await pool.query(migration)
      expect(await (await call(f.business,f.session)).json()).toMatchObject({schedule:{enabled:true,conversationId:id}})
    }
  })

})
