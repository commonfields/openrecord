import type { DecisionItem } from "@/lib/api"

/** What a waiting decision is, in the words the inbox and the overview share. */
export function decisionLabel(item: DecisionItem): { kind: string; title: string; summary: string } {
  switch (item.type) {
    case "GROWTH_OPPORTUNITY":
      return { kind: "Proposed work", title: item.opportunity.title, summary: item.opportunity.problemStatement }
    case "WORDPRESS_CHANGE":
      return { kind: "Website change", title: `Website change: ${item.change.targetTitle}`, summary: item.change.rationale }
    case "ACCOUNT_ACTION":
      return { kind: "Account change", title: item.action.kind.replaceAll("_", " "), summary: item.action.rationale }
    case "AGENT_PROPOSAL":
      return { kind: "Agent proposal", title: item.proposal.message, summary: "Agent proposal" }
  }
}
