// Agency workspace: clients and products open their business agent, while
// their existing records and growth data remain available at their routes.
import { useEffect, useMemo, useState } from "react"
import { Link, useNavigate } from "react-router"
import { ChevronDownIcon, ChevronRightIcon, FileCheck2Icon, GlobeIcon, LinkIcon, PlusIcon, SearchIcon, TriangleAlertIcon } from "lucide-react"
import type { GrowthOpportunity, GrowthProfile } from "@openrecord/contracts"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { EmptyState, PageHeader, Panel, StatStrip, domainOf } from "@/components/page"
import { Spinner } from "@/components/spinner"
import { errorMessage, formatDate, initial, markColor, relativeTime } from "@/lib/format"
import { Records, type Engagement } from "@/lib/record"
import { Growth } from "@/lib/growth"
import { Setup, setupError } from "@/lib/setup"
import { clientGrowthLine } from "@/lib/growth-stage"
import { useApi } from "@/lib/use-api"
import { useWorkspace } from "@/lib/workspace"

type GrowthState = { profile: GrowthProfile | null; opportunities: GrowthOpportunity[]; done: boolean }

/** One profile + opportunities read per client, loaded in parallel like the
 * businesses list does. A failing read stays unknown instead of inventing
 * "no marketing" for a client that may have both. */
function useClientGrowth(clients: Array<{ businessId: string }>): Record<string, GrowthState | undefined> {
  const [data, setData] = useState<Record<string, GrowthState>>({})
  const key = clients.map(c => c.businessId).join(",")
  useEffect(() => {
    let alive = true
    for (const c of clients) {
      void Promise.allSettled([Growth.profile(c.businessId), Growth.list(c.businessId)]).then(([p, o]) => {
        if (!alive) return
        setData(d => ({ ...d, [c.businessId]: {
          profile: p.status === "fulfilled" ? p.value.profile : null,
          opportunities: o.status === "fulfilled" ? o.value.opportunities : [],
          done: p.status === "fulfilled" && o.status === "fulfilled",
        } }))
      })
    }
    return () => { alive = false }
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps
  return data
}

export function ClientsPage() {
  const clients = useApi("record-clients", () => Records.list())
  const [q, setQ] = useState("")
  const list = useMemo(() => clients.data?.clients ?? [], [clients.data])
  const growth = useClientGrowth(list)
  const visible = list.filter((c) => `${c.name} ${c.websiteUrl}`.toLowerCase().includes(q.trim().toLowerCase()))
  const shared = list.filter((c) => c.hasActiveShare).length
  const withGoal = list.filter((c) => growth[c.businessId]?.profile).length
  const approved = list.reduce((n, c) => n + (growth[c.businessId]?.opportunities.filter(o => o.status === "APPROVED" || o.status === "REVIEWED").length ?? 0), 0)

  return (
    <div className="space-y-6 pb-4">
      <PageHeader
        title="Clients"
        description="Open a client or product to work with its agent and see its progress."
        actions={
          <AddBusinessButton />
        }
      />

      {list.length > 0 ? (
      <StatStrip
        stats={[
          { key: "all", label: "Clients and products", value: clients.loading ? <Skeleton className="h-5 w-8" /> : list.length, hint: "Records you operate" },
          { key: "goal", label: "With a marketing goal", value: clients.loading || !growthComplete(list, growth) ? <Skeleton className="h-5 w-8" /> : withGoal, hint: "Goal and metric defined" },
          { key: "approved", label: "Approved initiatives", value: clients.loading || !growthComplete(list, growth) ? <Skeleton className="h-5 w-8" /> : approved, hint: "Human-approved, across all clients", tone: "supported" },
          { key: "shared", label: "Shared", value: clients.loading ? <Skeleton className="h-5 w-8" /> : shared, hint: "Active record share link" },
        ]}
      />
      ) : null}

      {clients.loading ? (
        <Skeleton className="h-48 rounded-xl" />
      ) : clients.error ? (
        <EmptyState icon={<TriangleAlertIcon />} title="Clients could not load" description={errorMessage(clients.error)} action={<Button variant="outline" size="sm" onClick={() => void clients.reload()}>Try again</Button>} />
      ) : list.length === 0 ? (
        <Panel>
          <div className="p-6">
            <div className="space-y-3">
              <span className="flex size-9 items-center justify-center rounded-lg bg-primary-ink/10 text-primary-ink">
                <FileCheck2Icon className="size-4" />
              </span>
              <h2 className="text-sm font-medium">Add your first business</h2>
              <p className="max-w-md text-xs leading-relaxed text-muted-foreground">
                Add a website to start working with your agent, for a client or your own business.
              </p>
              <AddBusinessButton />
            </div>
          </div>
        </Panel>
      ) : (
        <Panel>
          <div className="flex items-center gap-2 px-3 pt-3 pb-2">
            <div className="relative flex-1">
              <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input value={q} onChange={(e) => setQ(e.currentTarget.value)} placeholder="Search clients" aria-label="Search clients" className="h-8 pl-8 text-xs" />
            </div>
          </div>
          <div className="hidden grid-cols-[minmax(0,1.1fr)_minmax(0,1.3fr)_9rem_7rem_1rem] gap-4 border-y bg-muted/40 px-4 py-1.5 text-[11px] text-muted-foreground sm:grid">
            <span>Client</span>
            <span>Marketing progress</span>
            <span>Record</span>
            <span>Share</span>
            <span />
          </div>
          {visible.length === 0 ? (
            <p className="px-4 py-8 text-center text-xs text-muted-foreground">No client matches &ldquo;{q}&rdquo;.</p>
          ) : (
            <ul className="divide-y">
              {visible.map((c) => (
                <ClientRow key={c.businessId} client={c} state={growth[c.businessId]} />
              ))}
            </ul>
          )}
        </Panel>
      )}

    </div>
  )
}

const growthComplete = (list: Array<{ businessId: string }>, growth: Record<string, GrowthState | undefined>) =>
  list.length > 0 && list.every((c) => growth[c.businessId]?.done)

function AddBusinessButton() {
  return <DropdownMenu>
    <DropdownMenuTrigger asChild><Button size="sm"><PlusIcon />Add business<ChevronDownIcon /></Button></DropdownMenuTrigger>
    <DropdownMenuContent align="start">
      <DropdownMenuItem asChild><Link to="/start">Client business</Link></DropdownMenuItem>
      <DropdownMenuItem asChild><Link to="/start?ownership=own">Our business or product</Link></DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>
}

function ClientRow({ client: c, state }: { client: Awaited<ReturnType<typeof Records.list>>["clients"][number]; state: GrowthState | undefined }) {
  const progress = state?.done ? clientGrowthLine({
    hasGoal: state.profile !== null,
    goalStatement: state.profile?.primaryGoal.statement ?? null,
    metricLabel: state.profile?.primaryGoal.metricDefinition.label ?? null,
    total: state.opportunities.length,
    approved: state.opportunities.filter(o => o.status === "APPROVED" || o.status === "REVIEWED").length,
    verified: state.opportunities.reduce((n, o) => n + o.executions.filter(e => e.assurance === "SYSTEM_VERIFIED").length, 0),
    reviewConcluded: state.opportunities.filter(o => o.status === "REVIEWED").length,
  }) : null
  return (
    <li>
      <Link
        to={`/businesses/${c.businessId}/agent`}
        className="grid items-center gap-x-4 gap-y-1 px-4 py-2.5 text-xs transition-colors hover:bg-muted/40 sm:grid-cols-[minmax(0,1.1fr)_minmax(0,1.3fr)_9rem_7rem_1rem]"
        aria-label={`${c.name}, open agent`}
      >
        <span className="flex min-w-0 items-center gap-3">
          <span className={`mark-shine flex size-7 shrink-0 items-center justify-center rounded-md text-xs font-semibold ${markColor(c.name).bg} ${markColor(c.name).text}`}>{initial(c.name)}</span>
          <span className="min-w-0">
            <span className="flex items-center gap-2">
              <span className="truncate font-medium">{c.name}</span>
              {c.engagement !== "CLIENT" ? <Badge variant="outline">{c.engagement === "DOGFOOD" ? "Dogfood" : "Fixture"}</Badge> : null}
            </span>
            <span className="flex items-center gap-1 truncate text-[11px] text-muted-foreground">
              <GlobeIcon className="size-3" />
              {domainOf(c.websiteUrl)}
            </span>
          </span>
        </span>
        <span className="min-w-0">
          {state === undefined || !state.done ? (
            <Skeleton className="h-3.5 w-40" />
          ) : progress ? (
            <span className="block truncate text-muted-foreground" title={progress}>{progress}</span>
          ) : null}
          <span className="mt-0.5 flex items-center gap-2 text-[11px]">
            <span className="font-medium text-primary-ink">Open agent</span>
          </span>
        </span>
        <span className="text-muted-foreground" title={c.lastCheckedAt ? formatDate(c.lastCheckedAt) : undefined}>
          {c.lastCheckedAt ? `Checked ${relativeTime(c.lastCheckedAt)}` : <span className="text-review">Never checked</span>}
        </span>
        <span>
          {c.hasActiveShare ? (
            <Badge variant="supported">
              <LinkIcon />
              Shared
            </Badge>
          ) : (
            <span className="text-muted-foreground">Not shared</span>
          )}
        </span>
        <ChevronRightIcon className="hidden size-4 text-muted-foreground sm:block" />
      </Link>
    </li>
  )
}

export function NewClientDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const nav = useNavigate()
  const { reloadBusinesses, setActiveBusinessId } = useWorkspace()
  const [name, setName] = useState("")
  const [website, setWebsite] = useState("https://")
  const [engagement, setEngagement] = useState<Engagement>("CLIENT")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const create = async () => {
    setBusy(true)
    setError(null)
    try {
      const { setup } = await Setup.start({ name: name.trim(), websiteUrl: website.trim(), engagement: engagement === "DOGFOOD" ? "DOGFOOD" : "CLIENT" })
      await reloadBusinesses()
      setActiveBusinessId(setup.businessId)
      onOpenChange(false)
      nav(`/businesses/${setup.businessId}/agent`)
    } catch (e) {
      setError(setupError(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New client</DialogTitle>
          <DialogDescription>Add the client, then work with its agent.</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            void create()
          }}
        >
          <div className="grid gap-2">
            <Label htmlFor="client-name">Client name</Label>
            <Input id="client-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={200} required autoFocus />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="client-site">Website</Label>
            <Input id="client-site" type="url" value={website} onChange={(e) => setWebsite(e.target.value)} maxLength={2000} required />
          </div>
          <div className="grid gap-2">
            <Label>Engagement</Label>
            <Select value={engagement} onValueChange={(v) => setEngagement(v as Engagement)}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="CLIENT">Client engagement</SelectItem>
                <SelectItem value="DOGFOOD">Dogfood (a site you control; not customer validation)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {error ? (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !name.trim()}>
              {busy ? <Spinner /> : null}
              Create client
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
