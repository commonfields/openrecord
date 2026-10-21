// W8 Google Analytics panel inside the measurement page: connect (read-only),
// link one property and key event to the selected GA4 metric definition,
// synchronize history, refresh, and read connection health in plain language.
// Uses the page's existing panels and controls; no new layout.
import { useState } from "react"
import type { Ga4BindingHealth, Ga4Connection, Ga4KeyEventChoice, Ga4PropertyChoice } from "@openrecord/contracts"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Panel, PanelHeader } from "@/components/page"
import { useApi } from "@/lib/use-api"
import { GA4_CALLBACK_COPY, GA4_CONNECTION_COPY, GA4_FRESHNESS_COPY, GA4_SYNC_ERROR_COPY, Ga4, ga4CoverageLine, ga4Error } from "@/lib/growth-ga4"

type Definition = { id: string; label: string; version: number; sourceKind: string; timeZone: string; propertyRef: string | null; eventName: string | null }
const shift = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)
const when = (iso: string | null) => iso ? new Date(iso).toLocaleString() : "never"

export function Ga4Health({ health }: { health: Ga4BindingHealth }) {
  const b = health.binding
  const conn = GA4_CONNECTION_COPY[health.connectionStatus]
  return <div className="grid gap-1 text-xs">
    <p><span className="font-medium">{b.propertyDisplayName}</span> ({b.property}), key event <span className="font-mono">{b.eventName}</span>, counted as key events in {b.propertyTimeZone}. Read through {health.connectionEmail}.</p>
    <p><Badge variant={health.connectionStatus === "ACTIVE" ? "supported" : "review"}>{conn.title}</Badge> <span className="text-muted-foreground">{conn.detail}</span></p>
    <p><Badge variant={health.freshness === "FRESH" ? "supported" : health.freshness === "STALE" ? "review" : "unknown"}>{GA4_FRESHNESS_COPY[health.freshness]}</Badge>{" "}
      Last successful synchronization: {when(health.lastSuccessfulSyncAt)}.</p>
    <p>{ga4CoverageLine(health)}</p>
    {health.openJob ? <p>Synchronization of {health.openJob.dateStart} to {health.openJob.dateEnd} is {health.openJob.status === "CLAIMED" ? "running" : "queued"}.</p> : null}
    {health.lastErrorCode ? <p role="alert" className="text-destructive">Last attempt: {GA4_SYNC_ERROR_COPY[health.lastErrorCode] ?? health.lastErrorCode}</p> : null}
  </div>
}

function BindForm({ businessId, definition, connections, done }: { businessId: string; definition: Definition; connections: Ga4Connection[]; done: () => Promise<void> }) {
  const active = connections.filter(c => c.status === "ACTIVE")
  const [connectionId, setConnectionId] = useState(active[0]?.id ?? "")
  const [properties, setProperties] = useState<Ga4PropertyChoice[] | null>(null)
  const [property, setProperty] = useState("")
  const [keyEvents, setKeyEvents] = useState<Ga4KeyEventChoice[] | null>(null)
  const [eventName, setEventName] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [requestKey] = useState(() => crypto.randomUUID())
  const step = async (f: () => Promise<void>) => { setBusy(true); setError(null); try { await f() } catch (e) { setError(ga4Error(e)) } finally { setBusy(false) } }
  if (!active.length) return <p className="text-xs text-muted-foreground">Connect Google Analytics first.</p>
  return <div className="grid gap-3">
    <p className="text-xs text-muted-foreground">This metric counts the key event <span className="font-mono">{definition.eventName}</span> in {definition.propertyRef} ({definition.timeZone}). Only a property the connected Google account can read, with the same time zone and key event, can be linked.</p>
    <div className="flex flex-wrap items-end gap-2">
      <div className="grid min-w-56 gap-1"><Label htmlFor="ga4-connection">Connection</Label>
        <Select value={connectionId} onValueChange={v => { setConnectionId(v); setProperties(null); setKeyEvents(null) }}>
          <SelectTrigger id="ga4-connection"><SelectValue /></SelectTrigger>
          <SelectContent>{active.map(c => <SelectItem key={c.id} value={c.id}>{c.googleEmail}</SelectItem>)}</SelectContent>
        </Select>
      </div>
      <Button size="sm" variant="outline" disabled={busy || !connectionId} onClick={() => void step(async () => { setProperties((await Ga4.properties(connectionId)).properties) })}>Load properties</Button>
    </div>
    {properties ? <div className="flex flex-wrap items-end gap-2">
      <div className="grid min-w-72 gap-1"><Label htmlFor="ga4-property">Property</Label>
        <Select value={property} onValueChange={v => { setProperty(v); setKeyEvents(null); setEventName("") }}>
          <SelectTrigger id="ga4-property"><SelectValue placeholder={properties.length ? "Choose a property" : "No readable properties"} /></SelectTrigger>
          <SelectContent>{properties.map(p => <SelectItem key={p.property} value={p.property}>{p.displayName} ({p.property}) · {p.accountDisplayName}</SelectItem>)}</SelectContent>
        </Select>
      </div>
      <Button size="sm" variant="outline" disabled={busy || !property} onClick={() => void step(async () => { setKeyEvents((await Ga4.keyEvents(connectionId, property)).keyEvents) })}>Load key events</Button>
    </div> : null}
    {keyEvents ? <div className="flex flex-wrap items-end gap-2">
      <div className="grid min-w-56 gap-1"><Label htmlFor="ga4-event">Key event</Label>
        <Select value={eventName} onValueChange={setEventName}>
          <SelectTrigger id="ga4-event"><SelectValue placeholder={keyEvents.length ? "Choose the key event" : "No key events configured"} /></SelectTrigger>
          <SelectContent>{keyEvents.map(k => <SelectItem key={k.eventName} value={k.eventName}>{k.eventName}{k.countingMethod ? ` (${k.countingMethod.toLowerCase().replaceAll("_", " ")})` : ""}</SelectItem>)}</SelectContent>
        </Select>
      </div>
      <Button size="sm" disabled={busy || !eventName} onClick={() => void step(async () => {
        await Ga4.bind(businessId, { connectionId, property, metricDefinitionId: definition.id, eventName }, requestKey)
        await done()
      })}>Link property to {definition.label} v{definition.version}</Button>
    </div> : null}
    {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
  </div>
}

function SyncControls({ businessId, health, done }: { businessId: string; health: Ga4BindingHealth; done: () => Promise<void> }) {
  const latest = health.latestCompleteDay
  const [start, setStart] = useState(shift(latest, -89))
  const [end, setEnd] = useState(latest)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const request = async (kind: "BACKFILL" | "REFRESH", dateStart: string, dateEnd: string) => {
    setBusy(true); setError(null)
    try { await Ga4.sync(businessId, health.binding.id, { kind, dateStart, dateEnd }, crypto.randomUUID()); await done() } catch (e) { setError(ga4Error(e)) } finally { setBusy(false) }
  }
  const blocked = busy || health.connectionStatus !== "ACTIVE" || health.openJob !== null
  return <div className="grid gap-2">
    <div className="flex flex-wrap items-end gap-2">
      <Button size="sm" disabled={blocked} onClick={() => void request("REFRESH", shift(latest, -2), latest)}>Refresh now (last 3 days)</Button>
      <div className="grid gap-1"><Label htmlFor="ga4-from">History from</Label><Input id="ga4-from" type="date" value={start} max={latest} onChange={e => setStart(e.target.value)} /></div>
      <div className="grid gap-1"><Label htmlFor="ga4-to">to</Label><Input id="ga4-to" type="date" value={end} max={latest} onChange={e => setEnd(e.target.value)} /></div>
      <Button size="sm" variant="outline" disabled={blocked} onClick={() => void request("BACKFILL", start, end)}>Synchronize these dates</Button>
    </div>
    <p className="text-xs text-muted-foreground">Up to 366 complete days per request, ending no later than {latest} (yesterday in {health.binding.propertyTimeZone}). A repeated answer is confirmed, not stored twice; a changed figure is kept as a revision.</p>
    {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
  </div>
}

export function Ga4Panel({ businessId, definition, callbackStatus }: { businessId: string; definition: Definition | undefined; callbackStatus: string | null }) {
  const state = useApi(`ga4:${businessId}`, async () => {
    const [connections, bindings] = await Promise.all([Ga4.connections(), Ga4.bindings(businessId)])
    return { ...connections, ...bindings }
  })
  const [error, setError] = useState<string | null>(null)
  const callback = callbackStatus ? GA4_CALLBACK_COPY[callbackStatus] ?? null : null
  const go = async (connectionId: string | null) => {
    setError(null)
    try { window.location.assign((await Ga4.connect(businessId, connectionId)).authorizationUrl) } catch (e) { setError(ga4Error(e)) }
  }
  const disconnect = async (connectionId: string) => {
    if (!window.confirm("Disconnect this Google account? OpenRecord will ask Google to remove its access and erase the stored credentials. Figures already collected are kept.")) return
    setError(null)
    try { await Ga4.disconnect(connectionId); await state.reload() } catch (e) { setError(ga4Error(e)) }
  }
  const data = state.data
  const health = data && definition ? data.health.find(h => h.binding.metricDefinitionId === definition.id) ?? null : null
  return <Panel>
    <PanelHeader title="Google Analytics (read-only)" description="Collect daily key-event counts directly from Google Analytics instead of uploading files. OpenRecord only reads reports; it cannot change your Analytics setup. Uploading files stays available." />
    <div className="grid gap-4 p-5">
      {callback ? <p role={callback.ok ? "status" : "alert"} className={callback.ok ? "text-xs" : "text-xs text-destructive"}>{callback.text}</p> : null}
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
      {state.error ? <p role="alert" className="text-xs text-destructive">{ga4Error(state.error)}</p> : null}
      {!data ? <p className="text-xs text-muted-foreground">Loading Google Analytics status…</p>
        : !data.configured ? <p className="text-xs text-muted-foreground">Google Analytics access is not configured on this server. Daily figures can still be uploaded as files below.</p>
        : <>
          <section className="grid gap-2" aria-label="Google Analytics connections">
            {data.connections.length === 0 ? <p className="text-xs text-muted-foreground">No Google account is connected. Connecting records which Google account allowed read access; it does not show who owns a property.</p> : null}
            <ul className="divide-y text-xs">{data.connections.map(c => <li key={c.id} className="flex flex-wrap items-center gap-2 py-2">
              <Badge variant={c.status === "ACTIVE" ? "supported" : "review"}>{GA4_CONNECTION_COPY[c.status].title}</Badge>
              <span>{c.googleEmail}</span>
              <span className="text-muted-foreground">authorized {when(c.lastAuthorizedAt)}</span>
              {c.status !== "ACTIVE" ? <Button size="sm" variant="outline" onClick={() => void go(c.id)}>Reconnect</Button> : null}
              {c.status !== "DISCONNECTED" ? <Button size="sm" variant="ghost" onClick={() => void disconnect(c.id)}>Disconnect</Button> : null}
              {c.status === "DISCONNECTED" && c.revocationConfirmed === false ? <span className="text-muted-foreground">Google did not confirm the removal; remove OpenRecord in the Google account's third-party access too.</span> : null}
            </li>)}</ul>
            <Button size="sm" className="justify-self-start" onClick={() => void go(null)}>Connect Google Analytics</Button>
          </section>
          {!definition || definition.sourceKind !== "GA4_AGGREGATE_EXPORT"
            ? <p className="text-xs text-muted-foreground">The selected metric is not a Google Analytics key-event count, so it is measured from uploaded files only.</p>
            : health ? <section className="grid gap-3" aria-label="Linked property">
              <Ga4Health health={health} />
              <SyncControls businessId={businessId} health={health} done={state.reload} />
            </section>
            : <BindForm businessId={businessId} definition={definition} connections={data.connections} done={state.reload} />}
        </>}
    </div>
  </Panel>
}
