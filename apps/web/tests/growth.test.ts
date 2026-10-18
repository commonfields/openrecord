import { describe, expect, it } from "vitest"
import { matchRoutes } from "react-router"
import { agentEvidencePath } from "../app/lib/agent-evidence"
import { growthPath, growthEvidencePath, profileFromForm } from "../app/lib/growth"

describe("growth workspace form and navigation", () => {
  const id = "00000000-0000-4000-8000-000000000001"
  const form = () => {
    const data = new FormData()
    for (const [key, value] of Object.entries({ category: "Software", audience: "Operators", valueProposition: "Clear positioning", goalKind: "TRIAL_SIGNUPS", eventName: "trial_signup", reportingTimeZone: "Asia/Makassar", propertyRef: "" })) data.set(key, value)
    return data
  }
  it("saves an event definition with explicit count semantics and optional property", () => {
    const value = profileFromForm(form())
    expect(value.primaryGoal).toEqual({ kind: "TRIAL_SIGNUPS", analyticsSource: "GA4_AGGREGATE_EXPORT", eventName: "trial_signup", countingSemantics: "EVENT_COUNT", reportingTimeZone: "Asia/Makassar", propertyRef: null })
  })
  it("rejects invalid timezone, empty audience and malformed event names before saving", () => {
    for (const [key, value] of [["reportingTimeZone", "+08:00"], ["eventName", "signup events"], ["audience", "   "]]) {
      const data = form(); data.set(key!, value!); expect(() => profileFromForm(data)).toThrow("Check the product details")
    }
  })
  it("links every observed reference kind to its stored source workspace", () => {
    const paths = {
      OBSERVATION: `/observations/${id}`, RECORD_CHECK: `/clients/${id}`, RECORD_JUDGMENT: `/clients/${id}`, RECORD_ACTION: `/clients/${id}`,
      ACQUISITION_BATCH: `/clients/${id}/discovery?batchId=${id}`, ACQUISITION_RESULT: `/clients/${id}/discovery`, REFERRAL_IMPORT: `/clients/${id}/discovery/report`,
    }
    for (const kind of ["OBSERVATION", "RECORD_CHECK", "RECORD_JUDGMENT", "RECORD_ACTION", "ACQUISITION_BATCH", "ACQUISITION_RESULT", "REFERRAL_IMPORT"] as const) {
      expect(growthEvidencePath(id, { kind, id })).toBe(paths[kind])
    }
  })
  it("links goal and opportunity citations to the authenticated workspace", () => {
    for (const kind of ["growth_goal", "growth_opportunity"]) {
      const path = agentEvidencePath(id, { kind, id, text: "Growth evidence" })
      expect(path?.split("#")[0]).toBe(growthPath(id)); expect(matchRoutes([{ path: "/clients/:id/growth" }], path!)?.[0]?.params["id"]).toBe(id)
    }
  })
})
