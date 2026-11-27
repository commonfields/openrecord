// Undo a chat from one of the person's messages, the way a coding agent
// reverts a thread to before a turn. The turns from that message on leave the
// chat, and what they saved that nobody has decided yet goes with them:
//
//   cards    pending page changes, publications, reviews, strategies, account
//            actions, drafts and initiatives are withdrawn (REJECTED or
//            CANCELLED). Decided cards are kept and listed: approved or
//            published work is never undone here; the card's own undo does that.
//   artifacts  versions those turns saved are reverted: an artifact they created
//            is archived, one they edited gets the earlier content back as a new
//            version. One edited since by anyone else, or on a prepared or live
//            campaign page, is kept and listed.
//   helpers  tasks those turns started are stopped, and their results are not
//            posted back into the chat.
//   queue    a queued resume for a withdrawn card is cancelled.
//
// Research observations, notes and memory those turns saved stay: they are
// evidence or the business's record, not the turn's draft work. Run journals
// stay too, so the record of what happened is never rewritten.
//
// Withdrawing is not a verdict on the work, so nothing is written to decision
// feedback, and no chat is resumed: the cards leave the chat in the same
// transaction, so decision resume can no longer find a chat for them.
//
//   POST /api/businesses/:id/agent/conversations/:conversation/rollback
//        { from, revision, requestId }  ->  { conversation, rollback }
import { createHash } from "node:crypto"
import { SqlClient } from "@effect/sql"
import { HttpRouter } from "@effect/platform"
import { Effect, Schema } from "effect"
import { BusinessRepository, GrowthRepository, AgentProposalRepository, type Session } from "@openrecord/db"
import { AgentConversationRefused, deliverTaskResults, loadConversation } from "./agent-conversations.js"
import { settleRuns } from "./agent-run.js"
import { cancelTaskTree } from "./agent-sessions.js"
import { decode, json, operatorSessionFor, readJson, type WithSession } from "./record-routes.js"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const digest = (s: string) => createHash("sha256").update(s).digest("hex")

export type CardType = "CAMPAIGN_PUBLICATION" | "CAMPAIGN_REVIEW" | "MARKETING_STRATEGY" | "AGENT_PROPOSAL" | "GROWTH_OPPORTUNITY" | "WORDPRESS_CHANGE" | "WEBFLOW_CHANGE" | "ACCOUNT_ACTION"
const CARD_TYPES = new Set<string>(["CAMPAIGN_PUBLICATION", "CAMPAIGN_REVIEW", "MARKETING_STRATEGY", "AGENT_PROPOSAL", "GROWTH_OPPORTUNITY", "WORDPRESS_CHANGE", "WEBFLOW_CHANGE", "ACCOUNT_ACTION"])
type Card = { readonly type: CardType; readonly id: string }

export type RollbackResult = {
  readonly fromIndex: number
  readonly removedMessages: number
  /** Cards withdrawn because nobody had decided them. */
  readonly withdrawn: ReadonlyArray<Card>
  /** Cards left as they are, with why: already decided, or not found. */
  readonly keptCards: ReadonlyArray<Card & { readonly status: string }>
  readonly restoredArtifacts: ReadonlyArray<{ readonly id: string; readonly title: string; readonly version: number; readonly restoredFrom: number }>
  readonly archivedArtifacts: ReadonlyArray<{ readonly id: string; readonly title: string }>
  readonly keptArtifacts: ReadonlyArray<{ readonly id: string; readonly title: string; readonly reason: "EDITED_SINCE" | "ON_CAMPAIGN_PAGE" }>
  readonly stoppedTasks: number
}

type Scope = { readonly accountId: string; readonly userId: string; readonly businessId: string }
type RawMessage = { readonly role?: unknown; readonly origin?: unknown; readonly run?: { readonly id?: unknown }; readonly decisions?: unknown }

const cardsOf = (messages: ReadonlyArray<RawMessage>): Card[] => {
  const seen = new Map<string, Card>()
  for (const m of messages) for (const d of Array.isArray(m.decisions) ? m.decisions as Array<{ type?: unknown; id?: unknown }> : []) {
    if (typeof d?.type === "string" && CARD_TYPES.has(d.type) && typeof d.id === "string" && UUID.test(d.id)) seen.set(`${d.type}:${d.id}`, { type: d.type as CardType, id: d.id })
  }
  return [...seen.values()]
}

/** A deterministic UUID for one rollback's decision on one item, so a replayed transition is the same request. */
const keyFor = (requestId: string, itemId: string) => {
  const h = digest(`${requestId}:${itemId}`)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`
}

/** Withdraws one pending card. Returns the status it was left in when it was not pending. */
const withdraw = (scope: Scope, card: Card, requestId: string) => Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const { accountId, businessId, userId } = scope
  const done = (rows: ReadonlyArray<unknown>) => rows.length > 0
  const statusOf = (rows: ReadonlyArray<Record<string, unknown>>) => rows[0] ? String(rows[0]["status"]) : "NOT_FOUND"
  switch (card.type) {
    case "WORDPRESS_CHANGE": {
      if (done(yield* sql`UPDATE wordpress_changes SET status='REJECTED', decided_by_user_id=${userId}, decided_at=now()
        WHERE id=${card.id} AND account_id=${accountId} AND business_id=${businessId} AND status='PROPOSED' RETURNING id`)) return null
      return statusOf(yield* sql`SELECT status FROM wordpress_changes WHERE id=${card.id} AND account_id=${accountId} AND business_id=${businessId}`)
    }
    case "WEBFLOW_CHANGE": {
      if (done(yield* sql`UPDATE webflow_changes SET status='REJECTED', decided_by_user_id=${userId}, decided_at=now()
        WHERE id=${card.id} AND account_id=${accountId} AND business_id=${businessId} AND status='PROPOSED' RETURNING id`)) return null
      return statusOf(yield* sql`SELECT status FROM webflow_changes WHERE id=${card.id} AND account_id=${accountId} AND business_id=${businessId}`)
    }
    case "ACCOUNT_ACTION": {
      if (done(yield* sql`UPDATE account_actions SET status='REJECTED', decided_by_user_id=${userId}, decided_at=now()
        WHERE id=${card.id} AND account_id=${accountId} AND business_id=${businessId} AND status='PROPOSED' RETURNING id`)) return null
      return statusOf(yield* sql`SELECT status FROM account_actions WHERE id=${card.id} AND account_id=${accountId} AND business_id=${businessId}`)
    }
    case "CAMPAIGN_PUBLICATION": {
      if (done(yield* sql`UPDATE campaign_publications SET status='REJECTED', decided_at=now(), decided_by_user_id=${userId}
        WHERE id=${card.id} AND business_id=${businessId} AND status='PREPARED' RETURNING id`)) return null
      return statusOf(yield* sql`SELECT status FROM campaign_publications WHERE id=${card.id} AND business_id=${businessId}`)
    }
    case "CAMPAIGN_REVIEW": {
      if (done(yield* sql`UPDATE campaign_reviews SET status='REJECTED', decided_by_user_id=${userId}, decided_at=now()
        WHERE id=${card.id} AND business_id=${businessId} AND status='PROPOSED' RETURNING id`)) return null
      return statusOf(yield* sql`SELECT status FROM campaign_reviews WHERE id=${card.id} AND business_id=${businessId}`)
    }
    case "MARKETING_STRATEGY": {
      if (done(yield* sql`UPDATE marketing_strategy_versions SET status='REJECTED', decided_by_user_id=${userId}, decided_at=now()
        WHERE id=${card.id} AND business_id=${businessId} AND status='PROPOSED' RETURNING id`)) return null
      return statusOf(yield* sql`SELECT status FROM marketing_strategy_versions WHERE id=${card.id} AND business_id=${businessId}`)
    }
    case "AGENT_PROPOSAL": {
      const rows = yield* sql`SELECT status FROM agent_proposals WHERE id=${card.id} AND business_id=${businessId}`
      if (statusOf(rows) !== "PROPOSED") return statusOf(rows)
      return yield* (yield* AgentProposalRepository).reject(accountId, businessId, card.id, userId).pipe(
        Effect.as(null), Effect.catchTag("AgentProposalRefused", () => Effect.succeed("NOT_PENDING")))
    }
    case "GROWTH_OPPORTUNITY": {
      const growth = yield* GrowthRepository
      const current = yield* growth.get(accountId, businessId, card.id).pipe(Effect.catchTag("GrowthRefused", () => Effect.succeed(null)))
      if (!current) return "NOT_FOUND"
      if (current.status !== "DISCOVERED" && current.status !== "PROPOSED") return current.status
      const session: Session = { accountId, userId }
      return yield* growth.decide(session, businessId, card.id, "CANCELLED", { expectedStatus: current.status, expectedRevision: current.revision,
        idempotencyKey: keyFor(requestId, card.id), reason: "Withdrawn: the chat turn that proposed it was undone." }).pipe(
        Effect.as(null), Effect.catchTag("GrowthRefused", () => Effect.succeed("NOT_PENDING")))
    }
  }
})

/**
 * Reverts what the removed runs saved to artifacts. Only versions the journal
 * attributes to those runs count; an artifact anyone else wrote after the
 * earliest of them is left as it is.
 */
const revertArtifacts = (scope: Scope, runIds: ReadonlyArray<string>) => Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const restored: Array<RollbackResult["restoredArtifacts"][number]> = []
  const archived: Array<RollbackResult["archivedArtifacts"][number]> = []
  const kept: Array<RollbackResult["keptArtifacts"][number]> = []
  if (!runIds.length) return { restored, archived, kept }
  const rows = yield* sql`SELECT a->>'id' AS id, (a->>'version')::int AS version FROM agent_run_events e, jsonb_array_elements(e.payload->'artifacts') a
    WHERE e.run_id IN ${sql.in(runIds)} AND e.type='TOOL_COMPLETED' AND e.payload->>'tool' IN ('create_artifact','edit_artifact')
      AND jsonb_typeof(e.payload->'artifacts')='array' AND a->>'id' ~ '^[0-9a-fA-F-]{36}$' AND a->>'version' ~ '^[0-9]+$'`
  const written = new Map<string, Set<number>>()
  for (const r of rows) {
    const id = String(r["id"]), v = Number(r["version"])
    written.set(id, (written.get(id) ?? new Set()).add(v))
  }
  for (const [id, versions] of written) {
    const locked = (yield* sql`SELECT id, title, version, archived_at FROM agent_artifacts
      WHERE id=${id} AND account_id=${scope.accountId} AND business_id=${scope.businessId} FOR UPDATE`)[0]
    if (!locked || locked["archived_at"] !== null) continue
    const title = String(locked["title"]), current = Number(locked["version"])
    const first = Math.min(...versions)
    // Every version from the earliest removed one to the current one must be the removed runs' own.
    let own = true
    for (let v = first; v <= current; v++) if (!versions.has(v)) { own = false; break }
    if (!own) { kept.push({ id, title, reason: "EDITED_SINCE" }); continue }
    const onPage = yield* sql`SELECT 1 FROM campaign_publications p JOIN campaign_artifact_bindings b ON b.id=p.binding_id
      WHERE b.artifact_id=${id} AND p.status IN ('PREPARED','PUBLISHED') LIMIT 1`
    if (onPage.length) { kept.push({ id, title, reason: "ON_CAMPAIGN_PAGE" }); continue }
    if (first === 1) {
      yield* sql`UPDATE agent_artifacts SET archived_at=now() WHERE id=${id} AND archived_at IS NULL`
      archived.push({ id, title })
      continue
    }
    const before = (yield* sql`SELECT title, content, content_digest FROM agent_artifact_versions WHERE artifact_id=${id} AND version=${first - 1}`)[0]
    if (!before) { kept.push({ id, title, reason: "EDITED_SINCE" }); continue }
    yield* sql`INSERT INTO agent_artifact_versions(artifact_id, version, title, content, content_digest, note, source, created_by_user_id)
      VALUES (${id}, ${current + 1}, ${String(before["title"])}, ${String(before["content"])}, ${String(before["content_digest"])},
        ${`Back to version ${first - 1}: the chat turn that changed it was undone.`}, 'OPERATOR', ${scope.userId})`
    yield* sql`UPDATE agent_artifacts SET version=${current + 1}, title=${String(before["title"])}, updated_at=now() WHERE id=${id}`
    restored.push({ id, title: String(before["title"]), version: current + 1, restoredFrom: first - 1 })
  }
  return { restored, archived, kept }
})

export const rollbackConversation = (scope: Scope, input: { readonly conversationId: string; readonly from: number; readonly revision: number; readonly requestId: string }) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    const result = yield* sql.withTransaction(Effect.gen(function*() {
      const select = sql`SELECT id, messages, revision, (lease_until > now()) AS busy FROM agent_conversations
        WHERE id=${input.conversationId} AND account_id=${scope.accountId} AND business_id=${scope.businessId} AND user_id=${scope.userId}
          AND expires_at > now() FOR UPDATE`
      const locked = (yield* select)[0]
      if (!locked) return yield* Effect.fail(new AgentConversationRefused({ reason: "NOT_FOUND" }))
      const replay = (yield* sql`SELECT result FROM agent_conversation_rollbacks WHERE conversation_id=${input.conversationId} AND request_id=${input.requestId}`)[0]
      if (replay) return replay["result"] as RollbackResult
      if (locked["busy"] === true) return yield* Effect.fail(new AgentConversationRefused({ reason: "BUSY" }))
      const queued = yield* sql`SELECT 1 FROM agent_request_jobs WHERE conversation_id=${input.conversationId} AND status IN ('QUEUED','RUNNING') LIMIT 1`
      if (queued.length) return yield* Effect.fail(new AgentConversationRefused({ reason: "BUSY" }))
      // A stopped run becomes its note and finished helpers post first, as on a send;
      // the person's revision from before that still counts as current.
      const seen = Number(locked["revision"])
      const settled = (yield* settleRuns(input.conversationId)) + (yield* deliverTaskResults(input.conversationId))
      const row = settled ? (yield* select)[0]! : locked
      if (input.revision !== Number(row["revision"]) && input.revision !== seen) return yield* Effect.fail(new AgentConversationRefused({ reason: "STALE" }))
      const messages = (Array.isArray(row["messages"]) ? row["messages"] : []) as RawMessage[]
      const at = messages[input.from]
      if (!at || at.role !== "user" || at.origin !== undefined) return yield* Effect.fail(new AgentConversationRefused({ reason: "NOT_FOUND" }))
      const kept = messages.slice(0, input.from), removed = messages.slice(input.from)
      const runIds = [...new Set(removed.flatMap(m => m.role === "agent" && typeof m.run?.id === "string" && UUID.test(m.run.id) ? [m.run.id] : []))]
      // A card a kept message also carries stays: an earlier turn showed it first.
      const earlier = new Set(cardsOf(kept).map(c => `${c.type}:${c.id}`))
      const cards = cardsOf(removed).filter(c => !earlier.has(`${c.type}:${c.id}`))

      const withdrawn: Card[] = [], keptCards: Array<Card & { status: string }> = []
      for (const card of cards) {
        const left = yield* withdraw(scope, card, input.requestId)
        if (left === null) withdrawn.push(card); else keptCards.push({ ...card, status: left })
      }
      // Helpers those turns started stop, and nothing they finish is posted here.
      let stoppedTasks = 0
      if (runIds.length) {
        const running = yield* sql`SELECT id FROM agent_tasks WHERE parent_conversation_id=${input.conversationId} AND parent_run_id IN ${sql.in(runIds)} AND status='RUNNING'`
        yield* cancelTaskTree(running.map(r => String(r["id"])))
        stoppedTasks = running.length
        yield* sql`UPDATE agent_tasks SET delivered_at=now() WHERE parent_conversation_id=${input.conversationId} AND parent_run_id IN ${sql.in(runIds)} AND delivered_at IS NULL`
      }
      if (withdrawn.length) yield* sql`UPDATE agent_work_jobs SET status='CANCELLED', failure_reason='CANCELLED', finished_at=now(), claim_id=NULL, lease_until=NULL
        WHERE kind='DECISION_RESUME_WRITE' AND status='QUEUED' AND payload->>'conversationId'=${input.conversationId}
          AND payload->>'itemId' IN ${sql.in(withdrawn.map(c => c.id))}`
      const artifacts = yield* revertArtifacts(scope, runIds)

      const rollback: RollbackResult = { fromIndex: input.from, removedMessages: removed.length, withdrawn, keptCards,
        restoredArtifacts: artifacts.restored, archivedArtifacts: artifacts.archived, keptArtifacts: artifacts.kept, stoppedTasks }
      yield* sql`UPDATE agent_conversations SET messages=${JSON.stringify(kept)}::jsonb, revision=revision+1, user_revision=revision+1,
          last_request_id=NULL, last_request_digest=NULL,
          last_reply=CASE WHEN last_reply ? 'title' THEN jsonb_build_object('title', last_reply->'title') ELSE NULL END,
          updated_at=now(), expires_at=now()+interval '30 days'
        WHERE id=${input.conversationId}`
      yield* sql`INSERT INTO agent_conversation_rollbacks(conversation_id, account_id, business_id, user_id, request_id, from_index, removed_messages, run_ids, result)
        VALUES (${input.conversationId}, ${scope.accountId}, ${scope.businessId}, ${scope.userId}, ${input.requestId}, ${input.from}, ${removed.length},
          ${`{${runIds.join(",")}}`}::uuid[], ${JSON.stringify(rollback)}::jsonb)`
      return rollback
    }))
    const conversation = yield* loadConversation(scope, input.conversationId)
    return { conversation, rollback: result }
  })

const Body = Schema.Struct({ from: Schema.Int.pipe(Schema.between(0, 1000)), revision: Schema.Int.pipe(Schema.greaterThanOrEqualTo(0)), requestId: Schema.UUID })

export const agentRollbackApi = (withSession: WithSession) => {
  const operator = operatorSessionFor(withSession)
  return HttpRouter.empty.pipe(
    HttpRouter.post("/api/businesses/:id/agent/conversations/:conversation/rollback", operator((s: Session) => Effect.gen(function*() {
      const { params } = yield* HttpRouter.RouteContext
      const businessId = params["id"] ?? "", conversationId = params["conversation"] ?? ""
      if (!UUID.test(businessId) || !UUID.test(conversationId)) return yield* json(422, { _tag: "InvalidRequest" })
      if (!(yield* (yield* BusinessRepository).getScoped(s.accountId, businessId))) return yield* json(404, { _tag: "BusinessNotFound" })
      const body = decode(Body, yield* readJson)
      if (!body) return yield* json(422, { _tag: "InvalidRequest" })
      const done = yield* rollbackConversation({ accountId: s.accountId, userId: s.userId, businessId }, { conversationId, ...body }).pipe(
        Effect.map(r => ({ ok: true as const, r })),
        Effect.catchTag("AgentConversationRefused", e => Effect.succeed({ ok: false as const, reason: e.reason })))
      if (!done.ok) return yield* json(done.reason === "NOT_FOUND" ? 404 : 409, { _tag: "RollbackRefused", reason: done.reason })
      return yield* json(200, done.r, { "cache-control": "no-store" })
    })).pipe(Effect.catchAll(e => json(typeof e === "object" && e !== null && "_tag" in e && e._tag === "NotAuthenticated" ? 401 : 500, { _tag: "RollbackUnavailable" })))),
  )
}
