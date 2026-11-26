/** Matches the desktop decision card's post-approval instruction. */
export const approvedInitiativeMessage = (title: string, proposedChange: string) => {
  let text = `I approved "${title.trim()}". Do it now.`
  const change = proposedChange.trim()
  if (change) text += ` The change: ${change}`
  return `${text} Make the finished work in this turn with create_artifact: the actual page, copy or file, not a plan. If our site is connected, prepare the exact change for my approval. If it isn't, end with a handoff I can apply myself: where it goes and the exact text. Then say what to measure, and when to check it.`
}

export const declinedInitiativeMessage = (title: string, reason: string | null) => {
  const lead = reason?.trim()
    ? `The owner declined the idea "${title.trim()}". Their reason: ${reason.trim()}.`
    : `The owner declined the idea "${title.trim()}".`
  return `${lead} Read read_decision_feedback for this business. Propose one revised idea with propose_growth_opportunity that addresses their reason, or ask a single clarifying question if you cannot.`
}