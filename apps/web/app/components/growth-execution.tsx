// W7 connected change on one approved initiative: connect a repository, review
// one exact change, approve that exact change, send it as a pull request, then
// follow what GitHub confirms and, separately, what the live website shows.
// OpenRecord never merges and never deploys. The words never turn a provider
// response into "marketing work completed".
import { useState } from "react"
import type { ExecutionOperation, ExecutionTarget } from "@openrecord/contracts"
import { executionFacts } from "@openrecord/contracts"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { formatDateTime } from "@/lib/format"
import { EXECUTION_STATE_COPY, GrowthExecutions, executionError, executionFactLines, executionStopCopy, type SiteChoice } from "@/lib/growth-execution"

const TONE = { ok: "supported", wait: "outline", no: "review" } as const

export function ExecutionDiff({ diff }: { diff: string }) {
  return <pre aria-label="Exact change" className="max-h-64 overflow-auto rounded-md border bg-muted/30 p-3 font-mono text-[11px] leading-relaxed">{diff.split("\n").map((line, i) =>
    <span key={i} className={line.startsWith("+") && !line.startsWith("+++") ? "block bg-green-500/10" : line.startsWith("-") && !line.startsWith("---") ? "block bg-red-500/10" : "block text-muted-foreground"}>{line || " "}</span>)}</pre>
}

export function ExecutionFacts({ operation }: { operation: ExecutionOperation }) {
  const lines = executionFactLines(executionFacts(operation))
  return <ul className="space-y-1" aria-label="What is confirmed">{lines.map(l => <li key={l.label} className="flex flex-wrap items-center gap-2">
    <span className="w-32 shrink-0 text-muted-foreground">{l.label}</span><Badge variant={TONE[l.tone]}>{l.text}</Badge></li>)}
    <li className="text-muted-foreground">Business results are measured separately. None of the lines above shows them.</li></ul>
}

export function ExecutionCard({ businessId, operation: o, reload }: { businessId: string; operation: ExecutionOperation; reload: () => Promise<void> }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState(false)
  const [reason, setReason] = useState("")
  const copy = EXECUTION_STATE_COPY[o.state]
  const stop = executionStopCopy(o)
  const pr = o.evidence.find(e => e.kind === "PR_OPENED")
  const run = async (work: () => Promise<unknown>) => { setBusy(true); setError(null); try { await work(); await reload() } catch (err) { setError(executionError(err)); await reload().catch(() => undefined) } finally { setBusy(false) } }
  return <article className="space-y-3 rounded-md border p-3" aria-label={`Connected change ${o.filePath}`}>
    <div className="flex flex-wrap items-center gap-2"><span className="font-medium">Remove noindex from {o.filePath}</span><Badge variant={o.state === "VERIFIED" ? "supported" : o.state === "FAILED" || o.state === "BLOCKED" ? "review" : "outline"}>{copy.title}</Badge></div>
    <p className="text-muted-foreground">{stop ?? copy.detail}</p>
    <dl className="grid gap-2 sm:grid-cols-2">
      <div><dt className="text-muted-foreground">Repository</dt><dd className="break-all">{o.owner}/{o.repository}, branch {o.baseBranch}</dd></div>
      <div><dt className="text-muted-foreground">Page</dt><dd className="break-all">{o.filePath}, live at {o.liveUrl}</dd></div>
      <div><dt className="text-muted-foreground">Reviewed from commit</dt><dd className="break-all font-mono">{o.baseCommitSha.slice(0, 12)}</dd></div>
      <div><dt className="text-muted-foreground">Change identity</dt><dd className="break-all font-mono">{o.patchSha256.slice(0, 16)}…</dd></div>
    </dl>
    <ExecutionDiff diff={o.diff} />
    <p className="text-muted-foreground">Risk: if the page was meant to stay out of search, removing noindex makes it indexable. Boundary: OpenRecord only opens a pull request with exactly this change. It will not merge it, deploy it or edit anything else.</p>
    {pr ? <p>Pull request: <a className="underline" href={String(pr.detail["prUrl"])} target="_blank" rel="noreferrer noopener">#{String(pr.detail["prNumber"])} on GitHub</a></p> : null}
    {o.receipt ? <p>GitHub merge confirmed {formatDateTime(o.receipt.mergedAt)}, merge commit <span className="font-mono">{o.receipt.mergeCommitSha.slice(0, 12)}</span>. This is recorded on the initiative as a verified merge, not as the website being live.</p> : null}
    <ExecutionFacts operation={o} />
    {o.liveChecks.length ? <details><summary className="cursor-pointer font-medium">Website checks ({o.liveChecks.length})</summary>
      <ol className="mt-2 space-y-1 border-l pl-3">{o.liveChecks.map(c => <li key={c.id}>{formatDateTime(c.checkedAt)}: {c.detail}</li>)}</ol></details> : null}
    <details><summary className="cursor-pointer font-medium">History ({o.events.length})</summary>
      <ol className="mt-2 space-y-1 border-l pl-3">{o.events.map(e => <li key={e.id}>{EXECUTION_STATE_COPY[e.state].title} by {e.actor === "EXECUTION_SYSTEM" ? "OpenRecord" : e.actor === "ASSISTANT" ? "Operator Agent" : "operator"}, {formatDateTime(e.createdAt)}. {e.reason}</li>)}</ol></details>
    {error ? <p role="alert" className="text-destructive">{error}</p> : null}
    {o.state === "PREPARED" ? <div className="space-y-2">
      <label className="flex items-start gap-2"><input type="checkbox" checked={confirm} onChange={e => setConfirm(e.target.checked)} className="mt-0.5" />
        <span>I reviewed this exact change, its repository, page and risk, and authorize opening a pull request.</span></label>
      <Label htmlFor={`exec-reason-${o.id}`}>Reason for approving</Label><Textarea id={`exec-reason-${o.id}`} value={reason} onChange={e => setReason(e.target.value)} maxLength={1000} />
      <div className="flex gap-2"><Button size="sm" disabled={busy || !confirm || !reason.trim()} onClick={() => void run(async () => {
        const { operation } = await GrowthExecutions.authorize(businessId, o.id, { reviewedPatchSha256: o.patchSha256, expectedRevision: o.revision, reason, idempotencyKey: crypto.randomUUID() })
        await GrowthExecutions.dispatch(businessId, o.id, { expectedRevision: operation.revision, idempotencyKey: crypto.randomUUID() })
      })}>{busy ? "Sending…" : "Approve and open pull request"}</Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(() => GrowthExecutions.cancel(businessId, o.id, { expectedRevision: o.revision, reason: "Cancelled by the operator", idempotencyKey: crypto.randomUUID() }))}>Cancel</Button></div></div> : null}
    {o.state === "AUTHORIZED" ? <div className="flex gap-2">
      <Button size="sm" disabled={busy} onClick={() => void run(() => GrowthExecutions.dispatch(businessId, o.id, { expectedRevision: o.revision, idempotencyKey: crypto.randomUUID() }))}>{busy ? "Sending…" : "Open the pull request"}</Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(() => GrowthExecutions.cancel(businessId, o.id, { expectedRevision: o.revision, reason: "Cancelled by the operator", idempotencyKey: crypto.randomUUID() }))}>Cancel</Button></div> : null}
    {o.state === "AWAITING_MERGE" || o.state === "UNKNOWN" || o.state === "RECONCILING" ? <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(() => GrowthExecutions.check(businessId, o.id))}>Check GitHub now</Button> : null}
    {o.state === "VERIFIED" ? <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(() => GrowthExecutions.liveCheck(businessId, o.id))}>Check the website now</Button> : null}
  </article>
}

function ConnectForm({ businessId, sites, done }: { businessId: string; sites: ReadonlyArray<SiteChoice>; done: (t: ExecutionTarget) => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [key] = useState(() => crypto.randomUUID())
  if (!sites.length) return <p className="text-muted-foreground">Register the website under Search first. A repository is connected to a registered website.</p>
  return <form className="grid gap-2" onSubmit={async e => {
    e.preventDefault(); const f = new FormData(e.currentTarget); setBusy(true); setError(null)
    try {
      const paths = String(f.get("allowedPaths") ?? "").split(/[\s,]+/).filter(Boolean)
      done((await GrowthExecutions.connect(businessId, { owner: String(f.get("owner")).trim(), repository: String(f.get("repository")).trim(), baseBranch: String(f.get("baseBranch")).trim(), siteTargetId: String(f.get("siteTargetId")), allowedPaths: paths, idempotencyKey: key })).target)
    } catch (err) { setError(executionError(err)) } finally { setBusy(false) }
  }}>
    <p className="text-muted-foreground">Connect the repository that publishes this website. Your administrator must have allowed it for your account.</p>
    <div className="grid gap-2 sm:grid-cols-3">
      <div className="grid gap-1"><Label htmlFor="exec-owner">Owner</Label><Input id="exec-owner" name="owner" required maxLength={39} /></div>
      <div className="grid gap-1"><Label htmlFor="exec-repo">Repository</Label><Input id="exec-repo" name="repository" required maxLength={100} /></div>
      <div className="grid gap-1"><Label htmlFor="exec-branch">Base branch</Label><Input id="exec-branch" name="baseBranch" required defaultValue="main" maxLength={200} /></div>
    </div>
    <div className="grid gap-1"><Label htmlFor="exec-site">Registered website</Label>
      <select id="exec-site" name="siteTargetId" className="h-8 rounded-md border bg-background px-2 text-xs">{sites.map(s => <option key={s.id} value={s.id}>{s.canonicalOrigin}</option>)}</select></div>
    <div className="grid gap-1"><Label htmlFor="exec-paths">Pages OpenRecord may change (HTML files, or a folder ending in /)</Label><Input id="exec-paths" name="allowedPaths" required placeholder="pricing.html pages/" /></div>
    {error ? <p role="alert" className="text-destructive">{error}</p> : null}
    <Button size="sm" disabled={busy} className="justify-self-start">{busy ? "Connecting…" : "Connect repository"}</Button>
  </form>
}

function PrepareForm({ businessId, opportunityId, targets, done }: { businessId: string; opportunityId: string; targets: ReadonlyArray<ExecutionTarget>; done: () => Promise<void> }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [key, setKey] = useState(() => crypto.randomUUID())
  return <form className="grid gap-2" onSubmit={async e => {
    e.preventDefault(); const f = new FormData(e.currentTarget); setBusy(true); setError(null)
    try {
      await GrowthExecutions.prepare(businessId, opportunityId, { targetId: String(f.get("targetId")), actionKind: "REMOVE_NOINDEX_META", filePath: String(f.get("filePath")).trim(), liveUrl: String(f.get("liveUrl")).trim(),
        rationale: String(f.get("rationale")).trim(), siteFindingId: null, idempotencyKey: key })
      setKey(crypto.randomUUID()); await done()
    } catch (err) { setError(executionError(err)) } finally { setBusy(false) }
  }}>
    <p className="text-muted-foreground">One supported change: remove an accidental robots noindex directive from one HTML page. OpenRecord reads the page from the repository and shows you the exact change before anything is sent.</p>
    <div className="grid gap-1"><Label htmlFor={`exec-target-${opportunityId}`}>Repository</Label>
      <select id={`exec-target-${opportunityId}`} name="targetId" className="h-8 rounded-md border bg-background px-2 text-xs">{targets.map(t => <option key={t.id} value={t.id}>{t.owner}/{t.repository} ({t.baseBranch})</option>)}</select></div>
    <div className="grid gap-2 sm:grid-cols-2">
      <div className="grid gap-1"><Label htmlFor={`exec-file-${opportunityId}`}>Page in the repository</Label><Input id={`exec-file-${opportunityId}`} name="filePath" required placeholder="pricing.html" maxLength={300} /></div>
      <div className="grid gap-1"><Label htmlFor={`exec-live-${opportunityId}`}>Where that page is live</Label><Input id={`exec-live-${opportunityId}`} name="liveUrl" type="url" required placeholder="https://example.com/pricing.html" maxLength={2000} /></div>
    </div>
    <div className="grid gap-1"><Label htmlFor={`exec-why-${opportunityId}`}>Why this change</Label><Textarea id={`exec-why-${opportunityId}`} name="rationale" required maxLength={2000} /></div>
    {error ? <p role="alert" className="text-destructive">{error}</p> : null}
    <Button size="sm" disabled={busy} className="justify-self-start">{busy ? "Preparing…" : "Prepare the exact change"}</Button>
  </form>
}

export function GrowthExecutionSection({ businessId, opportunityId }: { businessId: string; opportunityId: string }) {
  const [state, setState] = useState<{ operations: ReadonlyArray<ExecutionOperation>; targets: ReadonlyArray<ExecutionTarget>; sites: ReadonlyArray<SiteChoice> } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const load = async () => {
    setBusy(true); setError(null)
    try {
      const [ops, targets, sites] = await Promise.all([GrowthExecutions.list(businessId, opportunityId), GrowthExecutions.targets(businessId), GrowthExecutions.sites(businessId).catch(() => ({ sites: [] as SiteChoice[] }))])
      setState({ operations: ops.operations, targets: targets.targets, sites: sites.sites })
    } catch (err) { setError(executionError(err)) } finally { setBusy(false) }
  }
  return <details className="text-xs" onToggle={e => { if ((e.currentTarget as HTMLDetailsElement).open && !state && !busy) void load() }}>
    <summary className="cursor-pointer font-medium">Connected change</summary>
    <div className="mt-2 space-y-3">
      <p className="text-muted-foreground">Send one exact, approved website change to a repository as a pull request. This is separate from recording work by hand. A pull request is not a live change and not a business result.</p>
      {busy && !state ? <p className="text-muted-foreground">Loading…</p> : null}
      {error ? <p role="alert" className="text-destructive">{error}</p> : null}
      {state ? <>
        {state.operations.map(o => <ExecutionCard key={o.id} businessId={businessId} operation={o} reload={load} />)}
        {state.targets.length ? <PrepareForm businessId={businessId} opportunityId={opportunityId} targets={state.targets} done={load} /> : null}
        <details><summary className="cursor-pointer font-medium">{state.targets.length ? "Connect another repository" : "Connect a repository"}</summary>
          <div className="mt-2"><ConnectForm businessId={businessId} sites={state.sites} done={() => void load()} /></div></details>
      </> : null}
    </div>
  </details>
}
