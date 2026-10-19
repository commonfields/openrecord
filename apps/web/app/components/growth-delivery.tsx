import { useState } from "react"
import type { DeliveryTarget, GrowthDelivery, GrowthOpportunity } from "@openrecord/contracts"
import { ExternalLinkIcon, GitPullRequestIcon, PlusIcon, RefreshCwIcon, XIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Panel, PanelHeader } from "@/components/page"
import { ApiError } from "@/lib/api"
import { formatDateTime } from "@/lib/format"
import { cn } from "@/lib/utils"
import { DELIVERY_STATE_LABELS, Delivery, deliveryError } from "@/lib/growth-delivery"

// Marketing delivery (one channel): a reviewed copy change to one Markdown/MDX
// file, opened as a GitHub pull request by a person. OpenRecord never merges
// or deploys; it records what GitHub confirmed and what the operator attests.

export function DeliveryRepositories({ businessId, targets, reload }: { businessId: string; targets: DeliveryTarget[]; reload: () => Promise<void> }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [requestKey, setRequestKey] = useState(() => crypto.randomUUID())
  return <Panel>
    <PanelHeader title="Delivery repository" description="Where approved copy changes are opened as pull requests. Connecting does not grant access by itself: the server's allowlist and token decide.">
      <Button size="sm" variant="outline" onClick={() => { setOpen(true); setError(null); setRequestKey(crypto.randomUUID()) }}><PlusIcon />Connect repository</Button>
    </PanelHeader>
    <div className="p-5 pt-3 text-xs">
      {targets.length ? <ul className="space-y-2">{targets.map(t => <li key={t.id} className="flex flex-wrap items-center gap-2">
        <GitPullRequestIcon className="size-3.5 text-muted-foreground" />
        <span className="font-medium">{t.owner}/{t.repository}</span>
        <span className="text-muted-foreground">base {t.baseBranch} · {t.allowedPaths.join(", ")}</span>
      </li>)}</ul> : <p className="text-muted-foreground">No repository connected. A website address never implies repository access.</p>}
    </div>
    <Dialog open={open} onOpenChange={o => { if (!busy) setOpen(o) }}><DialogContent><DialogHeader>
      <DialogTitle>Connect a GitHub repository</DialogTitle>
      <DialogDescription>Only Markdown or MDX files under the paths you allow can be changed, and only through a pull request you open.</DialogDescription>
    </DialogHeader><form className="grid gap-4" onSubmit={async e => {
      e.preventDefault(); const form = new FormData(e.currentTarget); setBusy(true); setError(null)
      const text = (k: string) => String(form.get(k) ?? "").trim()
      try {
        await Delivery.connect(businessId, { owner: text("owner"), repository: text("repository"), baseBranch: text("baseBranch"),
          allowedPaths: text("allowedPaths").split(/[\n,]/).map(s => s.trim()).filter(Boolean), idempotencyKey: requestKey })
        setOpen(false); await reload()
      } catch (err) { setError(deliveryError(err)) } finally { setBusy(false) }
    }}>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-2"><Label htmlFor="repo-owner">Owner</Label><Input id="repo-owner" name="owner" placeholder="your-org" required /></div>
        <div className="grid gap-2"><Label htmlFor="repo-name">Repository</Label><Input id="repo-name" name="repository" placeholder="website" required /></div>
      </div>
      <div className="grid gap-2"><Label htmlFor="repo-branch">Base branch</Label><Input id="repo-branch" name="baseBranch" defaultValue="main" required /></div>
      <div className="grid gap-2"><Label htmlFor="repo-paths">Allowed paths</Label>
        <Textarea id="repo-paths" name="allowedPaths" placeholder={"content/pages/\nsrc/content/landing.mdx"} required />
        <p className="text-[0.6875rem] text-muted-foreground">One per line: a folder ending in “/” or an exact .md/.mdx file. Hidden folders such as .github are refused.</p>
      </div>
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
      <DialogFooter><Button type="button" variant="ghost" disabled={busy} onClick={() => setOpen(false)}>Cancel</Button><Button disabled={busy}>{busy ? "Checking GitHub…" : "Connect repository"}</Button></DialogFooter>
    </form></DialogContent></Dialog>
  </Panel>
}

/** Unified diff with removed lines red and added lines green. */
function DiffView({ diff }: { diff: string }) {
  const lines = diff.split("\n").slice(2)
  return <pre className="max-h-80 overflow-auto rounded-lg border bg-muted/30 py-2 font-mono text-[0.6875rem] leading-relaxed" aria-label="Proposed change">
    {lines.map((line, i) => <div key={i} className={cn("px-3 whitespace-pre-wrap",
      line.startsWith("+") ? "bg-supported-soft text-supported" : line.startsWith("-") ? "bg-wrong-soft text-wrong" : line.startsWith("@@") ? "text-muted-foreground" : "text-foreground/80")}>
      {line || " "}
    </div>)}
  </pre>
}

type Edit = { find: string; replace: string }
function PrepareChange({ businessId, opportunity, targets, done }: { businessId: string; opportunity: GrowthOpportunity; targets: DeliveryTarget[]; done: () => Promise<void> }) {
  const [targetId, setTargetId] = useState(targets[0]?.id ?? "")
  const [edits, setEdits] = useState<Edit[]>([{ find: "", replace: "" }])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [requestKey] = useState(() => crypto.randomUUID())
  const target = targets.find(t => t.id === targetId)
  const setEdit = (i: number, patch: Partial<Edit>) => setEdits(all => all.map((e, j) => j === i ? { ...e, ...patch } : e))
  return <form className="grid gap-4" onSubmit={async e => {
    e.preventDefault(); const form = new FormData(e.currentTarget); setBusy(true); setError(null)
    const text = (k: string) => String(form.get(k) ?? "").trim()
    try {
      await Delivery.prepare(businessId, opportunity.id, { targetId, filePath: text("filePath"), edits, rationale: text("rationale"), assumptions: text("assumptions"), idempotencyKey: requestKey })
      await done()
    } catch (err) { setError(deliveryError(err)) } finally { setBusy(false) }
  }}>
    {targets.length > 1 ? <div className="grid gap-2"><Label htmlFor="delivery-target">Repository</Label>
      <select id="delivery-target" className="h-8 rounded-md border bg-background px-2 text-xs" value={targetId} onChange={e => setTargetId(e.target.value)}>
        {targets.map(t => <option key={t.id} value={t.id}>{t.owner}/{t.repository}</option>)}
      </select></div> : null}
    <div className="grid gap-2"><Label htmlFor="delivery-path">File</Label>
      <Input id="delivery-path" name="filePath" placeholder={target?.allowedPaths.find(p => p.endsWith("/")) ? `${target.allowedPaths.find(p => p.endsWith("/"))}index.md` : "content/home.md"} required />
      <p className="text-[0.6875rem] text-muted-foreground">Allowed: {target?.allowedPaths.join(", ")} on {target?.baseBranch}.</p>
    </div>
    <div className="grid gap-3">
      <p className="text-xs font-medium">Exact changes</p>
      {edits.map((edit, i) => <div key={i} className="grid gap-2 rounded-lg border p-3">
        <div className="flex items-center justify-between"><Label htmlFor={`find-${i}`}>Current text {i + 1}</Label>
          {edits.length > 1 ? <Button type="button" size="icon-sm" variant="ghost" aria-label="Remove change" onClick={() => setEdits(all => all.filter((_, j) => j !== i))}><XIcon /></Button> : null}</div>
        <Textarea id={`find-${i}`} value={edit.find} onChange={e => setEdit(i, { find: e.target.value })} placeholder="Paste the text exactly as it is in the file" required />
        <Label htmlFor={`replace-${i}`}>Replace with</Label>
        <Textarea id={`replace-${i}`} value={edit.replace} onChange={e => setEdit(i, { replace: e.target.value })} />
      </div>)}
      {edits.length < 20 ? <Button type="button" size="sm" variant="outline" className="justify-self-start" onClick={() => setEdits(all => [...all, { find: "", replace: "" }])}><PlusIcon />Add another change</Button> : null}
      <p className="text-[0.6875rem] text-muted-foreground">Each current text must appear exactly once, so nothing is guessed.</p>
    </div>
    <div className="grid gap-2"><Label htmlFor="delivery-rationale">Why this change</Label><Textarea id="delivery-rationale" name="rationale" defaultValue={opportunity.expectedMechanism} maxLength={2000} required /></div>
    <div className="grid gap-2"><Label htmlFor="delivery-assumptions">Assumptions</Label><Textarea id="delivery-assumptions" name="assumptions" defaultValue={opportunity.assumptions} maxLength={2000} required /></div>
    {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
    <DialogFooter><Button disabled={busy || !targetId}>{busy ? "Reading the file…" : "Prepare change for review"}</Button></DialogFooter>
  </form>
}

type Action = "approve" | "reject" | "open" | "deploy"
function DeliveryCard({ businessId, delivery: d, reload }: { businessId: string; delivery: GrowthDelivery; reload: () => Promise<void> }) {
  const [action, setAction] = useState<Action | null>(null)
  const [reason, setReason] = useState("")
  const [requestKey, setRequestKey] = useState(() => crypto.randomUUID())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const begin = (next: Action) => { setAction(next); setReason(""); setError(null); setRequestKey(crypto.randomUUID()) }
  const opened = d.events.find(e => e.state === "PR_OPENED")
  const merged = d.events.find(e => e.state === "PR_MERGED")
  const deployed = d.events.find(e => e.state === "DEPLOYMENT_VERIFIED")
  const unknown = d.state === "APPROVED_FOR_PR" && d.attempts.at(-1)?.state === "UNKNOWN"
  const tone = d.state === "DEPLOYMENT_VERIFIED" || d.state === "PR_MERGED" ? "supported" : d.state === "DRAFTED" || d.state === "APPROVED_FOR_PR" || d.state === "PR_OPENED" ? "review" : "outline"
  const submit = async (run: () => Promise<unknown>) => {
    setBusy(true); setError(null)
    try { await run(); setAction(null); await reload() } catch (err) { setError(deliveryError(err)); await reload() } finally { setBusy(false) }
  }
  const openPullRequest = () => submit(async () => {
    try {
      const r = await Delivery.openPullRequest(businessId, d.id, requestKey)
      setNotice(r.outcome === "REPLAYED" ? "The pull request already exists; nothing was sent again." : null)
    } catch (err) {
      // 409/502 carry the recorded outcome: stale base, refusal, or unconfirmed.
      if (err instanceof ApiError && typeof err.body["outcome"] === "string") {
        setNotice(err.body["outcome"] === "STALE" ? "The file changed on the base branch after review. Nothing was written. Prepare the change again."
          : err.body["outcome"] === "UNKNOWN" ? "GitHub did not confirm the result. Trying again checks GitHub before writing anything."
          : "GitHub refused the change. Nothing was opened.")
        return
      }
      throw err
    }
  })
  return <div id={`delivery-${d.id}`} className="space-y-3 rounded-xl border bg-card p-4">
    <div className="flex flex-wrap items-center gap-2">
      <span className="min-w-0 flex-1 truncate text-xs font-medium">{d.owner}/{d.repository} · {d.filePath}</span>
      <Badge variant={tone}>{DELIVERY_STATE_LABELS[d.state]}</Badge>
    </div>
    <DiffView diff={d.diff} />
    <dl className="grid gap-2 text-xs sm:grid-cols-2">
      <div><dt className="text-muted-foreground">Why</dt><dd className="mt-0.5 whitespace-pre-wrap">{d.rationale}</dd></div>
      <div><dt className="text-muted-foreground">Assumptions</dt><dd className="mt-0.5 whitespace-pre-wrap">{d.assumptions}</dd></div>
      <div><dt className="text-muted-foreground">Prepared by</dt><dd className="mt-0.5">{d.proposedBy === "ASSISTANT" ? "Operator Agent (draft)" : "Account operator"}, {formatDateTime(d.createdAt)}</dd></div>
      <div><dt className="text-muted-foreground">Reviewed against</dt><dd className="mt-0.5 font-mono text-[0.6875rem]">{d.baseBranch} @ {d.baseCommitSha.slice(0, 7)} · patch {d.patchSha256.slice(0, 12)}</dd></div>
    </dl>
    {opened ? <p className="text-xs">Pull request: <a className="inline-flex items-center gap-1 underline" href={String(opened.detail["prUrl"])} target="_blank" rel="noreferrer">#{String(opened.detail["prNumber"])}<ExternalLinkIcon className="size-3" /></a>
      {merged ? <span className="text-muted-foreground"> · merged on GitHub ({String(merged.detail["mergeCommitSha"]).slice(0, 7)})</span> : null}</p> : null}
    {d.state === "PR_MERGED" ? <p className="text-xs text-muted-foreground">Merged is not deployed. Record a deployment once you have seen the change live.</p> : null}
    {deployed ? <p className="text-xs">Deployment attested by an operator: seen at <a className="underline" href={String(deployed.detail["url"])} target="_blank" rel="noreferrer">{String(deployed.detail["url"])}</a> on {formatDateTime(String(deployed.detail["observedAt"]))}. <span className="text-muted-foreground">Not verified by OpenRecord.</span></p> : null}
    {d.state === "STALE" ? <p className="text-xs text-muted-foreground">The file changed on the base branch after this was reviewed. Nothing was written; prepare the change again.</p> : null}
    {d.state === "CLOSED_WITHOUT_DELIVERY" ? <p className="text-xs text-muted-foreground">The pull request was closed without merging. Nothing was delivered.</p> : null}
    {unknown ? <p className="text-xs text-review">GitHub did not confirm the last attempt. Trying again checks GitHub before writing anything.</p> : null}
    {notice ? <p role="status" className="text-xs">{notice}</p> : null}
    <div className="flex flex-wrap gap-2">
      {d.state === "DRAFTED" ? <><Button size="sm" onClick={() => begin("approve")}>Approve for pull request</Button><Button size="sm" variant="outline" onClick={() => begin("reject")}>Reject</Button></> : null}
      {d.state === "APPROVED_FOR_PR" ? <><Button size="sm" onClick={() => begin("open")}><GitPullRequestIcon />{unknown ? "Try again" : "Open pull request"}</Button><Button size="sm" variant="outline" onClick={() => begin("reject")}>Reject</Button></> : null}
      {d.state === "PR_OPENED" ? <Button size="sm" variant="outline" disabled={busy} onClick={() => void submit(() => Delivery.refresh(businessId, d.id))}><RefreshCwIcon />Check GitHub status</Button> : null}
      {d.state === "PR_MERGED" ? <Button size="sm" onClick={() => begin("deploy")}>Record deployment</Button> : null}
    </div>
    {error && action === null ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
    <details className="text-xs"><summary className="cursor-pointer font-medium">History ({d.events.length})</summary><ol className="mt-2 space-y-1.5 border-l pl-3">
      {d.events.map(e => <li key={e.id}>{DELIVERY_STATE_LABELS[e.state]} · {e.actor === "DELIVERY_SYSTEM" ? "confirmed by GitHub" : e.actor === "ASSISTANT" ? "Operator Agent" : "operator"} · {formatDateTime(e.createdAt)}<p className="text-muted-foreground">{e.reason}</p></li>)}
    </ol></details>

    <Dialog open={action !== null} onOpenChange={o => { if (!o && !busy) setAction(null) }}><DialogContent><DialogHeader>
      <DialogTitle>{action === "approve" ? "Approve this exact change" : action === "reject" ? "Reject this change" : action === "open" ? "Open a pull request on GitHub" : "Record a deployment"}</DialogTitle>
      <DialogDescription>{action === "approve" ? `Approval binds patch ${d.patchSha256.slice(0, 12)}. A different change needs a new review.`
        : action === "reject" ? "Nothing is sent to GitHub. The history is kept."
        : action === "open" ? `This is the only step that writes outside OpenRecord.`
        : "You attest where and when you saw the change live. OpenRecord records it as operator-attested and does not verify it."}</DialogDescription>
    </DialogHeader>
      {action === "open" ? <div className="space-y-3 text-xs">
        <ol className="list-decimal space-y-1 pl-4">
          <li>Check that {d.filePath} on {d.baseBranch} is still the version you reviewed. If not, stop and write nothing.</li>
          <li>Create the branch <span className="font-mono">openrecord/growth-{d.id.slice(0, 8)}…</span> from {d.baseBranch}.</li>
          <li>Commit exactly the approved file content to it.</li>
          <li>Open a pull request into {d.baseBranch} in {d.owner}/{d.repository}.</li>
        </ol>
        <p className="text-muted-foreground">OpenRecord does not merge or deploy it.</p>
        {error ? <p role="alert" className="text-destructive">{error}</p> : null}
        <DialogFooter><Button type="button" variant="ghost" disabled={busy} onClick={() => setAction(null)}>Cancel</Button><Button disabled={busy} onClick={() => void openPullRequest()}>{busy ? "Working with GitHub…" : "Open pull request"}</Button></DialogFooter>
      </div> : action === "deploy" ? <form className="grid gap-3" onSubmit={e => {
        e.preventDefault(); const form = new FormData(e.currentTarget)
        void submit(() => Delivery.attest(businessId, d.id, { url: String(form.get("url")), observedAt: new Date(String(form.get("observedAt"))).toISOString(),
          note: String(form.get("note") ?? "").trim(), expectedRevision: d.revision, idempotencyKey: requestKey }))
      }}>
        <div className="grid gap-2"><Label htmlFor={`deploy-url-${d.id}`}>Live page</Label><Input id={`deploy-url-${d.id}`} name="url" type="url" required /></div>
        <div className="grid gap-2"><Label htmlFor={`deploy-at-${d.id}`}>Seen live at</Label><Input id={`deploy-at-${d.id}`} name="observedAt" type="datetime-local" required /></div>
        <div className="grid gap-2"><Label htmlFor={`deploy-note-${d.id}`}>What you saw</Label><Textarea id={`deploy-note-${d.id}`} name="note" maxLength={1000} required /></div>
        {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
        <DialogFooter><Button type="button" variant="ghost" disabled={busy} onClick={() => setAction(null)}>Cancel</Button><Button disabled={busy}>{busy ? "Saving…" : "Record attested deployment"}</Button></DialogFooter>
      </form> : <form className="grid gap-3" onSubmit={e => {
        e.preventDefault()
        void submit(() => Delivery.decide(businessId, d.id, { approve: action === "approve", reviewedPatchSha256: d.patchSha256, expectedRevision: d.revision, reason: reason.trim(), idempotencyKey: requestKey }))
      }}>
        <Label htmlFor={`delivery-reason-${d.id}`}>Reason for your decision</Label>
        <Textarea id={`delivery-reason-${d.id}`} value={reason} onChange={e => setReason(e.target.value)} maxLength={1000} required />
        {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
        <DialogFooter><Button type="button" variant="ghost" disabled={busy} onClick={() => setAction(null)}>Cancel</Button><Button disabled={busy || !reason.trim()}>{busy ? "Saving…" : action === "approve" ? "Approve change" : "Reject change"}</Button></DialogFooter>
      </form>}
    </DialogContent></Dialog>
  </div>
}

export function OpportunityDelivery({ businessId, opportunity, targets, deliveries, reload }: {
  businessId: string; opportunity: GrowthOpportunity; targets: DeliveryTarget[]; deliveries: GrowthDelivery[]; reload: () => Promise<void>
}) {
  const [preparing, setPreparing] = useState(false)
  const deliverable = opportunity.status === "APPROVED"
  if (!deliverable && deliveries.length === 0) return null
  return <section aria-label="Delivery" className="space-y-3 border-t pt-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="text-xs font-medium">Delivery</h3>
      {deliverable ? <Button size="sm" variant="outline" disabled={!targets.length} onClick={() => setPreparing(true)}>Prepare a change</Button> : null}
    </div>
    {deliverable && !targets.length ? <p className="text-xs text-muted-foreground">Connect a delivery repository to prepare a change for this opportunity.</p> : null}
    {deliveries.map(d => <DeliveryCard key={d.id} businessId={businessId} delivery={d} reload={reload} />)}
    <Dialog open={preparing} onOpenChange={setPreparing}><DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl"><DialogHeader>
      <DialogTitle>Prepare a change</DialogTitle><DialogDescription>{opportunity.title}. OpenRecord reads the current file and shows you the exact diff before anything is approved.</DialogDescription>
    </DialogHeader>
      <PrepareChange businessId={businessId} opportunity={opportunity} targets={targets} done={async () => { setPreparing(false); await reload() }} />
    </DialogContent></Dialog>
  </section>
}
