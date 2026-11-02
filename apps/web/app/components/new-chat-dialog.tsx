import { useEffect, useRef, useState, type ReactNode } from "react"
import { useNavigate } from "react-router"
import { Building2Icon, MessagesSquareIcon, SearchIcon, SquarePenIcon } from "lucide-react"
import { Agent, type Business } from "@/lib/api"
import { Records, type ClientSummary } from "@/lib/record"
import { chatPath } from "@/lib/agent-chats"
import { useWorkspace } from "@/lib/workspace"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"

/** One list of businesses to chat about. A client record is the same
 * business seen from the agency side, so it is listed once, by its own name. */
export function chatTargets(businesses: readonly Business[], clients: readonly Pick<ClientSummary, "businessId" | "name">[], search: string) {
  const clientIds = new Set(clients.map(c => c.businessId))
  const query = search.trim().toLocaleLowerCase()
  return [
    ...businesses.filter(b => !clientIds.has(b.id)).map(b => ({ id: b.id, name: b.name })),
    ...clients.map(c => ({ id: c.businessId, name: c.name })),
  ].filter(item => item.name.toLocaleLowerCase().includes(query))
}

export function NewChatDialog({ trigger }: { trigger?: ReactNode } = {}) {
  const { businesses, businessesLoading, businessesError, reloadBusinesses, setActiveBusinessId } = useWorkspace()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [clients, setClients] = useState<ClientSummary[] | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [refresh, setRefresh] = useState(0)
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)
  const request = useRef<{ businessId: string | null; id: string } | null>(null)

  useEffect(() => {
    if (!open) return
    let live = true
    setClients(null); setLoadError(false)
    void Records.list().then(r => { if (live) setClients(r.clients) }).catch(() => { if (live) setLoadError(true) })
    return () => { live = false }
  }, [open, refresh])

  const choose = async (target: ReturnType<typeof chatTargets>[number] | null) => {
    if (pending.current) return
    pending.current = true; setBusy(true); setError(null)
    try {
      const businessId = target?.id ?? null
      const id = request.current?.businessId === businessId ? request.current.id : crypto.randomUUID()
      request.current = { businessId, id }
      const { conversation } = await Agent.create(businessId, id)
      if (businessId !== null) setActiveBusinessId(businessId)
      await navigate(chatPath({ businessId, id: conversation.id }))
      request.current = null
      setOpen(false)
    } catch { setError("Couldn't start the chat. Try again.") }
    finally { pending.current = false; setBusy(false) }
  }
  const targets = clients ? chatTargets(businesses, clients, query) : []
  const failed = loadError || businessesError !== null
  const loading = !failed && (clients === null || businessesLoading)

  return <Dialog open={open} onOpenChange={next => {
    if (pending.current) return
    setOpen(next)
    if (next) { setQuery(""); setError(null) }
  }}>
    <DialogTrigger asChild>
      {trigger ?? <Button type="button" variant="ghost" size="icon-sm" aria-label="New chat" title="New chat" className="hover:shadow-(--control-shadow)"><SquarePenIcon className="size-4" /></Button>}
    </DialogTrigger>
    <DialogContent className="gap-0 overflow-hidden rounded-[14px] p-0 sm:max-w-2xl">
      <DialogHeader className="px-6 pb-4 pt-5">
        <DialogTitle>Start a new chat</DialogTitle>
        <DialogDescription>Choose the business to talk about, or start without one.</DialogDescription>
      </DialogHeader>
      <div className="relative mx-6 mb-3">
        <SearchIcon className="pointer-events-none absolute left-3 top-2 size-4 text-muted-foreground" />
        <Input aria-label="Search businesses" placeholder="Search businesses" value={query} onChange={e => setQuery(e.target.value)} className="h-8 pl-9 text-sm" />
      </div>
      <button type="button" disabled={busy} onClick={() => void choose(null)} className="mx-4 mb-2 flex items-center gap-3 rounded-[8px] px-3 py-3 text-left outline-none transition-[background-color,box-shadow] hover:bg-accent hover:shadow-(--control-shadow) focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">
        <MessagesSquareIcon className="size-5 shrink-0 text-muted-foreground" />
        <span><span className="block text-sm font-medium">Start without a business</span><span className="block text-[0.8125rem] text-muted-foreground">A general chat, without business context</span></span>
      </button>
      <div className="max-h-[45vh] overflow-y-auto border-t px-4 py-2" aria-busy={loading || busy}>
        {failed ? <div role="alert" className="px-2 py-4 text-sm">Couldn't load your businesses. <button type="button" className="underline" onClick={() => { setRefresh(n => n + 1); void reloadBusinesses() }}>Try again</button></div>
          : loading ? <p role="status" className="px-2 py-4 text-sm text-muted-foreground">Loading workspaces…</p>
          : targets.length === 0 ? <p className="px-2 py-4 text-sm text-muted-foreground">{query ? "No matching businesses." : "No businesses yet. You can start a general chat."}</p>
          : <section aria-label="Businesses" className="py-1">
              <h3 className="px-3 py-1.5 text-[0.8125rem] text-muted-foreground">Businesses</h3>
              {targets.map(target => <button key={target.id} type="button" disabled={busy} onClick={() => void choose(target)} className="flex w-full items-center gap-3 rounded-[8px] px-3 py-2.5 text-left text-sm outline-none transition-[background-color,box-shadow] hover:bg-accent hover:shadow-(--control-shadow) focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">
                <Building2Icon className="size-4 shrink-0 text-muted-foreground" /><span className="truncate">{target.name}</span>
              </button>)}
            </section>}
      </div>
      {error ? <p role="alert" className="border-t px-6 py-3 text-sm text-destructive">{error}</p> : null}
      <div className="flex justify-between border-t px-6 py-3 text-xs text-muted-foreground">
        <button type="button" disabled={busy} onClick={() => { setOpen(false); void navigate("/businesses") }} className="hover:text-foreground focus-visible:underline">Manage businesses</button>
        <button type="button" disabled={busy} onClick={() => { setOpen(false); void navigate("/start") }} className="hover:text-foreground focus-visible:underline">Add a business</button>
      </div>
    </DialogContent>
  </Dialog>
}
