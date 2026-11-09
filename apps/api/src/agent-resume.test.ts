import { describe, expect, it } from "vitest"
import { buildContext } from "./agent-context.js"
import { formatResumeContext, RESUME_CONTEXT_LIMIT } from "./agent-resume.js"

const noWork = { goalId: null, goalVersion: null, campaigns: [], wordpressChanges: [], accountActions: [], limitPerKind: 10, note: "" }

describe("business resume context", () => {
  it("keeps saved context in user data, separate from the actual request", () => {
    const built = buildContext([], "Continue", undefined, "Untrusted business brief")
    expect(built.contents).toEqual([{ role: "user", parts: [{ text: "Untrusted business brief" }, { text: "Continue" }] }])
    expect(built.historyChars).toBe("Untrusted business brief".length)
  })

  it("reserves context budget instead of adding unbounded history", () => {
    const built = buildContext([{ role: "user", text: "a".repeat(500) }], "Continue", { historyChars: 100, verbatimMessages: 16 }, "b".repeat(100))
    expect(built.historyChars).toBeLessThanOrEqual(100)
    expect(built.contents.at(-1)?.parts.at(-1)).toEqual({ text: "Continue" })
  })

  it("drops whole lower-priority records and retains valid JSON", () => {
    const text = formatResumeContext({ goal: null, objectiveWork: noWork, investigations: [{ id: "first", question: "a".repeat(5000), campaign: null }, { id: "second", question: "b".repeat(5000), campaign: null }], note: "" })
    expect(text.length).toBeLessThanOrEqual(RESUME_CONTEXT_LIMIT)
    const snapshot = JSON.parse(text.slice(text.indexOf("\n") + 1))
    expect(snapshot.investigations).toHaveLength(1)
    expect(snapshot.investigations[0].id).toBe("first")
    expect(snapshot.omittedInvestigations).toBe(1)
  })

  it("keeps a linked campaign's live state whole with its investigation", () => {
    const campaign = { campaignId: "c1", title: "Onboarding", status: "DRAFT", linkedNoteId: "n1", linkedAt: new Date("2026-11-06T00:00:00Z"), notedRevision: 1, currentRevision: 2,
      revisionChanged: true, latestRun: { id: "r1", campaignRevision: 1, status: "STALE", deliverables: { VERIFYING: 1 } } }
    const text = formatResumeContext({ goal: null, objectiveWork: noWork, note: "", investigations: [
      { id: "first", question: "Why are bookings flat?", campaign },
      { id: "second", question: "c".repeat(RESUME_CONTEXT_LIMIT), campaign },
    ] })
    expect(text.length).toBeLessThanOrEqual(RESUME_CONTEXT_LIMIT)
    expect(text).toContain("VERIFYING or WAITING_FOR_APPROVAL is not delivery or success")
    const snapshot = JSON.parse(text.slice(text.indexOf("\n") + 1))
    expect(snapshot.investigations).toEqual([{ id: "first", question: "Why are bookings flat?", campaign: JSON.parse(JSON.stringify(campaign)) }])
  })

  it("keeps objective lineage ahead of investigations and trims it by whole records", () => {
    const campaigns = Array.from({ length: 10 }, (_, i) => ({ id: `c${i}`, title: "t".repeat(120), status: "DRAFT", revision: 1, deliverables: 1, goalId: "g", goalVersion: 1, currentObjective: true }))
    const text = formatResumeContext({ goal: null, note: "", objectiveWork: { ...noWork, goalId: "g", goalVersion: 1, campaigns, wordpressChanges: campaigns, accountActions: campaigns },
      investigations: [{ id: "first", question: "q".repeat(3000), campaign: null }] })
    expect(text.length).toBeLessThanOrEqual(RESUME_CONTEXT_LIMIT)
    const snapshot = JSON.parse(text.slice(text.indexOf("\n") + 1))
    expect(snapshot.investigations).toHaveLength(0)
    expect(snapshot.objectiveWork.campaigns[0].id).toBe("c0")
    expect(snapshot.objectiveWork.campaigns.length).toBeLessThanOrEqual(5)
    expect(snapshot.objectiveWork.omitted).toBe(30 - 3 * snapshot.objectiveWork.campaigns.length)
  })

  it("reports unreadable lineage instead of an empty list", () => {
    const text = formatResumeContext({ goal: null, note: "", investigations: [], objectiveWork: { status: "UNAVAILABLE", note: "Objective work could not be read." } })
    expect(JSON.parse(text.slice(text.indexOf("\n") + 1)).objectiveWork.status).toBe("UNAVAILABLE")
  })
})
