// Google Search Console in two places: choosing the site for a business
// (Channels) and reading its search performance (Results). Read-only; the
// Google connection is the one Google Analytics uses.
import { useEffect, useState } from "react"
import { Link, useLocation, useSearchParams } from "react-router"
import { SearchIcon } from "lucide-react"
import type { SearchPerformanceDays, SearchPerformanceRow, SearchTotals } from "@openrecord/contracts"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { PeriodSelect } from "@/components/period-select"
import { Panel, PanelHeader, StatStrip, pathOf } from "@/components/page"
import { GA4_CALLBACK_COPY } from "@/lib/growth-ga4"
import { GOOGLE_CALLBACK_COPY, SearchConsole, searchConsoleError, siteLabel, type SearchConsoleSiteChoice } from "@/lib/search-console"
import { useApi } from "@/lib/use-api"
import { cn } from "@/lib/utils"

/** Links here use #search-console; the panel renders after its data loads, so scroll then. */
function useScrollIntoViewOnHash(ready: boolean) {
  const { hash } = useLocation()
  useEffect(() => {
    if (ready && hash === "#search-console") document.getElementById("search-console")?.scrollIntoView({ behavior: "smooth", block: "start" })
  }, [ready, hash])
}

/** Connect Google and choose which Search Console site describes this business. */
export function SearchConsoleSetup({ businessId, onChange }: { businessId: string; onChange?: () => void }) {
  const status = useApi(`search-console:${businessId}`, () => SearchConsole.status(businessId))
  const [params] = useSearchParams()
  const callback = params.get("google")
  const callbackCopy = callback ? GOOGLE_CALLBACK_COPY[callback] ?? GA4_CALLBACK_COPY[callback] : undefined
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [changing, setChanging] = useState(false)
  const s = status.data
  useScrollIntoViewOnHash(Boolean(s?.configured))
  if (!s) return status.loading ? <Skeleton className="h-24 rounded-xl" /> : null
  if (!s.configured) return null
  const act = async (f: () => Promise<void>) => {
    setBusy(true); setError(null)
    try { await f(); await status.reload(); onChange?.() } catch (e) { setError(searchConsoleError(e)) } finally { setBusy(false) }
  }
  const connect = (connectionId: string | null) => act(async () => { window.location.assign((await SearchConsole.connect(businessId, connectionId)).authorizationUrl) })
  const readable = s.connections.filter(c => c.status === "ACTIVE" && c.searchConsole)
  const upgradable = s.connections.find(c => c.status === "ACTIVE" && !c.searchConsole) ?? s.connections.find(c => c.status === "REAUTHORIZATION_REQUIRED")
  const email = (id: string) => s.connections.find(c => c.id === id)?.googleEmail ?? "a Google account"

  return (
    <Panel id="search-console" className="space-y-3 p-4">
      <div className="flex items-start gap-2">
        <SearchIcon aria-hidden className="mt-0.5 size-3.5 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <h2 className="text-xs font-medium">Google Search Console</h2>
          <p className="text-[0.6875rem] text-muted-foreground">Which Google searches show your site and bring people to it. Read-only: OpenRecord cannot change anything in Search Console.</p>
        </div>
      </div>
      {callbackCopy ? <p role="status" className={cn("text-xs", callbackCopy.ok ? "text-foreground" : "text-destructive")}>{callbackCopy.text}</p> : null}
      {s.binding && !changing ? (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <p className="min-w-0 flex-1">Reading <span className="font-medium">{siteLabel(s.binding.siteUrl)}</span> through {email(s.binding.connectionId)}.</p>
          <Button size="sm" variant="outline" asChild><Link to={`/businesses/${businessId}/results#search-console`}>See performance</Link></Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setChanging(true)}>Change site</Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act(async () => { await SearchConsole.unbind(businessId) })}>Stop reading</Button>
        </div>
      ) : readable.length ? (
        <SitePicker businessId={businessId} connections={readable} busy={busy}
          onPick={(connectionId, siteUrl) => void act(async () => { await SearchConsole.bind(businessId, connectionId, siteUrl); setChanging(false) })}
          onCancel={s.binding ? () => setChanging(false) : null} />
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {upgradable ? (
            <>
              <Button size="sm" disabled={busy} onClick={() => void connect(upgradable.id)}>Add Search Console to {upgradable.googleEmail}</Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void connect(null)}>Use another Google account</Button>
            </>
          ) : <Button size="sm" disabled={busy} onClick={() => void connect(null)}>Connect Google Search Console</Button>}
          <p className="w-full text-[0.6875rem] text-muted-foreground">You'll sign in with Google and allow read-only access to Search Console and Analytics.</p>
        </div>
      )}
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
    </Panel>
  )
}

function SitePicker({ businessId, connections, busy, onPick, onCancel }: {
  businessId: string; connections: Array<{ id: string; googleEmail: string }>; busy: boolean
  onPick: (connectionId: string, siteUrl: string) => void; onCancel: (() => void) | null
}) {
  const [connectionId, setConnectionId] = useState(connections[0]!.id)
  const [sites, setSites] = useState<SearchConsoleSiteChoice[] | null>(null)
  const [site, setSite] = useState("")
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    setSites(null); setError(null)
    void SearchConsole.sites(businessId, connectionId).then(r => {
      if (!live) return
      setSites(r.sites)
      setSite(r.sites.find(x => x.matchesWebsite)?.siteUrl ?? r.sites[0]?.siteUrl ?? "")
    }).catch(e => { if (live) setError(searchConsoleError(e)) })
    return () => { live = false }
  }, [businessId, connectionId])
  return (
    <div className="flex flex-wrap items-end gap-2 text-xs">
      {connections.length > 1 ? (
        <Select value={connectionId} onValueChange={setConnectionId}>
          <SelectTrigger aria-label="Google account" className="w-56"><SelectValue /></SelectTrigger>
          <SelectContent>{connections.map(c => <SelectItem key={c.id} value={c.id}>{c.googleEmail}</SelectItem>)}</SelectContent>
        </Select>
      ) : null}
      {sites === null && !error ? <Skeleton className="h-8 w-64" /> : sites && sites.length === 0 ? (
        <p className="text-muted-foreground">This Google account has no verified Search Console sites. Add your site in Search Console, then come back.</p>
      ) : sites ? (
        <>
          <Select value={site} onValueChange={setSite}>
            <SelectTrigger aria-label="Search Console site" className="w-72"><SelectValue placeholder="Choose a site" /></SelectTrigger>
            <SelectContent>{sites.map(x => <SelectItem key={x.siteUrl} value={x.siteUrl}>{siteLabel(x.siteUrl)}{x.matchesWebsite ? " · your website" : ""}</SelectItem>)}</SelectContent>
          </Select>
          <Button size="sm" disabled={busy || !site} onClick={() => onPick(connectionId, site)}>Use this site</Button>
        </>
      ) : null}
      {onCancel ? <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>Cancel</Button> : null}
      {error ? <p role="alert" className="w-full text-destructive">{error}</p> : null}
    </div>
  )
}

const count = (n: number) => n.toLocaleString()
const pct = (n: number) => `${(n * 100).toFixed(1)}%`
/** Relative change; for position, lower is better, so the sign shown is the improvement. */
const delta = (now: number | null, before: number | null, lowerIsBetter = false) => {
  if (now === null || before === null || before === 0) return null
  const change = (now - before) / before
  const better = lowerIsBetter ? change < 0 : change > 0
  if (Math.abs(change) < 0.005) return <span className="text-muted-foreground">no change</span>
  return <span className={better ? "text-supported" : "text-wrong"}>{change > 0 ? "+" : ""}{Math.round(change * 100)}%</span>
}

/** Live Google Search performance for the business's site, beside the other results. */
export function SearchPerformancePanel({ businessId }: { businessId: string }) {
  const status = useApi(`search-console:${businessId}`, () => SearchConsole.status(businessId))
  const [days, setDays] = useState<SearchPerformanceDays>(28)
  const bound = status.data?.binding ?? null
  const perf = useApi(bound ? `search-performance:${businessId}:${bound.id}:${days}` : null, () => SearchConsole.performance(businessId, days))
  useScrollIntoViewOnHash(Boolean(status.data?.configured))
  if (!status.data?.configured) return null
  if (!bound) return (
    <Panel id="search-console" className="flex flex-wrap items-center gap-3 p-4 text-xs">
      <SearchIcon aria-hidden className="size-3.5 text-muted-foreground" />
      <p className="min-w-0 flex-1">Connect Google Search Console to see which searches show your site and how many people click through.</p>
      <Button asChild size="sm" variant="outline"><Link to={`/businesses/${businessId}/channels#search-console`}>Connect</Link></Button>
    </Panel>
  )
  const p = perf.data?.performance
  const totals = (t: SearchTotals | undefined) => t ?? { clicks: 0, impressions: 0, ctr: 0, position: null }
  const c = totals(p?.current.totals), b = totals(p?.previous.totals)
  return (
    <Panel id="search-console">
      <PanelHeader icon={<SearchIcon />} title="Google Search" description={p ? `${siteLabel(p.siteUrl)}, ${p.current.start} to ${p.current.end}, compared with the ${days} days before` : siteLabel(bound.siteUrl)}>
        <PeriodSelect value={days} options={[7, 28, 90] as const} onChange={setDays} />
      </PanelHeader>
      {perf.error && !p ? <p role="alert" className="px-4 pb-4 text-xs text-destructive">{searchConsoleError(perf.error)}</p> : !p ? <Skeleton className="m-4 h-24 rounded-lg" /> : (
        <div className="space-y-4 px-4 pb-4">
          <StatStrip stats={[
            { key: "clicks", label: "Clicks", value: count(c.clicks), delta: delta(c.clicks, b.clicks) },
            { key: "impressions", label: "Impressions", value: count(c.impressions), delta: delta(c.impressions, b.impressions) },
            { key: "ctr", label: "Click-through rate", value: pct(c.ctr), delta: delta(c.ctr, b.ctr) },
            { key: "position", label: "Average position", value: c.position === null ? "—" : c.position.toFixed(1), delta: delta(c.position, b.position, true), hint: "Lower is better" },
          ]} />
          <div className="grid gap-4 md:grid-cols-2">
            <TopRows title="Top searches" rows={p.topQueries} />
            <TopRows title="Top pages" rows={p.topPages} page />
          </div>
          <p className="text-[0.6875rem] text-muted-foreground">From Google Search Console, read live; Google's data ends about three days ago. Google Search only, not AI answers. Changes between periods describe what happened, not why.</p>
        </div>
      )}
    </Panel>
  )
}

function TopRows({ title, rows, page = false }: { title: string; rows: ReadonlyArray<SearchPerformanceRow>; page?: boolean }) {
  return (
    <div className="space-y-1.5">
      <h3 className="text-[0.6875rem] font-medium text-muted-foreground">{title}</h3>
      {rows.length === 0 ? <p className="text-xs text-muted-foreground">No data for this period.</p> : (
        <ol className="space-y-1 text-xs">
          {rows.map(r => (
            <li key={r.key} className="flex items-baseline gap-2">
              <span className="min-w-0 flex-1 truncate" title={r.key}>{page ? pathOf(r.key) : r.key}</span>
              <span className="tabular-nums">{count(r.clicks)}</span>
              <span className="w-20 text-right text-muted-foreground tabular-nums">{count(r.impressions)} seen</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
