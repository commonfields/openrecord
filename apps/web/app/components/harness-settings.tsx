// Settings → Agent: the connection surface for agent providers. Bridges are
// paired from this screen, instances can be enabled or refresh-requested, and
// every state shown comes from the server catalog — nothing here fakes a
// connection. The pairing code lives in component state only; the page never
// writes secrets to persistent browser storage.
import { useEffect, useState } from "react"
import { toast } from "sonner"
import { CheckIcon, ChevronDownIcon, CopyIcon, LaptopIcon, MonitorIcon, RefreshCwIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { SettingGroup, SettingRow } from "@/components/ui/setting"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Spinner } from "@/components/spinner"
import { modelBrand, ProviderLogo } from "@/components/provider-logo"
import { formatDateTime } from "@/lib/format"
import {
  HARNESS_DRIVERS,
  HARNESS_NAMES,
  Harness,
  enabledModels,
  harnessStatusLabel,
  agentSetupPrompt,
  localProvidersPrompt,
  loginCommand,
  nativeLoginCommand,
  pairCommand,
  startLocalBridge,
  useHarnessCatalog,
  type HarnessBridge,
  type HarnessCatalog,
  type HarnessInstance,
} from "@/lib/harness"
import { cn } from "@/lib/utils"

function CopyCommand({ value, label = "Setup command" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <span className="flex min-w-0 items-center gap-1">
      <code className="block min-w-0 flex-1 overflow-x-auto rounded-md bg-muted px-2 py-1.5 font-mono text-xs text-muted-foreground">{value}</code>
      <Button
        variant="ghost"
        size="icon-sm"
        className="size-7 text-muted-foreground"
        aria-label={`Copy ${label.toLowerCase()}`}
        onClick={() =>
          void navigator.clipboard
            .writeText(value)
            .then(() => {
              setCopied(true)
              toast.success(`${label} copied`)
              setTimeout(() => setCopied(false), 1500)
            })
            .catch(() => toast.error("Couldn't copy. Select the command text and copy it manually."))
        }
      >
        {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
      </Button>
    </span>
  )
}

// The downloadable bridge is bundled into the web app's public assets.
const BRIDGE_SCRIPT = "/openrecord-bridge.mjs"

function LoginHint({ instance, managed }: { instance: HarnessInstance; managed: boolean }) {
  return (
    <div className="mt-2 space-y-1">
      <p className="text-[0.6875rem] text-muted-foreground">
        {instance.auth === "unauthenticated"
          ? "Signed out. Sign in on that computer, then refresh here:"
          : "Sign-in state is unknown. If a turn fails, sign in with:"}
      </p>
      <CopyCommand value={managed ? nativeLoginCommand(instance.driver) : loginCommand(instance.driver, instance.localId)} label="Sign-in command" />
    </div>
  )
}

function InstanceRow({ instance, managed, reload }: { instance: HarnessInstance; managed: boolean; reload: () => Promise<void> }) {
  const [working, setWorking] = useState<"enable" | "refresh" | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [checkAfter, setCheckAfter] = useState<string | null>(null)
  const status = harnessStatusLabel(instance, checkAfter === instance.checkedAt)

  const toggle = (enabled: boolean) =>
    void (async () => {
      setWorking("enable")
      setError(null)
      setCheckAfter(enabled ? instance.checkedAt : null)
      try {
        await Harness.setEnabled(instance.id, enabled)
        await reload()
      } catch {
        setCheckAfter(null)
        setError("Couldn't save that. The provider state may have changed — try again.")
      } finally {
        setWorking(null)
      }
    })()

  const refresh = () =>
    void (async () => {
      setWorking("refresh")
      setError(null)
      setCheckAfter(instance.checkedAt)
      try {
        await Harness.refresh(instance.id)
        // The bridge reports its catalog periodically; the next poll shows it.
        await reload()
      } catch {
        setCheckAfter(null)
        setError("Couldn't request a refresh. Try again in a moment.")
      } finally {
        setWorking(null)
      }
    })()

  return (
    <div className="flex min-h-20 flex-col justify-center py-3.5 pr-3.5 pl-10">
      {instance.enabled && instance.modelsTruncated ? <p role="status" className="mb-2 text-xs text-muted-foreground">This provider's catalog was too large. Only the first {instance.models.length} models are available here.</p> : null}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
        <div className="min-w-0 space-y-1">
          <span className="flex items-center gap-2 text-sm font-medium"><ProviderLogo bare provider={instance.driver === "claude" ? "claude-code" : instance.driver} className="size-5" />{instance.name}</span>
          {instance.enabled ? <>
            <p role="status" className={cn("text-[0.8125rem] text-muted-foreground", status === "Authentication failed" && "text-destructive")}>
              {status}
              {status !== "Checking authentication…" ? <span> · {instance.version ? `${HARNESS_NAMES[instance.driver]} ${instance.version}` : "version unknown"} · {modelCount(instance)}</span> : null}
            </p>
            {status !== "Checking authentication…" && instance.installed && instance.auth !== "authenticated" && instance.driver !== "cliproxy" ? <LoginHint instance={instance} managed={managed} /> : null}
          </> : <p className="text-[0.8125rem] text-muted-foreground">Off · {instance.models.length} model{instance.models.length === 1 ? "" : "s"} available</p>}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {instance.enabled ? <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="size-7 text-muted-foreground"
                disabled={working !== null}
                onClick={refresh}
                aria-label={`Refresh ${instance.name}`}
              >
                {working === "refresh" ? <Spinner className="size-3.5" /> : <RefreshCwIcon />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>Refresh state and models</TooltipContent>
          </Tooltip> : null}
          <Switch
            aria-label={`Turn ${instance.name} ${instance.enabled ? "off" : "on"}`}
            checked={instance.enabled}
            disabled={working !== null}
            onCheckedChange={(v) => toggle(v)}
          />
        </div>
      </div>
      {error ? <p role="alert" className="mt-2 text-xs text-destructive">{error}</p> : null}
      {instance.enabled && instance.models.length > 0 ? <ModelChoices instance={instance} reload={reload} /> : null}
    </div>
  )
}

const modelCount = (instance: HarnessInstance) => {
  const on = enabledModels(instance).length, all = instance.models.length
  return on === all ? `${all} model${all === 1 ? "" : "s"}` : `${on} of ${all} models on`
}

// Which of a provider's models the chat offers. Every model is on until the
// person turns it off; a model the provider adds later starts on.
function ModelChoices({ instance, reload }: { instance: HarnessInstance; reload: () => Promise<void> }) {
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState("")
  // Switches answer at once; the next catalog load confirms them.
  const [pending, setPending] = useState<ReadonlyMap<string, boolean>>(new Map())
  const off = new Set(instance.disabledModels ?? [])
  const isOn = (id: string) => pending.get(id) ?? !off.has(id)
  const onCount = instance.models.filter(m => isOn(m.id)).length
  const choose = (model: string, enabled: boolean) =>
    void (async () => {
      setPending(p => new Map(p).set(model, enabled))
      try {
        await Harness.chooseModel(instance.id, model, enabled)
        await reload()
      } catch {
        toast.error("Couldn't change that model. Try again.")
      } finally {
        setPending(p => { const next = new Map(p); next.delete(model); return next })
      }
    })()
  const query = filter.trim().toLowerCase()
  const shown = query ? instance.models.filter(m => `${m.name} ${m.id}`.toLowerCase().includes(query)) : instance.models
  return (
    <div className="mt-2">
      <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open}
        className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground">
        <ChevronDownIcon className={cn("size-3.5 transition-transform", open ? "rotate-0" : "-rotate-90")} />
        Choose models ({onCount} of {instance.models.length} on)
      </button>
      {open ? (
        <div className="mt-2 space-y-2">
          {instance.models.length > 12 ? (
            <Input value={filter} onChange={e => setFilter(e.currentTarget.value)} placeholder="Search models" aria-label={`Search ${instance.name} models`} className="h-8 text-xs" />
          ) : null}
          <ul className="max-h-72 divide-y divide-border overflow-y-auto rounded-lg bg-muted/30">
            {shown.map(m => (
              <li key={m.id} className="flex items-center justify-between gap-3 px-3 py-2">
                <span className="min-w-0">
                  <span className="block truncate text-[0.8125rem]">{m.name}</span>
                  {m.name !== m.id ? <span className="block truncate text-[0.6875rem] text-muted-foreground">{m.id}</span> : null}
                </span>
                <Switch aria-label={`${isOn(m.id) ? "Turn off" : "Turn on"} ${m.name}`} checked={isOn(m.id)} disabled={pending.has(m.id)}
                  onCheckedChange={v => choose(m.id, v)} />
              </li>
            ))}
            {!shown.length ? <li className="px-3 py-2 text-xs text-muted-foreground">No model matches "{filter}".</li> : null}
          </ul>
          {onCount === 0 ? <p className="text-xs text-muted-foreground">Every model is off, so the chat won't offer {instance.name}.</p> : null}
        </div>
      ) : null}
    </div>
  )
}

// One computer and the providers on it. Each provider shows once, under the
// computer it runs on. An offline computer folds to one line: its providers
// cannot answer until it is back.
function MachineGroup({ bridge, instances, reload }: { bridge: HarnessBridge; instances: HarnessInstance[]; reload: () => Promise<void> }) {
  const [working, setWorking] = useState(false)
  const managed = bridge.managed === true
  const revoke = () =>
    void (async () => {
      setWorking(true)
      try {
        await Harness.revokeBridge(bridge.id)
        toast.success(managed ? "This computer disconnected" : `${bridge.name} removed`)
        await reload()
      } catch {
        toast.error("Couldn't disconnect it. It may already be gone — try again.")
      } finally {
        setWorking(false)
      }
    })()
  // CLIProxyAPI is plumbing, started in the background when installed: it shows only once it runs.
  const found = instances.filter(i => i.installed && (i.driver !== "cliproxy" || i.state !== "unavailable"))
  const missing = instances.filter(i => !i.installed && i.driver !== "cliproxy")
  const Icon = managed ? LaptopIcon : MonitorIcon
  return (
    <div>
      <div className="flex min-h-20 items-center justify-between gap-5 p-3.5">
        <div className="min-w-0 space-y-0.5">
          <span className="flex items-center gap-2 text-sm font-medium">
            <Icon className="size-5 text-muted-foreground" />
            {managed ? "This computer" : bridge.name}
            <span className={cn("size-1.5 rounded-full", bridge.online ? "bg-supported" : "bg-muted-foreground/40")} aria-hidden />
            <span className="font-normal text-muted-foreground">{bridge.online ? "Online" : "Offline"}</span>
          </span>
          {!bridge.online ? (
            <p className="text-[0.8125rem] text-muted-foreground">
              {managed ? "OpenRecord starts it again by itself; this clears once it reconnects." : "Not connected. Start the bridge on that computer again, or remove it here."}
            </p>
          ) : missing.length ? (
            <p className="text-[0.8125rem] text-muted-foreground">Not installed here: {missing.map(i => i.name).join(", ")}</p>
          ) : null}
        </div>
        <Button variant="outline" size="sm" disabled={working} onClick={revoke}>{managed ? "Disconnect" : "Remove"}</Button>
      </div>
      {bridge.online ? found.map(instance => <InstanceRow key={instance.id} instance={instance} managed={managed} reload={reload} />) : null}
    </div>
  )
}

// Shown when the server runs on this computer but its own bridge isn't connected yet.
// After Connect it says what is happening, and says so plainly if the bridge doesn't come up.
const CONNECT_TIMEOUT_MS = 45_000
function LocalBridgeRow({ reload }: { reload: () => Promise<void> }) {
  const [phase, setPhase] = useState<"idle" | "connecting" | "failed">("idle")
  useEffect(() => {
    if (phase !== "connecting") return
    // The catalog polls on its own; if this row is still here after the timeout, the bridge didn't connect.
    const t = window.setTimeout(() => setPhase("failed"), CONNECT_TIMEOUT_MS)
    return () => window.clearTimeout(t)
  }, [phase])
  const connect = () =>
    void (async () => {
      setPhase("connecting")
      try {
        const status = await startLocalBridge(true, reload)
        if (status === "UNAVAILABLE") { setPhase("failed"); toast.error("The bridge program isn't available on this computer.") }
        if (status === "DISABLED") { setPhase("failed"); toast.error("This server isn't running in local mode (OPENRECORD_LOCAL_BRIDGE).") }
        await reload()
      } catch {
        setPhase("failed")
      }
    })()
  return (
    <SettingRow label="This computer" icon={<LaptopIcon className="size-5 text-muted-foreground" />}
      description={phase === "connecting" ? "Starting the bridge here and checking which AI subscriptions are signed in. This takes a few seconds."
        : phase === "failed" ? "The bridge didn't connect. Try again; if it still doesn't, use the prompt below with your coding agent to check the providers on this computer."
        : "Use the Codex, Claude Code, OpenCode or Cursor already signed in here, and CLIProxyAPI if it is installed. No pairing code needed."}>
      <Button size="sm" disabled={phase === "connecting"} onClick={connect}>
        {phase === "connecting" ? <Spinner className="size-3.5" /> : null}
        {phase === "connecting" ? "Connecting" : phase === "failed" ? "Try again" : "Connect"}
      </Button>
    </SettingRow>
  )
}

/** A copy-paste prompt for the coding agent on this computer: providers signed in, CLIProxyAPI set up safely. */
function LocalSetupGroup() {
  const prompt = localProvidersPrompt()
  const [open, setOpen] = useState(false)
  return (
    <SettingGroup title="Set up this computer with your coding agent"
      description="Paste this into Claude Code, Codex or Cursor here. It checks which AI subscriptions are installed and signed in, and sets up CLIProxyAPI safely. It never signs in for you or shares a key.">
      <div className="space-y-2 px-4 py-3.5">
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs font-medium">Prompt for your coding agent</p>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => setOpen(v => !v)}>{open ? "Hide" : "Show"}</Button>
            <CopyButton value={prompt} label="Setup prompt" />
          </div>
        </div>
        {open ? <pre className="max-h-64 overflow-auto rounded-md bg-muted px-3 py-2 font-mono text-[0.6875rem] whitespace-pre-wrap text-muted-foreground">{prompt}</pre> : null}
      </div>
    </SettingGroup>
  )
}

const machineOrder = (b: HarnessBridge) => (b.managed ? 0 : 2) + (b.online ? 0 : 1)

function PairGroup({ local }: { local: boolean }) {
  const [name, setName] = useState("")
  const [pending, setPending] = useState(false)
  // The pairing code exists only in this component and expires server-side;
  // it is never written to browser storage.
  const [pairing, setPairing] = useState<{ name: string; code: string; expiresAt: string } | null>(null)
  const origin = typeof window === "undefined" ? "" : window.location.origin
  const loopback = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(origin)
  const requestPairing = () =>
    void (async () => {
      setPending(true)
      try {
        const label = name.trim() || "Another computer"
        const r = await Harness.pair(label)
        setPairing({ name: label, code: r.code, expiresAt: r.expiresAt })
      } catch {
        toast.error("Couldn't create a pairing code. Try again.")
      } finally {
        setPending(false)
      }
    })()

  return (
    <SettingGroup
      title={local ? "Connect another computer" : "Connect a computer"}
      description="Use the AI subscriptions signed in on another machine. Get a code, then paste the setup prompt into the coding agent on that computer (Claude Code, Codex, Cursor…), or run the commands yourself. Credentials stay on that computer."
    >
      {pairing ? (
        <div className="space-y-3 px-4 py-3.5">
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-0.5">
              <p className="text-xs font-medium">Setup for {pairing.name}</p>
              <p className="text-xs text-muted-foreground">The code works once and expires {formatDateTime(pairing.expiresAt)}. Don't share it.</p>
            </div>
            <Button variant="outline" size="sm" onClick={() => setPairing(null)}>Discard</Button>
          </div>
          {loopback ? <p className="text-xs text-wrong" role="status">This page is on {origin}, which other computers can't reach. Open OpenRecord at an address that computer can reach to pair it.</p> : null}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-medium">Prompt for your coding agent</p>
              <CopyButton value={agentSetupPrompt(pairing.code, formatDateTime(pairing.expiresAt), origin)} label="Setup prompt" />
            </div>
            <pre className="max-h-48 overflow-auto rounded-md bg-muted px-3 py-2 font-mono text-[0.6875rem] whitespace-pre-wrap text-muted-foreground">{agentSetupPrompt(pairing.code, formatDateTime(pairing.expiresAt), origin)}</pre>
          </div>
          <div className="space-y-1.5">
            <p className="text-xs font-medium">Or run it yourself</p>
            <div className="flex flex-wrap items-center gap-2">
              <Button asChild variant="outline" size="sm"><a href={BRIDGE_SCRIPT} download>Download bridge</a></Button>
              <span className="text-[0.6875rem] text-muted-foreground">Single script. Needs Node 24 or later. Run this where you saved it:</span>
            </div>
            <CopyCommand value={pairCommand(pairing.code)} label="Pairing command" />
          </div>
        </div>
      ) : (
        <SettingRow label="New computer" description="Name it, then get a one-time code and its setup prompt.">
          <Input
            id="bridge-pair-name"
            value={name}
            placeholder="Work laptop"
            onChange={(e) => setName(e.currentTarget.value)}
            maxLength={100}
            aria-label="Computer name"
            className="w-40"
          />
          <Button size="sm" disabled={pending} onClick={requestPairing}>
            {pending ? <Spinner className="size-3.5" /> : null}
            Get code
          </Button>
        </SettingRow>
      )}
    </SettingGroup>
  )
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <Button variant="outline" size="sm" onClick={() => void navigator.clipboard.writeText(value).then(() => {
      setCopied(true)
      toast.success(`${label} copied`)
      setTimeout(() => setCopied(false), 1500)
    }).catch(() => toast.error("Couldn't copy. Select the text and copy it manually."))}>
      {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
      Copy
    </Button>
  )
}

function Machines({ catalog, reload }: { catalog: HarnessCatalog; reload: () => Promise<void> }) {
  const bridges = [...catalog.bridges].sort((a, b) => machineOrder(a) - machineOrder(b))
  return (
    <>
      {catalog.local && !catalog.bridges.some(b => b.managed) ? <LocalBridgeRow reload={reload} /> : null}
      {bridges.map(bridge => (
        <MachineGroup key={bridge.id} bridge={bridge} reload={reload}
          instances={catalog.instances.filter(i => i.bridgeId === bridge.id).sort((a, b) => HARNESS_DRIVERS.indexOf(a.driver) - HARNESS_DRIVERS.indexOf(b.driver))} />
      ))}
      {!bridges.length && !catalog.local ? <SettingRow label="Computers" description="No computer is connected yet. Connect one below to use the AI subscriptions signed in there." /> : null}
    </>
  )
}

export function AgentConnectionSection() {
  const { catalog, loading, error, reload } = useHarnessCatalog({ pollMs: 5000 })

  return (
    <>
      <SettingGroup title="Connection" description="The models this app can use: a hosted default, and the AI subscriptions on your computers.">
        {loading && !catalog ? (
          <div className="flex items-center gap-2 px-4 py-3.5 text-xs text-muted-foreground" role="status">
            <Spinner className="size-3.5" />
            Checking provider status…
          </div>
        ) : error && !catalog ? (
          <div className="space-y-2 px-4 py-3.5">
            <p role="alert" className="text-xs text-destructive">
              Couldn't load providers ({error})
            </p>
            <Button variant="outline" size="sm" onClick={() => void reload()}>
              Retry
            </Button>
          </div>
        ) : !catalog ? null : (
          <div className={cn(error ? "border-b" : "")}>
            <SettingRow
              label="OpenRecord hosted"
              icon={catalog.hosted ? <ProviderLogo provider={modelBrand(catalog.hosted.model, catalog.hosted.provider)} className="size-5" /> : undefined}
              description={
                catalog.hosted ? `${catalog.hosted.provider} · ${catalog.hosted.model}` : "No hosted provider is configured on this server."
              }
            >
              <span className="text-xs text-muted-foreground">{catalog.hosted ? "Available" : "Not configured"}</span>
            </SettingRow>
          </div>
        )}
        {catalog && error ? (
          <p role="status" className="px-4 py-2 text-xs text-muted-foreground">
            The list may be stale ({error}).{" "}
            <button type="button" className="font-medium text-foreground underline-offset-2 hover:underline" onClick={() => void reload()}>
              Retry
            </button>
          </p>
        ) : null}
        {catalog ? <Machines catalog={catalog} reload={reload} /> : null}
      </SettingGroup>
      {catalog?.local ? <LocalSetupGroup /> : null}
      <PairGroup local={catalog?.local === true} />
      <SettingGroup title="Privacy" description="Subscription credentials stay on each computer. The server stores provider status, account labels, and conversation data. Hosted-provider keys stay on the server.">
        <SettingRow label="Pairing codes" description="Work once, expire in ten minutes, and are shown only in this dialog, never stored." />
        <SettingRow label="Provider selection" description="Remembered in this browser only, never a credential, and re-validated by the server on every turn." />
      </SettingGroup>
    </>
  )
}
