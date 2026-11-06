import { afterEach, describe, expect, it, vi } from "vitest"
import { Agent, waitForAgentRequest } from "../app/lib/api"

const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
const reply = { reply: "Research complete", conversationId: "conversation", revision: 1, toolCalls: [], citations: [], provider: "fixture", requestedModel: "fixture" }
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })
describe("durable agent client", () => {
  it("submits once and polls the stored result", async () => {
    vi.useFakeTimers()
    const fetch = vi.fn().mockResolvedValueOnce(response({ requestId: "request" }, 202)).mockResolvedValueOnce(response({ status: "RUNNING" })).mockResolvedValueOnce(response({ status: "COMPLETED", result: reply }))
    vi.stubGlobal("fetch", fetch)
    const sent = Agent.send(null, "Review", "request", 0, "conversation")
    await vi.runAllTimersAsync()
    expect(await sent).toEqual(reply)
    expect(fetch.mock.calls.map(c => c[0])).toEqual(["/api/agent/requests", "/api/agent/requests/request", "/api/agent/requests/request"])
    expect(fetch.mock.calls.filter(c => c[1]?.method === "POST")).toHaveLength(1)
  })
  it("reconnects transient reads without resubmitting work", async () => {
    vi.useFakeTimers()
    const fetch = vi.fn().mockRejectedValueOnce(new TypeError("offline")).mockResolvedValueOnce(response({ status: "COMPLETED", result: reply }))
    vi.stubGlobal("fetch", fetch)
    const waiting = waitForAgentRequest("saved")
    await vi.runAllTimersAsync()
    expect(await waiting).toEqual(reply)
    expect(fetch.mock.calls.every(c => !c[1]?.method)).toBe(true)
  })
  it("does not retry interrupted work", async () => {
    const fetch = vi.fn().mockResolvedValue(response({ status: "INTERRUPTED", failure_reason: "INTERRUPTED", result: null }))
    vi.stubGlobal("fetch", fetch)
    await expect(waitForAgentRequest("request")).rejects.toMatchObject({ status: 503, body: { reason: "INTERRUPTED" } })
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it("detaches without cancelling server work", async () => {
    const fetch = vi.fn().mockResolvedValue(response({ status: "RUNNING" }))
    vi.stubGlobal("fetch", fetch)
    const controller = new AbortController()
    const waiting = waitForAgentRequest("request", controller.signal)
    const rejected = expect(waiting).rejects.toMatchObject({ name: "AbortError" })
    controller.abort(); await rejected
    expect(fetch.mock.calls.some(c => String(c[0]).endsWith("/cancel"))).toBe(false)
  })
})
