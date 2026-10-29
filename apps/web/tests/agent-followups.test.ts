import { afterEach, describe, expect, it, vi } from "vitest"
import { decodeFollowupResponse, type FollowupPolicy, type HarnessInstance } from "@openrecord/contracts"
import { Followups, followupError, followupLocation, followupModel, followupModelMatches, followupStatus } from "../app/lib/agent-followups"
import { ApiError } from "../app/lib/api"

const id = "00000000-0001-4100-8000-000000000001"
const otherId = "00000000-0001-4100-8000-000000000002"
const policy: FollowupPolicy = { kind: "configured", enabled: true, grantId: id, conversationId: id,
  selection: null, provider: "gemini", model: "fixture", updatedAt: "2026-10-29T00:00:00Z" }
const instance: HarnessInstance = { id, bridgeId: id, localId: "test", driver: "codex", name: "Test computer", enabled: true,
  installed: true, version: "test", auth: "authenticated", state: "ready", models: [{ id: "fixture", name: "Fixture", reasoningEfforts: ["high"] }], checkedAt: null }
const response = { policy: { kind: "unconfigured" }, limits: { wakeUpsPer24Hours: 1, modelSteps: 3, toolCalls: 4, timeoutSeconds: 120, readOnly: true }, wakes: [] }
afterEach(() => vi.unstubAllGlobals())

describe("automatic follow-up controls", () => {
  it("does not infer hosted authority from unknown or unavailable selections", () => {
    expect(followupModel({ status: "unknown", stored: { target: "hosted" } })).toBeNull()
    expect(followupModel({ status: "unset" })).toBeNull()
    expect(followupModel({ status: "unavailable", stored: { target: "instance", instanceId: id, model: "fixture" } })).toBeNull()
    expect(followupModel({ status: "hosted", explicit: true, provider: "gemini", model: "fixture" })).toMatchObject({ selection: null, provider: "gemini", model: "fixture" })
  })
  it("pins the instance, model and chosen reasoning effort", () => {
    expect(followupModel({ status: "instance", instance, model: instance.models[0]! }, "high")).toMatchObject({
      selection: { instanceId: id, model: "fixture", reasoningEffort: "high" }, provider: "codex", model: "fixture",
    })
  })
  it("distinguishes paused, this chat and another chat", () => {
    expect(followupLocation({ kind: "unconfigured" }, id)).toBe("off")
    expect(followupLocation({ ...policy, enabled: false }, id)).toBe("off")
    expect(followupLocation(policy, id)).toBe("here")
    expect(followupLocation(policy, otherId)).toBe("elsewhere")
  })
  it("does not silently repin a different model or reasoning selection", () => {
    const model = followupModel({ status: "hosted", explicit: true, provider: "gemini", model: "fixture" })!
    expect(followupModelMatches(policy, model)).toBe(true)
    expect(followupModelMatches(policy, { ...model, model: "different" })).toBe(false)
    const picked = followupModel({ status: "instance", instance, model: instance.models[0]! }, "high")!
    expect(followupModelMatches({ ...policy, provider: "codex", selection: { instanceId: id, model: "fixture", reasoningEffort: "low" } }, picked)).toBe(false)
  })
  it("validates response authority instead of accepting malformed state", async () => {
    expect(decodeFollowupResponse(response).policy).toEqual({ kind: "unconfigured" })
    expect(() => decodeFollowupResponse({ ...response, policy: { kind: "configured", enabled: true } })).toThrow()
    expect(() => decodeFollowupResponse({ ...response, limits: { ...response.limits, readOnly: false } })).toThrow()
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(response), { status: 200 })))
    expect(await Followups.read(id)).toEqual(response)
  })
  it("sends an explicit, versioned grant only on configuration", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(response), { status: 200 }))
    vi.stubGlobal("fetch", fetch)
    const request = { enabled: true, requestId: id, expectedGrantId: null, conversationId: id, selection: null, expectedProvider: "gemini", expectedModel: "fixture" } as const
    await Followups.configure(id, request)
    expect(fetch).toHaveBeenCalledWith(`/api/businesses/${id}/agent/follow-ups`, expect.objectContaining({ method: "PUT", credentials: "include", body: JSON.stringify(request) }))
    await Followups.configure(id, { enabled: false })
    expect(fetch).toHaveBeenLastCalledWith(`/api/businesses/${id}/agent/follow-ups`, expect.objectContaining({ body: '{"enabled":false}' }))
  })
  it("keeps failures opaque and does not describe a saved update as business success", () => {
    expect(followupError(new ApiError(409, { _tag: "GrantRequestConflict" }))).toContain("Refresh")
    expect(followupError(new Error("private provider error"))).not.toContain("private provider error")
    expect(followupStatus.COMPLETED).toBe("Update saved")
    expect(followupStatus.INTERRUPTED).toContain("not retried")
  })
})
