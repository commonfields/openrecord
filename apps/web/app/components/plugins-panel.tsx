// Plugins for a business on the Channels page: OpenRecord's packs and the
// account's own, each switched on per business. A plugin adds playbooks to
// the composer and guidance to the agent; it never grants tools or lifts the
// approval rules. The account installs its own from a JSON manifest.
import { useState } from "react"
import { toast } from "sonner"
import { PuzzleIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { Panel } from "@/components/page"
import { playbooksChanged } from "@/components/playbooks"
import { api, ApiError } from "@/lib/api"
import { useApi } from "@/lib/use-api"

type Plugin = { name: string; title: string; description: string; version: string; source: "OPENRECORD" | "YOURS"; enabled: boolean; playbookCount: number
  guidance?: string; toolServers?: Array<{ label: string; url: string; why?: string }> }
const EXAMPLE = JSON.stringify({ name: "dental-clinics", title: "Dental clinics", description: "How we market dental clinics.", version: "1.0.0",
  guidance: "Patients choose by insurance accepted, emergency availability and reviews. Lead with those.",
  playbooks: [{ name: "insurance-pages", title: "Insurance pages", prompt: "Check which insurers {business} accepts and whether each has a page that AI answers can cite." }] }, null, 2)

export function PluginsPanel({ businessId }: { businessId: string }) {
  const base = `/api/businesses/${encodeURIComponent(businessId)}/plugins`
  const q = useApi(`plugins:${businessId}`, () => api<{ plugins: Plugin[] }>(base))
  const [busy, setBusy] = useState<string | null>(null)
  const [installing, setInstalling] = useState(false)
  const [manifest, setManifest] = useState(EXAMPLE)
  const [error, setError] = useState<string | null>(null)
  if (!q.data) return null
  const toggle = async (p: Plugin) => {
    setBusy(p.name)
    try { await api(`${base}/${p.name}`, { method: p.enabled ? "DELETE" : "POST" }); await q.reload(); playbooksChanged(); toast.success(p.enabled ? `${p.title} switched off` : `${p.title} switched on`) }
    catch { toast.error("That did not work. Try again.") } finally { setBusy(null) }
  }
  const install = async () => {
    setError(null)
    let m: { name?: unknown }
    try { m = JSON.parse(manifest) as { name?: unknown } } catch { setError("That isn't valid JSON."); return }
    try {
      await api(`/api/plugins/${encodeURIComponent(String(m.name ?? ""))}`, { method: "PUT", body: manifest })
      await q.reload(); setInstalling(false); toast.success("Plugin installed. Switch it on for the businesses that should use it.")
    } catch (e) {
      setError(e instanceof ApiError && e.tag === "InvalidManifest" ? String(e.body["rule"] ?? "The manifest is not valid.") : e instanceof ApiError && e.tag === "PlaybookNameTaken" ? `The playbook /${String(e.body["name"])} already exists. Rename it.` : e instanceof ApiError && e.tag === "NameTaken" ? "That name is an OpenRecord plugin. Choose another." : "It could not be installed. Try again.")
    }
  }
  const remove = async (p: Plugin) => {
    try { await api(`/api/plugins/${p.name}`, { method: "DELETE" }); await q.reload(); playbooksChanged() } catch { toast.error("It could not be removed. Try again.") }
  }
  return (
    <Panel id="plugins" className="space-y-3 p-4">
      <div className="flex items-start gap-2">
        <PuzzleIcon aria-hidden className="mt-0.5 size-3.5 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <h2 className="text-xs font-medium">Plugins</h2>
          <p className="text-[0.6875rem] text-muted-foreground">Packs of playbooks and guidance for this kind of business. A plugin shapes how the agent works here; it never gives it new permissions or skips your approval.</p>
        </div>
        <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setInstalling(v => !v)}>{installing ? "Close" : "Install your own"}</Button>
      </div>
      <ul className="divide-y">
        {q.data.plugins.map(p => (
          <li key={p.name} className="flex flex-wrap items-center gap-3 py-2.5 text-xs">
            <div className="min-w-0 flex-1">
              <p className="font-medium">{p.title} <span className="font-normal text-muted-foreground">· {p.source === "OPENRECORD" ? "OpenRecord" : "Yours"} · v{p.version}{p.playbookCount ? ` · ${p.playbookCount} playbook${p.playbookCount === 1 ? "" : "s"}` : ""}</span></p>
              <p className="text-[0.6875rem] text-muted-foreground">{p.description}</p>
              {p.enabled && p.toolServers?.length ? <p className="text-[0.6875rem] text-muted-foreground">Suggests tool servers: {p.toolServers.map(t => t.label).join(", ")}. Connect them under Tool servers.</p> : null}
            </div>
            {p.source === "YOURS" ? <Button size="sm" variant="ghost" className="h-7 text-xs text-muted-foreground" onClick={() => void remove(p)}>Remove</Button> : null}
            <Switch checked={p.enabled} disabled={busy === p.name} onCheckedChange={() => void toggle(p)} aria-label={`${p.title} for this business`} />
          </li>
        ))}
      </ul>
      {installing ? (
        <form className="step-in space-y-2" onSubmit={e => { e.preventDefault(); void install() }}>
          <p className="text-[0.6875rem] text-muted-foreground">Paste a plugin manifest: name, title, description, version, and optional guidance, playbooks (with {"{business}"} for the business's name) and tool servers.</p>
          <Textarea value={manifest} onChange={e => setManifest(e.currentTarget.value)} rows={10} spellCheck={false} aria-label="Plugin manifest" className="font-mono text-[0.6875rem]" />
          {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
          <Button size="sm" type="submit">Install plugin</Button>
        </form>
      ) : null}
    </Panel>
  )
}
