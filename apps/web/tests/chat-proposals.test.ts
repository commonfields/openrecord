import { describe, expect, it } from "vitest"
import { conversationProposals } from "../app/lib/chat-proposals"
import type { AgentDecisionRef, AgentProposal } from "../app/lib/api"

const oldDraft = { id: "old-draft", kind: "PROPOSE_QUESTION_SET", status: "APPROVED" } as const
const pending = { id: "pending", kind: "DRAFT_SOURCE_ACTION", status: "PROPOSED" } as const
const message = (...decisions: AgentDecisionRef[]) => ({ role: "agent", decisions })

describe("conversation proposal scope", () => {
  it("does not dump business-wide accepted or pending work into a new chat", () => {
    expect(conversationProposals([oldDraft, pending], [])).toEqual({ openProposals: [], keptDrafts: [] })
    expect(conversationProposals([oldDraft, pending], [{ role: "user" }, { role: "agent" }])).toEqual({ openProposals: [], keptDrafts: [] })
  })
  it("keeps proposals explicitly linked to this conversation and deduplicates references", () => {
    const refs = message({ type: "AGENT_PROPOSAL", id: pending.id })
    expect(conversationProposals([oldDraft, pending], [refs, refs])).toEqual({ openProposals: [pending], keptDrafts: [] })
    expect(conversationProposals([oldDraft], [message({ type: "AGENT_PROPOSAL", id: oldDraft.id })]).keptDrafts).toEqual([oldDraft])
  })
  it("does not treat user text or other decision types as proposal links", () => {
    expect(conversationProposals([oldDraft], [
      { role: "user", decisions: [{ type: "AGENT_PROPOSAL", id: oldDraft.id }] },
      message({ type: "GROWTH_OPPORTUNITY", id: oldDraft.id }),
      message({ type: "WORDPRESS_CHANGE", id: oldDraft.id }),
    ]).keptDrafts).toEqual([])
  })
  it("does not label accepted measurement requests or rejected proposals as drafts", () => {
    const proposals: Pick<AgentProposal, "id" | "kind" | "status">[] = [
      { id: "check", kind: "REQUEST_CHECK", status: "APPROVED" },
      { id: "measurement", kind: "REQUEST_ACQUISITION_BATCH", status: "APPROVED" },
      { id: "rejected", kind: "DRAFT_SOURCE_ACTION", status: "REJECTED" },
    ]
    expect(conversationProposals(proposals, [message(...proposals.map(p => ({ type: "AGENT_PROPOSAL" as const, id: p.id })))])).toEqual({ openProposals: [], keptDrafts: [] })
  })
})
