import { describe, expect, it } from "vitest"
import type { GrowthOpportunity, GrowthSeries } from "@openrecord/contracts"
import { buildActions, goalTotals } from "../app/components/today-overview"
import type { IssueWithEvidence, RepresentationRow, SearchOverview } from "../app/lib/api"

const biz = "00000000-0000-4000-8000-000000000001"

const rep = (id: string, state: string, extracted: string | null, reason = "TEST"): RepresentationRow => ({
  binding_id: id,
  fact: { id: `f-${id}`, subject: "TEST", predicate: "phone_support", valueText: "false", valueType: "boolean", status: "ACTIVE", version: 1 },
  source: { target_id: "t", url: "https://test.example/pricing", control: "OWNED" },
  finding: { state, reason },
  effective_observation: extracted === null ? null : { observation_id: "o", completed_at: "2026-10-14T12:00:00.000Z", collection_state: "OK", extracted_value: extracted, extraction_state: "OK" },
  latest_attempt: null,
  latest_successful_check: null,
})

const issue = (claim: string, state: IssueWithEvidence["state"]): IssueWithEvidence =>
  ({
    claim_id: `c-${claim}`,
    claim_text: claim,
    observation_id: `o-${claim}`,
    answer_text: "TEST",
    provider: "mock",
    observed_model: "mock-v1",
    collected_at: "2026-10-16T17:00:00.000Z",
    question_prompt: "TEST question?",
    judgment_id: null,
    verdict: null,
    notes: null,
    facts: [],
    state,
    citation_evidence: [],
  }) as unknown as IssueWithEvidence

const search = (overrides: Partial<SearchOverview>): SearchOverview => ({
  sites: [],
  website: "https://test.example/",
  lastInspection: "2026-10-18T16:00:00.000Z",
  urlsInspected: 1,
  openFindings: 0,
  awaitingApproval: 0,
  fixesApplied: 0,
  verificationPending: 0,
  verifiedFixes: 0,
  needsAttention: [],
  ...overrides,
})

describe("Do next ranking", () => {
  it("puts drifted sources before wrong AI claims, and unreadable sources after them", () => {
    const actions = buildActions(biz, {
      representations: [rep("unknown", "UNKNOWN", null, "selector found no value"), rep("drift", "DRIFT", "true"), rep("ok", "IN_SYNC", "false")],
      issues: [issue("TEST costs $29", "WRONG")],
      search: null,
      opportunities: [],
    })
    expect(actions.map((a) => a.key)).toEqual(["rep:drift", "claim:test costs $29", "rep:unknown"])
    expect(actions[0]).toMatchObject({ title: "Phone support is out of date on test.example", cta: "Review", to: `/businesses/${biz}/representations/drift` })
    expect(actions[0]?.detail).toContain("“true”")
  })

  it("never lists sources that match the approved fact", () => {
    const actions = buildActions(biz, { representations: [rep("ok", "IN_SYNC", "false")], issues: [], search: null, opportunities: [] })
    expect(actions).toEqual([])
  })

  it("adds website fixes awaiting approval and initiatives waiting for a decision", () => {
    const opportunity = { id: "opp", title: "TEST initiative", status: "PROPOSED", progress: "NOT_STARTED" } as GrowthOpportunity
    const actions = buildActions(biz, { representations: [rep("ok", "IN_SYNC", "false")], issues: [], search: search({ awaitingApproval: 2 }), opportunities: [opportunity] })
    expect(actions.map((a) => a.title)).toEqual(["2 website fixes are ready for your approval", "Approve the initiative “TEST initiative”"])
  })
})

const series = (days: Array<[string, number | null, "OK" | "MISSING"]>, provider?: "GA4_DATA_API"): GrowthSeries => ({
  businessId: biz,
  metricDefinitionId: "m",
  metricLabel: "Signups",
  definitionVersion: 1,
  sourceKind: "OPERATOR_AGGREGATE_EXPORT",
  countingSemantics: "EVENT_COUNT",
  unit: "COUNT",
  timeZone: "UTC",
  start: days[0]![0],
  end: days[days.length - 1]![0],
  days: days.map(([day, value, status]) => ({ day, value, status, origin: status === "OK" ? "REAL" : null, ...(provider ? { provider } : {}) })),
  conflicts: [],
})

describe("goal totals", () => {
  it("compares the latest period with the one before it and skips missing days", () => {
    const t = goalTotals(
      series([
        ["2026-10-01", 2, "OK"],
        ["2026-10-02", 3, "OK"],
        ["2026-10-03", null, "MISSING"],
        ["2026-10-04", 7, "OK"],
      ]),
      2,
    )
    expect(t).toMatchObject({ current: 7, previous: 5, reported: 1, any: true, fromGa4: false })
  })

  it("names Google Analytics when the provider supplied the days", () => {
    expect(goalTotals(series([["2026-10-01", 1, "OK"]], "GA4_DATA_API"), 7)?.fromGa4).toBe(true)
    expect(goalTotals(null, 7)).toBeNull()
  })
})

describe("setup steps", () => {
  it("walks a new business through the loop instead of reporting all caught up", () => {
    const actions = buildActions(
      biz,
      { representations: [], issues: [], search: search({ lastInspection: null }), opportunities: [] },
      { activeFacts: 0, checks: 0, hasGoal: false, goalLoading: false },
    )
    expect(actions.map((a) => a.key)).toEqual(["setup:facts", "setup:check", "setup:sources", "setup:website", "setup:goal"])
    expect(actions.every((a) => a.setup)).toBe(true)
  })

  it("drops a step once that part is set up, and ranks real problems first", () => {
    const actions = buildActions(
      biz,
      { representations: [rep("drift", "DRIFT", "true")], issues: [], search: search({}), opportunities: [] },
      { activeFacts: 3, checks: 4, hasGoal: false, goalLoading: false },
    )
    expect(actions.map((a) => a.key)).toEqual(["rep:drift", "setup:goal"])
  })
})
