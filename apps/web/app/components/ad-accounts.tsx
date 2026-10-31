// The client's own ad accounts on Meta and Google Ads, in two places:
// connecting and choosing accounts (Channels) and reading their performance
// (Results). Read-only: OpenRecord cannot create, change or pause an ad.
import { useEffect, useMemo, useState } from "react"
import { Link, useLocation, useSearchParams } from "react-router"
import { MapPinIcon, MegaphoneIcon, StarIcon } from "lucide-react"
import { AD_PROVIDER_NAME, AD_PROVIDERS, CHANNEL_PROVIDERS, type AdCampaignRow, type AdConnection, type AdPerformanceDays, type ChannelProvider, type LocalTotals } from "@openrecord/contracts"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { PeriodSelect } from "@/components/period-select"
import { Panel, PanelHeader, StatStrip } from "@/components/page"
import { ADS_CALLBACK_COPY, Ads, SETUP_NEEDED, adsError, type AdAccountChoice } from "@/lib/ads"
import { useApi } from "@/lib/use-api"
import { cn } from "@/lib/utils"

const BLURB: Record<ChannelProvider, string> = {
  google_business: "Your Google listing on Search and Maps: calls, directions, searches and reviews.",
  meta: "Facebook and Instagram ads: spend, clicks, leads and purchases.",
  google_ads: "Search, YouTube and Display ads: spend, clicks and conversions.",
}

/** Connect Meta and Google Ads, and choose which ad accounts belong to this business. */
export function AdAccountsSetup({ businessId }: { businessId: string }) {
  const status = useApi(`ads:${businessId}`, () => Ads.status(businessId))
  const [params] = useSearchParams()
  const callback = params.get("ads")
  const callbackCopy = callback ? ADS_CALLBACK_COPY[callback] : undefined
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { hash } = useLocation()
  useEffect(() => { if (status.data && hash === "#ads") document.getElementById("ads")?.scrollIntoView({ behavior: "smooth", block: "start" }) }, [status.data, hash])
  const s = status.data
  if (!s) return status.loading ? <Skeleton className="h-32 rounded-xl" /> : null
  const act = async (f: () => Promise<void>) => {
    setBusy(true); setError(null)
    try { await f(); await status.reload() } catch (e) { setError(adsError(e)) } finally { setBusy(false) }
  }
  const connect = (provider: ChannelProvider) => act(async () => { window.location.assign((await Ads.connect(businessId, provider)).authorizationUrl) })

  return (
    <Panel id="ads" className="space-y-3 p-4">
      <div className="flex items-start gap-2">
        <MegaphoneIcon aria-hidden className="mt-0.5 size-3.5 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <h2 className="text-xs font-medium">Ads and Google listing</h2>
          <p className="text-[0.6875rem] text-muted-foreground">So the agent can see what the ads cost, what they bring in, and how people find you on Google. Read-only: OpenRecord can't change an ad, edit your listing or reply to reviews.</p>
        </div>
      </div>
      {callbackCopy ? <p role="status" className={cn("text-xs", callbackCopy.ok ? "text-foreground" : "text-destructive")}>{callbackCopy.text}</p> : null}
      <ul className="divide-y divide-border">
        {CHANNEL_PROVIDERS.map(provider => {
          const platform = s.providers[provider]
          const bound = s.bindings.filter(b => b.provider === provider)
          const signIns = s.connections.filter(c => c.provider === provider)
          const active = signIns.filter(c => c.status === "ACTIVE")
          const expired = signIns.filter(c => c.status === "REAUTHORIZATION_REQUIRED")
          return (
            <li key={provider} className="space-y-2 py-3 first:pt-0 last:pb-0">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <h3 className="text-xs font-medium">{AD_PROVIDER_NAME[provider]}</h3>
                <p className="text-[0.6875rem] text-muted-foreground">{BLURB[provider]}</p>
              </div>
              {!platform.configured ? (
                <p className="text-[0.6875rem] text-muted-foreground">Not switched on for this OpenRecord server yet. {SETUP_NEEDED[provider][platform.reason] ?? ""}</p>
              ) : (
                <>
                  {bound.map(b => (
                    <div key={b.id} className="flex flex-wrap items-center gap-2 text-xs">
                      <p className="min-w-0 flex-1">Reading <span className="font-medium">{b.name}</span>{b.currency ? ` (${b.currency})` : ""} through {signIns.find(c => c.id === b.connectionId)?.displayName ?? "a sign-in"}.</p>
                      <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act(async () => { await Ads.unbind(businessId, b.id) })}>Stop reading</Button>
                    </div>
                  ))}
                  {expired.map(c => (
                    <div key={c.id} className="flex flex-wrap items-center gap-2 text-xs">
                      <p className="min-w-0 flex-1 text-destructive">{c.displayName}'s sign-in expired{provider === "meta" ? " (Meta asks again about every 60 days)" : ""}.</p>
                      <Button size="sm" disabled={busy} onClick={() => void connect(provider)}>Reconnect</Button>
                    </div>
                  ))}
                  {active.length ? (
                    <AccountPicker connections={active} bound={bound.map(b => b.externalId).join(",")} busy={busy}
                      onPick={(connectionId, externalId) => void act(async () => { await Ads.bind(businessId, connectionId, externalId) })}
                      onAnother={() => void connect(provider)}
                      onDisconnect={id => void act(async () => { await Ads.disconnect(id) })} />
                  ) : !expired.length ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <Button size="sm" disabled={busy} onClick={() => void connect(provider)}>Connect {AD_PROVIDER_NAME[provider]}</Button>
                      <p className="text-[0.6875rem] text-muted-foreground">
                        {provider === "meta" ? "You'll sign in with Facebook and allow read-only access to ads (ads_read)."
                          : provider === "google_ads" ? "You'll sign in with Google. Google offers no read-only option for ads, so OpenRecord only ever reads."
                          : "You'll sign in with Google. Google offers no read-only option for Business Profile, so OpenRecord only ever reads."}
                      </p>
                    </div>
                  ) : null}
                </>
              )}
            </li>
          )
        })}
      </ul>
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
    </Panel>
  )
}

function AccountPicker({ connections, bound, busy, onPick, onAnother, onDisconnect }: {
  connections: AdConnection[]; bound: string; busy: boolean
  onPick: (connectionId: string, externalId: string) => void; onAnother: () => void; onDisconnect: (connectionId: string) => void
}) {
  const [connectionId, setConnectionId] = useState(connections[0]!.id)
  const [accounts, setAccounts] = useState<AdAccountChoice[] | null>(null)
  const [choice, setChoice] = useState("")
  const [error, setError] = useState<string | null>(null)
  // The bound ad accounts as one string, so the list is read again only when they change.
  const boundIds = useMemo(() => new Set(bound.split(",").filter(Boolean)), [bound])
  useEffect(() => {
    let live = true
    setAccounts(null); setError(null)
    void Ads.accounts(connectionId).then(r => {
      if (!live) return
      setAccounts(r.accounts)
      setChoice(r.accounts.find(a => a.active && !boundIds.has(a.externalId))?.externalId ?? "")
    }).catch(e => { if (live) setError(adsError(e)) })
    return () => { live = false }
  }, [connectionId, boundIds])
  const open = accounts?.filter(a => !boundIds.has(a.externalId)) ?? []
  return (
    <div className="flex flex-wrap items-end gap-2 text-xs">
      {connections.length > 1 ? (
        <Select value={connectionId} onValueChange={setConnectionId}>
          <SelectTrigger aria-label="Signed in as" className="w-48"><SelectValue /></SelectTrigger>
          <SelectContent>{connections.map(c => <SelectItem key={c.id} value={c.id}>{c.displayName}</SelectItem>)}</SelectContent>
        </Select>
      ) : null}
      {accounts === null && !error ? <Skeleton className="h-7 w-64" /> : accounts && accounts.length === 0 ? (
        <p className="text-muted-foreground">This sign-in can't see any ad accounts. Ask the business to add it to their ad account, then come back.</p>
      ) : open.length ? (
        <>
          <Select value={choice} onValueChange={setChoice}>
            <SelectTrigger aria-label="Ad account" className="w-72"><SelectValue placeholder="Choose an ad account" /></SelectTrigger>
            <SelectContent>{open.map(a => <SelectItem key={a.externalId} value={a.externalId}>{a.name}{a.currency ? ` · ${a.currency}` : ""}{a.active ? "" : " · inactive"}</SelectItem>)}</SelectContent>
          </Select>
          <Button size="sm" disabled={busy || !choice} onClick={() => onPick(connectionId, choice)}>Use this account</Button>
        </>
      ) : accounts ? <p className="text-muted-foreground">Every ad account this sign-in can see is already added.</p> : null}
      <Button size="sm" variant="ghost" disabled={busy} onClick={onAnother}>Use another sign-in</Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => onDisconnect(connectionId)}>Disconnect</Button>
      {error ? <p role="alert" className="w-full text-destructive">{error}</p> : null}
    </div>
  )
}

const FAILURE: Record<string, string> = {
  AdsReauthorizationRequired: "the sign-in expired. Reconnect it on the Channels page.",
  AdAccountNotAccessible: "the signed-in person can no longer read this ad account.",
  ProviderQuota: "the platform's rate limit was reached. Try again in a few minutes.",
}
const count = (n: number) => Math.round(n).toLocaleString()
const money = (n: number | null, currency: string | null) => n === null ? "—" : currency ? new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: n < 10 ? 2 : 0 }).format(n) : n.toFixed(2)
/** Relative change; for costs, lower is better, so the colour shows the improvement. */
const delta = (now: number | null, before: number | null, lowerIsBetter = false) => {
  if (now === null || before === null || before === 0) return null
  const change = (now - before) / before
  if (Math.abs(change) < 0.005) return <span className="text-muted-foreground">no change</span>
  return <span className={(lowerIsBetter ? change < 0 : change > 0) ? "text-supported" : "text-wrong"}>{change > 0 ? "+" : ""}{Math.round(change * 100)}%</span>
}

/** Live performance of every ad account bound to this business, beside the other results. */
export function AdPerformancePanel({ businessId }: { businessId: string }) {
  const status = useApi(`ads:${businessId}`, () => Ads.status(businessId))
  const [days, setDays] = useState<AdPerformanceDays>(28)
  const bound = status.data?.bindings ?? []
  const perf = useApi(bound.some(b => b.provider !== "google_business") ? `ad-performance:${businessId}:${bound.map(b => b.id).join(",")}:${days}` : null, () => Ads.performance(businessId, days))
  const anyConfigured = status.data ? AD_PROVIDERS.some(p => status.data!.providers[p].configured) : false
  const adBound = bound.filter(b => b.provider !== "google_business")
  if (!status.data || !anyConfigured) return null
  if (!adBound.length) return (
    <Panel id="ads" className="flex flex-wrap items-center gap-3 p-4 text-xs">
      <MegaphoneIcon aria-hidden className="size-3.5 text-muted-foreground" />
      <p className="min-w-0 flex-1">Connect Meta or Google Ads to see what the ads cost and what they bring in.</p>
      <Button asChild size="sm" variant="outline"><Link to={`/businesses/${businessId}/channels#ads`}>Connect</Link></Button>
    </Panel>
  )
  const r = perf.data
  return (
    <Panel id="ads">
      <PanelHeader icon={<MegaphoneIcon />} title="Ads" description={r?.accounts[0] ? `${r.accounts[0].current.start} to ${r.accounts[0].current.end}, compared with the ${days} days before` : "Meta and Google Ads"}>
        <PeriodSelect value={days} options={[7, 28, 90] as const} onChange={setDays} />
      </PanelHeader>
      {perf.error && !r ? <p role="alert" className="px-4 pb-4 text-xs text-destructive">{adsError(perf.error)}</p> : !r ? <Skeleton className="m-4 h-24 rounded-lg" /> : (
        <div className="space-y-5 px-4 pb-4">
          {r.accounts.map(a => {
            const c = a.current.totals, b = a.previous.totals
            return (
              <section key={`${a.provider}:${a.externalId}`} className="space-y-3" aria-label={`${AD_PROVIDER_NAME[a.provider]}: ${a.accountName}`}>
                <h3 className="text-xs font-medium">{AD_PROVIDER_NAME[a.provider]} <span className="font-normal text-muted-foreground">{a.accountName}</span></h3>
                <StatStrip stats={[
                  { key: "spend", label: "Spend", value: money(c.spend, a.currency), delta: delta(c.spend, b.spend) },
                  { key: "clicks", label: "Clicks", value: count(c.clicks), delta: delta(c.clicks, b.clicks) },
                  { key: "conversions", label: "Conversions", value: count(c.conversions), delta: delta(c.conversions, b.conversions) },
                  { key: "cpa", label: "Cost per conversion", value: money(c.costPerConversion, a.currency), delta: delta(c.costPerConversion, b.costPerConversion, true), hint: "Lower is better" },
                  ...(c.conversionValue > 0 ? [{ key: "roas", label: "Return on ad spend", value: c.roas === null ? "—" : `${c.roas.toFixed(1)}×`, delta: delta(c.roas, b.roas) }] : []),
                ]} />
                <Campaigns rows={a.topCampaigns} currency={a.currency} />
                <p className="text-[0.6875rem] text-muted-foreground">{a.conversionDefinition}</p>
              </section>
            )
          })}
          {r.failures.map(f => <p key={`${f.provider}:${f.accountName}`} role="alert" className="text-xs text-destructive">{AD_PROVIDER_NAME[f.provider]} · {f.accountName}: {FAILURE[f.reason] ?? "The platform didn't answer. Try again later."}</p>)}
          <p className="text-[0.6875rem] text-muted-foreground">Read live from the ad platforms; data ends yesterday. Each platform credits its own ads, so their conversions overlap. Changes between periods describe what happened, not why.</p>
        </div>
      )}
    </Panel>
  )
}

function Campaigns({ rows, currency }: { rows: ReadonlyArray<AdCampaignRow>; currency: string | null }) {
  if (!rows.length) return <p className="text-xs text-muted-foreground">No campaign spent money in this period.</p>
  return (
    <div className="space-y-1.5">
      <h4 className="text-[0.6875rem] font-medium text-muted-foreground">Top campaigns by spend</h4>
      <ol className="space-y-1 text-xs">
        {rows.slice(0, 5).map(r => (
          <li key={r.id || r.name} className="flex items-baseline gap-2">
            <span className="min-w-0 flex-1 truncate" title={r.name}>{r.name || "Unnamed campaign"}</span>
            <span className="tabular-nums">{money(r.spend, currency)}</span>
            <span className="w-24 text-right text-muted-foreground tabular-nums">{count(r.conversions)} conv.</span>
          </li>
        ))}
      </ol>
    </div>
  )
}

/** Live Google Business Profile performance: what people did from the listing, how often it was shown, what they searched, and reviews. */
export function LocalProfilePanel({ businessId }: { businessId: string }) {
  const status = useApi(`ads:${businessId}`, () => Ads.status(businessId))
  const [days, setDays] = useState<AdPerformanceDays>(28)
  const bound = (status.data?.bindings ?? []).filter(b => b.provider === "google_business")
  const perf = useApi(bound.length ? `local:${businessId}:${bound.map(b => b.id).join(",")}:${days}` : null, () => Ads.local(businessId, days))
  if (!status.data?.providers.google_business.configured) return null
  if (!bound.length) return (
    <Panel id="local" className="flex flex-wrap items-center gap-3 p-4 text-xs">
      <MapPinIcon aria-hidden className="size-3.5 text-muted-foreground" />
      <p className="min-w-0 flex-1">Connect Google Business Profile to see calls, direction requests and reviews from your Google listing.</p>
      <Button asChild size="sm" variant="outline"><Link to={`/businesses/${businessId}/channels#ads`}>Connect</Link></Button>
    </Panel>
  )
  const r = perf.data
  const actions = (t: LocalTotals) => t.calls + t.directionRequests + t.websiteClicks + t.bookings + t.conversations
  return (
    <Panel id="local">
      <PanelHeader icon={<MapPinIcon />} title="Google listing" description={r?.locations[0] ? `${r.locations[0].current.start} to ${r.locations[0].current.end}, compared with the ${days} days before` : "Google Business Profile"}>
        <PeriodSelect value={days} options={[7, 28, 90] as const} onChange={setDays} />
      </PanelHeader>
      {perf.error && !r ? <p role="alert" className="px-4 pb-4 text-xs text-destructive">{adsError(perf.error)}</p> : !r ? <Skeleton className="m-4 h-24 rounded-lg" /> : (
        <div className="space-y-5 px-4 pb-4">
          {r.locations.map(l => {
            const c = l.current.totals, b = l.previous.totals
            return (
              <section key={l.locationId} className="space-y-3" aria-label={l.locationName}>
                <h3 className="text-xs font-medium">{l.locationName}</h3>
                <StatStrip stats={[
                  { key: "actions", label: "Actions from the listing", value: count(actions(c)), delta: delta(actions(c), actions(b)), hint: "Calls, directions, website, bookings, messages" },
                  { key: "calls", label: "Calls", value: count(c.calls), delta: delta(c.calls, b.calls) },
                  { key: "directions", label: "Direction requests", value: count(c.directionRequests), delta: delta(c.directionRequests, b.directionRequests) },
                  { key: "views", label: "Times shown", value: count(c.impressions), delta: delta(c.impressions, b.impressions), hint: `${count(c.searchImpressions)} Search · ${count(c.mapsImpressions)} Maps` },
                ]} />
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-1.5">
                    <h4 className="text-[0.6875rem] font-medium text-muted-foreground">What people searched{l.searchTerms ? ` · ${l.searchTerms.month}` : ""}</h4>
                    {!l.searchTerms ? <p className="text-xs text-muted-foreground">Not available from Google right now.</p> : !l.searchTerms.terms.length ? <p className="text-xs text-muted-foreground">No search terms for last month.</p> : (
                      <ol className="space-y-1 text-xs">
                        {l.searchTerms.terms.slice(0, 6).map(t => (
                          <li key={t.term} className="flex items-baseline gap-2"><span className="min-w-0 flex-1 truncate">{t.term}</span><span className="tabular-nums text-muted-foreground">{t.atLeast ? "≥ " : ""}{count(t.impressions)}</span></li>
                        ))}
                      </ol>
                    )}
                  </div>
                  <div className="space-y-1.5">
                    <h4 className="text-[0.6875rem] font-medium text-muted-foreground">Reviews</h4>
                    {!l.reviews ? <p className="text-xs text-muted-foreground">Not available from Google right now.</p> : (
                      <>
                        <p className="flex items-center gap-1.5 text-xs">
                          <StarIcon aria-hidden className="size-3.5 fill-current text-amber-500" />
                          <span className="font-medium">{l.reviews.averageRating ?? "—"}</span>
                          <span className="text-muted-foreground">from {count(l.reviews.total)} reviews · {l.reviews.inWindow} new this period · {l.reviews.unanswered} of the newest {l.reviews.sampled} unanswered</span>
                        </p>
                        {l.reviews.recent.slice(0, 3).map((rv, i) => (
                          <p key={i} className="line-clamp-2 text-xs text-muted-foreground">{rv.rating ? `${rv.rating}★ ` : ""}{rv.text || "No comment"}</p>
                        ))}
                      </>
                    )}
                  </div>
                </div>
              </section>
            )
          })}
          {r.failures.map(f => <p key={f.locationName} role="alert" className="text-xs text-destructive">{f.locationName}: {FAILURE[f.reason] ?? "Google didn't answer. Try again later."}</p>)}
          <p className="text-[0.6875rem] text-muted-foreground">From Google Business Profile, read live; data ends yesterday. Calls and directions are taps on the listing, not completed calls or visits. Changes between periods describe what happened, not why.</p>
        </div>
      )}
    </Panel>
  )
}
