// Revenue from the business's Stripe account, in two places: connecting it
// with a restricted read-only key (Channels) and reading revenue (Results).
// OpenRecord can't charge, refund or change anything in Stripe.
import { useState } from "react"
import { Link } from "react-router"
import { BanknoteIcon } from "lucide-react"
import type { AdPerformanceDays, RevenueTotals } from "@openrecord/contracts"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { PeriodSelect } from "@/components/period-select"
import { Panel, PanelHeader, StatStrip } from "@/components/page"
import { Revenue, revenueError } from "@/lib/revenue"
import { relativeTime } from "@/lib/format"
import { useApi } from "@/lib/use-api"

/** Connect Stripe with a restricted read-only key. */
export function RevenueSetup({ businessId }: { businessId: string }) {
  const q = useApi(`revenue:${businessId}`, () => Revenue.status(businessId))
  const [key, setKey] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!q.data) return q.loading ? <Skeleton className="h-24 rounded-xl" /> : null
  const { configured, connection } = q.data
  const act = async (f: () => Promise<unknown>) => {
    setBusy(true); setError(null)
    try { await f(); setKey(""); await q.reload() } catch (e) { setError(revenueError(e)) } finally { setBusy(false) }
  }
  return (
    <Panel id="revenue" className="space-y-3 p-4">
      <div className="flex items-start gap-2">
        <BanknoteIcon aria-hidden className="mt-0.5 size-3.5 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <h2 className="text-xs font-medium">Revenue · Stripe</h2>
          <p className="text-[0.6875rem] text-muted-foreground">So the agent can show what growth is worth in money and customers. Read-only: OpenRecord can't charge, refund or change anything in Stripe.</p>
        </div>
      </div>
      {!configured ? (
        <p className="text-[0.6875rem] text-muted-foreground">Not switched on for this OpenRecord server yet. Needs a token encryption key (ADS_TOKEN_ENCRYPTION_KEYS or GA4_TOKEN_ENCRYPTION_KEYS).</p>
      ) : connection && connection.status === "ACTIVE" ? (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <p className="min-w-0 flex-1">Reading <span className="font-medium">{connection.displayName}</span>{connection.livemode ? "" : " (test mode)"} with key ending {connection.last4}, connected {relativeTime(connection.connectedAt)}.</p>
          <Button size="sm" variant="outline" asChild><Link to={`/businesses/${businessId}/results#revenue`}>See revenue</Link></Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act(() => Revenue.disconnect(businessId))}>Disconnect</Button>
        </div>
      ) : (
        <form className="space-y-2" onSubmit={e => { e.preventDefault(); if (key.trim()) void act(() => Revenue.connect(businessId, key)) }}>
          {connection?.status === "REVOKED" ? <p className="text-xs text-destructive">Stripe no longer accepts the key ending {connection.last4}. Paste a new one.</p> : null}
          <ol className="list-decimal space-y-0.5 pl-4 text-[0.6875rem] text-muted-foreground">
            <li>In Stripe, open Developers → API keys and choose <span className="font-medium text-foreground">Create restricted key</span>.</li>
            <li>Name it OpenRecord and set <span className="font-medium text-foreground">Charges</span> and <span className="font-medium text-foreground">Customers</span> to Read. Leave everything else as None.</li>
            <li>Create it, copy the key (it starts with rk_live_) and paste it here.</li>
          </ol>
          <div className="flex flex-wrap items-center gap-2">
            <Input value={key} onChange={e => setKey(e.currentTarget.value)} placeholder="rk_live_…" autoComplete="off" spellCheck={false} aria-label="Stripe restricted key" className="w-80 font-mono text-xs" />
            <Button size="sm" type="submit" disabled={busy || !key.trim()}>Connect Stripe</Button>
          </div>
        </form>
      )}
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
    </Panel>
  )
}

const money = (n: number | null, currency: string) => n === null ? "—" : new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: n < 100 ? 2 : 0 }).format(n)
const delta = (now: number | null, before: number | null) => {
  if (now === null || before === null || before === 0) return null
  const change = (now - before) / before
  if (Math.abs(change) < 0.005) return <span className="text-muted-foreground">no change</span>
  return <span className={change > 0 ? "text-supported" : "text-wrong"}>{change > 0 ? "+" : ""}{Math.round(change * 100)}%</span>
}

/** Live revenue beside the other results, per currency. */
export function RevenuePanel({ businessId }: { businessId: string }) {
  const status = useApi(`revenue:${businessId}`, () => Revenue.status(businessId))
  const [days, setDays] = useState<AdPerformanceDays>(28)
  const connected = status.data?.connection?.status === "ACTIVE"
  const perf = useApi(connected ? `revenue-performance:${businessId}:${days}` : null, () => Revenue.performance(businessId, days))
  if (!status.data?.configured) return null
  if (!connected) return (
    <Panel id="revenue" className="flex flex-wrap items-center gap-3 p-4 text-xs">
      <BanknoteIcon aria-hidden className="size-3.5 text-muted-foreground" />
      <p className="min-w-0 flex-1">Connect Stripe to see revenue and paying customers beside your marketing results.</p>
      <Button asChild size="sm" variant="outline"><Link to={`/businesses/${businessId}/channels#revenue`}>Connect</Link></Button>
    </Panel>
  )
  const r = perf.data?.revenue
  const main = (t: RevenueTotals | undefined) => t?.byCurrency[0] ?? null
  const c = main(r?.current.totals), b = r ? r.previous.totals.byCurrency.find(x => x.currency === c?.currency) ?? null : null
  return (
    <Panel id="revenue">
      <PanelHeader icon={<BanknoteIcon />} title="Revenue" description={r ? `${r.accountName}${r.livemode ? "" : " (test mode)"}, ${r.current.start} to ${r.current.end}, compared with the ${days} days before` : "Stripe"}>
        <PeriodSelect value={days} options={[7, 28, 90] as const} onChange={setDays} />
      </PanelHeader>
      {perf.error && !r ? <p role="alert" className="px-4 pb-4 text-xs text-destructive">{revenueError(perf.error)}</p> : !r ? <Skeleton className="m-4 h-24 rounded-lg" /> : (
        <div className="space-y-3 px-4 pb-4">
          {c ? (
            <StatStrip stats={[
              { key: "net", label: "Net revenue", value: money(c.net, c.currency), delta: delta(c.net, b?.net ?? null), hint: "Paid minus refunds, before Stripe fees" },
              { key: "orders", label: "Paid orders", value: c.orders.toLocaleString(), delta: delta(c.orders, b?.orders ?? null) },
              { key: "aov", label: "Average order", value: money(c.averageOrder, c.currency), delta: delta(c.averageOrder, b?.averageOrder ?? null) },
              { key: "customers", label: "Paying customers", value: r.current.totals.payingCustomers.toLocaleString(), delta: delta(r.current.totals.payingCustomers, r.previous.totals.payingCustomers),
                ...(r.current.totals.newCustomers !== null ? { hint: `${r.current.totals.newCustomers} new` } : {}) },
            ]} />
          ) : <p className="text-xs text-muted-foreground">No paid orders in this period.</p>}
          {r.current.totals.byCurrency.length > 1 ? (
            <p className="text-xs text-muted-foreground">Also: {r.current.totals.byCurrency.slice(1).map(x => `${money(x.net, x.currency)} from ${x.orders} orders`).join(", ")}. Currencies aren't converted or added together.</p>
          ) : null}
          <p className="text-[0.6875rem] text-muted-foreground">From Stripe, read live with a read-only key; through yesterday. Stripe can't tell which channel brought a sale. Changes between periods describe what happened, not why.{r.current.totals.truncated ? " More than 3,000 charges: totals are a lower bound." : ""}</p>
        </div>
      )}
    </Panel>
  )
}
