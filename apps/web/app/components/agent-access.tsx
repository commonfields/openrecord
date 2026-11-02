// Three ways the business's agent work connects outward:
//  - a live log feed from the website's host, for AI crawler and AI referral traffic;
//  - access for outside agents (MCP grants), each limited to this business and named permissions;
//  - outside tool servers (MCP) whose read-only tools OpenRecord's agent may use.
// Secrets (feed tokens, grant tokens) are shown once, right after creation.
import { useState } from "react"
import { CableIcon, KeyRoundIcon, RadioTowerIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Panel } from "@/components/page"
import { api, ApiError } from "@/lib/api"
import { useApi } from "@/lib/use-api"

const biz = (id: string) => `/api/businesses/${encodeURIComponent(id)}`
const when = (iso: string | null) => iso ? new Date(iso).toLocaleString() : "never"

function Secret({ label, value, note }: { label: string; value: string; note: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <div className="space-y-1 rounded-md border border-dashed p-2">
      <p className="text-[0.6875rem] font-medium">{label}</p>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate font-mono text-[0.6875rem]">{value}</code>
        <Button size="sm" variant="ghost" onClick={() => { void navigator.clipboard?.writeText(value); setCopied(true) }}>{copied ? "Copied" : "Copy"}</Button>
      </div>
      <p className="text-[0.6875rem] text-muted-foreground">{note}</p>
    </div>
  )
}

function Header({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2">
      {icon}
      <div className="min-w-0 flex-1">
        <h2 className="text-xs font-medium">{title}</h2>
        <p className="text-[0.6875rem] text-muted-foreground">{children}</p>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- live log feed

type Feed = { id: string; label: string; hint: string; lastReceivedAt: string | null; recordsReceived: number; recordsUnrecognized: number; active: boolean }
export function LiveTrafficFeed({ businessId }: { businessId: string }) {
  const q = useApi(`ai-traffic-feeds:${businessId}`, () => api<{ feeds: Feed[] }>(`${biz(businessId)}/ai-traffic-feeds`))
  const [created, setCreated] = useState<{ url: string; token: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!q.data) return null
  const act = async (f: () => Promise<unknown>) => { setBusy(true); setError(null); try { await f(); await q.reload() } catch { setError("That did not work. Try again.") } finally { setBusy(false) } }
  const active = q.data.feeds.filter(f => f.active)
  return (
    <Panel id="ai-traffic-feed" className="space-y-3 p-4">
      <Header icon={<RadioTowerIcon aria-hidden className="mt-0.5 size-3.5 text-muted-foreground" />} title="Live AI traffic feed">
        Point your host&apos;s log drain at OpenRecord to see AI crawlers and AI-referred visits as they happen. Only daily counts per AI agent and page are kept; IP addresses, query strings and raw lines are discarded.
      </Header>
      {active.length ? (
        <ul className="divide-y text-xs">
          {active.map(f => (
            <li key={f.id} className="flex flex-wrap items-center gap-2 py-2">
              <span className="min-w-0 flex-1"><span className="font-medium">{f.label}</span>
                <span className="block text-[0.6875rem] text-muted-foreground">Last delivery {when(f.lastReceivedAt)} · {f.recordsReceived.toLocaleString()} records read{f.recordsUnrecognized ? `, ${f.recordsUnrecognized.toLocaleString()} not recognized` : ""} · token ending {f.hint}</span></span>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act(() => api(`${biz(businessId)}/ai-traffic-feeds/${f.id}`, { method: "DELETE" }))}>Disconnect</Button>
            </li>
          ))}
        </ul>
      ) : null}
      {created ? <Secret label="Drain URL and token (shown once)" value={`${created.url}  ·  Authorization: Bearer ${created.token}`}
        note="Add a log drain on your host with this URL and header. If it cannot set headers, use the URL with ?token= and the token appended." /> : null}
      <Button size="sm" variant="outline" disabled={busy} onClick={() => void act(async () => {
        const r = await api<{ url: string; token: string }>(`${biz(businessId)}/ai-traffic-feeds`, { method: "POST", body: JSON.stringify({ label: "Website host" }) })
        setCreated(r)
      })}>Create a feed</Button>
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
    </Panel>
  )
}

// ---------------------------------------------------------------- outside agents (MCP grants)

const PERMISSIONS: ReadonlyArray<{ id: string; label: string }> = [
  { id: "evidence:read", label: "Read evidence and business data" },
  { id: "research:run", label: "Run research and save evidence" },
  { id: "work:propose", label: "Propose work for approval" },
]
type Grant = { id: string; label: string; permissions: string[]; hint: string; expiresAt: string; lastUsedAt: string | null; active: boolean }
export function AgentAccess({ businessId }: { businessId: string }) {
  const q = useApi(`mcp-grants:${businessId}`, () => api<{ grants: Grant[]; tools: Array<{ name: string; permission: string }> }>(`${biz(businessId)}/mcp-grants`))
  const [label, setLabel] = useState("")
  const [perms, setPerms] = useState<string[]>(["evidence:read", "research:run"])
  const [created, setCreated] = useState<{ endpoint: string; token: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!q.data) return null
  const act = async (f: () => Promise<unknown>) => { setBusy(true); setError(null); try { await f(); await q.reload() } catch { setError("That did not work. Try again.") } finally { setBusy(false) } }
  const active = q.data.grants.filter(g => g.active)
  return (
    <Panel id="agent-access" className="space-y-3 p-4">
      <Header icon={<KeyRoundIcon aria-hidden className="mt-0.5 size-3.5 text-muted-foreground" />} title="Use OpenRecord from your own agent">
        Give a coding agent or assistant (any MCP client) access to this business&apos;s tools: {q.data.tools.length} tools, including the full research catalog. It works as you, for this business only, and can never approve, publish or change facts.
      </Header>
      {active.length ? (
        <ul className="divide-y text-xs">
          {active.map(g => (
            <li key={g.id} className="flex flex-wrap items-center gap-2 py-2">
              <span className="min-w-0 flex-1"><span className="font-medium">{g.label}</span>
                <span className="block text-[0.6875rem] text-muted-foreground">{g.permissions.join(", ")} · expires {new Date(g.expiresAt).toLocaleDateString()} · last used {when(g.lastUsedAt)} · token ending {g.hint}</span></span>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act(() => api(`${biz(businessId)}/mcp-grants/${g.id}`, { method: "DELETE" }))}>Revoke</Button>
            </li>
          ))}
        </ul>
      ) : null}
      {created ? <Secret label="MCP endpoint and token (shown once)" value={`${created.endpoint}  ·  Authorization: Bearer ${created.token}`}
        note="Add an MCP server in your agent with this URL (Streamable HTTP) and the Authorization header." /> : null}
      <form className="space-y-2" onSubmit={e => { e.preventDefault(); if (label.trim() && perms.length) void act(async () => {
        setCreated(await api<{ endpoint: string; token: string }>(`${biz(businessId)}/mcp-grants`, { method: "POST", body: JSON.stringify({ label: label.trim(), permissions: perms, days: 30 }) }))
        setLabel("")
      }) }}>
        <div className="flex flex-wrap gap-3">
          {PERMISSIONS.map(p => (
            <label key={p.id} className="flex items-center gap-1.5 text-[0.6875rem]">
              <input type="checkbox" checked={perms.includes(p.id)} onChange={e => setPerms(e.currentTarget.checked ? [...perms, p.id] : perms.filter(x => x !== p.id))} />{p.label}
            </label>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Input value={label} onChange={e => setLabel(e.currentTarget.value)} placeholder="Which agent, for example Claude Code on my laptop" aria-label="Agent name" className="w-80 text-xs" maxLength={80} />
          <Button size="sm" type="submit" disabled={busy || !label.trim() || !perms.length}>Create access for 30 days</Button>
        </div>
      </form>
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
    </Panel>
  )
}

// ---------------------------------------------------------------- outside tool servers (MCP connections)

type Conn = { id: string; label: string; url: string; hint: string | null; active: boolean }
export function ToolServers({ businessId }: { businessId: string }) {
  const q = useApi(`mcp-connections:${businessId}`, () => api<{ connections: Conn[] }>(`${biz(businessId)}/mcp-connections`))
  const [form, setForm] = useState({ label: "", url: "", credential: "" })
  const [note, setNote] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!q.data) return null
  const act = async (f: () => Promise<unknown>) => {
    setBusy(true); setError(null); setNote(null)
    try { await f(); await q.reload() } catch (e) {
      setError(e instanceof ApiError && e.tag === "ServerUnavailable" ? `The server could not be reached: ${String(e.body["reason"] ?? "")}` : e instanceof ApiError && e.tag === "InvalidRequest" ? "Check the name and that the address starts with https://." : "That did not work. Try again.")
    } finally { setBusy(false) }
  }
  const active = q.data.connections.filter(c => c.active)
  return (
    <Panel id="tool-servers" className="space-y-3 p-4">
      <Header icon={<CableIcon aria-hidden className="mt-0.5 size-3.5 text-muted-foreground" />} title="Tool servers for the agent">
        Connect an MCP server and OpenRecord&apos;s agent can use its tools. Only tools the server marks read-only are ever called; answers are treated as untrusted evidence. Credentials are stored encrypted and never shown again.
      </Header>
      {active.length ? (
        <ul className="divide-y text-xs">
          {active.map(c => (
            <li key={c.id} className="flex flex-wrap items-center gap-2 py-2">
              <span className="min-w-0 flex-1"><span className="font-medium">{c.label}</span><span className="block truncate text-[0.6875rem] text-muted-foreground">{c.url}{c.hint ? ` · credential ending ${c.hint}` : ""}</span></span>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act(() => api(`${biz(businessId)}/mcp-connections/${c.id}`, { method: "DELETE" }))}>Disconnect</Button>
            </li>
          ))}
        </ul>
      ) : null}
      <form className="flex flex-wrap items-center gap-2" onSubmit={e => { e.preventDefault(); if (form.label.trim() && form.url.trim()) void act(async () => {
        const r = await api<{ tools: number; readOnlyTools: number }>(`${biz(businessId)}/mcp-connections`, { method: "POST",
          body: JSON.stringify({ label: form.label.trim(), url: form.url.trim(), ...(form.credential.trim() ? { credential: form.credential.trim() } : {}) }) })
        setNote(`Connected: ${r.tools} tools, ${r.readOnlyTools} read-only and usable by the agent.`); setForm({ label: "", url: "", credential: "" })
      }) }}>
        <Input value={form.label} onChange={e => setForm({ ...form, label: e.currentTarget.value })} placeholder="Name" aria-label="Server name" className="w-40 text-xs" maxLength={80} />
        <Input value={form.url} onChange={e => setForm({ ...form, url: e.currentTarget.value })} placeholder="https://example.com/mcp" aria-label="Server address" className="w-72 font-mono text-xs" />
        <Input type="password" value={form.credential} onChange={e => setForm({ ...form, credential: e.currentTarget.value })} placeholder="Bearer token (optional)" aria-label="Server credential" autoComplete="off" className="w-56 font-mono text-xs" />
        <Button size="sm" type="submit" disabled={busy || !form.label.trim() || !form.url.trim()}>{busy ? "Checking" : "Connect"}</Button>
      </form>
      {note ? <p className="text-xs">{note}</p> : null}
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
    </Panel>
  )
}
