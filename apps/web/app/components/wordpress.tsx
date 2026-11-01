// WordPress in the app: connecting a site on the Channels page, and the card
// a person approves a prepared change on. The card shows exactly what will
// change, publishes it on approval, says whether the live page shows it, and
// can undo it.
import { useState } from "react"
import { toast } from "sonner"
import { ExternalLinkIcon, GlobeIcon, Undo2Icon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { Panel } from "@/components/page"
import { ApiError, WordPress, notifyDecisionsChanged, type WordPressChange, type WordPressValues } from "@/lib/api"
import { relativeTime } from "@/lib/format"
import { useApi } from "@/lib/use-api"

const KIND_LABEL: Readonly<Record<WordPressChange["kind"], string>> = {
  UPDATE_COPY: "Update the copy of", SET_SEO: "New search title and description for", ADD_FAQ: "Add an FAQ to", CREATE_POST: "Publish a new",
}
const REASONS: Readonly<Record<string, string>> = {
  ChangedSincePrepared: "Someone edited this page in WordPress after the change was prepared, so it wasn't overwritten. Ask the agent to prepare it again.",
  SeoNotWritable: "The site's SEO plugin didn't accept the new title or description through WordPress's API. Set it in WordPress, or allow API writes in the plugin.",
  NotStoredAsApproved: "WordPress didn't store the change exactly as approved, so it isn't counted as published.",
  WordPressCredentialRefused: "WordPress no longer accepts the connected application password. Reconnect it on the Channels page.",
  WordPressNotConnected: "No WordPress site is connected. Connect it on the Channels page.",
  ChangeNotPending: "This change was already decided.",
  SiteUNAVAILABLE: "The WordPress site didn't answer. Try again in a moment.",
  SiteRATE_LIMITED: "The WordPress site is limiting requests. Try again in a few minutes.",
  SiteFORBIDDEN: "WordPress refused: the connected user can't make this change.",
  SiteNOT_FOUND: "That page or post no longer exists in WordPress.",
}
const reasonOf = (e: unknown) => e instanceof ApiError && typeof e.body["reason"] === "string" ? e.body["reason"] : ""
const plain = (html: string) => html.replace(/<!--[\s\S]*?-->/g, "").replace(/<script[\s\S]*?<\/script>/gi, " [structured data] ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
const SEO_LABEL = (key: string) => /title/.test(key) ? "Search title" : "Search description"

function Values({ label, before, after }: { label: string; before: string | undefined; after: string }) {
  return (
    <div className="space-y-1">
      <p className="text-[0.6875rem] font-medium text-muted-foreground">{label}</p>
      {before !== undefined ? <p className="rounded-md bg-destructive/5 px-2.5 py-1.5 text-xs text-muted-foreground line-through decoration-destructive/40">{before || "(empty)"}</p> : null}
      <p className="rounded-md bg-supported/10 px-2.5 py-1.5 text-xs">{after}</p>
    </div>
  )
}

function ChangePreview({ change }: { change: WordPressChange }) {
  const a: WordPressValues = change.after, b: WordPressValues = change.before
  if (change.kind === "ADD_FAQ") {
    const added = plain((a.content ?? "").slice((b.content ?? "").replace(/\s+$/, "").length))
    return <Values label="Added at the end of the page" before={undefined} after={added.slice(0, 1200)} />
  }
  return (
    <div className="space-y-2.5">
      {a.title !== undefined ? <Values label="Title" before={change.kind === "CREATE_POST" ? undefined : b.title} after={a.title} /> : null}
      {Object.entries(a.meta ?? {}).map(([k, v]) => <Values key={k} label={SEO_LABEL(k)} before={b.meta?.[k]} after={v} />)}
      {a.content !== undefined ? (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground">{change.kind === "CREATE_POST" ? "Body" : "Body text, before and after"}</summary>
          <div className="mt-2 space-y-2">
            {change.kind !== "CREATE_POST" ? <p className="max-h-40 overflow-y-auto rounded-md bg-destructive/5 px-2.5 py-1.5 text-muted-foreground">{plain(b.content ?? "").slice(0, 3000)}</p> : null}
            <p className="max-h-40 overflow-y-auto rounded-md bg-supported/10 px-2.5 py-1.5">{plain(a.content).slice(0, 3000)}</p>
          </div>
        </details>
      ) : null}
    </div>
  )
}

export function WordPressChangeCard({ businessId, change: initial, onDone }: { businessId: string; change: WordPressChange; onDone?: () => void }) {
  const [change, setChange] = useState(initial)
  const [busy, setBusy] = useState(false)
  const act = (work: () => Promise<{ change: WordPressChange }>, success: string) => void (async () => {
    setBusy(true)
    try { const r = await work(); setChange(r.change); toast.success(success); notifyDecisionsChanged(); onDone?.() }
    catch (e) {
      toast.error(REASONS[reasonOf(e)] ?? "That didn't work. Try again.")
      void WordPress.change(businessId, change.id).then(r => setChange(r.change), () => {})
    } finally { setBusy(false) }
  })()
  const what = `${KIND_LABEL[change.kind]} ${change.kind === "CREATE_POST" ? (change.postType === "pages" ? "page" : "post") : `"${change.targetTitle}"`}`
  return (
    <div className="space-y-3 rounded-[10px] bg-card p-4 shadow-(--card-shadow)">
      <div className="flex flex-wrap items-center gap-2">
        <GlobeIcon className="size-3.5 text-muted-foreground" />
        <span className="min-w-0 flex-1 text-sm font-medium">{what}</span>
        <Badge variant={change.status === "PUBLISHED" ? "supported" : change.status === "FAILED" ? "review" : "outline"}>
          {{ PROPOSED: "Waiting for approval", PUBLISHING: "Publishing", PUBLISHED: "Published", REJECTED: "Rejected", FAILED: "Not published", UNDONE: "Undone" }[change.status]}
        </Badge>
      </div>
      <p className="text-xs text-muted-foreground">{change.rationale}</p>
      <ChangePreview change={change} />
      {change.status === "FAILED" && change.failure ? <p className="text-xs text-destructive">{REASONS[change.failure] ?? "It couldn't be published."}</p> : null}
      {change.status === "PUBLISHED" ? (
        <p className="text-xs text-muted-foreground">
          Published {change.decidedAt ? relativeTime(change.decidedAt) : ""}.{" "}
          {change.liveCheck?.observed === true ? "The live page shows it." : change.liveCheck?.observed === false ? "The live page doesn't show it yet; a cache may be delaying it." : "OpenRecord couldn't check the live page."}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {change.status === "PROPOSED" ? <>
          <Button size="sm" className="h-8 text-xs" disabled={busy} onClick={() => act(() => WordPress.approve(businessId, change.id), "Published to WordPress")}>Approve and publish</Button>
          <Button size="sm" variant="ghost" className="h-8 text-xs" disabled={busy} onClick={() => act(() => WordPress.reject(businessId, change.id), "Change rejected")}>Reject</Button>
        </> : null}
        {change.status === "PUBLISHED" ? (
          <Button size="sm" variant="outline" className="h-8 text-xs" disabled={busy} onClick={() => act(() => WordPress.undo(businessId, change.id), change.kind === "CREATE_POST" ? "Moved back to draft" : "Change undone")}>
            <Undo2Icon />Undo
          </Button>
        ) : null}
        {(change.publishedLink ?? change.targetLink) ? (
          <Button asChild size="sm" variant="ghost" className="h-8 text-xs text-muted-foreground">
            <a href={change.publishedLink ?? change.targetLink ?? undefined} target="_blank" rel="noreferrer noopener"><ExternalLinkIcon />Open page</a>
          </Button>
        ) : null}
      </div>
    </div>
  )
}

/** The card for a change the agent prepared in this chat, loaded by id. */
export function WordPressChangeById({ businessId, changeId }: { businessId: string; changeId: string }) {
  const q = useApi(`wordpress-change:${changeId}`, () => WordPress.change(businessId, changeId))
  if (!q.data) return q.loading ? <Skeleton className="h-32 rounded-[10px]" /> : null
  return <WordPressChangeCard businessId={businessId} change={q.data.change} />
}

const CONNECT_ERRORS: Readonly<Record<string, string>> = {
  SiteAUTH: "WordPress didn't accept that username and application password.",
  CannotPublish: "That WordPress user can't publish and edit pages. Use an Administrator or Editor.",
  SiteREST_UNAVAILABLE: "This site's REST API isn't reachable. It may be turned off by a security plugin.",
  SiteNOT_PUBLIC: "That address doesn't point to a public website.",
  SiteREDIRECTED: "That address redirects. Use the site's final address, starting with https://.",
  InvalidRequest: "Check the address (it must start with https://), the username and the application password.",
  WordPressNotConfigured: "Not switched on for this OpenRecord server yet. It needs a token encryption key.",
}

export function WordPressSetup({ businessId }: { businessId: string }) {
  const q = useApi(`wordpress:${businessId}`, () => WordPress.status(businessId))
  const [siteUrl, setSiteUrl] = useState(""), [username, setUsername] = useState(""), [password, setPassword] = useState("")
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null)
  if (!q.data) return q.loading ? <Skeleton className="h-24 rounded-xl" /> : null
  const { configured, connection } = q.data
  const act = async (f: () => Promise<unknown>) => {
    setBusy(true); setError(null)
    try { await f(); setPassword(""); await q.reload() } catch (e) { setError(CONNECT_ERRORS[reasonOf(e)] ?? "Couldn't connect. Try again.") } finally { setBusy(false) }
  }
  return (
    <Panel id="wordpress" className="space-y-3 p-4">
      <div className="flex items-start gap-2">
        <GlobeIcon aria-hidden className="mt-0.5 size-3.5 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <h2 className="text-xs font-medium">Website, WordPress</h2>
          <p className="text-[0.6875rem] text-muted-foreground">So the agent can improve your pages: titles, search descriptions, FAQs and new posts. Nothing is published until you approve the exact change, and every change can be undone.</p>
        </div>
      </div>
      {!configured ? <p className="text-[0.6875rem] text-muted-foreground">{CONNECT_ERRORS["WordPressNotConfigured"]}</p>
      : connection && connection.status === "ACTIVE" ? (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <p className="min-w-0 flex-1">
            Connected to <span className="font-medium">{connection.siteName || connection.siteUrl}</span> as {connection.username}, connected {relativeTime(connection.connectedAt)}.
            {connection.seoPlugin === "NONE" ? " No Yoast or Rank Math found, so search titles and descriptions can't be set." : ` Search titles through ${connection.seoPlugin === "YOAST" ? "Yoast" : "Rank Math"}.`}
          </p>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act(() => WordPress.disconnect(businessId))}>Disconnect</Button>
        </div>
      ) : (
        <form className="space-y-2" onSubmit={e => { e.preventDefault(); void act(() => WordPress.connect(businessId, siteUrl, username, password)) }}>
          {connection?.status === "REVOKED" ? <p className="text-xs text-destructive">WordPress no longer accepts the application password ending {connection.last4}. Create a new one.</p> : null}
          <ol className="list-decimal space-y-0.5 pl-4 text-[0.6875rem] text-muted-foreground">
            <li>In WordPress, open <span className="font-medium text-foreground">Users, Profile</span> for an Administrator or Editor.</li>
            <li>Under <span className="font-medium text-foreground">Application Passwords</span>, name it OpenRecord and choose Add.</li>
            <li>Copy the password WordPress shows (it's only shown once) and paste it here. You can revoke it there anytime.</li>
          </ol>
          <div className="grid gap-2 sm:grid-cols-3">
            <Input value={siteUrl} onChange={e => setSiteUrl(e.currentTarget.value)} placeholder="https://yoursite.com" aria-label="Site address" className="text-xs" />
            <Input value={username} onChange={e => setUsername(e.currentTarget.value)} placeholder="WordPress username" aria-label="WordPress username" autoComplete="off" className="text-xs" />
            <Input value={password} onChange={e => setPassword(e.currentTarget.value)} placeholder="Application password" aria-label="Application password" autoComplete="off" spellCheck={false} className="font-mono text-xs" />
          </div>
          <Button size="sm" type="submit" disabled={busy || !siteUrl.trim() || !username.trim() || !password.trim()}>Connect WordPress</Button>
        </form>
      )}
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
    </Panel>
  )
}
