// Playbooks in the composer: OpenRecord's SEO, AEO and GEO playbooks and the
// account's own, offered as /name. Choosing one types its prompt; nothing is
// sent until the person sends it. "Save as playbook" keeps the current draft
// for every business in the account, with the business's name generalised to
// {business}.
import { useEffect, useState } from "react"
import { toast } from "sonner"
import { Trash2Icon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { api, ApiError } from "@/lib/api"

export type Playbook = { readonly name: string; readonly title: string; readonly prompt: string; readonly area: string; readonly builtIn: boolean }
export const PLAYBOOKS_CHANGED = "openrecord:playbooks-changed"

let cache: Promise<ReadonlyArray<Playbook>> | null = null
const load = () => (cache ??= api<{ playbooks: Playbook[] }>("/api/playbooks").then(r => r.playbooks).catch(() => { cache = null; return [] }))
const changed = (list: ReadonlyArray<Playbook>) => { cache = Promise.resolve(list); window.dispatchEvent(new Event(PLAYBOOKS_CHANGED)) }

/** The playbooks offered in the composer, shared by every composer on the page. */
export function usePlaybooks(enabled: boolean) {
  const [list, setList] = useState<ReadonlyArray<Playbook>>([])
  useEffect(() => {
    if (!enabled) return
    let live = true
    const refresh = () => { void load().then(l => { if (live) setList(l) }) }
    refresh()
    window.addEventListener(PLAYBOOKS_CHANGED, refresh)
    return () => { live = false; window.removeEventListener(PLAYBOOKS_CHANGED, refresh) }
  }, [enabled])
  return list
}

/** Playbooks matching "/..." typed in the composer: by name first, then by title. */
export const playbookMatches = (text: string, list: ReadonlyArray<Playbook>) => {
  const m = /^\/([a-z0-9-]*)$/i.exec(text.trim())
  if (!m) return []
  const q = m[1]!.toLowerCase()
  return [...list.filter(p => p.name.startsWith(q)), ...list.filter(p => !p.name.startsWith(q) && q.length > 1 && (p.name.includes(q) || p.title.toLowerCase().includes(q)))]
}

/** The prompt as typed for this business. */
export const playbookText = (p: Playbook, businessName: string | null) => p.prompt.replace(/\{business\}/g, businessName || "this business")

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").replace(/^[^a-z]+/, "").slice(0, 40)
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

export function SavePlaybookDialog({ open, onOpenChange, draft, businessName }: { open: boolean; onOpenChange: (v: boolean) => void; draft: string; businessName: string | null }) {
  const own = usePlaybooks(open).filter(p => !p.builtIn)
  const [title, setTitle] = useState("")
  const [name, setName] = useState("")
  const [prompt, setPrompt] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!open) return
    // A playbook is for every business: the current business's name becomes {business}.
    setPrompt(businessName ? draft.replace(new RegExp(escapeRe(businessName), "g"), "{business}") : draft)
    setTitle(""); setName(""); setError(null)
  }, [open, draft, businessName])
  const save = async () => {
    const n = name || slug(title)
    if (!/^[a-z][a-z0-9-]{1,39}$/.test(n)) { setError("The command needs 2 to 40 lowercase letters, digits or hyphens, starting with a letter."); return }
    setBusy(true); setError(null)
    try {
      const r = await api<{ playbooks: Playbook[] }>(`/api/playbooks/${n}`, { method: "PUT", body: JSON.stringify({ title: title.trim() || n, prompt: prompt.trim() }) })
      changed(r.playbooks)
      toast.success(`Saved. Type /${n} in any business's chat to use it.`)
      onOpenChange(false)
    } catch (e) {
      setError(e instanceof ApiError && e.tag === "NameTaken" ? `/${n} is already an OpenRecord command or playbook. Choose another name.` : "It could not be saved. Try again.")
    } finally { setBusy(false) }
  }
  const remove = async (n: string) => {
    try { changed((await api<{ playbooks: Playbook[] }>(`/api/playbooks/${n}`, { method: "DELETE" })).playbooks) } catch { toast.error("It could not be deleted. Try again.") }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Save as playbook</DialogTitle>
          <DialogDescription>Reuse this request in any business in your account by typing its command. {"{business}"} becomes the business&apos;s name.</DialogDescription>
        </DialogHeader>
        <form className="space-y-3" onSubmit={e => { e.preventDefault(); if (prompt.trim()) void save() }}>
          <div className="flex flex-wrap gap-2">
            <Input value={title} onChange={e => { setTitle(e.currentTarget.value); if (!name) setError(null) }} placeholder="Title, for example Monthly SEO report" aria-label="Playbook title" className="min-w-0 flex-1 text-sm" maxLength={120} autoFocus />
            <div className="flex items-center gap-1 text-sm text-muted-foreground">/<Input value={name || slug(title)} onChange={e => setName(slug(e.currentTarget.value))} aria-label="Command" className="w-40 font-mono text-sm" /></div>
          </div>
          <Textarea value={prompt} onChange={e => setPrompt(e.currentTarget.value)} rows={6} maxLength={4000} aria-label="Playbook prompt" className="text-sm" />
          {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
          <DialogFooter>
            <Button type="submit" size="sm" disabled={busy || !prompt.trim() || !(name || slug(title))}>Save playbook</Button>
          </DialogFooter>
        </form>
        {own.length ? (
          <div className="space-y-1 border-t pt-3">
            <p className="text-xs font-medium">Your playbooks</p>
            <ul className="max-h-40 divide-y overflow-y-auto">
              {own.map(p => (
                <li key={p.name} className="flex items-center gap-2 py-1.5 text-xs">
                  <span className="font-mono">/{p.name}</span><span className="min-w-0 flex-1 truncate text-muted-foreground">{p.title}</span>
                  <Button variant="ghost" size="icon-sm" className="size-7 text-muted-foreground" aria-label={`Delete /${p.name}`} onClick={() => void remove(p.name)}><Trash2Icon className="size-3.5" /></Button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
