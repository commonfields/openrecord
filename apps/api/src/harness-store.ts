import { createHash, randomBytes, randomUUID } from "node:crypto"
import { SqlClient } from "@effect/sql"
import { Data, Effect, Schema } from "effect"
import {
  HarnessInstance,
  HarnessJob,
  HarnessJobResult,
  HarnessReport,
  type HarnessModelInput,
  type HarnessSelection
} from "@openrecord/contracts"
import type { Session } from "@openrecord/db"

export class HarnessRefused extends Data.TaggedError("HarnessRefused")<{
  readonly reason:
    | "NOT_FOUND"
    | "UNAVAILABLE"
    | "MODEL_UNAVAILABLE"
    | "PAIR_EXPIRED"
    | "UNAUTHENTICATED"
    | "CANCELLED"
    | "INVALID_REQUEST"
    | "CONTEXT_LIMIT"
}> {}
const hash = (token: string) => createHash("sha256").update(token).digest("hex")
const RowId = Schema.Struct({ id: Schema.UUID })
const BridgeIdentity = Schema.Struct({ id: Schema.UUID, account_id: Schema.UUID, user_id: Schema.UUID })
export type BridgeIdentity = typeof BridgeIdentity.Type
const fail = (reason: HarnessRefused["reason"]) => Effect.fail(new HarnessRefused({ reason }))

export const createPair = (session: Session, name: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const membership =
          yield* sql`SELECT user_id FROM account_users WHERE account_id=${session.accountId} AND user_id=${session.userId} FOR UPDATE`
        if (!membership.length) return yield* fail("INVALID_REQUEST")
        const code = randomBytes(32).toString("base64url")
        yield* sql`DELETE FROM agent_bridges WHERE account_id=${session.accountId} AND user_id=${session.userId}
    AND token_hash IS NULL AND pair_expires_at<=now()`
        const count =
          yield* sql`SELECT count(*) AS count FROM agent_bridges WHERE account_id=${session.accountId} AND user_id=${session.userId} AND revoked_at IS NULL`
        if (Number(count[0]?.["count"] ?? 0) >= 16) return yield* fail("INVALID_REQUEST")
        const rows = yield* sql`INSERT INTO agent_bridges(account_id,user_id,name,pair_hash)
    VALUES(${session.accountId},${session.userId},${name},${hash(code)}) RETURNING id, pair_expires_at`
        const row = rows[0]
        if (!row) return yield* fail("INVALID_REQUEST")
        return { code, expiresAt: new Date(String(row["pair_expires_at"])).toISOString() }
      })
    )
  })

export const registerBridge = (code: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const token = randomBytes(32).toString("base64url")
    const rows = yield* sql`UPDATE agent_bridges SET token_hash=${hash(token)},pair_hash=NULL,last_seen_at=now()
    WHERE pair_hash=${hash(code)} AND pair_expires_at>now() AND revoked_at IS NULL AND token_hash IS NULL RETURNING id`
    if (!rows[0]) return yield* fail("PAIR_EXPIRED")
    const { id } = yield* Schema.decodeUnknown(RowId)(rows[0])
    return { bridgeId: id, token }
  })

export const authenticateBridge = (token: string) =>
  Effect.gen(function* () {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return yield* fail("UNAUTHENTICATED")
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql`SELECT b.id,b.account_id,b.user_id FROM agent_bridges b
    JOIN account_users a ON a.account_id=b.account_id AND a.user_id=b.user_id
    WHERE b.token_hash=${hash(token)} AND b.revoked_at IS NULL`
    if (!rows[0]) return yield* fail("UNAUTHENTICATED")
    return yield* Schema.decodeUnknown(BridgeIdentity)(rows[0])
  })

export const harnessCatalog = (session: Session) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const bridges = yield* sql`SELECT id,name,(last_seen_at > now()-interval '90 seconds') AS online,managed
    FROM agent_bridges WHERE account_id=${session.accountId} AND user_id=${session.userId} AND revoked_at IS NULL AND token_hash IS NOT NULL ORDER BY created_at`
    const rows = yield* sql`SELECT i.id,i.bridge_id AS "bridgeId",i.local_id AS "localId",i.driver,i.name,i.enabled,
    i.report->'installed' AS installed,i.report->'version' AS version,i.report->'auth' AS auth,i.report->'accountLabel' AS "accountLabel",coalesce(i.report->'modelsTruncated','false'::jsonb) AS "modelsTruncated",i.report->>'limitResetsAt' AS "limitResetsAt",to_jsonb(i.disabled_models) AS "disabledModels",
    CASE WHEN b.last_seen_at>now()-interval '90 seconds' THEN i.report->>'state' ELSE 'offline' END AS state,
    i.report->'models' AS models,to_char(i.checked_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "checkedAt"
    FROM agent_harness_instances i JOIN agent_bridges b ON b.id=i.bridge_id AND b.revoked_at IS NULL
    WHERE i.account_id=${session.accountId} AND i.user_id=${session.userId} ORDER BY i.name`
    return {
      bridges: yield* Schema.decodeUnknown(
        Schema.Array(Schema.Struct({ id: Schema.UUID, name: Schema.String, online: Schema.Boolean, managed: Schema.Boolean }))
      )(bridges),
      instances: yield* Schema.decodeUnknown(Schema.Array(HarnessInstance))(rows)
    }
  })

/** Turns one model of the person's provider on or off. Turning a model off
 * cancels queued or running jobs on it, as turning the provider off does. */
export const chooseHarnessModel = (session: Session, id: string, model: string, enabled: boolean) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const updated = yield* sql`UPDATE agent_harness_instances i SET disabled_models = CASE WHEN ${enabled}
            THEN array_remove(i.disabled_models, ${model}::text)
            ELSE (SELECT coalesce(array_agg(DISTINCT m), '{}') FROM unnest(array_append(i.disabled_models, ${model}::text)) m) END
          FROM agent_bridges b
          WHERE i.id=${id} AND i.account_id=${session.accountId} AND i.user_id=${session.userId} AND b.id=i.bridge_id AND b.revoked_at IS NULL
          RETURNING i.id`
        if (!updated.length) return yield* fail("NOT_FOUND")
        if (!enabled)
          yield* sql`UPDATE agent_harness_jobs SET status='CANCELLED',lease=NULL,input='{}',result=NULL,completed_at=now()
            WHERE instance_id=${id} AND model=${model} AND status IN ('QUEUED','RUNNING')`
      })
    )
  })

export const activateHarness = (session: Session, id: string, enabled: boolean) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const updated = yield* sql`UPDATE agent_harness_instances i SET enabled=${enabled},enabled_by_user=${enabled} FROM agent_bridges b
      WHERE i.id=${id} AND i.account_id=${session.accountId} AND i.user_id=${session.userId}
      AND b.id=i.bridge_id AND b.revoked_at IS NULL RETURNING i.id`
        if (!updated.length) return yield* fail("NOT_FOUND")
        if (enabled)
          yield* sql`UPDATE agent_bridges b SET refresh_requested=true FROM agent_harness_instances i
      WHERE i.id=${id} AND i.bridge_id=b.id AND b.revoked_at IS NULL`
        if (!enabled)
          yield* sql`UPDATE agent_harness_jobs SET status='CANCELLED',lease=NULL,input='{}',result=NULL,completed_at=now()
      WHERE instance_id=${id} AND status IN ('QUEUED','RUNNING')`
      })
    )
  })

export const revokeBridge = (session: Session, id: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const rows =
          yield* sql`UPDATE agent_bridges SET revoked_at=coalesce(revoked_at,now()),token_hash=NULL,pair_hash=NULL
      WHERE id=${id} AND account_id=${session.accountId} AND user_id=${session.userId} RETURNING id`
        if (!rows.length) return yield* fail("NOT_FOUND")
        yield* sql`UPDATE agent_harness_instances SET enabled=false WHERE bridge_id=${id}`
        yield* sql`UPDATE agent_harness_jobs SET status='CANCELLED',lease=NULL,input='{}',result=NULL,completed_at=now()
      WHERE bridge_id=${id} AND status IN ('QUEUED','RUNNING')`
      })
    )
  })

export const resolveHarness = (session: Session, selection: HarnessSelection) =>
  Effect.gen(function* () {
    const { instances } = yield* harnessCatalog(session)
    const instance = instances.find((i) => i.id === selection.instanceId)
    if (!instance) return yield* fail("NOT_FOUND")
    if (!instance.enabled || !instance.installed || instance.state !== "ready" || instance.auth === "unauthenticated")
      return yield* fail("UNAVAILABLE")
    if (!instance.models.some((m) => m.id === selection.model) || instance.disabledModels?.includes(selection.model)) return yield* fail("MODEL_UNAVAILABLE")
    if (selection.reasoningEffort && ((instance.driver !== "codex" && instance.driver !== "opencode" && instance.driver !== "claude") || !instance.models.find(m => m.id === selection.model)?.reasoningEfforts?.includes(selection.reasoningEffort)))
      return yield* fail("MODEL_UNAVAILABLE")
    return instance
  })

// Claim once, never replay an uncertain provider call after a bridge crash.
// The operator can submit a new turn after the failed turn has released its lease.
export const requestHarnessRefresh = (session: Session, instanceId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql`UPDATE agent_bridges b SET refresh_requested=true
      FROM agent_harness_instances i WHERE i.id=${instanceId} AND i.bridge_id=b.id
      AND b.account_id=${session.accountId} AND b.user_id=${session.userId} AND b.revoked_at IS NULL RETURNING b.id`
    if (!rows.length) return yield* fail("NOT_FOUND")
  })

export const pollHarnessJobs = (bridge: BridgeIdentity, reports: ReadonlyArray<HarnessReport>, acceptJob = true) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const refresh = yield* sql`SELECT refresh_requested FROM agent_bridges WHERE id=${bridge.id} FOR UPDATE`
        const live =
          yield* sql`UPDATE agent_bridges SET last_seen_at=now(),refresh_requested=false WHERE id=${bridge.id} AND revoked_at IS NULL RETURNING id`
        if (!live.length) return yield* fail("UNAUTHENTICATED")
        for (const report of reports) {
          yield* sql`INSERT INTO agent_harness_instances(bridge_id,account_id,user_id,local_id,driver,name,report)
        VALUES(${bridge.id},${bridge.account_id},${bridge.user_id},${report.localId},${report.driver},${report.name},${JSON.stringify(report)}::jsonb)
        ON CONFLICT(bridge_id,local_id) DO UPDATE SET name=excluded.name,report=excluded.report,checked_at=now()
        WHERE agent_harness_instances.driver=excluded.driver`
        }
        // This computer's own bridge: a provider that is installed, signed in and
        // has models turns on by itself, unless the person has chosen otherwise.
        yield* sql`UPDATE agent_harness_instances i SET enabled=true FROM agent_bridges b
      WHERE i.bridge_id=${bridge.id} AND b.id=i.bridge_id AND b.managed AND NOT i.enabled AND i.enabled_by_user IS NULL
      AND i.report->>'installed'='true' AND i.report->>'state'='ready' AND i.report->>'auth'<>'unauthenticated'
      AND jsonb_array_length(coalesce(i.report->'models','[]'::jsonb))>0`
        yield* sql`UPDATE agent_harness_jobs SET status='FAILED',result=jsonb_build_object('kind','failed','reason','TIMEOUT','lease',coalesce(lease,gen_random_uuid())),lease=NULL,input='{}',completed_at=now()
      WHERE bridge_id=${bridge.id} AND status IN ('QUEUED','RUNNING') AND deadline<=now()`
        yield* sql`DELETE FROM agent_harness_jobs WHERE bridge_id=${bridge.id} AND completed_at<now()-interval '1 day'`
        const lease = randomUUID()
        const rows = acceptJob
          ? yield* sql`UPDATE agent_harness_jobs j SET status='RUNNING',lease=${lease}
      WHERE j.id=(SELECT q.id FROM agent_harness_jobs q JOIN agent_harness_instances i ON i.id=q.instance_id
        WHERE q.bridge_id=${bridge.id} AND q.status='QUEUED' AND q.deadline>now() AND i.enabled
        ORDER BY q.created_at FOR UPDATE OF q SKIP LOCKED LIMIT 1)
      RETURNING j.id,j.lease,j.model,j.input,
        (SELECT local_id FROM agent_harness_instances WHERE id=j.instance_id) AS "localId",
        (SELECT driver FROM agent_harness_instances WHERE id=j.instance_id) AS driver`
          : []
        const active =
          yield* sql`SELECT id FROM agent_harness_jobs WHERE bridge_id=${bridge.id} AND status='RUNNING' AND deadline>now()`
        return {
          refresh: refresh[0]?.["refresh_requested"] === true,
          job: rows[0] ? yield* Schema.decodeUnknown(HarnessJob)(rows[0]) : null,
          active: active.map((r) => String(r["id"]))
        }
      })
    )
  })

/** Holds a poll until a job is claimable, the bridge must refresh, or a running
 * job is cancelled (the bridge then stops it), for at most `ms`. */
export const longPollHarnessJobs = (bridge: BridgeIdentity, reports: ReadonlyArray<HarnessReport>, acceptJob: boolean, ms = 8000) =>
  Effect.gen(function* () {
    const first = yield* pollHarnessJobs(bridge, reports, acceptJob)
    if (first.job || first.refresh || !acceptJob) return first
    const until = Date.now() + ms
    let latest = first
    while (Date.now() < until) {
      yield* Effect.sleep("200 millis")
      latest = yield* pollHarnessJobs(bridge, [], acceptJob)
      if (latest.job || latest.refresh || latest.active.length !== first.active.length || latest.active.some((id, i) => id !== first.active[i])) return latest
    }
    return latest
  })

/** Records a running job's reasoning so far. A finished, cancelled or foreign job refuses it. */
export const recordHarnessProgress = (bridge: BridgeIdentity, id: string, progress: { readonly lease: string; readonly thought: string }) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows = yield* sql`UPDATE agent_harness_jobs SET progress = ${JSON.stringify({ thought: progress.thought, at: new Date().toISOString() })}::jsonb
      WHERE id = ${id} AND bridge_id = ${bridge.id} AND lease = ${progress.lease} AND status = 'RUNNING' AND deadline > now() RETURNING id`
    if (!rows.length) return yield* fail("CANCELLED")
  })

export const completeHarnessJob = (bridge: BridgeIdentity, id: string, result: HarnessJobResult) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows =
      yield* sql`UPDATE agent_harness_jobs j SET status=${result.kind === "completed" ? "COMPLETED" : "FAILED"},
    result=${JSON.stringify(result)}::jsonb,input='{}',lease=NULL,completed_at=now()
    FROM agent_harness_instances i,agent_bridges b
    WHERE j.id=${id} AND j.bridge_id=${bridge.id} AND j.lease=${result.lease} AND j.status='RUNNING' AND j.deadline>now()
      AND i.id=j.instance_id AND i.enabled AND b.id=j.bridge_id AND b.revoked_at IS NULL RETURNING j.id`
    if (!rows.length) return yield* fail("CANCELLED")
  })

// Reasoning parts are shown to the operator, never sent back to a model: re-sending them costs tokens.
const withoutThoughts = (contents: HarnessModelInput["contents"]) => contents.map(c => ({ ...c,
  parts: c.parts.filter(p => !(typeof p === "object" && p !== null && (p as { thought?: unknown }).thought === true)) }))

/** The largest model input a bridge job may carry. Instructions and tool
 * declarations alone are about 55 KB and the run keeps the conversation under
 * 64,000 characters, so this leaves room for a full turn; the bridge reads
 * job responses up to 500 KB. */
export const HARNESS_INPUT_LIMIT = 300_000

export const invokeHarness = (
  scope: Session & { businessId: string | null },
  selection: HarnessSelection,
  input: HarnessModelInput,
  onThought?: (thought: string) => Effect.Effect<void, unknown>
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const instance = yield* resolveHarness(scope, selection)
    const jobInput = { system: input.system, tools: input.tools, contents: withoutThoughts(input.contents), ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}) }
    if (Buffer.byteLength(JSON.stringify(jobInput), "utf8") > HARNESS_INPUT_LIMIT) return yield* fail("CONTEXT_LIMIT")
    const id = randomUUID()
    yield* sql`INSERT INTO agent_harness_jobs(id,instance_id,bridge_id,account_id,user_id,business_id,model,input)
    VALUES(${id},${instance.id},${instance.bridgeId},${scope.accountId},${scope.userId},${scope.businessId},${selection.model},${JSON.stringify(jobInput)}::jsonb)`
    return yield* Effect.gen(function* () {
      // Checked every 150 ms (the job deadline still bounds the wait); the
      // instance is re-validated about once a second.
      let thought = ""
      for (let attempt = 0; attempt < 700; attempt++) {
        if (attempt % 7 === 0) yield* resolveHarness(scope, selection)
        const rows = yield* sql`SELECT status,result,progress->>'thought' AS thought FROM agent_harness_jobs WHERE id=${id}`
        const row = rows[0]
        if (!row || row["status"] === "CANCELLED") return yield* fail("CANCELLED")
        if (row["status"] === "COMPLETED" || row["status"] === "FAILED") {
          const result = yield* Schema.decodeUnknown(HarnessJobResult)(row["result"])
          return result
        }
        if (onThought && typeof row["thought"] === "string" && row["thought"] !== thought) {
          thought = row["thought"]
          yield* onThought(thought).pipe(Effect.ignore)
        }
        yield* Effect.sleep("150 millis")
      }
      return yield* fail("UNAVAILABLE")
    }).pipe(
      Effect.ensuring(
        sql`UPDATE agent_harness_jobs SET status='CANCELLED',lease=NULL,input='{}',result=NULL,completed_at=now()
    WHERE id=${id} AND status IN ('QUEUED','RUNNING')`.pipe(Effect.orDie)
      )
    )
  })

export const cancelHarnessConversation = (scope: Session & { businessId: string | null; conversationId?: string }) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const stopped = yield* sql`UPDATE agent_conversations SET lease_id=NULL,lease_until=NULL WHERE account_id=${scope.accountId} AND user_id=${scope.userId} AND business_id IS NOT DISTINCT FROM ${scope.businessId}::uuid
          AND (${scope.conversationId ?? null}::uuid IS NULL OR id=${scope.conversationId ?? null}::uuid) RETURNING id`
        // Stopping a session stops the helper sessions it started, and theirs.
        if (stopped.length) yield* sql`WITH RECURSIVE tree AS (
            SELECT id, child_conversation_id FROM agent_tasks WHERE parent_conversation_id IN ${sql.in(stopped.map(r => String(r["id"])))} AND status = 'RUNNING'
            UNION SELECT t.id, t.child_conversation_id FROM agent_tasks t JOIN tree ON t.parent_conversation_id = tree.child_conversation_id WHERE t.status = 'RUNNING'
          ), released AS (UPDATE agent_conversations SET lease_id = NULL, lease_until = NULL WHERE id IN (SELECT child_conversation_id FROM tree) RETURNING id)
          UPDATE agent_tasks SET status = 'CANCELLED', failure_reason = 'CANCELLED', finished_at = now() WHERE id IN (SELECT id FROM tree) AND status = 'RUNNING'`
        // A targeted turn's cancellation watcher cancels its own provider job.
        // Do not cancel another saved conversation's job in the same business.
        if (!scope.conversationId) yield* sql`UPDATE agent_harness_jobs SET status='CANCELLED',lease=NULL,input='{}',result=NULL,completed_at=now()
      WHERE account_id=${scope.accountId} AND user_id=${scope.userId} AND business_id IS NOT DISTINCT FROM ${scope.businessId}::uuid AND status IN ('QUEUED','RUNNING')`
      })
    )
  })
