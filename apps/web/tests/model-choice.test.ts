import { describe, expect, it } from "vitest"
import { enabledModels, instanceReady, modelOptions, type HarnessCatalog, type HarnessInstance } from "../app/lib/harness"

const instance = (over: Partial<HarnessInstance> = {}): HarnessInstance => ({
  id: "11111111-1111-4111-8111-111111111111", bridgeId: "22222222-2222-4222-8222-222222222222", localId: "33333333-3333-4333-8333-333333333333",
  driver: "claude", name: "Claude Code", enabled: true, installed: true, version: "1", auth: "authenticated", state: "ready",
  models: [{ id: "sonnet", name: "Sonnet 5.5" }, { id: "opus", name: "Opus 5.5" }, { id: "haiku", name: "Haiku 5.5" }], checkedAt: "2026-10-31T00:00:00Z", ...over,
})

describe("choosing a provider's models", () => {
  it("offers only the models left on in the chat's model picker", () => {
    const i = instance({ disabledModels: ["opus"] })
    expect(enabledModels(i).map(m => m.id)).toEqual(["sonnet", "haiku"])
    const catalog = { bridges: [], instances: [i] } as unknown as HarnessCatalog
    expect(modelOptions(catalog).map(o => o.kind === "instance" ? o.model.id : o.value)).toEqual(["sonnet", "haiku"])
  })
  it("treats every model as on when none were turned off, and drops a provider with all models off", () => {
    expect(enabledModels(instance()).map(m => m.id)).toEqual(["sonnet", "opus", "haiku"])
    expect(instanceReady(instance({ disabledModels: ["sonnet", "opus", "haiku"] }))).toBe(false)
  })
})
