// Share one agent conversation as a read-only page for a client or teammate:
// create a link (shown once, to copy), see who has opened it, revoke it.
import { useEffect, useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { api } from "@/lib/api"

type Share = { id: string; hint: string; createdAt: string; expiresAt: string; lastViewedAt: string | null; active: boolean }
const base = (businessId: string, conversationId: string) => `/api/businesses/${encodeURIComponent(businessId)}/agent/conversations/${encodeURIComponent(conversationId)}/shares`

export function ShareChatDialog({ open, onOpenChange, businessId, conversationId }: { open: boolean; onOpenChange: (v: boolean) => void; businessId: string | null; conversationId: string | undefined }) {
  const [shares, setShares] = useState<Share[]>([])
  const [link, setLink] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const ready = open && businessId !== null && conversationId !== undefined
  useEffect(() => {
    if (!ready) return
    setLink(null)
    void api<{ shares: Share[] }>(base(businessId, conversationId)).then(r => setShares(r.shares)).catch(() => setShares([]))
  }, [ready, businessId, conversationId])
  if (!businessId || !conversationId) return null
  const create = async () => {
    setBusy(true)
    try {
      const r = await api<{ path: string }>(base(businessId, conversationId), { method: "POST", body: JSON.stringify({ days: 14 }) })
      const url = `${window.location.origin}${r.path}`
      setLink(url)
      void navigator.clipboard?.writeText(url).then(() => toast.success("Link copied")).catch(() => {})
      setShares((await api<{ shares: Share[] }>(base(businessId, conversationId))).shares)
    } catch { toast.error("The link could not be created. Try again.") } finally { setBusy(false) }
  }
  const revoke = async (id: string) => {
    try { setShares((await api<{ shares: Share[] }>(`${base(businessId, conversationId)}/${id}`, { method: "DELETE" })).shares); setLink(null) } catch { toast.error("It could not be revoked. Try again.") }
  }
  const active = shares.filter(s => s.active)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Share this chat</DialogTitle>
          <DialogDescription>Anyone with the link can read this conversation for 14 days, including messages added later: your messages, the agent&apos;s replies and their sources. They can&apos;t reply, and never see the agent&apos;s reasoning, tool details or the contents of attached files.</DialogDescription>
        </DialogHeader>
        {link ? (
          <div className="space-y-1 rounded-md border border-dashed p-2">
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate font-mono text-[0.6875rem]">{link}</code>
              <Button size="sm" variant="ghost" onClick={() => void navigator.clipboard?.writeText(link).then(() => toast.success("Link copied"))}>Copy</Button>
            </div>
            <p className="text-[0.6875rem] text-muted-foreground">Shown once. Revoke it below at any time.</p>
          </div>
        ) : null}
        <Button size="sm" disabled={busy} onClick={() => void create()} className="w-fit">{busy ? "Creating" : "Create a link"}</Button>
        {active.length ? (
          <ul className="divide-y border-t text-xs">
            {active.map(s => (
              <li key={s.id} className="flex items-center gap-2 py-2">
                <span className="min-w-0 flex-1">Link ending {s.hint} · expires {new Date(s.expiresAt).toLocaleDateString()} · {s.lastViewedAt ? `opened ${new Date(s.lastViewedAt).toLocaleString()}` : "not opened yet"}</span>
                <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => void revoke(s.id)}>Revoke</Button>
              </li>
            ))}
          </ul>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
