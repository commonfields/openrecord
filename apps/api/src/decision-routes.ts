import { pendingCampaignPublications } from "./campaign-publication.js"
import { pendingCampaignReviews } from "./campaign-results.js"
import { pendingStrategies } from "./marketing-strategy.js"
// One feed of everything waiting on a person: proposals the agent saved
// (re-checks, drafts, measurement plans) and growth initiatives proposed for
// approval, across every business the session can reach. Reading it decides
// nothing; each item is decided through its own route, with the approver taken
// from the session.
import { Effect } from "effect"
import { SqlClient } from "@effect/sql"
import { HttpRouter } from "@effect/platform"
import { AgentProposalRepository, BusinessRepository, GrowthRefused, GrowthRepository, type AgentProposal } from "@openrecord/db"
import type { GrowthOpportunity } from "@openrecord/contracts"
import { json, operatorSessionFor, type WithSession } from "./record-routes.js"
import { listChanges, type WordPressChange } from "./wordpress.js"
import { listWebflowChanges, type WebflowChange } from "./webflow.js"
import { listActions, type AccountAction } from "./account-actions.js"

/** The agent message that put a decision in the inbox: who sent it, from which
 * chat, and its text with any diagrams or generated views, so the inbox can
 * show the message as the person would have read it in the chat. */
export type DecisionAgent = { readonly provider: string | null; readonly model: string | null; readonly session: string | null; readonly text: string }

export type DecisionItem =
  | { readonly type: "MARKETING_STRATEGY"; readonly business: { readonly id: string; readonly name: string }; readonly createdAt: string; readonly conversationId?: string; readonly agent?: DecisionAgent; readonly strategy: Record<string, unknown> }
  | { readonly type: "CAMPAIGN_REVIEW"; readonly business: { readonly id: string; readonly name: string }; readonly createdAt: string; readonly conversationId?: string; readonly agent?: DecisionAgent; readonly review: Record<string, unknown> }
  | { readonly type: "CAMPAIGN_PUBLICATION"; readonly business: { readonly id: string; readonly name: string }; readonly createdAt: string; readonly conversationId?: string; readonly agent?: DecisionAgent; readonly publication: Record<string, unknown> }
  | { readonly type: "AGENT_PROPOSAL"; readonly business: { readonly id: string; readonly name: string }; readonly createdAt: string; readonly conversationId?: string; readonly agent?: DecisionAgent; readonly proposal: AgentProposal }
  | { readonly type: "GROWTH_OPPORTUNITY"; readonly business: { readonly id: string; readonly name: string }; readonly createdAt: string; readonly conversationId?: string; readonly agent?: DecisionAgent; readonly opportunity: GrowthOpportunity }
  | { readonly type: "WORDPRESS_CHANGE"; readonly business: { readonly id: string; readonly name: string }; readonly createdAt: string; readonly conversationId?: string; readonly agent?: DecisionAgent; readonly change: WordPressChange }
  | { readonly type: "WEBFLOW_CHANGE"; readonly business: { readonly id: string; readonly name: string }; readonly createdAt: string; readonly conversationId?: string; readonly agent?: DecisionAgent; readonly change: WebflowChange }
  | { readonly type: "ACCOUNT_ACTION"; readonly business: { readonly id: string; readonly name: string }; readonly createdAt: string; readonly conversationId?: string; readonly agent?: DecisionAgent; readonly action: AccountAction }

export const pendingDecisions = (accountId: string, userId: string) => Effect.gen(function*() {
  const businesses = yield* (yield* BusinessRepository).list(accountId)
  const proposals = yield* AgentProposalRepository
  const growth = yield* GrowthRepository
  const perBusiness = yield* Effect.forEach(businesses, b => Effect.gen(function*() {
    const business = { id: b.id, name: b.name }
    const open = yield* proposals.listByBusiness(accountId, b.id, "PROPOSED")
    // A business without a growth profile has no initiatives yet.
    const initiatives = yield* growth.list(accountId, b.id).pipe(Effect.catchIf(e => e instanceof GrowthRefused, () => Effect.succeed([])))
    const changes = yield* listChanges(accountId, b.id, "PROPOSED")
    const webflow = yield* listWebflowChanges(accountId, b.id, "PROPOSED")
    const publications = yield* pendingCampaignPublications(accountId, b.id)
    const reviews = yield* pendingCampaignReviews(accountId, b.id)
    const strategies = yield* pendingStrategies(accountId, b.id)
    const actions = yield* listActions(accountId, b.id, "PROPOSED")
    return [
      ...strategies.map((strategy): DecisionItem => ({ type: "MARKETING_STRATEGY", business, createdAt: strategy.createdAt, strategy: strategy as unknown as Record<string, unknown> })),
      ...reviews.map((review): DecisionItem => ({ type: "CAMPAIGN_REVIEW", business, createdAt: new Date(String(review["createdAt"])).toISOString(), review })),
      ...publications.map((publication): DecisionItem => ({ type: "CAMPAIGN_PUBLICATION", business, createdAt: new Date(String(publication["createdAt"])).toISOString(), publication })),
      ...open.map((proposal): DecisionItem => ({ type: "AGENT_PROPOSAL", business, createdAt: proposal.createdAt, proposal })),
      ...initiatives.filter(o => o.status === "PROPOSED").map((opportunity): DecisionItem => ({ type: "GROWTH_OPPORTUNITY", business, createdAt: opportunity.createdAt, opportunity })),
      ...changes.map((change): DecisionItem => ({ type: "WORDPRESS_CHANGE", business, createdAt: change.createdAt, change })),
      ...webflow.map((change): DecisionItem => ({ type: "WEBFLOW_CHANGE", business, createdAt: change.createdAt, change })),
      ...actions.map((action): DecisionItem => ({ type: "ACCOUNT_ACTION", business, createdAt: action.createdAt, action })),
    ]
  }), { concurrency: 4 })
  const items = perBusiness.flat().sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  if (!items.length) return items
  // A receipt identifies the conversation that created a decision. Conversations
  // are private to a user: never return a teammate's conversation ID.
  const sql = yield* SqlClient.SqlClient
  const receipts = yield* sql`SELECT r.business_id, r.conversation_id, e.payload->'receipt' AS receipt
    FROM agent_run_events e JOIN agent_runs r ON r.id=e.run_id
    JOIN agent_conversations c ON c.id=r.conversation_id
    WHERE r.account_id=${accountId} AND r.user_id=${userId} AND c.account_id=${accountId}
      AND c.user_id=${userId} AND c.expires_at>now() AND e.type='TOOL_COMPLETED'
      AND e.payload ? 'receipt' ORDER BY e.created_at DESC`
  // The reply that names a decision in its `decisions`: the same private scope.
  const sent = yield* sql`SELECT c.id AS conversation_id, c.business_id, COALESCE(c.task_title, c.last_reply->>'title') AS title, m.value AS message
    FROM agent_conversations c CROSS JOIN LATERAL jsonb_array_elements(c.messages) m
    WHERE c.account_id=${accountId} AND c.user_id=${userId} AND c.expires_at>now()
      AND m.value->>'role'='agent' AND jsonb_typeof(m.value->'decisions')='array'
    ORDER BY c.updated_at DESC`
  const refs = (m: unknown) => {
    const list = (m as Record<string, unknown> | null)?.["decisions"]
    return Array.isArray(list) ? list as ReadonlyArray<Record<string, unknown>> : []
  }
  return items.map(item => {
    const [key, id] = item.type === "MARKETING_STRATEGY" ? ["marketingStrategyId", item.strategy["id"]]
      : item.type === "CAMPAIGN_REVIEW" ? ["campaignReviewId", item.review["id"]]
      : item.type === "CAMPAIGN_PUBLICATION" ? ["publicationId", item.publication["id"]]
      : item.type === "AGENT_PROPOSAL" ? ["proposalId", item.proposal.id]
      : item.type === "GROWTH_OPPORTUNITY" ? ["opportunityId", item.opportunity.id]
      : item.type === "ACCOUNT_ACTION" ? ["accountActionId", item.action.id]
      : item.type === "WEBFLOW_CHANGE" ? ["webflowChangeId", item.change.id] : ["wordpressChangeId", item.change.id]
    const said = sent.find(row => String(row["business_id"]) === item.business.id && refs(row["message"]).some(d => d["type"] === item.type && d["id"] === id))
    if (said) {
      const message = said["message"] as Record<string, unknown>
      const inference = (message["inference"] ?? {}) as Record<string, unknown>
      const str = (v: unknown) => typeof v === "string" && v.length ? v : null
      const agent: DecisionAgent = { provider: str(inference["provider"]), model: str(inference["requestedModel"]), session: str(said["title"]), text: String(message["text"] ?? "").slice(0, 8000) }
      return { ...item, conversationId: String(said["conversation_id"]), agent }
    }
    const match = receipts.find(row => String(row["business_id"]) === item.business.id && (row["receipt"] as Record<string, unknown> | null)?.[key] === id)
    return match ? { ...item, conversationId: String(match["conversation_id"]) } : item
  })
})

export const decisionApi = (withSession: WithSession) => {
  const operator = operatorSessionFor(withSession)
  return HttpRouter.empty.pipe(
    HttpRouter.get("/api/decisions", operator(session => Effect.gen(function*() {
      const items = yield* pendingDecisions(session.accountId, session.userId)
      return yield* json(200, { items, count: items.length }, { "cache-control": "no-store" })
    })).pipe(Effect.catchAll(e => typeof e === "object" && e !== null && "_tag" in e && e._tag === "NotAuthenticated"
      ? json(401, { _tag: "NotAuthenticated" })
      : json(500, { _tag: "DecisionsUnavailable" })))),
  )
}
