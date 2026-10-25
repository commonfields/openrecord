// Agent provider surface: the harness client/selection lib, the Settings →
// Agent connection section, and the composer model selector + stop control.
// Pure selection logic runs directly; the React surface is asserted with file
// scans, the same browser-free style as product-surface.test.ts.
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import type { HarnessCatalog, HarnessInstance } from "@openrecord/contracts"
import {
  HARNESS_NAMES,
  instanceReady,
  loginCommand,
  modelOptions,
  resolveSelection,
  selectionRequest,
  selectionSendable,
  selectionValue,
} from "../app/lib/harness"

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8")
const agentChat = () => read("../app/components/agent-chat.tsx")
const webApi = () => read("../app/lib/api.ts")
const harnessLib = () => read("../app/lib/harness.ts")
const settingsDialog = () => read("../app/components/settings-dialog.tsx")
const harnessSettings = () => read("../app/components/harness-settings.tsx")

const HOSTED = { provider: "openrecord", model: "claude-sonnet" }

let serial = 0
const uuid = () => `00000000-0001-4100-8000-${String(++serial).padStart(12, "0")}`

function instance(overrides: Partial<HarnessInstance> = {}): HarnessInstance {
  return {
    id: uuid(),
    bridgeId: uuid(),
    localId: uuid(),
    driver: "codex",
    name: "Work laptop",
    enabled: true,
    installed: true,
    version: "1.2.3",
    auth: "authenticated",
    state: "ready",
    models: [{ id: "gpt-5", name: "GPT-5" }],
    checkedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  }
}

function catalog(overrides: Partial<HarnessCatalog> = {}): HarnessCatalog {
  return { bridges: [], instances: [], hosted: null, ...overrides }
}

describe("model options from the catalog", () => {
  it("lists hosted first, then enabled ready instances per provider", () => {
    const codex = instance()
    const claude = instance({ driver: "claude", name: "Home laptop", models: [{ id: "claude-x", name: "Claude X" }] })
    const options = modelOptions(catalog({ hosted: HOSTED, instances: [claude, codex] }))
    expect(options[0]).toMatchObject({ kind: "hosted", value: "hosted", provider: "openrecord", model: "claude-sonnet" })
    expect(options.slice(1).map(o => (o.kind === "instance" ? o.instance.id : "?"))).toEqual([codex.id, claude.id])
  })

  it("skips instances that are disabled, offline, uninstalled, model-less or signed out", () => {
    const disabled = instance()
    const offline = instance()
    const uninstalled = instance()
    const modelless = instance()
    const signedOut = instance()
    const options = modelOptions(
      catalog({
        instances: [
          { ...disabled, enabled: false },
          { ...offline, state: "offline" },
          { ...uninstalled, installed: false },
          { ...modelless, models: [] },
          { ...signedOut, auth: "unauthenticated" },
        ],
      }),
    )
    expect(options).toEqual([])
  })

  it("tolerates an unknown sign-in state but shows it separately from signed-out", () => {
    const unknown = instance({ auth: "unknown" })
    const signedOut = instance({ auth: "unauthenticated" })
    expect(modelOptions(catalog({ instances: [unknown, signedOut] })).map(o => o.value)).toEqual([`${unknown.id}:gpt-5`])
    expect(instanceReady(unknown)).toBe(true)
    expect(instanceReady(signedOut)).toBe(false)
  })

  it("uses instance-id + model-id as the option value", () => {
    const one = instance({ driver: "opencode" })
    const options = modelOptions(catalog({ instances: [one] }))
    expect(options[0]?.value).toBe(`${one.id}:gpt-5`)
  })

  it("round-trips model ids that contain colons without splitting them", () => {
    const one = instance({ driver: "opencode", models: [{ id: "provider/model:free", name: "Model (free)" }] })
    const options = modelOptions(catalog({ instances: [one] }))
    expect(options[0]?.value).toBe(`${one.id}:provider/model:free`)
    const resolved = resolveSelection(catalog({ instances: [one] }), {
      target: "instance",
      instanceId: one.id,
      model: "provider/model:free",
    })
    expect(resolved).toMatchObject({ status: "instance", model: { id: "provider/model:free" } })
    if (resolved.status !== "instance") throw new Error("expected instance resolution")
    expect(selectionRequest(resolved)).toEqual({ instanceId: one.id, model: "provider/model:free" })
    expect(selectionValue(resolved, options)).toBe(`${one.id}:provider/model:free`)
  })
})

describe("selection resolution never falls back silently", () => {
  it("resolves a remembered instance selection only while it is still ready", () => {
    const cat = catalog({ instances: [instance()] })
    const ready = cat.instances[0]!
    expect(resolveSelection(cat, { target: "instance", instanceId: ready.id, model: "gpt-5" })).toMatchObject({
      status: "instance",
      instance: ready,
      model: { id: "gpt-5" },
    })
    // Disabled after the fact: still unavailable, never redirected to hosted.
    const disabled = catalog({ hosted: HOSTED, instances: [{ ...ready, id: ready.id, enabled: false }] })
    expect(resolveSelection(disabled, { target: "instance", instanceId: ready.id, model: "gpt-5" })).toEqual({
      status: "unavailable",
      stored: { target: "instance", instanceId: ready.id, model: "gpt-5" },
    })
  })

  it("treats a missing model on an existing instance as unavailable", () => {
    const cat = catalog({ instances: [instance({ models: [{ id: "gpt-6", name: "GPT-6" }] })] })
    const one = cat.instances[0]!
    expect(resolveSelection(cat, { target: "instance", instanceId: one.id, model: "gpt-5" })).toMatchObject({ status: "unavailable" })
  })

  it("hosts by default, with or without an explicit hosted pick", () => {
    const cat = catalog({ hosted: HOSTED })
    expect(resolveSelection(cat, null)).toEqual({ status: "hosted", provider: "openrecord", model: "claude-sonnet", explicit: false })
    expect(resolveSelection(cat, { target: "hosted" })).toEqual({ status: "hosted", provider: "openrecord", model: "claude-sonnet", explicit: true })
  })

  it("is unset when nothing is remembered and no hosted provider exists", () => {
    expect(resolveSelection(catalog({ instances: [instance()] }), null)).toEqual({ status: "unset" })
    expect(resolveSelection(catalog(), { target: "hosted" })).toEqual({ status: "unset" })
  })

  it("stays unknown until the catalog loads, keeping the stored choice", () => {
    expect(resolveSelection(null, { target: "instance", instanceId: "x", model: "m" })).toEqual({
      status: "unknown",
      stored: { target: "instance", instanceId: "x", model: "m" },
    })
  })
})

describe("selection to request field", () => {
  it("sends instance selections and omits the field for hosted or nothing", () => {
    const cat = catalog({ instances: [instance()] })
    const one = cat.instances[0]!
    const resolved = resolveSelection(cat, { target: "instance", instanceId: one.id, model: "gpt-5" })
    if (resolved.status !== "instance") throw new Error("expected instance resolution")
    expect(selectionRequest(resolved)).toEqual({ instanceId: one.id, model: "gpt-5" })
    expect(selectionRequest(resolveSelection(catalog({ hosted: HOSTED }), { target: "hosted" }))).toBeUndefined()
    expect(selectionRequest(resolveSelection(catalog({ hosted: HOSTED }), null))).toBeUndefined()
    const unavailable = resolveSelection(catalog(), { target: "instance", instanceId: "x", model: "m" })
    expect(selectionRequest(unavailable)).toBeUndefined()
  })

  it("gates sending on a known-missing selection but not on an unchecked one", () => {
    expect(selectionSendable(resolveSelection(catalog(), { target: "instance", instanceId: "x", model: "m" }))).toBe(false)
    expect(selectionSendable(resolveSelection(catalog(), { target: "hosted" }))).toBe(false) // unset: nothing configured
    expect(selectionSendable(resolveSelection(null, { target: "instance", instanceId: "x", model: "m" }))).toBe(true)
    expect(selectionSendable(resolveSelection(catalog({ hosted: HOSTED }), null))).toBe(true)
  })

  it("keeps the selected option highlighted while the list is open", () => {
    const one = instance()
    const cat = catalog({ instances: [one] })
    const options = modelOptions(cat)
    const resolved = resolveSelection(cat, { target: "instance", instanceId: one.id, model: "gpt-5" })
    expect(selectionValue(resolved, options)).toBe(`${one.id}:gpt-5`)
    expect(selectionValue(resolveSelection(cat, { target: "instance", instanceId: uuid(), model: "gpt-5" }), options)).toBeUndefined()
  })
})

describe("harness client", () => {
  it("targets the provider, bridge, instance and cancel endpoints", () => {
    const lib = harnessLib()
    for (const path of ["/api/agent/providers", "/api/agent/bridges/pairs", "/api/agent/bridges/", "/api/agent/providers/", "/refresh", "PATCH", "DELETE"]) {
      expect(lib, `missing: ${path}`).toContain(path)
    }
    // The four providers are all surfaced, never hard-coded to one.
    expect(HARNESS_NAMES).toEqual({ codex: "Codex", claude: "Claude Code", opencode: "OpenCode", cursor: "Cursor" })
  })

  it("builds the local bridge setup command with the current origin and code", () => {
    const lib = harnessLib()
    expect(lib).toContain("node openrecord-bridge.mjs pair --server")
    expect(lib).toContain("window.location.origin")
    expect(lib).toContain("--code")
    // Sign-in runs on the paired machine, per driver; credentials never cross it.
    for (const driver of ["codex", "claude", "opencode", "cursor"] as const) {
      expect(loginCommand(driver)).toBe(`node openrecord-bridge.mjs login --driver ${driver}`)
      expect(loginCommand(driver, "instance-id")).toBe("node openrecord-bridge.mjs login --instance instance-id")
    }
  })

  it("keeps the pairing code out of persistent storage", () => {
    const dialog = harnessSettings()
    expect(dialog).toContain("Get pairing code")
    expect(dialog).not.toMatch(/localStorage/)
    expect([...harnessLib().matchAll(/localStorage\.(get|remove|set)Item/g)].length).toBeGreaterThan(0)
    // The only localStorage key is the non-sensitive selection.
    expect(harnessLib()).toContain('"openrecord:agent-selection"')
  })
})

describe("api client carries the selection contract", () => {
  it("adds an optional selection to Agent.send and reads provider back", () => {
    const api = webApi()
    expect(api).toContain("selection?: HarnessSelection")
    expect(api).toContain("provider: string")
    expect(api).toContain("requestedModel: string | null")
    expect(api).toContain("conversationId, selection })")
  })

  it("wires the real cancel route for stopping a turn", () => {
    expect(webApi()).toContain("/agent/cancel")
  })
})

describe("settings → agent connection surface", () => {
  it("replaces the static Not connected badge with the live section", () => {
    const dialog = settingsDialog()
    expect(dialog).toContain("<AgentConnectionSection />")
    expect(dialog).not.toContain("Not connected")
    // Composer toggles stay in the same section.
    for (const kept of ["enterToSend", "voiceInput", "Send with Enter", "Voice input"]) {
      expect(dialog, `missing copy: ${kept}`).toContain(kept)
    }
  })

  it("shows hosted, bridges, all four providers and real loading/error states", () => {
    const dialog = harnessSettings()
    expect(dialog).toContain("OpenRecord hosted")
    expect(dialog).toContain("Bridges")
    // All four providers are surfaced through the shared driver table.
    expect(dialog).toContain("HARNESS_DRIVERS")
    expect(dialog).toContain("Not reported by any paired bridge yet")
    expect(dialog).toContain("Checking provider status")
    expect(dialog).toContain("Couldn't load providers")
    expect(dialog).toContain("Retry")
    expect(dialog).toContain("Offline")
    expect(dialog).toContain("Needs sign-in on this machine")
    expect(dialog).toContain("Sign-in state unknown")
    // The downloaded bridge and its prerequisites, where the pair/login
    // commands run. The code is a capability: copy says so.
    expect(dialog).toContain('href={BRIDGE_SCRIPT} download')
    expect(dialog).toContain('BRIDGE_SCRIPT = "/openrecord-bridge.mjs"')
    expect(dialog).toContain("Node 24")
    expect(dialog).toContain("Download bridge")
    expect(dialog).toContain("short-lived")
    expect(dialog).toContain("loginCommand")
    expect(dialog).toContain("Harness.setEnabled")
    expect(dialog).toContain("Harness.refresh")
    expect(dialog).toContain("Harness.revokeBridge")
    expect(dialog).toContain("pairCommand")
  })
})

describe("composer model selector and stop control", () => {
  it("is present in every layout and locked while a turn is in flight", () => {
    const chat = agentChat()
    expect([...chat.matchAll(/session=\{session\}/g)].length).toBeGreaterThanOrEqual(3)
    expect(chat).toContain("function ModelSelector")
    expect(chat).toContain("locked={inFlight}")
    expect(chat).toContain("Manage providers")
    expect(chat).toContain('openSettings("agent")')
    expect(chat).toContain('aria-label="Agent model"')
  })

  it("shows a stop button wired to the session cancel, replacing send in flight", () => {
    const chat = agentChat()
    expect(chat).toContain('aria-label="Stop the agent"')
    expect(chat).toContain("stopTurn")
    expect(chat).toContain("Agent.cancel")
  })

  it("keeps /setup /status /plan /report usable without a model", () => {
    const chat = agentChat()
    // The selection gate never folds into the Composer's disabled prop, so
    // the textarea and command submit stay enabled in every layout.
    expect(chat).not.toMatch(/disabled=\{session\.busy \|\| !session\.ready \|\| !session\.sendable/)
    expect(chat).not.toMatch(/disabled=\{!session\.ready \|\| session\.busy \|\| !session\.sendable/)
    // The gate is its own prop, checked only against ordinary sends.
    expect(chat).toContain("modelBlocked={!session.sendable}")
    expect(chat).toContain("!modelBlocked && text.trim().length > 0")
    // Commands stay submittable with the gate on; text typed while blocked is
    // preserved rather than cleared.
    expect(chat).toContain("Commands are deterministic and never need a model")
    expect(chat).toContain("command !== null ||")
  })

  it("labels completed replies with the provider and model", () => {
    const chat = agentChat()
    expect(chat).toContain("Answered by")
    // Live replies: from the send response. History: from the persisted
    // inference, rendered exactly the same way.
    expect(chat).toContain("provider: r.provider")
    expect(chat).toContain("model: r.requestedModel")
    expect(chat).toContain("toDisplayMessages")
    expect(chat).toContain("m.inference.provider")
    expect(chat).toContain("m.inference.requestedModel")
  })

  it("blocks sending and says so when the selection is unavailable", () => {
    const chat = agentChat()
    expect(chat).toContain("!session.sendable")
    expect(chat).toContain('session.selection.status === "unavailable"')
    expect(chat).toContain("The model you used is unavailable now")
  })
})
