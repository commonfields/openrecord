// Agent providers (Settings → Agent connection + the composer model
// selector): the typed client for the harness catalog and the browser-side
// provider selection shared by every agent layout.
//
// Endpoint paths are the ones the backend serves today; the shared route
// table in @openrecord/contracts does not carry them yet, so they are kept
// here as the client-side source of truth next to their response types.
import type {
  HarnessBridge,
  HarnessCatalog,
  HarnessDriver,
  HarnessInstance,
  HarnessModel,
  HarnessSelection,
} from "@openrecord/contracts"
import { HARNESS_NAMES } from "@openrecord/contracts"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { api } from "./api"

export type { HarnessBridge, HarnessCatalog, HarnessDriver, HarnessInstance, HarnessModel, HarnessSelection }
export { HARNESS_NAMES }

export const HARNESS_DRIVERS = ["codex", "claude", "opencode", "cursor", "cliproxy"] as const satisfies readonly HarnessDriver[]

export const Harness = {
  catalog: () => api<HarnessCatalog>("/api/agent/providers"),
  pair: (name: string) =>
    api<{ code: string; expiresAt: string }>("/api/agent/bridges/pairs", {
      method: "POST",
      body: JSON.stringify({ name }),
    }),
  /** This computer's bridge, started by the server when it runs locally. connect: true turns it back on after a disconnect. */
  local: (connect = false) =>
    api<{ status: "DISABLED" | "UNAVAILABLE" | "OFF" | "STARTED" | "RUNNING" }>("/api/agent/bridges/local", {
      method: "POST",
      body: JSON.stringify({ connect }),
    }),
  revokeBridge: (bridgeId: string) => api<{ revoked: boolean }>(`/api/agent/bridges/${bridgeId}`, { method: "DELETE" }),
  setEnabled: (instanceId: string, enabled: boolean) =>
    api<{ updated: boolean }>(`/api/agent/providers/${instanceId}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled }),
    }),
  refresh: (instanceId: string) =>
    api<{ requested: boolean }>(`/api/agent/providers/${instanceId}/refresh`, { method: "POST", body: "{}" }),
}

// The setup run on a paired machine. The code is a short-lived capability:
// it grants connection only, and provider work uses CLI credentials that stay
// on that machine. Run from the folder where the downloaded bridge sits.
export function pairCommand(code: string): string {
  const origin = typeof window === "undefined" ? "" : window.location.origin
  return `node openrecord-bridge.mjs pair --server ${origin} --code ${code}`
}

// Signs a driver's CLI tool in on the machine that runs the bridge. Existing
// credentials stay local; the app never sees them.
export function loginCommand(driver: HarnessDriver, localId?: string): string {
  // CLIProxyAPI signs in to providers itself; the bridge only needs its client key.
  if (driver === "cliproxy") return "./CLIProxyAPI --claude-login   # or --codex-login, --antigravity-login; then set CLIPROXY_API_KEY and restart the bridge"
  return localId
    ? `node openrecord-bridge.mjs login --instance ${localId}`
    : `node openrecord-bridge.mjs login --driver ${driver}`
}

// The provider's own sign-in command, for a computer where OpenRecord runs
// the bridge itself (there is no bridge script to call there).
export function nativeLoginCommand(driver: HarnessDriver): string {
  return { codex: "codex login", claude: "claude auth login", opencode: "opencode auth login", cursor: "cursor-agent login", cliproxy: "cli-proxy-api -claude-login   # or -codex-login" }[driver]
}

// A prompt the person pastes into the coding agent on another computer
// (Claude Code, Codex, Cursor…) to install, pair and keep the bridge running.
export function agentSetupPrompt(code: string, expiresAt: string, origin = typeof window === "undefined" ? "" : window.location.origin): string {
  return `Set up the OpenRecord bridge on this computer so OpenRecord can use the AI subscriptions signed in here. Work step by step and tell me what you did.

1. Check that Node.js 24 or later is installed (node --version). If not, install it the usual way for this system (Homebrew, nvm, winget or the package manager).
2. Download the bridge:
   mkdir -p ~/.openrecord/bin && curl -fsSL ${origin}/openrecord-bridge.mjs -o ~/.openrecord/bin/openrecord-bridge.mjs
3. Pair it. The code works once and expires at ${expiresAt}:
   node ~/.openrecord/bin/openrecord-bridge.mjs pair --server ${origin} --code ${code}
   It keeps running after it prints "bridge running". Stop it with Ctrl-C once you see that line.
4. Keep the bridge running in the background and after restarts, using the absolute path to node:
   - macOS: a LaunchAgent at ~/Library/LaunchAgents/io.openrecord.bridge.plist running "node ~/.openrecord/bin/openrecord-bridge.mjs run" with RunAtLoad and KeepAlive, loaded with launchctl.
   - Linux: a systemd user service with Restart=always, enabled and started.
   - Windows: a Task Scheduler task that runs at logon and restarts on failure.
   Then check it is running: node ~/.openrecord/bin/openrecord-bridge.mjs probe
5. Report which of these are installed and signed in: codex, claude, opencode, cursor-agent. Do not sign in for me or change their settings; tell me the sign-in command for any that are signed out.
6. If CLIProxyAPI is installed, check its config.yaml lists a key under access api-keys. The bridge starts it in the background and reads that key itself.

Never print, log or share the pairing code or ~/.openrecord/bridge.json. Do not set ANTHROPIC_API_KEY or OPENAI_API_KEY for the bridge: they would bill an API key instead of my subscriptions.`
}

// ---- model selection ----

export function harnessStatusLabel(instance: HarnessInstance, checking: boolean): string | null {
  if (!instance.enabled) return null
  if (instance.state === "offline") return "Bridge offline"
  if (!instance.installed) return instance.driver === "cliproxy" ? "Not running" : "Not installed"
  if (checking) return "Checking authentication…"
  if (instance.auth === "unauthenticated") return "Authentication failed"
  if (instance.state === "error" || instance.state === "unavailable") return "Connection failed"
  if (instance.state === "usage_limited") return "Usage limited"
  if (instance.auth === "unknown") return "Authentication status unavailable"
  return "Connected"
}

// An instance offers turns only while the user turned it on, the bridge
// reports it ready with at least one model, and it did not just report its
// CLI tool signed out (unknown sign-in state is tolerated; the server has
// the final say).
export function instanceReady(instance: HarnessInstance): boolean {
  return (
    instance.enabled &&
    instance.installed &&
    instance.auth !== "unauthenticated" &&
    instance.state === "ready" &&
    instance.models.length > 0
  )
}

export type ModelOption =
  | { kind: "hosted"; value: string; provider: string; model: string }
  | { kind: "instance"; value: string; instance: HarnessInstance; model: HarnessModel }

// Hosted first, then one group per provider in the fixed driver order.
export function modelOptions(catalog: HarnessCatalog): ModelOption[] {
  const options: ModelOption[] = []
  if (catalog.hosted) {
    options.push({ kind: "hosted", value: "hosted", provider: catalog.hosted.provider, model: catalog.hosted.model })
  }
  for (const driver of HARNESS_DRIVERS) {
    for (const instance of catalog.instances.filter(i => i.driver === driver && instanceReady(i))) {
      for (const model of instance.models) {
        options.push({ kind: "instance", value: `${instance.id}:${model.id}`, instance, model })
      }
    }
  }
  return options
}

// What the user picked. Lives in browser-local storage: it is a convenience,
// not a credential. The server re-validates it on every turn.
export type StoredSelection = { target: "hosted" } | { target: "instance"; instanceId: string; model: string }

export type AgentSelection =
  | { status: "hosted"; provider: string; model: string; explicit: boolean }
  | { status: "instance"; instance: HarnessInstance; model: HarnessModel }
  // Remembered but not yet checked against a loaded catalog. Sending is
  // allowed; the server has the final say.
  | { status: "unknown"; stored: StoredSelection | null }
  // The catalog loaded and it is gone: disabled, offline or model dropped.
  // Never silently re-routed to another provider.
  | { status: "unavailable"; stored: { target: "instance"; instanceId: string; model: string } }
  // Catalog loaded, nothing remembered and no hosted default either.
  | { status: "unset" }

const SELECTION_KEY = "openrecord:agent-selection"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

export function loadStoredSelection(): StoredSelection | null {
  try {
    const raw = window.localStorage.getItem(SELECTION_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed)) return null
    if (parsed["target"] === "hosted") return { target: "hosted" }
    if (
      parsed["target"] === "instance" &&
      typeof parsed["instanceId"] === "string" &&
      typeof parsed["model"] === "string"
    ) {
      return { target: "instance", instanceId: parsed["instanceId"], model: parsed["model"] }
    }
    return null
  } catch {
    return null
  }
}

export function storeSelection(selection: StoredSelection | null): void {
  try {
    if (selection === null) window.localStorage.removeItem(SELECTION_KEY)
    else window.localStorage.setItem(SELECTION_KEY, JSON.stringify(selection))
  } catch {
    // Storage unavailable; the choice still applies for this session.
  }
}

export function resolveSelection(catalog: HarnessCatalog | null, stored: StoredSelection | null): AgentSelection {
  if (!catalog) return { status: "unknown", stored }
  if (stored && stored.target === "instance") {
    const instance = catalog.instances.find(i => i.id === stored.instanceId)
    const model = instance && instanceReady(instance) ? instance.models.find(m => m.id === stored.model) : undefined
    if (instance && model) return { status: "instance", instance, model }
    return { status: "unavailable", stored }
  }
  if (catalog.hosted) {
    // Omitting the selection resolves to the hosted default, with or without
    // an explicit hosted pick.
    return { status: "hosted", provider: catalog.hosted.provider, model: catalog.hosted.model, explicit: stored?.target === "hosted" }
  }
  return { status: "unset" }
}

// The request field for Agent.send. undefined means "hosted default": both
// an explicit hosted pick and no preference at all ride the hosted path.
export function selectionRequest(selection: AgentSelection): HarnessSelection | undefined {
  switch (selection.status) {
    case "hosted":
    case "unset":
      return undefined
    case "instance":
      return { instanceId: selection.instance.id, model: selection.model.id }
    case "unavailable":
      return undefined // never sent — the turn is blocked in the composer instead
    case "unknown":
      return selection.stored && selection.stored.target === "instance"
        ? { instanceId: selection.stored.instanceId, model: selection.stored.model }
        : undefined
  }
}

// A turn cannot start on a selection known to be missing.
export function selectionSendable(selection: AgentSelection): boolean {
  return selection.status !== "unavailable" && selection.status !== "unset"
}

export function selectionValue(selection: AgentSelection, options: readonly ModelOption[]): string | undefined {
  const candidate =
    selection.status === "hosted"
      ? "hosted"
      : selection.status === "instance"
        ? `${selection.instance.id}:${selection.model.id}`
        : selection.status === "unknown" && selection.stored && selection.stored.target === "instance"
          ? `${selection.stored.instanceId}:${selection.stored.model}`
          : ""
  return options.some(o => o.value === candidate) && candidate !== "" ? candidate : undefined
}

export function selectionLabel(selection: AgentSelection): string {
  switch (selection.status) {
    case "hosted":
      return `Hosted · ${selection.model}`
    case "instance":
      return `${HARNESS_NAMES[selection.instance.driver]} · ${selection.model.name}`
    case "unknown":
      return selection.stored && selection.stored.target === "instance" ? selection.stored.model : "Model"
    case "unavailable":
      return "Model unavailable"
    case "unset":
      return "Model"
  }
}

// ---- hooks ----

// When the server runs on this computer it starts the bridge itself: asked
// once per page load, then the catalog is re-read while providers are found.
let localBridgeAsked = false
export function startLocalBridge(connect: boolean, reload: () => Promise<void>) {
  return Harness.local(connect).then(r => {
    if (r.status === "STARTED") for (const ms of [2000, 6000, 12000, 25000]) window.setTimeout(() => void reload(), ms)
    return r.status
  })
}

export function useHarnessCatalog({
  pollMs,
  enabled = true,
}: {
  pollMs?: number
  enabled?: boolean
} = {}): { catalog: HarnessCatalog | null; loading: boolean; error: string | null; reload: () => Promise<void> } {
  const [catalog, setCatalog] = useState<HarnessCatalog | null>(null)
  const [loading, setLoading] = useState(enabled)
  const [error, setError] = useState<string | null>(null)
  const generation = useRef(0)

  const load = useCallback(async () => {
    const gen = ++generation.current
    setLoading(true)
    try {
      const next = await Harness.catalog()
      if (generation.current !== gen) return
      setCatalog(next)
      setError(null)
      if (next.local && !localBridgeAsked) {
        localBridgeAsked = true
        void startLocalBridge(false, load).catch(() => { localBridgeAsked = false })
      }
    } catch (e) {
      if (generation.current !== gen) return
      setError(e instanceof Error && e.message ? e.message : "Couldn't load providers")
    } finally {
      if (generation.current === gen) setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!enabled) {
      generation.current++
      setCatalog(null)
      setError(null)
      setLoading(false)
      return
    }
    void load()
    if (!pollMs) return
    const timer = window.setInterval(() => void load(), pollMs)
    return () => window.clearInterval(timer)
  }, [enabled, pollMs, load])

  return { catalog, loading, error, reload: load }
}

// Selection shared across agent layouts: read once from storage, then kept in
// state; the resolved value always reflects the freshest catalog.
export function useAgentSelection(catalog: HarnessCatalog | null): {
  selection: AgentSelection
  choose: (next: StoredSelection | null) => void
  request: HarnessSelection | undefined
  sendable: boolean
} {
  const [stored, setStored] = useState<StoredSelection | null>(loadStoredSelection)
  const choose = useCallback((next: StoredSelection | null) => {
    storeSelection(next)
    setStored(next)
  }, [])
  const selection = useMemo(() => resolveSelection(catalog, stored), [catalog, stored])
  return { selection, choose, request: selectionRequest(selection), sendable: selectionSendable(selection) }
}
