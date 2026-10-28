// One feed of everything waiting on a person: proposals the agent saved
// (re-checks, drafts, measurement plans) and growth initiatives proposed for
// approval, across every business the session can reach. Reading it decides
// nothing; each item is decided through its own route, with the approver taken
// from the session.
import { Effect } from "effect"
import { HttpRouter } from "@effect/platform"
import { AgentProposalRepository, BusinessRepository, GrowthRefused, GrowthRepository, type AgentProposal } from "@openrecord/db"
import type { GrowthOpportunity } from "@openrecord/contracts"
import { json, operatorSessionFor, type WithSession } from "./record-routes.js"

export type DecisionItem =
  | { readonly type: "AGENT_PROPOSAL"; readonly business: { readonly id: string; readonly name: string }; readonly createdAt: string; readonly proposal: AgentProposal }
  | { readonly type: "GROWTH_OPPORTUNITY"; readonly business: { readonly id: string; readonly name: string }; readonly createdAt: string; readonly opportunity: GrowthOpportunity }

export const pendingDecisions = (accountId: string) => Effect.gen(function*() {
  const businesses = yield* (yield* BusinessRepository).list(accountId)
  const proposals = yield* AgentProposalRepository
  const growth = yield* GrowthRepository
  const perBusiness = yield* Effect.forEach(businesses, b => Effect.gen(function*() {
    const business = { id: b.id, name: b.name }
    const open = yield* proposals.listByBusiness(accountId, b.id, "PROPOSED")
    // A business without a growth profile has no initiatives yet.
    const initiatives = yield* growth.list(accountId, b.id).pipe(Effect.catchIf(e => e instanceof GrowthRefused, () => Effect.succeed([])))
    return [
      ...open.map((proposal): DecisionItem => ({ type: "AGENT_PROPOSAL", business, createdAt: proposal.createdAt, proposal })),
      ...initiatives.filter(o => o.status === "PROPOSED").map((opportunity): DecisionItem => ({ type: "GROWTH_OPPORTUNITY", business, createdAt: opportunity.createdAt, opportunity })),
    ]
  }), { concurrency: 4 })
  return perBusiness.flat().sort((a, b) => b.createdAt.localeCompare(a.createdAt))
})

export const decisionApi = (withSession: WithSession) => {
  const operator = operatorSessionFor(withSession)
  return HttpRouter.empty.pipe(
    HttpRouter.get("/api/decisions", operator(session => Effect.gen(function*() {
      const items = yield* pendingDecisions(session.accountId)
      return yield* json(200, { items, count: items.length }, { "cache-control": "no-store" })
    })).pipe(Effect.catchAll(e => typeof e === "object" && e !== null && "_tag" in e && e._tag === "NotAuthenticated"
      ? json(401, { _tag: "NotAuthenticated" })
      : json(500, { _tag: "DecisionsUnavailable" })))),
  )
}
