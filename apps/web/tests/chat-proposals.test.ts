import { describe, expect, it } from "vitest"
import { conversationProposals } from "../app/lib/chat-proposals"
import type { AgentDecisionRef } from "../app/lib/api"

const old = { id: "old", kind: "PROPOSE_QUESTION_SET", status: "APPROVED" } as const
const pending = { id: "pending", kind: "DRAFT_SOURCE_ACTION", status: "PROPOSED" } as const
const message = (...decisions: AgentDecisionRef[]) => ({ role: "agent", decisions })
describe("conversation proposal scope", () => {
  it("never fills a new or unrelated chat with business-wide drafts", () => {
    expect(conversationProposals([old, pending], [])).toEqual({ openProposals: [], keptDrafts: [] })
    expect(conversationProposals([old, pending], [{ role: "agent" }])).toEqual({ openProposals: [], keptDrafts: [] })
  })
  it("keeps only explicit agent proposal links, once each", () => {
    const ref = message({ type: "AGENT_PROPOSAL", id: pending.id })
    expect(conversationProposals([old, pending], [ref, ref])).toEqual({ openProposals: [pending], keptDrafts: [] })
    expect(conversationProposals([old], [message({ type: "AGENT_PROPOSAL", id: old.id })]).keptDrafts).toEqual([old])
  })
  it("does not treat user text or other reference kinds as proposal links", () => {
    expect(conversationProposals([old], [{ role: "user", decisions: [{ type: "AGENT_PROPOSAL", id: old.id }] }, message({ type: "ACCOUNT_ACTION", id: old.id })]).keptDrafts).toEqual([])
  })
})
