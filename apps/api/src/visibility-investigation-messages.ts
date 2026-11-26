/** Read-only reassessment after an automatic visibility drop opened an investigation. */
export const visibilityInvestigationMessage = (investigationId: string, context: string) =>
  `OpenRecord visibility alert: investigation ${investigationId} was opened because ${context}. ` +
  "Read read_investigation and the relevant stored measurements for this business. " +
  "Summarize what the evidence shows, what is still unknown, and the single best next check. " +
  "This is an authorized read-only background turn: no proposals, publishing, spending, delegation or live fetches."