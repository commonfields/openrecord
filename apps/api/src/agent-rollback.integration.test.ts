// Undoing a chat from one of the person's messages, against a disposable
// PostgreSQL: the later turns leave the chat, their undecided cards are
// withdrawn without a verdict or a resumed turn, decided ones stay, the
// artifact versions they saved are reverted unless someone wrote after them,
// their helpers stop without posting back, and a retried request replays.
import { createHash, randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { HttpApp } from "@effect/platform"
import { Layer, Redacted } from "effect"
import { PgClient } from "@effect/sql-pg"
import { AdsProvider, adsConfigFromEnv } from "@openrecord/ads"
import {
  GrowthRepositoriesLive, AgentProposalRepositoryLive,
  AuthRepositoryLive, DiscoveryMatchRepositoryLive, DiscoveryObservationRepositoryLive,
  EvidenceLineageRepositoryLive, InterventionBindingRepositoryLive, InterventionRepositoryLive,
  RecordRepositoryLive, AcquisitionRepositoryLive, SourceTargetRepositoryLive,
} from "@openrecord/db"
import type { HttpTransport } from "@openrecord/representation"
import pg from "pg"
import { makeRouter, RepoLayers } from "./router.js"
import { ResearchHttp } from "./research/net.js"

const url = process.env["TEST_DATABASE_URL"] ?? ""
const suite = url ? describe : describe.skip
const key = () => createHash("sha256").update(randomUUID()).digest("hex")
const sha = (s: string) => createHash("sha256").update(s).digest("hex")

suite("chat rollback (disposable PostgreSQL)", () => {
  let pool: pg.Pool
  const repos = Layer.mergeAll(
    RepoLayers.SetupRepositoryLive, GrowthRepositoriesLive, AgentProposalRepositoryLive,
    AuthRepositoryLive, RecordRepositoryLive, AcquisitionRepositoryLive,
    InterventionRepositoryLive, InterventionBindingRepositoryLive, SourceTargetRepositoryLive,
    EvidenceLineageRepositoryLive, DiscoveryObservationRepositoryLive, DiscoveryMatchRepositoryLive,
    RepoLayers.AssayRepositoryLive, RepoLayers.AssayReviewRepositoryLive, RepoLayers.BusinessRepositoryLive,
    RepoLayers.FactRepositoryLive, RepoLayers.QuestionRepositoryLive, RepoLayers.CheckRunRepositoryLive,
    RepoLayers.ObservationRepositoryLive, RepoLayers.ClaimRepositoryLive, RepoLayers.JudgmentRepositoryLive,
    RepoLayers.ReobservationIntentRepositoryLive, RepoLayers.ReobservationRepositoryLive, RepoLayers.ProductReadRepositoryLive,
    RepoLayers.DiscoveryScopeRepositoryLive, RepoLayers.DiscoveryRunRepositoryLive, RepoLayers.DiscoveryFrontierRepositoryLive,
    RepoLayers.SiteTargetRepositoryLive, RepoLayers.SiteRunRepositoryLive, RepoLayers.SitePageObservationRepositoryLive,
    RepoLayers.SiteFindingRepositoryLive, RepoLayers.SiteFindingEventRepositoryLive, RepoLayers.SiteFixProposalRepositoryLive,
    RepoLayers.SiteMutationRepositoryLive, RepoLayers.SiteVerificationRepositoryLive, RepoLayers.SiteOperatorEventRepositoryLive,
    RepoLayers.SiteGscRepositoryLive, RepoLayers.GrowthMeasurementRepositoryLive,
  ).pipe(Layer.provideMerge(PgClient.layer({ url: Redacted.make(url) })))
  const transport: HttpTransport = { lookup: async () => ["93.184.216.34"], fetch: async () => ({ status: 404, headers: {}, body: new Uint8Array(), peerIp: "93.184.216.34" }) }
  const ads = adsConfigFromEnv({ GA4_TOKEN_ENCRYPTION_KEYS: `k1:${Buffer.alloc(32, 5).toString("base64")}` })
  const layer = Layer.mergeAll(repos, Layer.succeed(ResearchHttp, transport), Layer.succeed(AdsProvider, ads))
  beforeAll(() => { pool = new pg.Pool({ connectionString: url }) })
  afterAll(async () => { await pool.end() })

  const one = async (q: string, v: unknown[] = []) => (await pool.query(q, v)).rows[0]
  const fixture = async () => {
    const accountId = String((await one("INSERT INTO accounts(name) VALUES('TEST rollback') RETURNING id")).id)
    const userId = String((await one("INSERT INTO users(email,password_hash) VALUES($1,'TEST') RETURNING id", [`rollback-${randomUUID()}@example.test`])).id)
    await pool.query("INSERT INTO account_users(account_id,user_id) VALUES($1,$2)", [accountId, userId])
    const businessId = String((await one("INSERT INTO businesses(account_id,name) VALUES($1,'TEST Dental') RETURNING id", [accountId])).id)
    const session = String((await one("INSERT INTO sessions(id,account_id,user_id,expires_at,token_digest) SELECT u,$1::uuid,$2::uuid,now()+interval '1 hour',encode(sha256(convert_to(u::text,'UTF8')),'hex') FROM gen_random_uuid() u RETURNING id", [accountId, userId])).id)
    return { accountId, userId, businessId, session }
  }
  type F = Awaited<ReturnType<typeof fixture>>
  const run = async (f: F, conversationId: string) => String((await one(`INSERT INTO agent_runs(conversation_id,account_id,business_id,user_id,request_id,lease_id,objective,status,outcome,finished_at,settled_at)
    VALUES($1,$2,$3,$4,$5,$6,'TEST turn','COMPLETED','ANSWERED',now(),now()) RETURNING id`, [conversationId, f.accountId, f.businessId, f.userId, randomUUID(), randomUUID()])).id)
  const event = (runId: string, seq: number, payload: unknown) =>
    pool.query("INSERT INTO agent_run_events(run_id,seq,type,payload) VALUES($1,$2,'TOOL_COMPLETED',$3)", [runId, seq, JSON.stringify(payload)])
  const change = async (f: F, status: string) => String((await one(`INSERT INTO wordpress_changes(business_id,account_id,kind,post_type,post_id,target_title,before_values,after_values,rationale,status,proposed_by,created_by_user_id,request_key)
    VALUES($1,$2,'UPDATE_COPY','pages',7,'TEST page','{}','{"content":"TEST"}','TEST reason',$3,'ASSISTANT',$4,$5) RETURNING id`, [f.businessId, f.accountId, status, f.userId, key()])).id)
  const strategy = async (f: F) => String((await one(`INSERT INTO marketing_strategy_versions(business_id,version,audience,positioning,offer,voice,avoid_phrases,priority_bets,budget_limit,rationale,proposed_by_actor,proposed_by_user_id,request_key)
    VALUES($1,1,'TEST','TEST','TEST','TEST','{}','{}','TEST','TEST rationale','ASSISTANT',$2,$3) RETURNING id`, [f.businessId, f.userId, key()])).id)
  const artifact = async (f: F, versions: ReadonlyArray<{ content: string; source?: string }>) => {
    const id = String((await one("INSERT INTO agent_artifacts(account_id,business_id,kind,format,title,version,created_by_user_id) VALUES($1,$2,'ARTICLE','MARKDOWN','TEST piece',$3,$4) RETURNING id",
      [f.accountId, f.businessId, versions.length, f.userId])).id)
    for (const [i, v] of versions.entries()) await pool.query(`INSERT INTO agent_artifact_versions(artifact_id,version,title,content,content_digest,source,created_by_user_id)
      VALUES($1,$2,'TEST piece',$3,$4,$5,$6)`, [id, i + 1, v.content, sha(v.content), v.source ?? "ASSISTANT", f.userId])
    return id
  }
  const web = () => HttpApp.toWebHandlerLayer(makeRouter(), layer as never)
  const send = async (h: ReturnType<typeof web>, path: string, session: string, body?: unknown) => {
    const r = await h.handler(new Request(`http://localhost${path}`, { method: body === undefined ? "GET" : "POST",
      headers: { cookie: `or_session=${session}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }))
    const text = await r.text()
    return { status: r.status, json: text ? JSON.parse(text) : null }
  }

  it("removes the later turns and withdraws only what they saved and nobody decided", async () => {
    const f = await fixture(), other = await fixture()
    const conversationId = String((await one("INSERT INTO agent_conversations(account_id,business_id,user_id) VALUES($1,$2,$3) RETURNING id", [f.accountId, f.businessId, f.userId])).id)
    const r1 = await run(f, conversationId), r2 = await run(f, conversationId)
    const earlierChange = await change(f, "PROPOSED"), pending = await change(f, "PROPOSED"), published = await change(f, "PUBLISHED"), pendingStrategy = await strategy(f)
    // Artifacts: one the removed turn created, one it edited twice, one the person edited after it.
    const created = await artifact(f, [{ content: "TEST new piece" }])
    const edited = await artifact(f, [{ content: "TEST original" }, { content: "TEST edit one" }, { content: "TEST edit two" }])
    const touched = await artifact(f, [{ content: "TEST start" }, { content: "TEST agent edit" }, { content: "TEST person edit", source: "OPERATOR" }])
    await event(r2, 1, { tool: "create_artifact", effect: "record", artifacts: [{ id: created, version: 1 }] })
    await event(r2, 2, { tool: "edit_artifact", effect: "record", artifacts: [{ id: edited, version: 2 }] })
    await event(r2, 3, { tool: "edit_artifact", effect: "record", artifacts: [{ id: edited, version: 3 }] })
    await event(r2, 4, { tool: "edit_artifact", effect: "record", artifacts: [{ id: touched, version: 2 }] })
    // A helper the removed turn started, still running, and a finished one not yet posted.
    const helper = async (leased: boolean) => String((await one(`INSERT INTO agent_conversations(account_id,business_id,user_id,parent_conversation_id,depth,task_title,task_role,archived_at,lease_id,lease_until)
      VALUES($1,$2,$3,$4,1,'TEST helper','researcher',now(),$5,CASE WHEN $6::boolean THEN now()+interval '5 minutes' END) RETURNING id`,
      [f.accountId, f.businessId, f.userId, conversationId, leased ? randomUUID() : null, leased])).id)
    const child = await helper(true)
    const task = async (childId: string) => String((await one(`INSERT INTO agent_tasks(account_id,user_id,business_id,parent_conversation_id,parent_run_id,child_conversation_id,kind,role,title,task,mode,client_request_id,request_id)
      VALUES($1,$2,$3,$4,$5,$6,'NEW','researcher','TEST helper','TEST task','async',$7,$8) RETURNING id`,
      [f.accountId, f.userId, f.businessId, conversationId, r2, childId, randomUUID(), randomUUID()])).id)
    const runningTask = await task(child), finishedTask = await task(await helper(false))
    await pool.query("UPDATE agent_tasks SET status='COMPLETED', result_summary='TEST result', finished_at=now() WHERE id=$1", [finishedTask])
    // Queued resumes: one for a card the rollback withdraws, one for a card an earlier turn showed.
    const resume = (itemId: string) => one(`INSERT INTO agent_work_jobs(account_id,user_id,business_id,kind,ref_id,payload) VALUES($1,$2,$3,'DECISION_RESUME_WRITE',$4,$5) RETURNING job_id`,
      [f.accountId, f.userId, f.businessId, itemId, JSON.stringify({ conversationId, itemId })])
    const proposal = String((await one(`INSERT INTO agent_proposals(business_id,kind,message,proposer,proposed_by_user_id) VALUES($1,'REQUEST_CHECK','TEST re-check','assistant-v1',$2) RETURNING id`, [f.businessId, f.userId])).id)
    const goneOpportunity = randomUUID()
    const withdrawnResume = String((await resume(pending)).job_id), keptResume = String((await resume(earlierChange)).job_id)
    const messages = [
      { role: "user", text: "TEST first" },
      // A campaign review card: this chat could not be opened before the schema listed it.
      { role: "agent", text: "TEST first answer", run: { id: r1, status: "COMPLETED", outcome: "ANSWERED" },
        decisions: [{ type: "WORDPRESS_CHANGE", id: earlierChange }, { type: "CAMPAIGN_REVIEW", id: randomUUID() }] },
      { role: "user", text: "TEST second" },
      { role: "agent", text: "TEST second answer", run: { id: r2, status: "COMPLETED", outcome: "ANSWERED" },
        decisions: [{ type: "WORDPRESS_CHANGE", id: pending }, { type: "WORDPRESS_CHANGE", id: published }, { type: "MARKETING_STRATEGY", id: pendingStrategy }, { type: "WORDPRESS_CHANGE", id: earlierChange },
          { type: "AGENT_PROPOSAL", id: proposal }, { type: "GROWTH_OPPORTUNITY", id: goneOpportunity }] },
    ]
    await pool.query("UPDATE agent_conversations SET messages=$2, revision=4, user_revision=4, last_reply='{\"title\":\"TEST title\"}' WHERE id=$1", [conversationId, JSON.stringify(messages)])
    const h = web()
    try {
      const path = `/api/businesses/${f.businessId}/agent/conversations/${conversationId}/rollback`
      const loaded = await send(h, `/api/businesses/${f.businessId}/agent/conversation?conversationId=${conversationId}`, f.session)
      expect(loaded.status).toBe(200)
      // Loading posts the finished helper's result, as it always has.
      expect(loaded.json.conversation.messages.map((m: { text: string }) => m.text.split(":")[0])).toEqual(["TEST first", "TEST first answer", "TEST second", "TEST second answer", "Result from “TEST helper”"])
      const rev = Number(loaded.json.conversation.revision)
      // Another helper finishes after the person loaded the chat; its result is not posted yet.
      const lateTask = await task(await helper(false))
      await pool.query("UPDATE agent_tasks SET status='COMPLETED', result_summary='TEST late', finished_at=now() WHERE id=$1", [lateTask])

      // Refused: from an agent message, a stale revision, a busy chat, someone else's chat.
      expect((await send(h, path, f.session, { from: 1, revision: rev, requestId: randomUUID() })).status).toBe(404)
      expect((await send(h, path, f.session, { from: 2, revision: rev - 3, requestId: randomUUID() })).json).toEqual({ _tag: "RollbackRefused", reason: "STALE" })
      await pool.query("UPDATE agent_conversations SET lease_id=$2, lease_until=now()+interval '1 minute' WHERE id=$1", [conversationId, randomUUID()])
      expect((await send(h, path, f.session, { from: 2, revision: rev, requestId: randomUUID() })).json).toEqual({ _tag: "RollbackRefused", reason: "BUSY" })
      await pool.query("UPDATE agent_conversations SET lease_id=NULL, lease_until=NULL WHERE id=$1", [conversationId])
      expect((await send(h, `/api/businesses/${other.businessId}/agent/conversations/${conversationId}/rollback`, other.session, { from: 2, revision: rev, requestId: randomUUID() })).status).toBe(404)

      const requestId = randomUUID()
      const done = await send(h, path, f.session, { from: 2, revision: rev, requestId })
      expect(done.status).toBe(200)
      expect(done.json.conversation.messages.map((m: { text: string }) => m.text)).toEqual(["TEST first", "TEST first answer"])
      expect(done.json.conversation.title).toBe("TEST title")
      const rb = done.json.rollback
      expect(rb).toMatchObject({ fromIndex: 2, removedMessages: 4, stoppedTasks: 1 })
      expect(rb.withdrawn).toEqual(expect.arrayContaining([{ type: "WORDPRESS_CHANGE", id: pending }, { type: "MARKETING_STRATEGY", id: pendingStrategy }, { type: "AGENT_PROPOSAL", id: proposal }]))
      expect(rb.withdrawn).toHaveLength(3)
      expect(rb.keptCards).toEqual([{ type: "WORDPRESS_CHANGE", id: published, status: "PUBLISHED" }, { type: "GROWTH_OPPORTUNITY", id: goneOpportunity, status: "NOT_FOUND" }])
      expect((await one("SELECT status FROM agent_proposals WHERE id=$1", [proposal])).status).toBe("REJECTED")
      expect(rb.archivedArtifacts).toEqual([{ id: created, title: "TEST piece" }])
      expect(rb.restoredArtifacts).toEqual([{ id: edited, title: "TEST piece", version: 4, restoredFrom: 1 }])
      expect(rb.keptArtifacts).toEqual([{ id: touched, title: "TEST piece", reason: "EDITED_SINCE" }])

      const status = async (id: string) => String((await one("SELECT status FROM wordpress_changes WHERE id=$1", [id])).status)
      expect(await status(pending)).toBe("REJECTED")
      expect(await status(published)).toBe("PUBLISHED")
      expect(await status(earlierChange)).toBe("PROPOSED")
      expect((await one("SELECT status FROM marketing_strategy_versions WHERE id=$1", [pendingStrategy])).status).toBe("REJECTED")
      // Withdrawing is not a verdict: nothing is written for the agent to learn from.
      expect((await one("SELECT count(*)::int AS n FROM decision_feedback WHERE business_id=$1", [f.businessId])).n).toBe(0)
      expect((await one("SELECT archived_at FROM agent_artifacts WHERE id=$1", [created])).archived_at).not.toBeNull()
      expect(await one("SELECT a.version, v.content, v.source FROM agent_artifacts a JOIN agent_artifact_versions v ON v.artifact_id=a.id AND v.version=a.version WHERE a.id=$1", [edited]))
        .toEqual({ version: 4, content: "TEST original", source: "OPERATOR" })
      expect((await one("SELECT version FROM agent_artifacts WHERE id=$1", [touched])).version).toBe(3)
      expect(await one("SELECT status, delivered_at IS NOT NULL AS delivered FROM agent_tasks WHERE id=$1", [runningTask])).toEqual({ status: "CANCELLED", delivered: true })
      expect((await one("SELECT delivered_at IS NOT NULL AS delivered FROM agent_tasks WHERE id=$1", [finishedTask])).delivered).toBe(true)
      expect((await one("SELECT delivered_at IS NOT NULL AS delivered FROM agent_tasks WHERE id=$1", [lateTask])).delivered).toBe(true)
      expect((await one("SELECT lease_until FROM agent_conversations WHERE id=$1", [child])).lease_until).toBeNull()
      expect((await one("SELECT status FROM agent_work_jobs WHERE job_id=$1", [withdrawnResume])).status).toBe("CANCELLED")
      expect((await one("SELECT status FROM agent_work_jobs WHERE job_id=$1", [keptResume])).status).toBe("QUEUED")
      // The run journals stay; the rollback is recorded.
      expect((await one("SELECT count(*)::int AS n FROM agent_runs WHERE conversation_id=$1", [conversationId])).n).toBe(2)
      expect(await one("SELECT from_index, removed_messages, run_ids FROM agent_conversation_rollbacks WHERE conversation_id=$1", [conversationId]))
        .toEqual({ from_index: 2, removed_messages: 4, run_ids: [r2] })

      // A retried click replays the same result and removes nothing more.
      const again = await send(h, path, f.session, { from: 2, revision: rev, requestId })
      expect(again.status).toBe(200)
      expect(again.json.rollback).toEqual(rb)
      expect(again.json.conversation.messages).toHaveLength(2)
      expect((await one("SELECT count(*)::int AS n FROM agent_conversation_rollbacks WHERE conversation_id=$1", [conversationId])).n).toBe(1)
      // The revision moved: the next send or rollback uses it.
      expect(done.json.conversation.revision).toBe(rev + 2)
    } finally { await h.dispose() }
  })
})
