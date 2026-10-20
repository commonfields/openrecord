import { describe, expect, it } from "vitest"
import { createElement } from "react"
import { matchRoutes } from "react-router"
import { renderToStaticMarkup } from "react-dom/server"
import type { GrowthOpportunity } from "@openrecord/contracts"
import { GrowthReportView } from "../app/components/growth-report-view"
import { publicGrowthReportPath, REPORT_CAVEAT_COPY, REPORT_REASON_COPY } from "../app/lib/growth-report"
import { OpportunityCard } from "../app/routes/client-growth"
import { serviceReport, softwareReport } from "./growth-report-fixtures"

const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
const prose = (html: string) => html.split('aria-label="Evidence and provenance"')[0]!
const evidenceOf = (html: string) => html.split('aria-label="Evidence and provenance"')[1]!

describe("client growth report page", () => {
  it("software (TEST fixture): plain-language comparable report with a human KEEP decision", () => {
    const html = renderToStaticMarkup(createElement(GrowthReportView, { report: softwareReport }))
    const body = prose(html)
    expect(body).toContain("TEST Fixture SaaS")
    expect(body).toContain("Reporting period: 1 Sept 2026 – 15 Sept 2026")
    expect(body).toContain("Increase trial signups")
    expect(body).toContain("Approved by a person")
    expect(body).toContain("Recorded by the team, not independently verified")
    expect(body).toContain("Data quality: the before and after figures can be compared.")
    expect(body).toContain("agreed before the work was done")
    expect(body).toContain("went from 4 before to 6 after (+2 per day, +50%)")
    expect(body).toContain("It does not show that the work caused the change.")
    expect(body).toContain("Keep the change")
    expect(body).toContain("TEST Re-check signups in October")
    expect(body).toContain(REPORT_CAVEAT_COPY.OPERATOR_ATTESTED_ONLY)
    // No identifiers, codes or causal claims outside the evidence section.
    expect(body).not.toMatch(uuid)
    for (const code of ["COMPARABLE", "OPERATOR_ATTESTED", "EVENT_COUNT", "PRE_DECLARED", "SQL"]) expect(body).not.toContain(code)
    for (const claim of ["proves", "generated revenue", "attributed to", "successful", "worked", "thanks to", "lift"]) expect(body.toLowerCase()).not.toContain(claim)
    // Provenance stays available in the evidence section.
    const evidence = evidenceOf(html)
    expect(evidence).toContain("00000000-0000-4000-8000-000000000070")
    expect(evidence).toContain("d".repeat(64))
    expect(evidence).toContain("c".repeat(64))
  })

  it("service (TEST fixture): indeterminate, superseded, multiple and unrelated actions, no invented decision", () => {
    const html = renderToStaticMarkup(createElement(GrowthReportView, { report: serviceReport }))
    const body = prose(html)
    expect(body).toContain("A newer version of this report has been published")
    expect(body).toContain("Data quality: the before and after figures cannot be reliably compared.")
    expect(body).toContain(REPORT_REASON_COPY.MISSING_DAYS)
    expect(body).toContain("No before and after comparison is given in this report.")
    expect(body).toContain("6 of 7")
    expect(body).toContain("Other marketing activity in the same period")
    expect(body).toContain("part of “TEST Weekend promotion”")
    expect(body).toContain(REPORT_CAVEAT_COPY.OTHER_ACTIONS_IN_PERIOD)
    expect(body).toContain("No decision has been recorded yet.")
    expect(body).not.toContain("went from")
    expect(body).not.toMatch(uuid)
    expect(evidenceOf(html)).toContain("After, missing: 2026-09-11")
  })

  it("routes the capability link outside the workspace and offers reports only on approved initiatives", () => {
    const id = "A".repeat(43)
    expect(matchRoutes([{ path: "/reports/:publicId" }], publicGrowthReportPath(id))?.[0]?.params["publicId"]).toBe(id)
    const userId = "00000000-0000-4000-8000-000000000002"
    const base = { id: "00000000-0000-4000-8000-000000000030", businessId: "00000000-0000-4000-8000-000000000001", goalId: "00000000-0000-4000-8000-000000000010", title: "TEST",
      problemStatement: "TEST", audience: "TEST", buyerIntent: "TEST", targetUrl: null, source: "TEST", proposedChange: "TEST", expectedMechanism: "TEST", assumptions: "TEST", uncertainty: "TEST",
      baselineAvailability: "UNKNOWN", ownerUserId: userId, createdByUserId: userId, createdByActor: "OPERATOR", createdAt: "2026-08-20T00:00:00.000Z", updatedAt: "2026-08-21T00:00:00.000Z",
      updatedByUserId: userId, status: "PROPOSED", revision: 1, progress: "NOT_STARTED", executionCount: 0, executions: [], evidence: [], events: [] } satisfies GrowthOpportunity
    const event = (status: "PROPOSED" | "APPROVED", revision: number) => ({ id: `00000000-0000-4000-8000-00000000004${revision}`, status, revision, actor: "OPERATOR" as const, userId, reason: "TEST", conclusion: null, createdAt: "2026-08-21T00:00:00.000Z" })
    const render = (o: GrowthOpportunity) => renderToStaticMarkup(createElement(OpportunityCard, { businessId: base.businessId, opportunity: o, goal: undefined, userId, reload: async () => {} }))
    expect(render({ ...base, events: [event("PROPOSED", 1)] })).not.toContain("Client report")
    expect(render({ ...base, status: "APPROVED", revision: 2, events: [event("PROPOSED", 1), event("APPROVED", 2)] })).toContain("Client report")
  })
})
