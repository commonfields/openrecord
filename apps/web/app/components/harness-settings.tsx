// Settings → Agent: the connection surface for agent providers. Bridges are
// paired from this screen, instances can be enabled or refresh-requested, and
// every state shown comes from the server catalog — nothing here fakes a
// connection. The pairing code lives in component state only; the page never
// writes secrets to persistent browser storage.
import { useState, type ReactNode } from "react"
import { toast } from "sonner"
import { CheckIcon, CopyIcon, RefreshCwIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Spinner } from "@/components/spinner"
import { formatDateTime } from "@/lib/format"
import {
  HARNESS_DRIVERS,
  HARNESS_NAMES,
  Harness,
  loginCommand,
  pairCommand,
  useHarnessCatalog,
  type HarnessBridge,
  type HarnessInstance,
} from "@/lib/harness"
import { cn } from "@/lib/utils"

function SettingGroup({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <div className="space-y-0.5">
        <h3 className="text-xs font-medium">{title}</h3>
        {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
      </div>
      <div className="divide-y rounded-xl border">{children}</div>
    </section>
  )
}

function SettingRow({ label, description, children }: { label: string; description?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
      <div className="min-w-0 space-y-0.5">
        <span className="block text-xs font-medium">{label}</span>
        {description ? <div className="text-xs text-muted-foreground">{description}</div> : null}
      </div>
      {children ? <div className="flex shrink-0 items-center gap-2">{children}</div> : null}
    </div>
  )
}

function CopyCommand({ value }: { value: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <span className="flex min-w-0 items-center gap-1">
      <code className="block min-w-0 flex-1 overflow-x-auto rounded-md bg-muted px-2 py-1.5 font-mono text-xs text-muted-foreground">{value}</code>
      <Button
        variant="ghost"
        size="icon-sm"
        className="size-7 text-muted-foreground"
        aria-label="Copy setup command"
        onClick={() =>
          void navigator.clipboard
            .writeText(value)
            .then(() => {
              setCopied(true)
              toast.success("Setup command copied")
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

const stateBadge: Record<HarnessInstance["state"], { label: string; variant: "supported" | "partial" | "wrong" | "unknown" }> = {
  ready: { label: "Ready", variant: "supported" },
  usage_limited: { label: "Usage limited", variant: "partial" },
  unavailable: { label: "Unavailable", variant: "wrong" },
  error: { label: "Error", variant: "wrong" },
  offline: { label: "Offline", variant: "unknown" },
}

// The downloadable bridge, built and served by the backend.
const BRIDGE_SCRIPT = "/openrecord-bridge.mjs"

function LoginHint({ instance }: { instance: HarnessInstance }) {
  return (
    <div className="mt-2 space-y-1">
      <p className="text-[0.6875rem] text-muted-foreground">
        {instance.auth === "unauthenticated"
          ? "Sign in on this machine, then refresh here:"
          : "Sign-in state is unknown. If a turn fails, sign in with:"}
      </p>
      <CopyCommand value={loginCommand(instance.driver, instance.localId)} />
    </div>
  )
}

function InstanceRow({ instance, reload }: { instance: HarnessInstance; reload: () => Promise<void> }) {
  const badge = stateBadge[instance.state]
  const [working, setWorking] = useState<"enable" | "refresh" | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshNote, setRefreshNote] = useState(false)

  const toggle = (enabled: boolean) =>
    void (async () => {
      setWorking("enable")
      setError(null)
      try {
        await Harness.setEnabled(instance.id, enabled)
        await reload()
      } catch {
        setError("Couldn't save that. The provider state may have changed — try again.")
      } finally {
        setWorking(null)
      }
    })()

  const refresh = () =>
    void (async () => {
      setWorking("refresh")
      setError(null)
      try {
        await Harness.refresh(instance.id)
        setRefreshNote(true)
        // The bridge reports its catalog periodically; the next poll shows it.
        await reload()
      } catch {
        setError("Couldn't request a refresh. Try again in a moment.")
      } finally {
        setWorking(null)
      }
    })()

  return (
    <div className="px-4 py-3.5">
      {instance.modelsTruncated ? <p role="status" className="mb-2 text-xs text-muted-foreground">This provider's catalog was too large. Only the first {instance.models.length} models are available here.</p> : null}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
        <div className="min-w-0 space-y-1">
          <span className="block text-xs font-medium">{instance.name}</span>
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            {instance.accountLabel ? <span>{instance.accountLabel}</span> : null}
            <Badge variant={badge.variant}>{badge.label}</Badge>
            {instance.auth === "unauthenticated" ? (
              <Badge variant="partial">Needs sign-in on this machine</Badge>
            ) : instance.auth === "unknown" ? (
              <Badge variant="unknown">Sign-in state unknown</Badge>
            ) : null}
            {!instance.installed ? <Badge variant="unknown">Not installed</Badge> : null}
            <span>{instance.version ? `${HARNESS_NAMES[instance.driver]} ${instance.version}` : "Version unknown"}</span>
            <span>
              {instance.models.length} model{instance.models.length === 1 ? "" : "s"}
            </span>
          </div>
          {instance.auth !== "authenticated" ? <LoginHint instance={instance} /> : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Tooltip>
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
          </Tooltip>
          <Switch
            aria-label={`Turn ${instance.name} ${instance.enabled ? "off" : "on"}`}
            checked={instance.enabled}
            disabled={working !== null}
            onCheckedChange={(v) => toggle(v)}
          />
        </div>
      </div>
      {error ? <p role="alert" className="mt-2 text-xs text-destructive">{error}</p> : null}
      {refreshNote && !error ? (
        <p role="status" className="mt-2 text-xs text-muted-foreground">
          Refresh requested. The bridge reports its catalog periodically, so state and models may take a moment.
        </p>
      ) : null}
    </div>
  )
}

function BridgeRow({ bridge, reload }: { bridge: HarnessBridge; reload: () => Promise<void> }) {
  const [working, setWorking] = useState(false)
  const revoke = () =>
    void (async () => {
      setWorking(true)
      try {
        await Harness.revokeBridge(bridge.id)
        toast.success(`${bridge.name} revoked`)
        await reload()
      } catch {
        toast.error("Couldn't revoke the bridge. It may already be revoked — try again.")
      } finally {
        setWorking(false)
      }
    })()
  return (
    <SettingRow
      label={bridge.name}
      description={bridge.online ? "Connected to this server." : "Paired, but not reachable right now."}
    >
      <Badge variant={bridge.online ? "supported" : "unknown"}>{bridge.online ? "Online" : "Offline"}</Badge>
      <Button variant="outline" size="sm" disabled={working} onClick={revoke}>
        Revoke
      </Button>
    </SettingRow>
  )
}

function PairGroup() {
  const [name, setName] = useState("This computer")
  // The pairing code exists only in this component and expires server-side;
  // closing settings discards it. No secrets are stored.
  const [pairing, setPairing] = useState<{ name: string; code: string; expiresAt: string } | null>(null)
  const [pending, setPending] = useState(false)

  const requestPairing = () =>
    void (async () => {
      setPending(true)
      try {
        const r = await Harness.pair(name.trim() || "This computer")
        setPairing({ name: name.trim() || "This computer", code: r.code, expiresAt: r.expiresAt })
      } catch {
        toast.error("Couldn't create a pairing code. Try again.")
      } finally {
        setPending(false)
      }
    })()

  return (
    <SettingGroup
      title="Pair this computer"
      description="Connect a machine's local CLI tools to your OpenRecord account. The pairing code is a short-lived capability to connect; provider work runs with CLI credentials that stay on that machine, and the app never asks for them."
    >
      {pairing ? (
        <div className="space-y-3 px-4 py-3.5">
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-0.5">
              <p className="text-xs font-medium">Pairing code for {pairing.name}</p>
              <p className="text-xs text-muted-foreground">
                Expires {formatDateTime(pairing.expiresAt)}. On the machine whose CLI tools you want to connect, download the bridge, then run the
                setup command in the folder you saved it to.
              </p>
            </div>
            <Button variant="outline" size="sm" onClick={() => setPairing(null)}>
              Discard
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button asChild variant="outline" size="sm">
              <a href={BRIDGE_SCRIPT} download>
                Download bridge
              </a>
            </Button>
            <span className="text-[0.6875rem] text-muted-foreground">Single script. Needs Node 24 or later.</span>
          </div>
          <p className="text-xs text-wrong" role="status">
            The pairing code connects whoever holds it while it is valid. Don't share it.
          </p>
          <CopyCommand value={pairCommand(pairing.code)} />
        </div>
      ) : (
        <SettingRow label="New pairing" description="Shows a short-lived code and the command that pairs a machine.">
          <Input
            id="bridge-pair-name"
            value={name}
            onChange={(e) => setName(e.currentTarget.value)}
            maxLength={100}
            aria-label="Bridge name"
            className="w-40"
          />
          <Button size="sm" disabled={pending} onClick={requestPairing}>
            {pending ? <Spinner className="size-3.5" /> : null}
            Get pairing code
          </Button>
        </SettingRow>
      )}
      <SettingRow
        label="Download the bridge"
        description="One script, Node 24 or later. Keep it where you will run the pair and sign-in commands."
      >
        <Button asChild variant="outline" size="sm">
          <a href={BRIDGE_SCRIPT} download>
            Download bridge
          </a>
        </Button>
      </SettingRow>
    </SettingGroup>
  )
}

export function AgentConnectionSection() {
  const { catalog, loading, error, reload } = useHarnessCatalog({ pollMs: 5000 })

  return (
    <>
      <SettingGroup title="Connection" description="Which agent this app talks to. A turn needs a hosted default or an enabled provider from a paired bridge.">
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
              description={
                catalog.hosted ? `${catalog.hosted.provider} · ${catalog.hosted.model}` : "No hosted provider is configured on this server."
              }
            >
              <Badge variant={catalog.hosted ? "supported" : "unknown"}>{catalog.hosted ? "Available" : "Not configured"}</Badge>
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
        {catalog ? (
          catalog.bridges.length ? (
            catalog.bridges.map(bridge => <BridgeRow key={bridge.id} bridge={bridge} reload={reload} />)
          ) : (
            <SettingRow label="Bridges" description="Nothing is paired from your machines yet. Pair a bridge below to expose local CLI tools here." />
          )
        ) : null}
        {catalog
          ? HARNESS_DRIVERS.map(driver => {
              const instances = catalog.instances.filter(i => i.driver === driver)
              if (!instances.length) {
                return (
                  <SettingRow
                    key={driver}
                    label={HARNESS_NAMES[driver]}
                    description="Not reported by any paired bridge yet."
                  />
                )
              }
              return instances.map(instance => <InstanceRow key={instance.id} instance={instance} reload={reload} />)
            })
          : null}
      </SettingGroup>
      <PairGroup />
      <SettingGroup title="Privacy" description="Subscription credentials stay on your bridge machine. The server stores provider status, account labels, and conversation data. Hosted-provider keys stay on the server. Pairing codes stay in this dialog until you discard them or it closes.">
        <SettingRow label="Pairing codes" description="Short-lived capability codes; shown only in this dialog, never stored." />
        <SettingRow label="Provider selection" description="Remembered in this browser only, never a credential, and re-validated by the server on every turn." />
      </SettingGroup>
    </>
  )
}
