import { describe, expect, it } from "vitest"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import type { GrowthExecution, GrowthOpportunity, GrowthReportSummary } from "@openrecord/contracts"
import { GrowthStageStrip } from "../app/components/growth-pipeline"
import { clientGrowthLine, clientGrowthSummary, growthStages } from "../app/lib/growth-stage"
import { OpportunityCard } from "../app/routes/client-growth"

const id = "00000000-0000-4000-8000-000000000001"
const userId = id

const base = (overrides: Partial<GrowthOpportunity>): GrowthOpportunity => ({
  id: "00000000-0000-4000-8000-000000000030", businessId: id, goalId: "00000000-0000-4000-8000-000000000010", title: "TEST",
  problemStatement: "TEST", audience: "TEST", buyerIntent: "TEST", targetUrl: null, source: "TEST", proposedChange: "TEST",
  expectedMechanism: "TEST", assumptions: "TEST", uncertainty: "TEST", baselineAvailability: "UNKNOWN",
  ownerUserId: userId, createdByUserId: userId, createdByActor: "OPERATOR", createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z", updatedByUserId: userId, status: "PROPOSED", revision: 1, progress: "NOT_STARTED",
  executionCount: 0, executions: [], evidence: [], events: [], ...overrides,
})

const attested = (n: string): GrowthExecution => ({
  id: n, opportunityId: "00000000-0000-4000-8000-000000000030", businessId: id,
  type: "SOURCE_PUBLISHED", channel: "WEBSITE", target: "TEST page", description: null,
  performedAt: "2026-10-19T09:30:00.000Z", recordedAt: "2026-10-19T09:35:00.000Z",
  assurance: "OPERATOR_ATTESTED", actor: "HUMAN", actorId: userId, verification: null,
})
const verified = (n: string): GrowthExecution => ({
  ...attested(n), type: "SOURCE_UPDATED", assurance: "SYSTEM_VERIFIED", actor: "SYSTEM", actorId: null,
  verification: { kind: "GROWTH_DELIVERY", id: "00000000-0000-4000-8000-000000000042", claim: "PR_MERGED" },
})

const report = (version: number, status: "COMPARABLE" | "INDETERMINATE", superseded = false, shareActive = false): GrowthReportSummary => ({
  id: `00000000-0000-4000-8000-0000000001${String(version).padStart(2, "0")}`, opportunityId: "00000000-0000-4000-8000-000000000030",
  version, status, publishedAt: "2026-10-20T00:00:00.000Z", publishedByUserId: userId, supersedesId: null,
  snapshotDigest: "d".repeat(64), evidenceDigest: "e".repeat(64), superseded,
  share: shareActive ? { id: "00000000-0000-4000-8000-0000000000f0", publicId: "p".repeat(43), status: "ACTIVE", createdAt: "2026-10-20T00:00:00.000Z", revokedAt: null } : null,
})

const planInput = (timing: "PRE_DECLARED" | "DECLARED_AFTER_EXECUTION") => ({
  status: "APPROVED", hasGoal: true, plan: { plan: { declaredAt: "2026-10-02T00:00:00.000Z", baselineStart: "2026-09-01", baselineEnd: "2026-09-14", observationStart: "2026-09-15", observationEnd: "2026-09-28", metricDefinition: { id: "m", version: 1, label: "Signups", timeZone: "UTC" } }, timing }, opportunity: base({ status: "APPROVED" }), imports: 2, reports: undefined,
} as const)

describe("growth stage model", () => {
  it("shows an unapproved initiative as goal plus pending human decision, never as delivery stages", () => {
    const proposed = growthStages({ status: "PROPOSED", hasGoal: true, plan: null, opportunity: base({}), imports: 0, reports: undefined })
    expect(proposed.map(s => s.label)).toEqual(["Goal", "Decision"])
    expect(proposed[1]?.detail).toBe("Waiting for a human decision")
    expect(proposed[1]?.next).toBe("Approve or reject this initiative")
    const discovered = growthStages({ status: "DISCOVERED", hasGoal: true, plan: null, opportunity: base({}), imports: 0, reports: undefined })
    expect(discovered[1]?.detail).toContain("no human has reviewed it")
  })

  it("keeps a first approved initiative honest: nothing is declared, done, measured or reported yet", () => {
    const stages = growthStages({ status: "APPROVED", hasGoal: true, plan: null, opportunity: base({ status: "APPROVED" }), imports: 0, reports: undefined })
    const byKey = Object.fromEntries(stages.map(s => [s.key, s]))
    expect(byKey["plan"]?.state).toBe("current")
    expect(byKey["plan"]?.next).toBe("Declare the before and after periods")
    expect(byKey["execute"]?.next).toBe("Record what was actually done")
    expect(byKey["measure"]?.next).toContain("Import daily figures")
    expect(byKey["report"]?.caveat).toContain("record the work first")
    expect(byKey["report"]?.next).toBeUndefined()
  })

  it("marks a pre-declared plan and an attested execution done, and asks for evaluation, never claiming one ran", () => {
    const withWork = { ...planInput("PRE_DECLARED"), opportunity: base({ status: "APPROVED" as const, executionCount: 1, executions: [attested("00000000-0000-4000-8000-000000000040")], progress: "EXECUTED" as const }) }
    const stages = growthStages(withWork)
    const byKey = Object.fromEntries(stages.map(s => [s.key, s]))
    expect(byKey["plan"]?.state).toBe("done")
    expect(byKey["plan"]?.detail).toContain("Declared before the work")
    expect(byKey["execute"]?.state).toBe("done")
    expect(byKey["execute"]?.detail).toContain("1 recorded action")
    expect(byKey["execute"]?.detail).toContain("Operator-attested — not independently verified")
    expect(byKey["measure"]?.state).toBe("current")
    expect(byKey["measure"]?.next).toBe("Run the outcome evaluation")
    expect(byKey["report"]?.state).toBe("current")
    expect(byKey["report"]?.next).toBe("Preview the client report")
  })

  it("describes a verified merge as a merge, not publication", () => {
    const stages = growthStages({ ...planInput("PRE_DECLARED"), opportunity: base({ status: "APPROVED", executionCount: 1, executions: [verified("00000000-0000-4000-8000-000000000041")] }) })
    expect(stages.find(s => s.key === "execute")?.detail).toContain("System-verified merge confirmed — not live publication")
    const mixed = growthStages({ ...planInput("PRE_DECLARED"), opportunity: base({ status: "APPROVED", executionCount: 2, executions: [verified("00000000-0000-4000-8000-000000000041"), attested("00000000-0000-4000-8000-000000000040")] }) })
    expect(mixed.find(s => s.key === "execute")?.detail).toContain("1 system-verified · 1 operator-attested")
  })

  it("keeps a post-hoc plan visible as degraded", () => {
    const stages = growthStages(planInput("DECLARED_AFTER_EXECUTION"))
    const plan = stages.find(s => s.key === "plan")
    expect(plan?.state).toBe("attention")
    expect(plan?.caveat).toContain("not treat the periods as agreed in advance")
  })

  it("takes measure and report state only from a published report's status", () => {
    const comparable = growthStages({ ...planInput("PRE_DECLARED"), reports: [report(2, "COMPARABLE", false, true), report(1, "INDETERMINATE", true)] })
    expect(comparable.find(s => s.key === "measure")?.state).toBe("done")
    expect(comparable.find(s => s.key === "measure")?.detail).toContain("data quality, not success")
    expect(comparable.find(s => s.key === "report")?.detail).toBe("Version 2 published · immutable · share link active")
    const indeterminate = growthStages({ ...planInput("PRE_DECLARED"), reports: [report(1, "INDETERMINATE")] })
    expect(indeterminate.find(s => s.key === "measure")?.state).toBe("attention")
    expect(indeterminate.find(s => s.key === "measure")?.detail).toContain("indeterminate")
  })

  it("treats REVIEWED as approved and a cancelled initiative as closed", () => {
    const reviewed = growthStages({ ...planInput("PRE_DECLARED"), status: "REVIEWED", opportunity: base({ status: "REVIEWED", executionCount: 1, executions: [attested("00000000-0000-4000-8000-000000000040")] }) })
    expect(reviewed.map(s => s.label)).toEqual(["Goal", "Plan", "Execute", "Measure", "Report"])
    const cancelled = growthStages({ ...planInput("PRE_DECLARED"), status: "CANCELLED", opportunity: base({ status: "CANCELLED" }) })
    expect(cancelled.map(s => s.label)).toEqual(["Goal", "Decision"])
    expect(cancelled[1]?.state).toBe("attention")
  })
})

describe("client growth summary line", () => {
  it("claims nothing when nothing is known", () => {
    expect(clientGrowthLine(null)).toBe("")
    expect(clientGrowthLine(clientGrowthSummary([], null, null))).toBe("No marketing goal yet")
  })

  it("states the goal and counts approved work and verified executions", () => {
    const s = clientGrowthSummary(
      [base({ status: "APPROVED", executionCount: 1, executions: [verified("00000000-0000-4000-8000-000000000041")] }), base({ status: "PROPOSED" })],
      "Increase trial signups", "Trial signups",
    )
    expect(s).toMatchObject({ hasGoal: true, total: 2, approved: 1, verified: 1 })
    expect(clientGrowthLine(s)).toBe("Increase trial signups · 2 initiatives · 1 of 2 approved · 1 verified execution")
  })

  it("says awaiting review when nothing is approved yet", () => {
    const s = clientGrowthSummary([base({ status: "PROPOSED" })], "Increase trial signups", "Trial signups")
    expect(clientGrowthLine(s)).toBe("Increase trial signups · 1 initiative · 1 awaiting review")
  })
})

describe("growth pipeline rendering", () => {
  it("renders the visible stage workflow on an approved initiative and the decision flow on a proposed one", () => {
    const approved = renderToStaticMarkup(createElement(OpportunityCard, {
      businessId: id, opportunity: base({ status: "APPROVED", revision: 2, events: [
        { id: "00000000-0000-4000-8000-000000000061", status: "PROPOSED", revision: 1, actor: "OPERATOR", userId, reason: "TEST", conclusion: null, createdAt: "2026-10-01T00:00:00.000Z" },
        { id: "00000000-0000-4000-8000-000000000062", status: "APPROVED", revision: 2, actor: "OPERATOR", userId, reason: "TEST", conclusion: null, createdAt: "2026-10-02T00:00:00.000Z" },
      ] }), goal: undefined, userId, reload: async () => {},
    }))
    expect(approved).toContain("Initiative stages")
    for (const label of ["Goal", "Plan", "Execute", "Measure", "Report"]) expect(approved).toContain(`>${label}<`)
    expect(approved).toContain("Record execution")
    expect(approved).toContain("All details, evidence and history")
    expect(approved.indexOf("Measurement plan")).toBeLessThan(approved.indexOf("Outcome evaluation"))

    const proposed = renderToStaticMarkup(createElement(OpportunityCard, { businessId: id, opportunity: base({}), goal: undefined, userId, reload: async () => {} }))
    expect(proposed).toContain("Waiting for a human decision")
    expect(proposed).not.toContain("Record execution")
    expect(proposed).not.toContain("Measurement plan")
  })

  it("renders the strip with screen-reader state words", () => {
    const html = renderToStaticMarkup(createElement(GrowthStageStrip, { stages: [
      { key: "goal", label: "Goal", state: "done", detail: "Goal and metric defined for this client" },
      { key: "decision", label: "Decision", state: "current", detail: "Waiting for a human decision", next: "Approve or reject this initiative" },
    ] }))
    expect(html).toContain("Initiative stages")
    expect(html).toContain("sr-only")
  })
})
