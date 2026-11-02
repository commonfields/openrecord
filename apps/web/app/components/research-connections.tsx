// The business's own accounts with data providers, for the agent's research:
// Google Cloud (YouTube Data, Chrome real-user speed), GitHub, Reddit, Product
// Hunt, Bing Webmaster and, optionally and paid by the business, an SEO data
// account. Credentials are checked for format, stored encrypted and never
// shown again; OpenRecord only reads with them.
import { useState } from "react"
import { DatabaseIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Panel } from "@/components/page"
import { api, ApiError } from "@/lib/api"
import { useApi } from "@/lib/use-api"

type ProviderRow = { id: string; name: string; how: string; url: string; example: string; paid: boolean; optional: boolean; endpoints: string[]; connected: boolean; hint: string | null }
type Status = { available: boolean; providers: ProviderRow[] }
const base = (id: string) => `/api/businesses/${encodeURIComponent(id)}/research-connections`

export function ResearchConnections({ businessId }: { businessId: string }) {
  const q = useApi(`research-connections:${businessId}`, () => api<Status>(base(businessId)))
  const [open, setOpen] = useState<string | null>(null)
  const [value, setValue] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState("")
  if (!q.data) return null
  const needle = filter.trim().toLowerCase()
  const shown = q.data.providers.filter(p => !needle || p.connected || `${p.name} ${p.endpoints.join(" ")}`.toLowerCase().includes(needle))
  const act = async (f: () => Promise<unknown>) => {
    setBusy(true); setError(null)
    try { await f(); setValue(""); setOpen(null); await q.reload() } catch (e) {
      setError(e instanceof ApiError && e.tag === "CredentialFormat" ? `That doesn't look right. It should look like ${String(e.body["example"] ?? "")}` : e instanceof ApiError && e.tag === "NotConfigured" ? "Connections are not available yet. Contact your workspace administrator for help." : "That did not work. Try again.")
    } finally { setBusy(false) }
  }
  return (
    <Panel id="research-connections" className="space-y-3 p-4">
      <div className="flex items-start gap-2">
        <DatabaseIcon aria-hidden className="mt-0.5 size-3.5 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <h2 className="text-xs font-medium">Research data connections</h2>
          <p className="text-[0.6875rem] text-muted-foreground">Your own accounts with data providers, so the agent can research with them. Public sources work without any of these. Read-only: keys are stored encrypted and never shown again.</p>
        </div>
      </div>
      {q.data.available && q.data.providers.length > 10 ? (
        <Input value={filter} onChange={e => setFilter(e.currentTarget.value)} placeholder={`Search ${q.data.providers.length} providers, for example CRM, email, podcasts`} aria-label="Search providers" className="w-80 text-xs" />
      ) : null}
      {!q.data.available ? <p className="text-[0.6875rem] text-muted-foreground">Connections are not available yet. Contact your workspace administrator for help.</p> : (
        <ul className="divide-y">
          {shown.map(p => (
            <li key={p.id} className="space-y-2 py-2">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="min-w-0 flex-1"><span className="font-medium">{p.name}</span>{p.paid ? <span className="text-muted-foreground"> (billed to your own account)</span> : p.optional ? <span className="text-muted-foreground"> (optional, raises limits)</span> : null}
                  <span className="block text-[0.6875rem] text-muted-foreground">{p.endpoints.slice(0, 4).join(", ")}{p.endpoints.length > 4 ? ` and ${p.endpoints.length - 4} more` : ""}</span></span>
                {p.connected ? (<>
                  <span className="text-[0.6875rem] text-muted-foreground">Connected, ending {p.hint}</span>
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act(() => api(`${base(businessId)}/${p.id}`, { method: "DELETE" }))}>Disconnect</Button>
                </>) : <Button size="sm" variant="outline" onClick={() => { setOpen(open === p.id ? null : p.id); setValue(""); setError(null) }}>Connect</Button>}
              </div>
              {open === p.id ? (
                <form className="space-y-2" onSubmit={e => { e.preventDefault(); if (value.trim()) void act(() => api(`${base(businessId)}/${p.id}`, { method: "PUT", body: JSON.stringify({ credential: value.trim() }) })) }}>
                  <p className="text-[0.6875rem] text-muted-foreground">{p.how} <a className="underline" href={p.url} target="_blank" rel="noopener noreferrer">Open</a></p>
                  <div className="flex flex-wrap items-center gap-2">
                    <Input type="password" value={value} onChange={e => setValue(e.currentTarget.value)} placeholder={p.example} autoComplete="off" spellCheck={false} aria-label={`${p.name} credential`} className="w-80 font-mono text-xs" />
                    <Button size="sm" type="submit" disabled={busy || !value.trim()}>Save</Button>
                  </div>
                </form>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
    </Panel>
  )
}
