import { describe, expect, it } from "vitest"
import { Schema } from "effect"
import { CampaignBrief, CampaignDistribution, marketingCampaignWork, type Campaign } from "@openrecord/contracts"
import { commandTools } from "./agent-execution-policy.js"
import { MARKETING_OPERATING_POLICY } from "./marketing-operating-policy.js"

const plan = (): CampaignDistribution => ({ primaryChannel: "Email to existing trial users", rationale: "Reach people who already asked for help",
  motion: "OWNED", funnelStage: "ACTIVATION", destination: "Consenting trial users", cadence: "One welcome and one follow-up",
  budget: "Suggested: no paid spend", trackingPlan: "Tagged links and CRM booking event; verification still needed", conversionEvent: "Qualified onboarding booking" })
const campaign = (): Campaign => ({ id: "11111111-1111-4111-8111-111111111111", revision: 1, updated_at: "2026-11-06", brief: {
  title: "Onboarding", goal: "More qualified bookings", audience: "Trial users", offer: "Guided onboarding", message: "Get your first result", hypothesis: "Guidance helps",
  metric: "Qualified bookings in CRM", baseline: "Unavailable; first experiment", target: "Suggested: five bookings", owner: "Founder",
  launchDate: "2026-11-07", reviewDate: "2026-11-14", status: "DRAFT", tasks: [{ id: "22222222-2222-4222-8222-222222222222", title: "Welcome email", owner: "Founder", due: "2026-11-07", channel: "EMAIL", status: "TODO", note: "Subject: Need a hand? Book your guided onboarding." }],
  result: "", decision: "UNDECIDED", learning: "", nextMove: "",
} })
const assess = (c = campaign()) => marketingCampaignWork(c, "2026-11-06")

describe("actionable marketing work", () => {
  it("keeps old campaigns valid and reports missing distribution rather than inventing it", () => {
    const c = campaign()
    expect(Schema.decodeUnknownEither(CampaignBrief)(c.brief)._tag).toBe("Right")
    const work = assess(c).items
    expect(work.find(i => i.key === "distribution")).toMatchObject({ kind: "AGENT_WORK", tools: ["record_campaign_revision"] })
    expect(work.find(i => i.key === "measurement-plan")?.detail).toContain("trackingPlan")
    expect(c.brief.distribution).toBeUndefined()
  })
  it("saves a full-funnel distribution plan without pretending tracking is verified", () => {
    const c = campaign(); c.brief = { ...c.brief, distribution: plan() }
    expect(Schema.decodeUnknownEither(CampaignBrief)(c.brief)._tag).toBe("Right")
    const work = assess(c).items
    expect(work.some(i => i.key === "distribution" || i.key === "measurement-plan")).toBe(false)
    expect(work.find(i => i.key === "measurement-evidence")?.kind).toBe("CAPABILITY_GAP")
    expect(work.find(i => i.key === "distribution-adapter")?.detail).toContain("not implemented")
  })
  it("does not invent a budget or grant authority through the plan", () => {
    const c = campaign(); c.brief = { ...c.brief, distribution: { ...plan(), budget: "" } }
    expect(assess(c).items.find(i => i.key === "distribution")?.detail).toContain("budget")
    expect(Schema.decodeUnknownEither(CampaignDistribution, { onExcessProperty: "error" })({ ...plan(), approved: true })._tag).toBe("Left")
    expect(Schema.decodeUnknownEither(CampaignDistribution)({ ...plan(), trackingPlan: "x".repeat(2001) })._tag).toBe("Left")
  })
  it("prioritizes due reviews and never edits active campaigns through the agent", () => {
    const c = campaign(); c.brief = { ...c.brief, status: "ACTIVE", reviewDate: "2026-11-06", audience: "" }
    const work = assess(c).items
    expect(work[0]?.key).toBe("review")
    expect(work.find(i => i.key === "brief")).toMatchObject({ kind: "HUMAN_DECISION", tools: [] })
  })
  it.each(["CANCELLED", "WAITING_FOR_APPROVAL", "VERIFYING"])("uses real %s run status to avoid preparing duplicate changes", (status) => {
    const items = marketingCampaignWork(campaign(), "2026-11-06", { status, tasks: [] }).items
    const delivery = items.find(i => i.key === "delivery")!
    expect(delivery.tools).not.toContain("prepare_wordpress_change")
    if (status !== "VERIFYING") expect(delivery.kind).toBe("HUMAN_DECISION")
  })
  it("does not replay rejected changes or mistake observed delivery for measured impact", () => {
    const c = campaign()
    const blocked = marketingCampaignWork(c, "2026-11-06", { status: "BLOCKED", tasks: [{ taskId: c.brief.tasks[0]!.id, state: "BLOCKED" }] })
    expect(blocked.items.find(i => i.key === "delivery")?.kind).toBe("HUMAN_DECISION")
    const delivered = marketingCampaignWork(c, "2026-11-06", { status: "DELIVERY_OBSERVED", tasks: [] })
    expect(delivered.items.some(i => i.key === "delivery")).toBe(false)
    expect(delivered.items.some(i => i.key === "measurement-evidence")).toBe(true)
  })
  it.each(["WAITING_FOR_APPROVAL", "VERIFYING", "DELIVERY_OBSERVED", "BLOCKED"])("does not duplicate a stale run's %s receipt", (state) => {
    const c = campaign()
    const work = marketingCampaignWork(c, "2026-11-06", { status: "STALE", tasks: [{ taskId: c.brief.tasks[0]!.id, state }] })
    const delivery = work.items.find(i => i.key === "delivery")!
    expect(delivery.tools).not.toContain("record_campaign_run")
    expect(delivery.tools).not.toContain("prepare_wordpress_change")
  })
  it("keeps closed campaign learning explicitly operator-recorded", () => {
    const c = campaign(); c.brief = { ...c.brief, status: "CLOSED", learning: "Customers asked for a shorter call", nextMove: "Test 15 minutes" }
    expect(assess(c)).toMatchObject({ items: [], learning: { assurance: "OPERATOR_RECORDED", nextMove: "Test 15 minutes" } })
  })
  it("makes /marketing actionable without exposing unrelated writes", () => {
    const tools = ["read_marketing_work", "record_campaign_draft", "record_campaign_revision", "record_campaign_run", "prepare_wordpress_change", "prepare_account_action", "forget_memory", "propose_check_run"].map(name => ({ name, description: "", parametersJsonSchema: {} }))
    const names = commandTools("/marketing Work on onboarding", tools).map(t => t.name)
    expect(names).toContain("read_marketing_work")
    expect(names).toContain("record_campaign_revision")
    expect(names).toContain("prepare_account_action")
    expect(names).not.toContain("forget_memory")
    expect(names).not.toContain("propose_check_run")
    expect(commandTools("/campaign-status", tools).map(t => t.name)).toEqual(["read_marketing_work"])
    expect(MARKETING_OPERATING_POLICY).toContain("For an assessment/status-only request, remain read-only")
    expect(MARKETING_OPERATING_POLICY).toContain("do the permitted work in this turn")
  })
})
