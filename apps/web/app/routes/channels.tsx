// Channels: the accounts the agent works through, grouped by what it does
// with them. Each row says what the agent gets from the account and has one
// button. Google and Meta sign in straight away; Stripe and WordPress open a
// short form in the row. Extra data sources and access settings live on their
// own tab so the accounts stay readable.
import { useState, type ReactNode } from "react"
import { Link, useLocation, useParams, useSearchParams } from "react-router"
import { LoaderCircleIcon } from "lucide-react"
import { AD_PROVIDER_NAME, type ChannelProvider } from "@openrecord/contracts"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { PageHeader, Panel } from "@/components/page"
import { ChannelMark } from "@/components/channel-mark"
import { SearchConsoleSetup } from "@/components/search-console"
import { AdAccountsSetup } from "@/components/ad-accounts"
import { RevenueSetup } from "@/components/revenue"
import { WordPressSetup } from "@/components/wordpress"
import { AiAnswerTracking } from "@/components/ai-answer-tracking"
import { AiTrafficUpload } from "@/components/ai-traffic"
import { ResearchConnections } from "@/components/research-connections"
import { AgentAccess, LiveTrafficFeed, ToolServers } from "@/components/agent-access"
import { ADS_CALLBACK_COPY, Ads, adsError } from "@/lib/ads"
import { Revenue } from "@/lib/revenue"
import { SearchConsole, searchConsoleError, siteLabel } from "@/lib/search-console"
import { WordPress } from "@/lib/wordpress-api"
import { Channels } from "@/lib/setup"
import { useApi } from "@/lib/use-api"
import { useWorkspace } from "@/lib/workspace"
import { cn } from "@/lib/utils"
import { PluginsPanel } from "@/components/plugins-panel"

type State = "connected" | "choose" | "reconnect" | "available" | "unavailable"
const STATE_BADGE: Record<State, { label: string; variant: "supported" | "partial" | "wrong" | "outline" | "unknown" } | null> = {
  connected: { label: "Connected", variant: "supported" },
  choose: { label: "Finish setup", variant: "partial" },
  reconnect: { label: "Reconnect", variant: "wrong" },
  available: null,
  unavailable: { label: "Not available yet", variant: "outline" },
}
type Group = "measure" | "ads" | "website"
const GROUPS: ReadonlyArray<{ key: Group; title: string; description: string }> = [
  { key: "measure", title: "Measure results", description: "So the agent can tell what is working, from real numbers." },
  { key: "ads", title: "Ads and listings", description: "The agent reads results and can prepare changes for you to approve." },
  { key: "website", title: "Your website", description: "The agent drafts page changes and posts; each one waits for your approval." },
]
const TOOL_ANCHORS = ["research-connections", "ai-answer-tracking", "ai-traffic", "ai-traffic-feed", "tool-servers", "plugins", "agent-access"]

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
  // Links to a tool section (#plugins, #agent-access, ...) open its tab.
  const [tab, setTab] = useState(() => params.get("tab") === "tools" || TOOL_ANCHORS.includes(hash.slice(1)) ? "tools" : "accounts")
  const adsCallback = params.get("ads") ? ADS_CALLBACK_COPY[params.get("ads") ?? ""] : null

  const signIn = async (row: string, start: () => Promise<{ authorizationUrl: string }>, describe: (e: unknown) => string) => {
    setBusy(row); setError(null)
    try { window.location.assign((await start()).authorizationUrl) } catch (e) { setError({ row, text: describe(e) }); setBusy(null) }
  }

  const statuses = [sc, ads, revenue, wordpress]
  const loading = statuses.some(status => status.loading && !status.data)
  const incomplete = statuses.some(status => status.error && !status.data)
  const rows: Record<Group, ReactNode[]> = { measure: [], ads: [], website: [] }
  const states: State[] = []

  // Google Search and Analytics share one Google sign-in.
  if (sc.data) {
    const s = sc.data
    const readable = s?.connections.filter(c => c.status === "ACTIVE" && c.searchConsole) ?? []
    const upgradable = s?.connections.find(c => c.status === "ACTIVE" && !c.searchConsole) ?? s?.connections.find(c => c.status === "REAUTHORIZATION_REQUIRED")
    const state: State = !s?.configured ? "unavailable" : s.binding ? "connected" : readable.length ? "choose" : upgradable ? "reconnect" : "available"
    states.push(state)
    rows.measure.push(
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
    rows.measure.push(<RowError key="google" text="Google Search and Analytics status could not load." onRetry={() => void sc.reload()} />)
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
      states.push(state)
      const row = provider
      rows.ads.push(
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
    rows.ads.push(<RowError key="ads" text="Ads and Google listing status could not load." onRetry={() => void ads.reload()} />)
  }

  // Pasted keys: the row opens the short form instead of leaving the app.
  if (revenue.data) {
    const { configured, connection } = revenue.data
    const state: State = !configured ? "unavailable" : connection?.status === "ACTIVE" ? "connected" : connection?.status === "REVOKED" ? "reconnect" : "available"
    states.push(state)
    rows.measure.push(
      <ChannelRow key="revenue" row="revenue" mark="stripe" title="Stripe" purpose="Revenue and new customers, so results are counted in money."
        identity={connection?.status === "ACTIVE" ? connection.displayName : null}
        state={state} open={open === "revenue"} onToggle={() => toggle("revenue")} onConnect={() => toggle("revenue")}
        >
        <RevenueSetup businessId={id} bare onChange={() => void revenue.reload()} />
      </ChannelRow>,
    )
  } else if (revenue.error) {
    rows.measure.push(<RowError key="revenue" text="Stripe status could not load." onRetry={() => void revenue.reload()} />)
  }
  if (wordpress.data) {
    const { configured, connection } = wordpress.data
    const state: State = !configured ? "unavailable" : connection?.status === "ACTIVE" ? "connected" : connection?.status === "REVOKED" ? "reconnect" : "available"
    states.push(state)
    rows.website.push(
      <ChannelRow key="wordpress" row="wordpress" mark="wordpress" title="WordPress" purpose="Improve pages and publish posts, with your approval for each change."
        identity={connection?.status === "ACTIVE" ? connection.siteName || connection.siteUrl : null}
        state={state} open={open === "wordpress"} onToggle={() => toggle("wordpress")} onConnect={() => toggle("wordpress")}
        >
        <WordPressSetup businessId={id} bare onChange={() => void wordpress.reload()} />
      </ChannelRow>,
    )
  } else if (wordpress.error) {
    rows.website.push(<RowError key="wordpress" text="WordPress status could not load." onRetry={() => void wordpress.reload()} />)
  }

  const connected = [sc.data?.binding, ...(ads.data?.bindings ?? []), revenue.data?.connection?.status === "ACTIVE", wordpress.data?.connection?.status === "ACTIVE"].filter(Boolean).length
  const profiles = inventory.data?.inventory.channels.filter(c => c.key.startsWith("profile:")) ?? []

  return (
    <div className="rise-in w-full space-y-5 pb-4">
      <PageHeader title="Channels"
        description={`The accounts your agent uses for ${name}. It reads results from them, and changes nothing until you approve it.`}
         />
      {adsCallback ? <p role="status" className={cn("text-sm", adsCallback.ok ? "text-muted-foreground" : "text-destructive")}>{adsCallback.text}</p> : null}

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList aria-label="Channels sections">
          <TabsTrigger value="accounts">Accounts</TabsTrigger>
          <TabsTrigger value="tools">Agent tools</TabsTrigger>
        </TabsList>

        <TabsContent value="accounts" className="space-y-5">
          <p className="text-xs text-muted-foreground">{loading ? "Checking your accounts." : incomplete ? "Some account statuses could not load." : connected ? `${connected} ${connected === 1 ? "account" : "accounts"} connected.` : states.length && states.every(st => st === "unavailable") ? "None of these can be connected on this OpenRecord workspace yet. Open Why? on a row to see what is missing." : "No accounts connected yet. Start with the one that counts your goal, usually Search Console or Stripe."}</p>
          {GROUPS.map(g => rows[g.key].length || loading ? (
            <Panel key={g.key} className="overflow-hidden">
              <div className="border-b border-border/60 px-4 py-3">
                <h2 className="text-sm font-medium">{g.title}</h2>
                <p className="text-xs text-muted-foreground">{g.description}</p>
              </div>
              <ul className="divide-y divide-border/60">{rows[g.key]}{loading && !rows[g.key].length ? <li className="p-4"><Skeleton className="h-10 rounded-lg" /></li> : null}</ul>
            </Panel>
          ) : null)}

          {profiles.length ? (
            <Panel className="space-y-3 p-4">
              <div>
                <h2 className="text-sm font-medium">Found on your website</h2>
                <p className="text-xs text-muted-foreground">Profiles your homepage links to. The agent reads them in research but cannot post there.</p>
              </div>
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
        </TabsContent>

        <TabsContent value="tools" className="space-y-3">
          <div className="py-2">
            <h2 className="text-base font-medium">What would you like to set up?</h2>
            <p className="mt-1 max-w-prose text-sm text-muted-foreground">These are optional. Start with the accounts tab to measure your results. Open a task below only when you need it.</p>
          </div>
          <ToolSetup id="research-connections" title="Give the agent more research sources" description="Add an account you already use for market or competitor research." open={hash === "#research-connections"}>
            <ResearchConnections businessId={id} />
          </ToolSetup>
          <ToolSetup id="ai-answer-tracking" title="Check AI answers on a schedule" description="Choose your buyer questions and how often to check them. Uses your connected AI subscriptions." open={hash === "#ai-answer-tracking"}>
            <AiAnswerTracking businessId={id} />
          </ToolSetup>
          <ToolSetup id="ai-traffic" title="See visits from AI assistants" description="Import a website log to count AI referrals and crawler visits. Ask your website manager for the log." open={hash === "#ai-traffic"}>
            <AiTrafficUpload businessId={id} />
          </ToolSetup>
          <ToolSetup id="plugins" title="Choose guidance for your business" description="Turn on specialist marketing guidance. This does not connect accounts or grant permission to act." open={hash === "#plugins"}>
            <PluginsPanel businessId={id} />
          </ToolSetup>
          <details className="rounded-xl border p-4" open={["#ai-traffic-feed", "#tool-servers", "#agent-access"].includes(hash) || undefined}>
            <summary className="cursor-pointer text-sm font-medium">Advanced connections for your technical team</summary>
            <p className="my-3 text-xs text-muted-foreground">You do not need these to use OpenRecord. Keep credentials private and review each connection's access.</p>
            <div className="space-y-3"><ToolServers businessId={id} /><LiveTrafficFeed businessId={id} /><AgentAccess businessId={id} /></div>
          </details>
        </TabsContent>
      </Tabs>
    </div>
  )
}

function ToolSetup({ id, title, description, open, children }: { id: string; title: string; description: string; open: boolean; children: ReactNode }) {
  return <details data-tool={id} open={open || undefined} className="group rounded-xl border bg-card">
    <summary className="cursor-pointer rounded-xl px-4 py-4 outline-none focus-visible:ring-2 focus-visible:ring-ring">
      <span className="ml-1 text-sm font-medium">{title}</span>
      <span className="mt-1 block max-w-prose pl-5 text-xs leading-relaxed text-muted-foreground">{description}</span>
    </summary>
    <div className="border-t p-3">{children}</div>
  </details>
}

function ChannelRow({ row, mark, title, purpose, identity, state, open, onToggle, onConnect, busy = false, error = null, children }: {
  row: string; mark: string; title: string; purpose: string; identity: string | null; state: State; open: boolean
  onToggle: () => void; onConnect: () => void; busy?: boolean; error?: string | null; children: ReactNode
}) {
  const badge = STATE_BADGE[state]
  const needs = row === "google" || row === "google_business" ? "Google sign-in" : row === "meta" ? "Meta sign-in" : row === "google_ads" ? "Google Ads access" : "Secure key storage"
  const unavailableReason = `${needs} is not switched on for this OpenRecord workspace yet, so this account cannot be connected. Whoever runs your OpenRecord can turn it on.`
  // Opens the row instead of signing in when there is something to finish or manage here.
  const action = state === "connected" ? { label: open ? "Done" : "Manage", run: onToggle, variant: "outline" as const }
    : state === "choose" ? { label: open ? "Close" : "Finish setup", run: onToggle, variant: "default" as const }
    : state === "reconnect" ? { label: "Reconnect", run: onConnect, variant: "default" as const }
    : state === "available" ? { label: "Connect", run: onConnect, variant: "default" as const }
    : { label: open ? "Close" : "Why?", run: onToggle, variant: "ghost" as const }
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
          <Button size="sm" variant={action.variant} disabled={busy} onClick={action.run} className="min-w-24">
            {busy ? <LoaderCircleIcon className="animate-spin" /> : null}{action.label}
          </Button>
        </div>
        {error ? <p role="alert" className="px-4 pb-3 pl-15 text-xs text-destructive">{error}</p> : null}
        <CollapsibleContent>
          <div className="border-t border-border/60 bg-muted/30 px-4 py-3 sm:pl-15">
            {state === "unavailable"
              ? <p className="text-xs text-muted-foreground">{unavailableReason} Once it is on, you connect your own account here.</p>
              : children}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </li>
  )
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
