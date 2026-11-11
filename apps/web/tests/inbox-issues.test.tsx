import { renderToStaticMarkup } from "react-dom/server"
import { MemoryRouter } from "react-router"
import { describe, expect, it } from "vitest"
import { issueInboxItem } from "@/routes/approvals"
import type { IssueWithEvidence } from "@/lib/api"

const issue = (state: IssueWithEvidence["state"]): IssueWithEvidence => ({
  claim_id: "claim", observation_id: "observation", state, claim_text: "Example claim", answer_text: "Example answer", question_prompt: "Example question",
  verdict: null, notes: null, provider: "test", observed_model: null, collected_at: "2026-11-01T00:00:00Z", facts: [], citation_evidence: [],
})

describe("AI answers in the inbox", () => {
  it("shows an unreviewed answer without calling it wrong and links to its review", () => {
    const item = issueInboxItem("business", issue("NEEDS_REVIEW"))
    const markup = renderToStaticMarkup(<MemoryRouter>{item.detail}</MemoryRouter>)
    expect(item.summary).toBe("AI answer · Needs review")
    expect(markup).toContain("Example answer")
    expect(markup).toContain("No sources were linked")
    expect(markup).toContain("/observations/observation?claim=claim")
    expect(markup).not.toContain("Marked wrong")
  })

  it("links reviewed issues to their evidence", () => {
    const item = issueInboxItem("business", issue("WRONG"))
    const markup = renderToStaticMarkup(<MemoryRouter>{item.detail}</MemoryRouter>)
    expect(item.summary).toBe("AI answer · Marked wrong")
    expect(markup).toContain("/businesses/business/issues/claim")
  })
})
