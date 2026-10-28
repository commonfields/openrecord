// Agent provider surface: the harness client/selection lib, the Settings →
// Agent connection section, and the composer model selector + stop control.
// Pure selection logic runs directly; the React surface is asserted with file
// scans, the same browser-free style as product-surface.test.ts.
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import type { HarnessCatalog, HarnessInstance } from "@openrecord/contracts"
import { filterModels, modelProvider } from "../app/components/agent-model-picker"
import {
  HARNESS_NAMES,
  harnessStatusLabel,
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

describe("agent workspace presentation", () => {
  it("keeps work in the conversation, slows the shimmer, and exposes only supported reasoning levels", () => {
    const chat = agentChat()
    const overview = chat.slice(chat.indexOf("function OverviewAgent("), chat.indexOf("export function AgentWorkspace("))
    expect(overview).not.toContain("<AgentPane")
    expect(overview).not.toContain("const split")
    expect(overview).not.toContain("setFocus")
    expect(overview).toContain("work={session.hasWork ? <WorkPane")
    expect(chat).toContain('aria-label="Reasoning effort"')
    expect(chat).toContain("session.reasoningEfforts.length")
    expect(chat).toContain("{ ...selectionField, reasoningEffort }")
    expect(read("../app/globals.css")).toContain("thinking-sweep 4.5s linear infinite")
  })
  it("shows pending chat activity in the sidebar and matches model/reasoning text styles", () => {
    expect(agentChat()).toContain('activity.start(businessId, requestId, "New chat", conversationId, providerTag)')
    expect(agentChat()).toContain("activity.finish(businessId, requestId, true, r.provider, r.title)")
    expect(read("../app/components/app-shell.tsx")).toContain("motion-safe:animate-[status-pulse_2s_infinite]")
    const picker = read("../app/components/agent-model-picker.tsx")
    expect(picker).toContain("p-0 text-xs text-muted-foreground")
    expect(agentChat()).toContain("p-0 text-xs text-muted-foreground shadow-none")
    expect(agentChat()).not.toContain("<span>Reasoning</span>")
    expect(agentChat()).toContain('<SelectValue>{session.reasoningEffort ?? "Reasoning"}</SelectValue>')
    expect(agentChat()).not.toContain("{session.reasoningEfforts.length ? <div")
    expect(agentChat()).toContain("disabled={inFlight || session.reasoningEfforts.length === 0}")
    expect(agentChat()).toContain("This provider hasn't reported reasoning controls for this model.")
  })

  it("separates chat history from Work navigation and keeps header tabs compact", () => {
    const shell = read("../app/components/app-shell.tsx")
    const sidebar = shell.slice(shell.indexOf("function SidebarBody()"), shell.indexOf("const CHATS_SHOWN"))
    expect(sidebar.includes("{agent ? <ChatHistory /> : <>")).toBe(true)
    expect(sidebar.includes('label="Agent"')).toBe(false)
    for (const label of ["Channels", "Work", "Results"]) {
      expect(sidebar.includes(`label="${label}"`)).toBe(true)
    }
    for (const label of ["Clients", "All businesses"]) expect(sidebar.includes(`label="${label}"`)).toBe(false)
    const tabs = shell.slice(shell.indexOf("function ViewTabs("), shell.indexOf("function SidebarLink("))
    expect(tabs.includes("h-full min-h-0 self-stretch rounded-[3px]")).toBe(true)
    expect(tabs.includes("grid-cols-2 items-stretch rounded-md border border-sidebar-border")).toBe(true)
    expect(tabs.includes("grid h-6 w-auto")).toBe(true)
    expect(tabs.includes("rounded-[3px] px-1 text-[0.6875rem]")).toBe(true)
    expect(tabs.includes("data-[state=active]:shadow-(--card-shadow)")).toBe(false)
    expect(sidebar.indexOf('label="Results"')).toBeLessThan(sidebar.indexOf('label="Channels"'))
    expect(sidebar.includes("<ViewTabs")).toBe(false)
    const header = shell.slice(shell.indexOf("<header"), shell.indexOf("</header>"))
    expect(header.includes("<ViewTabs />")).toBe(true)
    expect(header.indexOf("<ViewTabs />")).toBeLessThan(header.indexOf("<Breadcrumbs />"))
    expect(tabs.includes("rounded-full")).toBe(false)
  })

  it("starts a separate sidebar chat without deleting the current conversation", () => {
    const shell = read("../app/components/app-shell.tsx")
    expect(shell.includes("<SearchButton onOpen={open} />")).toBe(true)
    expect(shell.includes("<NewChatDialog />")).toBe(true)
    expect(shell.includes("Find…")).toBe(false)
    const newChat = read("../app/components/new-chat-dialog.tsx")
    expect(newChat.includes("Agent.clear")).toBe(false)
    expect(newChat.includes("deletes the current conversation")).toBe(false)
    expect(newChat.includes("await Agent.create(businessId, id)")).toBe(true)
    expect(newChat.includes("Couldn't start the chat")).toBe(true)
    expect(newChat.includes("<SquarePenIcon")).toBe(true)
  })

  it("uses readable sidebar navigation and a plain account control", () => {
    const shell = read("../app/components/app-shell.tsx")
    expect(shell.includes("group/link relative flex h-9 items-center gap-2 rounded-md text-base")).toBe(true)
    const account = shell.slice(shell.indexOf("function AccountMenu()"))
    const trigger = account.slice(0, account.indexOf("</DropdownMenuTrigger>"))
    expect(trigger.includes("rounded-md text-left text-base")).toBe(true)
    expect(trigger.includes("border-sidebar-border")).toBe(false)
    expect(trigger.includes("shadow-(--card-shadow)")).toBe(false)
    expect(trigger.includes("bg-card")).toBe(false)
    expect(account.includes("min-h-16 w-full px-2.5 py-4")).toBe(true)
    expect(account.includes('aria-label="Account menu"')).toBe(true)
  })

  it("keeps the narrow composer low and multiline controls at the bottom without a scrollbar", () => {
    const chat = agentChat()
    expect(chat.includes("max-w-6xl")).toBe(false)
    expect(chat.includes("max-w-(--chat-max-width) shrink-0 pb-2")).toBe(true)
    expect(chat.includes("dark:bg-[#262626]")).toBe(true)
    expect(chat.includes("border-border bg-[#fafafa] px-3 py-2")).toBe(true)
    expect(chat.includes("relative flex min-h-12 cursor-text")).toBe(true)
    expect(chat.includes("cursor-text items-end")).toBe(true)
    expect(chat.includes("items-end gap-3 rounded-xl")).toBe(true)
    expect(chat.includes("size-8 shrink-0 self-end")).toBe(true)
    expect(chat.includes("flex shrink-0 self-end items-center")).toBe(true)
    expect(chat.includes("overflow-y-auto")).toBe(true)
    expect(chat.includes("[scrollbar-width:none] [&::-webkit-scrollbar]:hidden")).toBe(true)
    expect(chat.includes("disabled:bg-primary disabled:text-primary-foreground disabled:opacity-50")).toBe(true)
    expect(chat.includes("disabled={!canSend}")).toBe(true)
  })

  it("scrolls command results independently above the anchored composer and omits helper labels", () => {
    const chat = agentChat()
    const overview = chat.slice(chat.indexOf("function OverviewAgent"), chat.indexOf("// ----", chat.indexOf("function OverviewAgent") + 1))
    expect(chat.includes("setWorkspace(true)")).toBe(true)
    expect(chat.includes("const crowded")).toBe(false)
    expect(overview.includes('aria-label="Agent proposals" className="min-h-0 w-full flex-1 overflow-y-auto"')).toBe(true)
    expect(overview.includes("max-w-(--chat-max-width) shrink-0 pb-2")).toBe(true)
    expect(chat.includes("Stored evidence")).toBe(false)
    expect(chat.includes("Approval required")).toBe(false)
  })

  it("keeps Results measurement-focused without the Work action queue", () => {
    const results = read("../app/routes/today.tsx")
    expect(results.includes("NextActions"), "Results must not render Do next").toBe(false)
    expect(results).toContain("<HealthStrip")
    expect(results).toContain("<SourcesPanel")
    expect(read("../app/routes/work.tsx")).toContain("<NextActions")
  })

  it("places chat actions and voice inside the input, with the model in a separate toolbar", () => {
    const chat = agentChat()
    const composer = chat.slice(chat.indexOf("function Composer"), chat.indexOf("function CheckProposal"))
    const toolbar = composer.indexOf('role="toolbar" aria-label="Chat options"')
    expect(toolbar).toBeGreaterThan(0)
    expect(composer.indexOf('aria-label="Chat actions"')).toBeLessThan(toolbar)
    expect(composer.indexOf('"Start voice input"')).toBeLessThan(toolbar)
    expect(composer.indexOf("<ModelSelector")).toBeGreaterThan(toolbar)
    expect(composer.includes("min-h-28"), "input stays compact").toBe(false)
    expect(composer.includes('className="w-full space-y-0.5"')).toBe(true)
    expect(composer.includes("min-h-6 flex-wrap")).toBe(true)
    expect(chat.includes("Describe a task or ask a question")).toBe(true)
  })

  it("does not override sidebar focus when opening the Work destination", () => {
    const business = read("../app/routes/business.tsx")
    const results = business.slice(business.indexOf("export function ResultsPage"))
    expect(results).toContain("<Today />")
    expect(results.includes("setFocus"), "Work must respect the saved sidebar state").toBe(false)
  })

  it("omits the empty-chat greeting and keeps the model menu trigger text-only", () => {
    const chat = agentChat()
    expect(chat.includes("What should we look into for"), "empty chat greeting removed").toBe(false)
    const picker = read("../app/components/agent-model-picker.tsx")
    const trigger = picker.match(/aria-label="Agent model" disabled=\{locked\} className="([^"]+)"/)
    expect(trigger?.[1]).toContain("border-0")
    expect(trigger?.[1]).toContain("bg-transparent")
    expect(trigger?.[1]).toContain("shadow-none")
    expect(picker).toContain("<Popover.Content")
  })
})

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
  it("hides disabled-provider status and distinguishes failed authentication from unknown or offline", () => {
    expect(harnessStatusLabel(instance({ enabled: false, auth: "unauthenticated" }), false)).toBeNull()
    expect(harnessStatusLabel(instance(), true)).toBe("Checking authentication…")
    expect(harnessStatusLabel(instance({ auth: "unauthenticated" }), false)).toBe("Authentication failed")
    expect(harnessStatusLabel(instance({ auth: "unknown" }), false)).toBe("Authentication status unavailable")
    expect(harnessStatusLabel(instance({ state: "offline" }), true)).toBe("Bridge offline")
    expect(harnessStatusLabel(instance(), false)).toBe("Connected")
  })

  it("filters models by provider and case-insensitive name or id without changing option identities", () => {
    const codex = instance()
    const opencode = instance({ driver: "opencode", models: [{ id: "vendor/model:free", name: "GLM Flash" }, { id: "other", name: "Other" }] })
    const options = modelOptions(catalog({ hosted: HOSTED, instances: [codex, opencode] }))
    expect([...new Set(options.map(modelProvider))]).toEqual(["hosted", "codex", "opencode"])
    expect(filterModels(options, "opencode", " FLASH ").map(o => o.value)).toEqual([`${opencode.id}:vendor/model:free`])
    expect(filterModels(options, "all", "model:free")).toEqual(filterModels(options, "opencode", "glm"))
    expect(filterModels(options, "codex", "flash")).toEqual([])
    expect(filterModels(options, "all", "")).toEqual(options)
    expect(filterModels([], "all", "x")).toEqual([])
  })

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
    // Every provider is surfaced, never hard-coded to one.
    expect(HARNESS_NAMES).toEqual({ codex: "Codex", claude: "Claude Code", opencode: "OpenCode", cursor: "Cursor", cliproxy: "CLIProxyAPI" })
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
    expect(dialog).toContain("Get code")
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
    expect(webApi()).toContain("${agentBase(businessId)}/cancel")
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
    expect(dialog).toContain("Computers")
    // All four providers are surfaced through the shared driver table.
    expect(dialog).toContain("HARNESS_DRIVERS")
    expect(dialog).toContain("No computer is connected yet")
    expect(dialog).toContain("Checking provider status")
    expect(dialog).toContain("Couldn't load providers")
    expect(dialog).toContain("Retry")
    expect(dialog).toContain("Offline")
    expect(dialog).toContain("harnessStatusLabel")
    expect(dialog).not.toContain("<Badge")
    expect(dialog).toContain("{instance.enabled ? <>")
    // The downloaded bridge and its prerequisites, where the pair/login
    // commands run. The code is a capability: copy says so.
    expect(dialog).toContain('href={BRIDGE_SCRIPT} download')
    expect(dialog).toContain('BRIDGE_SCRIPT = "/openrecord-bridge.mjs"')
    expect(dialog).toContain("Node 24")
    expect(dialog).toContain("Download bridge")
    expect(dialog).toContain("Don't share it")
    expect(dialog).toContain("loginCommand")
    expect(dialog).toContain("Harness.setEnabled")
    expect(dialog).toContain("Harness.refresh")
    expect(dialog).toContain("Harness.revokeBridge")
    expect(dialog).toContain("pairCommand")
    expect(dialog).toContain("<ProviderLogo")
    expect(dialog).toContain("onClick={connect}>Connect")
    // An offline computer folds to one line; no restart command under each provider.
    expect(dialog).not.toContain('value="node openrecord-bridge.mjs run"')
    expect(dialog).toContain("Prompt for your coding agent")
    const prompt = harnessLib()
    expect(prompt).toContain("export function agentSetupPrompt(code: string")
    expect(prompt).toContain("KeepAlive")
    expect(prompt).toContain("Restart=always")
    expect(prompt).toContain("Do not set ANTHROPIC_API_KEY or OPENAI_API_KEY")
  })
})

describe("composer model selector and stop control", () => {
  it("opens the model menu above the trigger with a compact panel and blue selection check", () => {
    const chat = read("../app/components/agent-model-picker.tsx")
    expect(chat.includes('<Popover.Content side="top" align="end" sideOffset={8}')).toBe(true)
    expect(chat.includes("Model · next reply")).toBe(false)
    expect(chat.includes("dark:bg-[#303030]")).toBe(true)
    expect(chat.includes("size-4 shrink-0 text-secondary")).toBe(true)
    expect(chat.includes('aria-label="Model providers"')).toBe(true)
    expect(chat.includes('aria-label="Search models"')).toBe(true)
    expect(chat.includes("Enable fast mode")).toBe(false)
  })

  it("is present in every layout and locked while a turn is in flight", () => {
    const chat = agentChat()
    expect([...chat.matchAll(/session=\{session\}/g)].length).toBeGreaterThanOrEqual(3)
    expect(chat).toContain("function ModelSelector")
    expect(chat).toContain("locked={inFlight}")
    expect(chat).toContain("Manage providers")
    expect(chat).toContain('openSettings("agent")')
    expect(read("../app/components/agent-model-picker.tsx")).toContain('aria-label="Agent model"')
  })

  it("shows a stop button wired to the session cancel, replacing send in flight", () => {
    const chat = agentChat()
    const stop = chat.slice(chat.indexOf("{inFlight && session ? ("), chat.indexOf(") : text.trim().length > 0 ? ("))
    expect(stop.includes('variant="secondary"'), "Stop needs the contrasting blue button palette").toBe(true)
    expect(stop.includes("text-foreground"), "page text color must not override the stop icon contrast").toBe(false)
    expect(chat).toContain('aria-label="Stop the agent"')
    expect(chat).toContain("stopTurn")
    expect(chat).toContain("Agent.cancel")
  })

  it("runs slash commands through the selected agent in all layouts without rendering workflow cards", () => {
    const chat = agentChat()
    // The selection gate never folds into the Composer's disabled prop, so
    // the textarea and command submit stay enabled in every layout.
    expect(chat).not.toMatch(/disabled=\{session\.busy \|\| !session\.ready \|\| !session\.sendable/)
    expect(chat).not.toMatch(/disabled=\{!session\.ready \|\| session\.busy \|\| !session\.sendable/)
    expect(chat).toContain("modelBlocked={!session.sendable}")
    expect(chat).toContain("!modelBlocked && text.trim().length > 0")
    expect(chat).toContain("Choose an available model before running a command.")
    expect(chat).toContain("session.send(`/${command}`)")
    // A reply starts as "Thinking" and turns to "Working" once a tool runs.
    expect(chat).toContain('pending: true, progress')
    expect(read("../app/components/agent-trace.tsx")).toContain('initialProgress = (): Progress => ({ phase: "thinking"')
    expect(chat).not.toContain("<CommandFeed")
    expect(chat).not.toContain("<StatusCard")
    expect(chat).not.toContain("<SetupFlow")
    expect(chat).toContain("onCommand={onCommand}")
    const pane = chat.slice(chat.indexOf("function AgentPane("), chat.indexOf("// ---- overview"))
    expect(pane).toContain("onCommand: (c: AgentCommand) => void")
    expect([...chat.matchAll(/onCommand=\{runCommand\}/g)].length).toBeGreaterThanOrEqual(3)
  })

  it("keeps provider metadata without displaying an attribution line or duplicate chat actions", () => {
    const chat = agentChat()
    expect(chat).not.toContain("Answered by")
    expect(chat).not.toContain('aria-label="Delete conversation"')
    expect(chat).not.toContain('aria-label="Start a new conversation"')
    expect(chat).toContain("<LiveTrace progress=")
    expect(read("../app/components/agent-trace.tsx")).toContain('<span className="thinking">{working ? "Working" : "Thinking"} for {elapsed(now - progress.startedAt)}</span>')
    expect(chat).toContain("text-base leading-relaxed whitespace-pre-wrap")
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
    expect(read("../app/components/agent-model-picker.tsx")).toContain("The model you used is unavailable now")
  })
})
