// Channels: every account the agent can work through, as one list. Each row
// says what the agent does with it and has one button. Google and Meta sign in
// straight away; Stripe and WordPress open a short form in the row. Managing a
// connected account opens the same row.
import { useEffect, useState, type ReactNode } from "react"
import { Link, useLocation, useParams, useSearchParams } from "react-router"
import { ChevronRightIcon, LoaderCircleIcon } from "lucide-react"
import { AD_PROVIDER_NAME, type ChannelProvider } from "@openrecord/contracts"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Skeleton } from "@/components/ui/skeleton"
import { PageHeader, Panel } from "@/components/page"
import { ChannelMark } from "@/components/channel-mark"
import { SearchConsoleSetup } from "@/components/search-console"
import { AdAccountsSetup } from "@/components/ad-accounts"
import { RevenueSetup } from "@/components/revenue"
import { WordPressSetup } from "@/components/wordpress"
import { AiAnswerTracking } from "@/components/ai-answer-tracking"
import { AiTrafficUpload } from "@/components/ai-traffic"
import { ResearchConnections } from "@/components/research-connections"
import { AskAgentButton } from "@/components/workspace-agent"
import { AgentAccess, LiveTrafficFeed, ToolServers } from "@/components/agent-access"
import { ADS_CALLBACK_COPY, Ads, adsError } from "@/lib/ads"
import { Revenue } from "@/lib/revenue"
import { SearchConsole, searchConsoleError, siteLabel } from "@/lib/search-console"
import { WordPress } from "@/lib/wordpress-api"
import { Channels } from "@/lib/setup"
import { useApi } from "@/lib/use-api"
import { useWorkspace } from "@/lib/workspace"
import { cn } from "@/lib/utils"

type State = "connected" | "choose" | "reconnect" | "available" | "unavailable"
const STATE_BADGE: Record<State, { label: string; variant: "supported" | "partial" | "wrong" | "outline" | "unknown" } | null> = {
  connected: { label: "Connected", variant: "supported" },
  choose: { label: "Finish setup", variant: "partial" },
  reconnect: { label: "Reconnect", variant: "wrong" },
  available: null,
  unavailable: { label: "Not switched on", variant: "unknown" },
}

export function ChannelsPage() {
  const { id = "" } = useParams()
  const { activeBusiness } = useWorkspace()
  const name = activeBusiness?.name ?? "this business"
  const [params] = useSearchParams()
  const { hash } = useLocation()
  const sc = useApi(`channels-sc:${id}`, () => SearchConsole.status(id))
  const ads = useApi(`channels-ads:${id}`, () => Ads.status(id))
  const revenue = useApi(`channels-revenue:${id}`, () => Revenue.status(id))
  const wordpress = useApi(`channels-wp:${id}`, () => WordPress.status(id))
  const inventory = useApi(`channels:${id}`, () => Channels.get(id))
  // Coming back from Google or Meta lands here with the row to finish open.
  const [open, setOpen] = useState<string | null>(() => params.get("google") || hash === "#search-console" ? "google" : hash && hash !== "#ads" ? hash.slice(1) : null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<{ row: string; text: string } | null>(null)
  const toggle = (row: string) => setOpen(o => (o === row ? null : row))
  const adsCallback = params.get("ads") ? ADS_CALLBACK_COPY[params.get("ads") ?? ""] : null

  const signIn = async (row: string, start: () => Promise<{ authorizationUrl: string }>, describe: (e: unknown) => string) => {
    setBusy(row); setError(null)
    try { window.location.assign((await start()).authorizationUrl) } catch (e) { setError({ row, text: describe(e) }); setBusy(null) }
  }

  const statuses = [sc, ads, revenue, wordpress]
  const loading = statuses.some(status => status.loading && !status.data)
  const incomplete = statuses.some(status => status.error && !status.data)
  const rows: ReactNode[] = []

  // Google Search and Analytics share one Google sign-in.
  if (sc.data) {
    const s = sc.data
    const readable = s?.connections.filter(c => c.status === "ACTIVE" && c.searchConsole) ?? []
    const upgradable = s?.connections.find(c => c.status === "ACTIVE" && !c.searchConsole) ?? s?.connections.find(c => c.status === "REAUTHORIZATION_REQUIRED")
    const state: State = !s?.configured ? "unavailable" : s.binding ? "connected" : readable.length ? "choose" : upgradable ? "reconnect" : "available"
    rows.push(
      <ChannelRow key="google" row="google" mark="search-console" title="Google Search Console"
        purpose="See which Google searches bring people to your site."
        identity={s?.binding ? siteLabel(s.binding.siteUrl) : upgradable?.googleEmail ?? null}
        state={state} open={open === "google"} onToggle={() => toggle("google")}
        busy={busy === "google"} error={error?.row === "google" ? error.text : null}
        onConnect={() => void signIn("google", () => SearchConsole.connect(id, upgradable?.id ?? null), searchConsoleError)}
        >
        <SearchConsoleSetup businessId={id} bare onChange={() => { void sc.reload(); void inventory.reload() }} />
        <MeasurementNote inventory={inventory.data?.inventory ?? null} />
      </ChannelRow>,
    )
  } else if (sc.error) {
    rows.push(<RowError key="google" text="Google Search and Analytics status could not load." onRetry={() => void sc.reload()} />)
  }

  // Google Business Profile, Google Ads and Meta share the ads sign-in flow.
  if (ads.data) {
    const a = ads.data
    const PURPOSE: Record<ChannelProvider, string> = {
      google_business: "Calls, directions, searches and reviews from your Google listing.",
      google_ads: "What your Search, YouTube and Display ads cost and bring in.",
      meta: "What your Facebook and Instagram ads cost and bring in.",
    }
    for (const provider of ["google_business", "google_ads", "meta"] as const) {
      const platform = a.providers[provider]
      const bound = a.bindings.filter(b => b.provider === provider)
      const signIns = a.connections.filter(c => c.provider === provider)
      const active = signIns.filter(c => c.status === "ACTIVE")
      const expired = signIns.filter(c => c.status === "REAUTHORIZATION_REQUIRED")
      const state: State = !platform.configured ? "unavailable" : bound.length ? "connected" : active.length ? "choose" : expired.length ? "reconnect" : "available"
      const row = provider
      rows.push(
        <ChannelRow key={provider} row={row} mark={provider} title={AD_PROVIDER_NAME[provider]} purpose={PURPOSE[provider]}
          identity={bound.length ? bound.map(b => b.name).join(", ") : null}
          state={state} open={open === row} onToggle={() => toggle(row)}
          busy={busy === row} error={error?.row === row ? error.text : null}
          onConnect={() => void signIn(row, () => Ads.connect(id, provider), adsError)}
          >
          <AdAccountsSetup businessId={id} only={provider} bare onChange={() => void ads.reload()} />
        </ChannelRow>,
      )
    }
  } else if (ads.error) {
    rows.push(<RowError key="ads" text="Ads and Google listing status could not load." onRetry={() => void ads.reload()} />)
  }

  // Pasted keys: the row opens the short form instead of leaving the app.
  if (revenue.data) {
    const { configured, connection } = revenue.data
    const state: State = !configured ? "unavailable" : connection?.status === "ACTIVE" ? "connected" : connection?.status === "REVOKED" ? "reconnect" : "available"
    rows.push(
      <ChannelRow key="revenue" row="revenue" mark="stripe" title="Stripe" purpose="Revenue and new customers, so results are counted in money."
        identity={connection?.status === "ACTIVE" ? connection.displayName : null}
        state={state} open={open === "revenue"} onToggle={() => toggle("revenue")} onConnect={() => toggle("revenue")}
        >
        <RevenueSetup businessId={id} bare onChange={() => void revenue.reload()} />
      </ChannelRow>,
    )
  } else if (revenue.error) {
    rows.push(<RowError key="revenue" text="Stripe status could not load." onRetry={() => void revenue.reload()} />)
  }
  if (wordpress.data) {
    const { configured, connection } = wordpress.data
    const state: State = !configured ? "unavailable" : connection?.status === "ACTIVE" ? "connected" : connection?.status === "REVOKED" ? "reconnect" : "available"
    rows.push(
      <ChannelRow key="wordpress" row="wordpress" mark="wordpress" title="WordPress" purpose="Improve pages and publish posts, with your approval for each change."
        identity={connection?.status === "ACTIVE" ? connection.siteName || connection.siteUrl : null}
        state={state} open={open === "wordpress"} onToggle={() => toggle("wordpress")} onConnect={() => toggle("wordpress")}
        >
        <WordPressSetup businessId={id} bare onChange={() => void wordpress.reload()} />
      </ChannelRow>,
    )
  } else if (wordpress.error) {
    rows.push(<RowError key="wordpress" text="WordPress status could not load." onRetry={() => void wordpress.reload()} />)
  }

  const connected = [sc.data?.binding, ...(ads.data?.bindings ?? []), revenue.data?.connection?.status === "ACTIVE", wordpress.data?.connection?.status === "ACTIVE"].filter(Boolean).length
  const profiles = inventory.data?.inventory.channels.filter(c => c.key.startsWith("profile:")) ?? []

  return (
    <div className="rise-in w-full space-y-6 pb-4">
      <PageHeader title="Channels"
        description={`Where your agent works for ${name}. Connect an account and finish any account selection to make it available. Nothing is published, posted or spent until you approve it.`} />
      {adsCallback ? <p role="status" className={cn("text-sm", adsCallback.ok ? "text-muted-foreground" : "text-destructive")}>{adsCallback.text}</p> : null}

      <Panel className="overflow-hidden">
        <div className="flex items-center justify-between gap-3 border-b border-border/60 px-4 py-3">
          <h2 className="text-sm font-medium">Accounts</h2>
          <span className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">{loading ? "Checking" : incomplete ? "Some statuses unavailable" : connected ? `${connected} connected` : "None connected yet"}</span>
            <AskAgentButton businessId={id} request={`Which of our channels should ${name} connect first, and what would each one let you measure or do for our goal?`}>Which first?</AskAgentButton>
          </span>
        </div>
        {loading ? <div className="space-y-2 p-4">{[0, 1, 2].map(i => <Skeleton key={i} className="h-12 rounded-lg" />)}</div>
          : <ul className="divide-y divide-border/60">{rows}</ul>}
      </Panel>

      {profiles.length ? (
        <Panel className="space-y-3 p-4">
          <div>
            <h2 className="text-sm font-medium">Found on your website</h2>
            <p className="text-xs text-muted-foreground">Profiles your homepage links to. The agent reads them in research; it can't post there.</p>
          </div>
          <AskAgentButton businessId={id} request={`Research our profiles linked from the website (${profiles.map(p => p.label).join(", ")}): how active each is, how they compare with competitors, and what to improve first.`}>Research these profiles</AskAgentButton>
          <ul className="flex flex-wrap gap-2">
            {profiles.map(p => (
              <li key={p.key}>
                <a href={p.identity?.startsWith("http") ? p.identity : undefined} target="_blank" rel="noreferrer noopener"
                  className="inline-flex items-center gap-1.5 rounded-full bg-muted/70 px-2.5 py-1 text-xs shadow-(--control-shadow) transition-colors hover:bg-accent">
                  <ChannelMark channelKey={p.key} className="size-3.5" />{p.label}
                </a>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}

      <MoreTools businessId={id} />
    </div>
  )
}

function ChannelRow({ row, mark, title, purpose, identity, state, open, onToggle, onConnect, busy = false, error = null, children }: {
  row: string; mark: string; title: string; purpose: string; identity: string | null; state: State; open: boolean
  onToggle: () => void; onConnect: () => void; busy?: boolean; error?: string | null; children: ReactNode
}) {
  const badge = STATE_BADGE[state]
  // Opens the row instead of signing in when there is something to finish or manage here.
  const action = state === "connected" ? { label: open ? "Done" : "Manage", run: onToggle, variant: "outline" as const }
    : state === "choose" ? { label: open ? "Close" : "Finish setup", run: onToggle, variant: "default" as const }
    : state === "reconnect" ? { label: "Reconnect", run: onConnect, variant: "default" as const }
    : state === "available" ? { label: "Connect", run: onConnect, variant: "default" as const }
    : null
  return (
    <li id={row} className="scroll-mt-20">
      <Collapsible open={open} onOpenChange={onToggle}>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted/70 shadow-(--control-shadow)">
            <ChannelMark channelKey={mark} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-sm font-medium">{title}</h3>
              {badge ? <Badge variant={badge.variant}>{badge.label}</Badge> : null}
            </div>
            <p className="truncate text-xs text-muted-foreground">{identity && state === "connected" ? identity : purpose}</p>
          </div>
          <ChannelAsk title={title} connected={state === "connected"} />
          {action ? (
            <Button size="sm" variant={action.variant} disabled={busy} onClick={action.run} className="min-w-24">
              {busy ? <LoaderCircleIcon className="animate-spin" /> : null}{action.label}
            </Button>
          ) : (
            <CollapsibleTrigger asChild>
              <Button size="sm" variant="ghost" className="text-muted-foreground">
                Why<ChevronRightIcon className={cn("transition-transform", open && "rotate-90")} />
              </Button>
            </CollapsibleTrigger>
          )}
        </div>
        {error ? <p role="alert" className="px-4 pb-3 pl-15 text-xs text-destructive">{error}</p> : null}
        <CollapsibleContent>
          <div className="border-t border-border/60 bg-muted/30 px-4 py-3 sm:pl-15">
            {state === "unavailable"
              ? <p className="text-xs text-muted-foreground">This connection is not available yet. Contact your workspace administrator for help.</p>
              : children}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </li>
  )
}

/** Hands the agent this channel: what it shows when connected, what it would add when not. */
function ChannelAsk({ title, connected }: { title: string; connected: boolean }) {
  const { id = "" } = useParams()
  return <AskAgentButton businessId={id} className="h-7 text-xs text-muted-foreground"
    request={connected ? `What does our ${title} data show right now, and what should we do about it?` : `What would connecting ${title} let you measure or do for us, and is it worth connecting now?`}>Ask</AskAgentButton>
}

function RowError({ text, onRetry }: { text: string; onRetry: () => void }) {
  return (
    <li className="flex flex-wrap items-center gap-3 px-4 py-3">
      <p role="alert" className="min-w-0 flex-1 text-xs text-destructive">{text}</p>
      <Button size="sm" variant="outline" onClick={onRetry}>Try again</Button>
    </li>
  )
}

/** After Google access is granted, what the goal is counted from. */
function MeasurementNote({ inventory }: { inventory: { channels: ReadonlyArray<{ key: string; state: string; note: string; action: { label: string; href: string } | null }> } | null }) {
  const ga4 = inventory?.channels.find(c => c.key === "ga4")
  if (!ga4 || ga4.state === "UNSUPPORTED" || ga4.state === "PERMISSION_REQUIRED") return null
  return (
    <p className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <ChannelMark channelKey="ga4" className="size-3.5" />
      <span className="min-w-0 flex-1">{ga4.note}</span>
      {ga4.action ? <Button asChild size="sm" variant="outline"><Link to={ga4.action.href}>{ga4.action.label}</Link></Button> : null}
    </p>
  )
}

/** Data the agent can use without an account sign-in, kept out of the way. */
function MoreTools({ businessId }: { businessId: string }) {
  const [open, setOpen] = useState(false)
  const { hash } = useLocation()
  useEffect(() => { if (["#ai-answer-tracking", "#ai-traffic", "#ai-traffic-feed", "#research-connections", "#agent-access", "#tool-servers"].includes(hash)) setOpen(true) }, [hash])
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="space-y-3">
      <CollapsibleTrigger className="flex items-center gap-1.5 rounded-md text-sm font-medium outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
        <ChevronRightIcon aria-hidden className={cn("size-4 text-muted-foreground transition-transform", open && "rotate-90")} />
        More data for the agent
        <span className="font-normal text-muted-foreground">AI answer tracking, server logs, research accounts, tool servers and agent access</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-3">
        <AiAnswerTracking businessId={businessId} />
        <AiTrafficUpload businessId={businessId} />
        <LiveTrafficFeed businessId={businessId} />
        <ResearchConnections businessId={businessId} />
        <ToolServers businessId={businessId} />
        <AgentAccess businessId={businessId} />
      </CollapsibleContent>
    </Collapsible>
  )
}
