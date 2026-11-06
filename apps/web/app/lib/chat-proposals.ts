import type { AgentDecisionRef, AgentProposal } from "./api"

/** Business-wide work is not conversation history. Only explicit reply links count. */
export function conversationProposals<T extends Pick<AgentProposal, "id" | "kind" | "status">>(
  proposals: readonly T[],
  messages: readonly { role: string; decisions?: readonly AgentDecisionRef[] }[],
) {
  const ids = new Set(messages.filter(m => m.role === "agent").flatMap(m =>
    (m.decisions ?? []).filter(ref => ref.type === "AGENT_PROPOSAL").map(ref => ref.id)))
  const linked = proposals.filter(p => ids.has(p.id))
  return {
    openProposals: linked.filter(p => p.status === "PROPOSED"),
    keptDrafts: linked.filter(p => p.status === "APPROVED" &&
      (p.kind === "DRAFT_SOURCE_ACTION" || p.kind === "PREPARE_CLIENT_REPORT" || p.kind === "PROPOSE_QUESTION_SET")),
  }
}
