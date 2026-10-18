import { AgentChat } from "@/components/agent-chat"
// One client's record, operated by the agency: identity, three approved
// facts with one question each, checks on the live surface, human review,
// agency actions, the weekly re-check and its outcome, and the share URL.
import { useState, type ReactNode } from "react"
import { Link, useParams } from "react-router"
import { toast } from "sonner"
import {
  ArrowRightIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CircleDashedIcon,
  CircleHelpIcon,
  CircleStopIcon,
  CopyIcon,
  ExternalLinkIcon,
  GlobeIcon,
  LinkIcon,
  LoaderCircleIcon,
  PenLineIcon,
  PlayIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { EmptyState, PageHeader, Panel, PanelHeader, domainOf } from "@/components/page"
import { Spinner } from "@/components/spinner"
import { SearchSuggestions } from "@/components/search-suggestions"
import { errorMessage, formatDate, formatDateTime, relativeTime, sentenceCase } from "@/lib/format"
import { ApiError } from "@/lib/api"
import {
  DECISION_LABELS, FINDING_STATE_LABELS, OUTCOME_LABELS, publicRecordPath, Records, RUN_STATUS_LABELS, safeRecordUrl,
  type Decision, type OperatorRecord, type RecordCheck, type RecordResponse, type SourceKind, type ValueType,
} from "@/lib/record"

const SOURCE_KIND_LABELS: Record<string, string> = {
  BUSINESS_APPROVED: "Business-approved",
  WEBSITE: "Website",
  PUBLIC_SOURCE_UNAPPROVED: "Public source, unapproved",
}
import { useApi } from "@/lib/use-api"
import { cn } from "@/lib/utils"

const REFUSALS: Record<string, string> = {
  NoApprovedFacts: "Approve at least one fact before running a check.",
  FactNotCurrentlyValid: "An approved fact is not currently valid. Save and approve its current version before checking.",
  InvalidFactValidity: "The end of a fact's validity must follow its start.",
  RunInProgress: "A check is already running for this client.",
  NoBaseline: "Run the first check before a weekly re-check.",
  BaselineLocked: "A weekly re-check already compares against the first check, so the first check cannot be redone.",
  ItemSuperseded: "This fact was edited since; approve the current version.",
  FactsManagedByRepository: "This client's facts are managed by a repository manifest.",
  FixtureProviderDisabled: "The test fixture provider is disabled on this server.",
  InvalidSamples: "A run checks each fact 1 to 5 times.",
  SamplingPolicyChanged: "A re-check must reuse the first check's number of samples per fact.",
  FactNotValidAtObservation: "The approved fact was not valid when this was observed; save the version that was.",
  InvalidClaim: "The quoted claim must come from the observed answer.",
  Conflict: "Someone else just changed this. Reload and try again.",
}
const failure = (e: unknown) => {
  if (e instanceof ApiError && typeof e.body["reason"] === "string") return REFUSALS[e.body["reason"]] ?? e.body["reason"]
  return errorMessage(e)
}
const FAILURES: Record<string, string> = {
  PROVIDER_AUTH: "The provider rejected OpenRecord's credentials. Check GEMINI_API_KEY on the worker.",
  PROVIDER_UNSUPPORTED: "The provider is not configured for this model. Check GEMINI_API_KEY and GEMINI_MODEL on the worker.",
  PROVIDER_RATE_LIMITED: "The provider rate-limited the request.",
  PROVIDER_TIMEOUT: "The provider timed out.",
  PROVIDER_UNAVAILABLE: "The provider was unavailable.",
  PROVIDER_MALFORMED: "The provider returned an unreadable or oversized response.",
  PROVIDER_CONTRACT_MISMATCH: "The provider returned no usable answer (for example a blocked response).",
  WORKER_LOST: "The worker stopped before this check finished. Nothing was observed.",
}

const decisionTone: Record<Decision, string> = {
  MATCHES: "border-supported/50 bg-supported-soft text-supported",
  CONTRADICTS: "border-wrong/50 bg-wrong-soft text-wrong",
  UNKNOWN: "border-unknown/50 bg-unknown-soft text-unknown",
}

function useAction(reload: () => Promise<void>) {
  const [busy, setBusy] = useState(false)
  const run = async (fn: () => Promise<unknown>, success?: string) => {
    setBusy(true)
    try {
      await fn()
      await reload()
      if (success) toast.success(success)
      return true
    } catch (e) {
      toast.error(failure(e))
      return false
    } finally {
      setBusy(false)
    }
  }
  return { busy, run }
}

function EditClientDialog({ record, reload, open, onOpenChange }: { record: OperatorRecord; reload: () => Promise<void>; open: boolean; onOpenChange: (v: boolean) => void }) {
  const [name, setName] = useState(record.profile.name)
  const [website, setWebsite] = useState(record.profile.websiteUrl)
  const { busy, run } = useAction(reload)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit client</DialogTitle>
          <DialogDescription>The name and website appear on the shared record.</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            void run(() => Records.update(record.profile.businessId, { name: name.trim(), websiteUrl: website.trim() }), "Client updated").then((saved) => {
              if (saved) onOpenChange(false)
            })
          }}
        >
          <div className="grid gap-2">
            <Label htmlFor="name">Client name</Label>
            <Input id="name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="site">Website</Label>
            <Input id="site" type="url" value={website} onChange={(e) => setWebsite(e.target.value)} />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? <Spinner /> : null}
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function SlotEditor({ clientId, clientName, slot, current, reload, onDone }: {
  clientId: string; clientName: string; slot: 1 | 2 | 3; current: OperatorRecord["slots"][number] | undefined; reload: () => Promise<void>; onDone?: () => void
}) {
  const item = current?.item
  const [label, setLabel] = useState(item?.fact.predicate ?? "")
  const [value, setValue] = useState(item?.fact.valueText ?? "")
  const [valueType, setValueType] = useState<ValueType>(item?.fact.valueType ?? "TEXT")
  const [sourceKind, setSourceKind] = useState<SourceKind>(
    item?.fact.sourceKind === "BUSINESS_APPROVED" || item?.fact.sourceKind === "PUBLIC_SOURCE_UNAPPROVED" ? item.fact.sourceKind : "WEBSITE")
  const [source, setSource] = useState(item?.sourceUrl ?? "https://")
  const [question, setQuestion] = useState(item?.question.prompt ?? "")
  const { busy, run } = useAction(reload)
  const dirty = !item || label !== item.fact.predicate || value !== item.fact.valueText || valueType !== item.fact.valueType || sourceKind !== (item.fact.sourceKind ?? "WEBSITE") || source !== item.sourceUrl || question !== item.question.prompt
  const save = () =>
    run(
      () =>
        Records.saveSlot(clientId, slot, {
          subject: item?.fact.subject ?? clientName, predicate: label.trim(), valueText: value.trim(), valueType, sourceKind, sourceUrl: source.trim(), question: question.trim(),
          ...(item ? { validFrom: item.fact.validFrom, validUntil: item.fact.validUntil } : {}),
        }),
      "Saved. Approve this version before it is checked.",
    ).then((saved) => {
      if (saved) onDone?.()
    })
  return (
    <form
      className="grid gap-3"
      onSubmit={(e) => {
        e.preventDefault()
        void save()
      }}
    >
      <div className="grid gap-3 sm:grid-cols-[1fr_1fr_9rem]">
        <div className="grid gap-1.5"><Label htmlFor={`label-${slot}`} className="text-xs">Fact</Label><Input id={`label-${slot}`} placeholder="Check-in time" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={200} /></div>
        <div className="grid gap-1.5"><Label htmlFor={`value-${slot}`} className="text-xs">Approved value</Label><Input id={`value-${slot}`} placeholder="3:00 PM" value={value} onChange={(e) => setValue(e.target.value)} maxLength={500} /></div>
        <div className="grid gap-1.5">
          <Label className="text-xs">Type</Label>
          <Select value={valueType} onValueChange={(v) => setValueType(v as ValueType)}>
            <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>{(["TEXT", "BOOLEAN", "NUMBER", "CURRENCY", "DATE", "URL", "ENUM"] as const).map((t) => <SelectItem key={t} value={t}>{sentenceCase(t)}</SelectItem>)}</SelectContent>
          </Select>
        </div>
      </div>
      <div className="grid gap-1.5">
        <Label className="text-xs">Truth authority</Label>
        <Select value={sourceKind} onValueChange={(v) => setSourceKind(v as SourceKind)}>
          <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="BUSINESS_APPROVED">Business-approved</SelectItem>
            <SelectItem value="WEBSITE">Website (default)</SelectItem>
            <SelectItem value="PUBLIC_SOURCE_UNAPPROVED">Public source, unapproved</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-[0.6875rem] text-muted-foreground">Unapproved public-source facts are never presented as business truth.</p>
      </div>
      <div className="grid gap-1.5"><Label htmlFor={`source-${slot}`} className="text-xs">Source URL (where this fact is published)</Label><Input id={`source-${slot}`} type="url" value={source} onChange={(e) => setSource(e.target.value)} maxLength={2000} /></div>
      <div className="grid gap-1.5"><Label htmlFor={`question-${slot}`} className="text-xs">Question a buyer would ask</Label><Input id={`question-${slot}`} placeholder={`What time is check-in at ${clientName}?`} value={question} onChange={(e) => setQuestion(e.target.value)} maxLength={500} /></div>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" disabled={busy || !dirty || !label.trim() || !value.trim() || !question.trim()}>
          {busy ? <Spinner /> : null}
          {item ? "Save new version" : "Save fact"}
        </Button>
        {onDone && item ? (
          <Button type="button" size="sm" variant="ghost" onClick={onDone}>
            Cancel
          </Button>
        ) : null}
        {item && (current?.history.length ?? 0) > 1 ? (
          <span className="text-[0.6875rem] text-muted-foreground">
            Version {current!.history.length}. Earlier checks keep the question and fact they used; a changed question or fact makes the next comparison indeterminate.
          </span>
        ) : null}
      </div>
    </form>
  )
}

// Light reading view of a provider answer: bold, italics, bullets and
// headings. Display only; the exact stored text is one toggle away and is
// what judgments refer to.
function inline(text: string) {
  return text.split(/(\*\*[^*]+\*\*|\*[^*\s][^*]*\*)/g).map((part, i) =>
    part.startsWith("**") && part.endsWith("**") && part.length > 4 ? <strong key={i} className="font-semibold">{part.slice(2, -2)}</strong>
    : part.startsWith("*") && part.endsWith("*") && part.length > 2 ? <em key={i}>{part.slice(1, -1)}</em>
    : part)
}

function AnswerText({ text }: { text: string }) {
  const blocks: Array<{ kind: "p" | "h" | "li"; depth: number; text: string }> = []
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue
    const bullet = raw.match(/^(\s*)[*-]\s+(.*)$/)
    const heading = raw.match(/^\s*#{1,6}\s+(.*)$/)
    if (bullet) blocks.push({ kind: "li", depth: bullet[1]!.length >= 2 ? 1 : 0, text: bullet[2]! })
    else if (heading) blocks.push({ kind: "h", depth: 0, text: heading[1]! })
    else blocks.push({ kind: "p", depth: 0, text: raw.trim() })
  }
  return (
    <div className="space-y-2 text-[0.8125rem] leading-relaxed">
      {blocks.map((b, i) =>
        b.kind === "li" ? (
          <div key={i} className={cn("flex gap-2", b.depth ? "pl-5" : "pl-1")}>
            <span aria-hidden className="mt-[0.6em] size-1 shrink-0 rounded-full bg-muted-foreground/60" />
            <span className="min-w-0">{inline(b.text)}</span>
          </div>
        ) : b.kind === "h" ? (
          <p key={i} className="pt-1 font-semibold">{inline(b.text)}</p>
        ) : (
          <p key={i}>{inline(b.text)}</p>
        ),
      )}
    </div>
  )
}

const DECISION_ICONS: Record<Decision, typeof CheckIcon> = { MATCHES: CheckIcon, CONTRADICTS: XIcon, UNKNOWN: CircleHelpIcon }
const DECISION_HINTS: Record<Decision, string> = {
  MATCHES: "The answer agrees with the approved value",
  CONTRADICTS: "The answer states something the approved value rules out",
  UNKNOWN: "The answer does not let you decide",
}
const decisionDot: Record<Decision, string> = { MATCHES: "bg-supported", CONTRADICTS: "bg-wrong", UNKNOWN: "bg-unknown" }

function suggestionsHtml(o: NonNullable<RecordCheck["observation"]>) {
  return o.provider === "gemini" && o.providerMetadata !== null && typeof o.providerMetadata === "object" && "searchSuggestionsHtml" in o.providerMetadata && typeof o.providerMetadata.searchSuggestionsHtml === "string" ? o.providerMetadata.searchSuggestionsHtml : null
}

function Review({ clientId, check, approvedValue, reload, onJudged }: {
  clientId: string; check: RecordCheck; approvedValue: string | null; reload: () => Promise<void>; onJudged?: () => void
}) {
  const [note, setNote] = useState("")
  const [span, setSpan] = useState("")
  const [raw, setRaw] = useState(false)
  const [full, setFull] = useState(false)
  const { busy, run } = useAction(reload)
  if (check.status === "QUEUED" || check.status === "RUNNING")
    return (
      <p className="flex items-center gap-2 rounded-lg bg-review-soft/60 px-3 py-2.5 text-review">
        <LoaderCircleIcon className="size-3.5 animate-spin" />
        Check {check.status.toLowerCase()}…
      </p>
    )
  if (check.status === "FAILED" || !check.observation) {
    const stopped = check.failureClass === "CANCELLED"
    return (
      <p className={cn("flex items-start gap-2 rounded-lg px-3 py-2.5", stopped ? "bg-muted/60 text-muted-foreground" : "bg-partial-soft text-partial")}>
        {stopped ? <CircleStopIcon className="mt-0.5 size-3.5 shrink-0" /> : <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" />}
        <span>
          {stopped
            ? "Stopped before it ran. Nothing was asked and nothing was stored."
            : <>Check failed: {FAILURES[check.failureClass ?? ""] ?? check.failureDetailSafe ?? check.failureClass}. It shows as “could not be completed”; run a new check to try again.</>}
        </span>
      </p>
    )
  }
  const o = check.observation
  // Long answers start folded so the decision stays close; judgments still
  // refer to the full stored text.
  const long = o.answerText.length > 700
  const folded = long && !full
  const judge = (d: Decision) => {
    const claim = span.trim() ? { text: span.trim(), span: span.trim() } : undefined
    void run(() => Records.judge(clientId, o.id, d, note.trim() || null, claim), `Marked ${DECISION_LABELS[d].toLowerCase()}`).then((saved) => {
      if (saved) {
        setNote("")
        setSpan("")
        onJudged?.()
      }
    })
  }
  return (
    <div className="space-y-3">
      <article className="rounded-lg border bg-muted/25">
        <header className="flex items-center justify-between gap-3 border-b px-4 py-2 text-[0.6875rem] text-muted-foreground">
          <span className="truncate">
            {o.modelVersion ?? o.observedModel ?? o.requestedModel ?? "model unknown"} · {formatDateTime(o.collectedAt)} ·{" "}
            {check.retrievalObserved ? (
              <span className="text-supported">live web</span>
            ) : (
              <strong className="font-medium text-partial">{check.retrievalRequested ? "retrieval requested but not used" : "no live web"}</strong>
            )}
            {o.synthetic ? <strong className="font-medium text-partial"> · synthetic fixture</strong> : null}
          </span>
          <button type="button" className="shrink-0 font-medium hover:text-foreground" onClick={() => setRaw((v) => !v)}>
            {raw ? "Formatted" : "Exact text"}
          </button>
        </header>
        <div className="px-4 py-3">
          <div className={cn(folded && "max-h-56 overflow-hidden [mask-image:linear-gradient(to_bottom,black_60%,transparent)]")}>
            {raw ? <pre className="font-sans text-[0.8125rem] leading-relaxed whitespace-pre-wrap">{o.answerText}</pre> : <AnswerText text={o.answerText} />}
          </div>
          {long ? (
            <button type="button" className="mt-1 inline-flex items-center gap-1 text-[0.6875rem] font-medium text-muted-foreground hover:text-foreground" onClick={() => setFull((v) => !v)}>
              <ChevronDownIcon className={cn("size-3 transition-transform", full && "rotate-180")} />
              {full ? "Show less" : "Show full answer"}
            </button>
          ) : null}
        </div>
        <footer className="border-t px-4 py-2 text-[0.6875rem] leading-relaxed text-muted-foreground">
          <span className="font-medium">Sources</span>{" "}
          {o.citations.length
            ? o.citations.map((c, i) => {
                const url = safeRecordUrl(c.uri)
                const label = c.title ?? (url ? domainOf(url) : "untitled")
                return (
                  <span key={i}>
                    {i > 0 ? <span aria-hidden> · </span> : null}
                    {url ? <a className="text-foreground/80 hover:text-foreground hover:underline" href={url} target="_blank" rel="noreferrer" title={url}>{label}</a> : label}
                  </span>
                )
              })
            : "none cited"}
        </footer>
      </article>

      <SearchSuggestions html={suggestionsHtml(o)} />

      <div className="space-y-2 pt-1">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <p className="min-w-0">
            <span className="text-muted-foreground">Does it match </span>
            <span className="font-semibold">{approvedValue ?? "the approved fact"}</span>
            <span className="text-muted-foreground">?</span>
          </p>
          {check.judgment ? (
            <span className="text-[0.6875rem] text-muted-foreground">
              {check.judgments.length > 1 ? `Corrected ${check.judgments.length - 1}×` : `Reviewed ${formatDateTime(check.judgment.reviewedAt)}`}
            </span>
          ) : (
            <span className="text-[0.6875rem] font-medium text-review">Not reviewed yet</span>
          )}
        </div>
        <div className="grid grid-cols-3 gap-2">
          {(["MATCHES", "CONTRADICTS", "UNKNOWN"] as Decision[]).map((d) => {
            const Icon = DECISION_ICONS[d]
            const selected = check.judgment?.decision === d
            return (
              <button
                key={d}
                type="button"
                disabled={busy}
                title={DECISION_HINTS[d]}
                aria-pressed={selected}
                onClick={() => judge(d)}
                className={cn(
                  "inline-flex h-8 items-center justify-center gap-1.5 rounded-lg border font-medium transition-colors hover:bg-muted/60 disabled:opacity-50",
                  selected && decisionTone[d],
                )}
              >
                {busy ? <Spinner /> : <Icon className="size-3.5" />}
                {DECISION_LABELS[d]}
              </button>
            )
          })}
        </div>
        {check.claims.length ? (
          <ul className="space-y-0.5 text-[0.6875rem] text-muted-foreground">
            {check.claims.map((c) => (
              <li key={c.id}>Quoted: “{c.supportingSpan ?? c.claimText}”</li>
            ))}
          </ul>
        ) : null}
        <details className="group">
          <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-[0.6875rem] text-muted-foreground hover:text-foreground">
            <ChevronRightIcon className="size-3 transition-transform group-open:rotate-90" />
            Add a private note or the exact words you judged{note.trim() || span.trim() ? " · added" : ""}
          </summary>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <Input placeholder="Private note (optional)" aria-label="Internal note" className="h-8 text-xs" value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} />
            <Input placeholder="Exact words from the answer (optional)" aria-label="Exact quoted span" className="h-8 text-xs" value={span} onChange={(e) => setSpan(e.target.value)} maxLength={2000} />
          </div>
        </details>
      </div>
    </div>
  )
}

function checksFor(record: OperatorRecord, runId: string | undefined, slot: number) {
  const run = record.runs.find((r) => r.id === runId)
  const versions = new Set(record.slots.find((s) => s.slot === slot)?.history.map((h) => h.id) ?? [])
  return (run?.checks.filter((c) => versions.has(c.itemId)) ?? []).slice().sort((a, b) => a.sample - b.sample)
}

const FINDING_TONE: Record<string, string> = {
  NEEDS_REVIEW: "border-review/40 bg-review-soft text-review",
  OPEN: "border-wrong/50 bg-wrong-soft text-wrong",
  ACTION_RECORDED: "border-partial/40 bg-partial-soft text-partial",
  FOLLOW_UP_PENDING: "border-review/40 bg-review-soft text-review",
  AGREEMENT: "border-supported/50 bg-supported-soft text-supported",
  OBSERVED_CORRECTED: "border-supported/50 bg-supported-soft text-supported",
  NO_OBSERVED_CHANGE: "border-wrong/50 bg-wrong-soft text-wrong",
  INDETERMINATE: "border-unknown/50 bg-unknown-soft text-unknown",
  RESOLVED_EXTERNALLY: "border-unknown/50 bg-unknown-soft text-unknown",
}

function ActionForm({ record, reload }: { record: OperatorRecord; reload: () => Promise<void> }) {
  const [slot, setSlot] = useState("all")
  const [note, setNote] = useState("")
  const [link, setLink] = useState("")
  const [day, setDay] = useState(new Date().toISOString().slice(0, 10))
  const { busy, run } = useAction(reload)
  const submit = () =>
    run(
      () =>
        Records.action(record.profile.businessId, {
          slot: slot === "all" ? null : (Number(slot) as 1 | 2 | 3), note: note.trim(), links: link.trim() ? [link.trim()] : [],
          performedAt: new Date(`${day}T12:00:00Z`) > new Date() ? new Date().toISOString() : new Date(`${day}T12:00:00Z`).toISOString(),
        }),
      "Action recorded",
    ).then((saved) => { if (saved) { setNote(""); setLink("") } })
  return (
    <form className="grid gap-2.5" onSubmit={(e) => { e.preventDefault(); void submit() }}>
      <div className="grid grid-cols-[minmax(0,1fr)_8.5rem] gap-2">
        <Select value={slot} onValueChange={setSlot}>
          <SelectTrigger className="w-full text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All facts</SelectItem>
            {record.slots.map((s) => <SelectItem key={s.slot} value={String(s.slot)}>Fact {s.slot}: {s.item.fact.predicate}</SelectItem>)}
          </SelectContent>
        </Select>
        <Input type="date" aria-label="Date of the change" required value={day} max={new Date().toISOString().slice(0, 10)} onChange={(e) => setDay(e.target.value)} className="text-xs" />
      </div>
      <Textarea placeholder="Agency updated /rooms with breakfast details." aria-label="Action note" rows={2} className="text-xs" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
      <Input type="url" placeholder="Link to the changed page (optional)" aria-label="Changed page link" className="text-xs" value={link} onChange={(e) => setLink(e.target.value)} maxLength={2000} />
      <div className="flex items-center justify-between gap-2">
        <span className="text-[0.6875rem] text-muted-foreground">The note and link are shown on the client&apos;s record.</span>
        <Button type="submit" size="sm" variant="outline" disabled={busy || !note.trim() || !day}>
          {busy ? <Spinner /> : null}
          Record action
        </Button>
      </div>
    </form>
  )
}

function Share({ record, reload }: { record: OperatorRecord; reload: () => Promise<void> }) {
  const { busy, run } = useAction(reload)
  const id = record.profile.businessId
  if (!record.share)
    return (
      <div className="space-y-2">
        <p className="text-xs text-muted-foreground">{record.disclosure}</p>
        <Button size="sm" onClick={() => void run(() => Records.share(id), "Share link created")} disabled={busy}>
          {busy ? <Spinner /> : <LinkIcon />}
          Create share link
        </Button>
      </div>
    )
  const href = `${window.location.origin}${publicRecordPath(record.share.publicId)}`
  return (
    <div className="space-y-2.5">
      <div className="flex gap-1.5">
        <Input readOnly value={href} aria-label="Public record URL" className="text-xs" onFocus={(e) => e.target.select()} />
        <Button
          size="icon-sm"
          variant="outline"
          aria-label="Copy link"
          onClick={() => void navigator.clipboard.writeText(href).then(() => toast.success("Link copied"), () => toast.error("Could not copy the link. Select and copy the URL above."))}
        >
          <CopyIcon />
        </Button>
      </div>
      <div className="flex flex-wrap gap-1.5">
        <Button size="sm" variant="outline" asChild>
          <a href={href} target="_blank" rel="noreferrer">
            <ExternalLinkIcon />
            Open
          </a>
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="text-destructive hover:text-destructive"
          disabled={busy}
          onClick={() => { if (window.confirm("Revoke this link? It stops working immediately and cannot be re-enabled.")) void run(() => Records.revoke(id), "Link revoked") }}
        >
          Revoke link
        </Button>
      </div>
      <p className="text-[0.6875rem] leading-relaxed text-muted-foreground">Anyone with the link can read the reviewed record. Unreviewed answers and internal notes are never shown.</p>
    </div>
  )
}

type StepState = "done" | "current" | "todo"
type StepKey = "facts" | "check" | "review" | "action" | "recheck" | "share"
type Step = { key: StepKey; label: string; hint: string; state: StepState }

// The record's workflow. Every step is a shortcut to where that step is done;
// nothing is locked behind a step.
function Steps({ steps, onSelect }: { steps: Step[]; onSelect: (key: StepKey) => void }) {
  return (
    <nav aria-label="Record progress">
      <ol className="grid grid-cols-2 gap-1 rounded-xl bg-muted/40 p-1 sm:grid-cols-3 lg:grid-cols-6">
        {steps.map((s, i) => (
          <li key={s.key} className="min-w-0">
            <button
              type="button"
              onClick={() => onSelect(s.key)}
              aria-current={s.state === "current" ? "step" : undefined}
              className={cn(
                "flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors hover:bg-card/60",
                s.state === "current" && "bg-card shadow-(--card-shadow) hover:bg-card",
              )}
            >
              <span
                className={cn(
                  "flex size-[1.125rem] shrink-0 items-center justify-center rounded-full text-[0.625rem] font-semibold tabular-nums [&_svg]:size-2.5",
                  s.state === "done" ? "bg-supported-soft text-supported" : s.state === "current" ? "bg-review text-white" : "bg-muted text-muted-foreground",
                )}
              >
                {s.state === "done" ? <CheckIcon strokeWidth={3} /> : i + 1}
              </span>
              <span className="min-w-0">
                <span className={cn("block truncate font-medium", s.state === "todo" && "text-muted-foreground")}>{s.label}</span>
                <span className="block truncate text-[0.6875rem] text-muted-foreground">{s.hint}</span>
              </span>
            </button>
          </li>
        ))}
      </ol>
    </nav>
  )
}

function NextStep({ title, detail, done, children }: { title: string; detail?: ReactNode; done?: boolean; children?: ReactNode }) {
  return (
    <div id="record-next" className={cn("flex scroll-mt-4 flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border px-4 py-2.5", done ? "bg-muted/30" : "border-review/25 bg-review-soft/40")}>
      {done ? <CheckIcon className="size-4 shrink-0 text-supported" /> : <ArrowRightIcon className="size-4 shrink-0 text-review" />}
      <div className="min-w-0 flex-1">
        <p className="font-medium">
          {done ? null : <span className="text-review">Next · </span>}
          {title}
        </p>
        {detail ? <p className="mt-0.5 text-[0.6875rem] text-muted-foreground">{detail}</p> : null}
      </div>
      {children ? <div className="flex flex-wrap items-center gap-2">{children}</div> : null}
    </div>
  )
}

const needsReview = (c: RecordCheck) => !!c.observation && !c.judgment
const sampleDot = (c: RecordCheck) =>
  c.judgment ? decisionDot[c.judgment.decision]
  : c.observation ? "ring-1 ring-review ring-inset"
  : c.status === "QUEUED" || c.status === "RUNNING" ? "bg-muted-foreground/30"
  : c.failureClass === "CANCELLED" ? "bg-muted-foreground/20" : "bg-partial"

// One sample at a time: sample tabs (dot = your decision) with previous/next,
// then the selected answer. After a judgment the deck moves to the next sample
// that still needs review; when none is left in this fact it says so.
function ReviewDeck({ id, checks, total, kindLabel, approvedValue, reload, onAllReviewed }: {
  id: string; checks: RecordCheck[]; total: number; kindLabel: string; approvedValue: string | null; reload: () => Promise<void>; onAllReviewed?: () => void
}) {
  const firstOpen = checks.findIndex(needsReview)
  const [index, setIndex] = useState(firstOpen >= 0 ? firstOpen : 0)
  if (checks.length === 0) return null
  const at = Math.min(index, checks.length - 1)
  const current = checks[at]!
  const reviewed = checks.filter((c) => c.judgment).length
  const answered = checks.filter((c) => c.observation).length
  const advance = () => {
    const wasOpen = needsReview(checks[at]!)
    const order = [...checks.keys()].filter((i) => i !== at)
    const next = [...order.filter((i) => i > at), ...order.filter((i) => i < at)].find((i) => needsReview(checks[i]!))
    if (next !== undefined) setIndex(next)
    else if (wasOpen) onAllReviewed?.()
  }
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <p className="font-medium">
          {kindLabel}
          <span className="font-normal text-muted-foreground">
            {" · "}
            {reviewed} of {answered} reviewed{total > checks.length ? ` · ${checks.length} of ${total} samples` : ""}
          </span>
        </p>
        {checks.length > 1 ? (
          <div className="flex items-center gap-0.5">
            <Button size="icon-sm" variant="ghost" aria-label="Previous sample" disabled={at === 0} onClick={() => setIndex(at - 1)}>
              <ChevronLeftIcon />
            </Button>
            <div role="tablist" aria-label="Samples" className="flex items-center gap-0.5 rounded-lg bg-muted/60 p-0.5">
              {checks.map((c, i) => {
                const d = c.judgment?.decision
                return (
                  <button
                    key={c.id}
                    type="button"
                    role="tab"
                    aria-selected={i === at}
                    aria-label={`Sample ${c.sample}${d ? `, ${DECISION_LABELS[d]}` : c.observation ? ", needs review" : ", no answer"}`}
                    onClick={() => setIndex(i)}
                    className={cn(
                      "inline-flex h-6 min-w-8 items-center justify-center gap-1 rounded-md px-1.5 text-[0.6875rem] font-medium tabular-nums transition-colors",
                      i === at ? "bg-card text-foreground shadow-(--card-shadow)" : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {c.sample}
                    <span aria-hidden className={cn("size-1.5 rounded-full", sampleDot(c))} />
                  </button>
                )
              })}
            </div>
            <Button size="icon-sm" variant="ghost" aria-label="Next sample" disabled={at === checks.length - 1} onClick={() => setIndex(at + 1)}>
              <ChevronRightIcon />
            </Button>
          </div>
        ) : null}
      </div>

      <Review key={current.id} clientId={id} check={current} approvedValue={approvedValue} reload={reload} onJudged={advance} />
    </div>
  )
}

function EvidenceHistory({ record, slot, latest, initial }: {
  record: OperatorRecord; slot: 1 | 2 | 3; latest: OperatorRecord["runs"][number] | undefined; initial: OperatorRecord["runs"][number] | undefined
}) {
  const s = record.slots.find((x) => x.slot === slot)
  const item = s?.item
  if (!item) return null
  const baseline = checksFor(record, initial?.id, slot)
  const followUp = checksFor(record, latest?.id, slot)
  const followUpShown = latest?.kind === "FOLLOW_UP" ? followUp : []
  return (
    <details className="group rounded-lg border px-3 py-2 text-xs">
      <summary className="cursor-pointer font-medium text-muted-foreground group-open:text-foreground">
        Evidence history: record → observations → claims → judgments → actions → outcome
      </summary>
      <ol className="space-y-2.5 pt-3">
        <li>
          <p className="font-medium">Approved record</p>
          <p className="text-muted-foreground">
            “{item.fact.valueText}” · fact version {item.fact.version} · valid {formatDate(item.fact.validFrom)}
            {item.fact.validUntil ? ` – ${formatDate(item.fact.validUntil)}` : " – present"}
            {item.approval ? ` · approved ${formatDateTime(item.approval.approvedAt)}` : " · not approved"}
          </p>
        </li>
        {baseline.map((c) => (
          <li key={c.id}>
            <p className="font-medium">First check · sample {c.sample}{c.observation ? ` · observed ${formatDateTime(c.observation.collectedAt)}` : ""}</p>
            {c.observation ? (
              <p className="text-muted-foreground">
                {c.surface} · {c.observation.modelVersion ?? c.observation.observedModel ?? c.observation.requestedModel ?? "model unknown"} ·{" "}
                {c.retrievalObserved ? "live web retrieval used" : c.retrievalRequested ? "retrieval requested but not used" : "no live web retrieval"} ·{" "}
                digest {c.observation.rawDigest.slice(0, 12)}…
              </p>
            ) : <p className="text-muted-foreground">Check {c.status.toLowerCase()}.</p>}
            {c.claims.map((claim) => (
              <p key={claim.id} className="text-muted-foreground">
                Claim: “{claim.supportingSpan ?? claim.claimText}” ({claim.extractionMethod === "MANUAL_EXACT_SPAN" ? "exact span" : "transcription"}, reviewer {formatDateTime(claim.createdAt)})
              </p>
            ))}
            {c.judgments.map((j) => (
              <p key={j.id} className="text-muted-foreground">
                Judgment {DECISION_LABELS[j.decision]} against fact version {j.factVersion} · {formatDateTime(j.reviewedAt)}
                {j.supersedesId ? " · correction, history kept" : ""}
              </p>
            ))}
          </li>
        ))}
        {s.actions.length ? (
          <li>
            <p className="font-medium">Recorded actions</p>
            {s.actions.map((a) => (
              <p key={a.id} className="text-muted-foreground">{formatDate(a.performedAt)} · {a.note}</p>
            ))}
          </li>
        ) : null}
        {followUpShown.map((c) => (
          <li key={c.id}>
            <p className="font-medium">Re-check · sample {c.sample}{c.observation ? ` · observed ${formatDateTime(c.observation.collectedAt)}` : ""}</p>
            {c.judgment ? (
              <p className="text-muted-foreground">
                Judgment {DECISION_LABELS[c.judgment.decision]} against fact version {c.judgment.factVersion} · {formatDateTime(c.judgment.reviewedAt)}
              </p>
            ) : <p className="text-muted-foreground">Awaiting review.</p>}
          </li>
        ))}
        {s.comparison?.state === "DERIVED" ? (
          <li>
            <p className="font-medium">{OUTCOME_LABELS[s.comparison.outcome]}</p>
            <p className="text-muted-foreground">{s.comparison.text}</p>
            <p className="text-muted-foreground">{record.disclosure}</p>
          </li>
        ) : null}
      </ol>
    </details>
  )
}

// One fact as a row you can scan: what it is, the approved value, a dot per
// sample (your decisions) and its state. Opening it shows the question, the
// answers to review, the comparison and the evidence history.
function FactCard({ id, record, slot, latest, initial, reload, open, onToggle, onAllReviewed }: {
  id: string; record: OperatorRecord; slot: 1 | 2 | 3; latest: OperatorRecord["runs"][number] | undefined; initial: OperatorRecord["runs"][number] | undefined
  reload: () => Promise<void>; open: boolean; onToggle: () => void; onAllReviewed: () => void
}) {
  const s = record.slots.find((x) => x.slot === slot)
  const [editing, setEditing] = useState(!s)
  const { busy, run } = useAction(reload)
  const latestChecks = checksFor(record, latest?.id, slot)
  const baseline = checksFor(record, initial?.id, slot)
  const item = s?.item
  const finding = s?.finding
  const reviewed = latestChecks.filter((c) => c.judgment).length
  const answered = latestChecks.filter((c) => c.observation).length
  const waiting = latestChecks.filter(needsReview).length

  return (
    <Panel id={`fact-${slot}`} className="scroll-mt-4">
      <button type="button" aria-expanded={open} onClick={onToggle} className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/30">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-muted text-[0.6875rem] font-semibold text-muted-foreground tabular-nums">{slot}</span>
        <span className="min-w-0 flex-1">
          <span className={cn("block truncate font-medium", !item && "text-muted-foreground")}>{item ? item.fact.predicate : "Add a fact"}</span>
          <span className="block truncate text-muted-foreground">{item ? item.fact.valueText : "A fact the client stands behind, and the question a buyer would ask."}</span>
        </span>
        {latestChecks.length ? (
          <span className="hidden shrink-0 items-center gap-2 sm:flex">
            <span className="flex items-center gap-1" aria-hidden>
              {latestChecks.map((c) => <span key={c.id} className={cn("size-2 rounded-full", sampleDot(c))} />)}
            </span>
            <span className={cn("w-16 text-right text-[0.6875rem] tabular-nums", waiting ? "font-medium text-review" : "text-muted-foreground")}>
              {waiting ? `${waiting} to review` : `${reviewed}/${answered} done`}
            </span>
          </span>
        ) : null}
        {item && !item.approval ? (
          <span className={cn("shrink-0 rounded-md border px-1.5 py-0.5 text-[0.6875rem] font-medium", FINDING_TONE["ACTION_RECORDED"])}>Not approved</span>
        ) : finding ? (
          <span className={cn("shrink-0 rounded-md border px-1.5 py-0.5 text-[0.6875rem] font-medium", FINDING_TONE[finding.state])}>{FINDING_STATE_LABELS[finding.state]}</span>
        ) : null}
        <ChevronDownIcon className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} />
      </button>

      {open ? (
        <div className="space-y-4 border-t px-4 py-4">
          {editing ? (
            <SlotEditor key={item?.id ?? "new"} clientId={id} clientName={record.profile.name} slot={slot} current={s} reload={reload} {...(item ? { onDone: () => setEditing(false) } : {})} />
          ) : item ? (
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 space-y-1">
                <p>
                  <span className="text-muted-foreground">Question </span>“{item.question.prompt}”
                </p>
                <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[0.6875rem] text-muted-foreground">
                  <ShieldCheckIcon className={cn("size-3 shrink-0", item.approval ? "text-supported" : "text-partial")} />
                  <span title={item.fact.sourceKind === "PUBLIC_SOURCE_UNAPPROVED" ? "Derived from public pages only; not business truth" : undefined}>
                    {SOURCE_KIND_LABELS[item.fact.sourceKind] ?? item.fact.sourceKind}
                  </span>
                  <span aria-hidden>·</span>
                  <span>{item.approval ? `approved ${formatDate(item.approval.approvedAt)}` : "not approved"}</span>
                  <span aria-hidden>·</span>
                  <span>v{item.fact.version}</span>
                  <span aria-hidden>·</span>
                  <a href={item.sourceUrl} target="_blank" rel="noreferrer" title={item.sourceUrl} className="inline-flex min-w-0 items-center gap-1 hover:text-foreground hover:underline">
                    <GlobeIcon className="size-3 shrink-0" />
                    <span className="truncate">{domainOf(item.sourceUrl)}</span>
                  </a>
                </p>
                {finding && finding.samples.reviewed > 0 ? <p className="text-[0.6875rem] text-muted-foreground">{finding.samples.statement}</p> : null}
              </div>
              <Button size="icon-sm" variant="ghost" aria-label="Edit fact" title="Edit fact" onClick={() => setEditing(true)}>
                <PenLineIcon />
              </Button>
            </div>
          ) : null}

          {item && !item.approval && !editing ? (
            <div className="flex flex-wrap items-center gap-3 rounded-lg border border-partial/25 bg-partial-soft/60 px-3 py-2">
              <span className="min-w-0 flex-1">Not approved: it will not be checked or shown to the client.</span>
              <Button size="sm" className="h-7 text-xs" disabled={busy} onClick={() => void run(() => Records.approve(id, item.id), "Fact approved")}>
                {busy ? <Spinner /> : <ShieldCheckIcon />}
                Approve fact
              </Button>
            </div>
          ) : null}

          {latestChecks.length ? (
            <ReviewDeck id={id} checks={latestChecks} total={latest?.sampleCount ?? latestChecks.length} kindLabel={latest?.kind === "FOLLOW_UP" ? "Weekly re-check answers" : "First check answers"} approvedValue={item?.fact.valueText ?? null} reload={reload} onAllReviewed={onAllReviewed} />
          ) : null}

          {latest?.kind === "FOLLOW_UP" && baseline.length && (latest.id !== initial?.id) ? (
            <details className="group rounded-lg border px-3 py-2">
              <summary className="cursor-pointer font-medium text-muted-foreground group-open:text-foreground">
                First check answers (before){baseline.length > 1 ? ` · ${baseline.length} samples` : ""}
              </summary>
              <div className="pt-3">
                <ReviewDeck id={id} checks={baseline} total={baseline.length} kindLabel="First check answers" approvedValue={item?.fact.valueText ?? null} reload={reload} />
              </div>
            </details>
          ) : null}

          {s?.comparison ? (
            <div
              className={cn(
                "rounded-lg px-4 py-3",
                s.comparison.state === "DERIVED" && (s.comparison.outcome === "OBSERVED_CORRECTED" || s.comparison.outcome === "RESOLVED_EXTERNALLY") ? "bg-supported-soft" : "bg-muted/50",
              )}
            >
              {s.comparison.state === "DERIVED" ? (
                <>
                  <p className="font-semibold">{OUTCOME_LABELS[s.comparison.outcome]}</p>
                  <p className="mt-0.5 text-muted-foreground">{s.comparison.text}</p>
                </>
              ) : s.comparison.state === "AWAITING_REVIEW" ? (
                <p>Review the first check and the re-check samples to derive the outcome.</p>
              ) : (
                <p>Re-check in progress.</p>
              )}
            </div>
          ) : null}

          {s?.actions.length ? (
            <ul className="space-y-1">
              {s.actions.map((a) => (
                <li key={a.id} className="flex gap-2">
                  <span className="w-20 shrink-0 text-muted-foreground tabular-nums">{formatDate(a.performedAt)}</span>
                  <span>
                    {a.note}
                    {a.slot === null ? <span className="text-muted-foreground"> (all facts)</span> : null}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}

          <EvidenceHistory record={record} slot={slot} latest={latest} initial={initial} />
        </div>
      ) : null}
    </Panel>
  )
}

type RunView = OperatorRecord["runs"][number]

// Stops the questions of a run that have not been sent yet. Questions already
// in flight finish and their answers are kept, like any other evidence.
function StopRunButton({ clientId, run, reload, className }: { clientId: string; run: RunView; reload: () => Promise<void>; className?: string }) {
  const { busy, run: act } = useAction(reload)
  const label = run.kind === "INITIAL" ? "first check" : "weekly re-check"
  const stop = () => {
    if (!window.confirm(`Stop this ${label}?\n\nQuestions that have not been sent are cancelled. Any question already in progress finishes and is kept.`)) return
    void act(async () => {
      const r = await Records.cancelRun(clientId, run.id)
      toast.success(r.cancelled ? `Stopped ${r.cancelled} question${r.cancelled === 1 ? "" : "s"}${r.stillRunning ? `; ${r.stillRunning} in progress will finish` : ""}` : `${r.stillRunning} in progress will finish`)
    })
  }
  return (
    <Button size="sm" variant="outline" className={cn("border-wrong/40 text-wrong hover:bg-wrong-soft hover:text-wrong", className)} disabled={busy} onClick={stop}>
      {busy ? <Spinner /> : <CircleStopIcon />}
      Stop {label}
    </Button>
  )
}

function RunBar({ clientId, run, reload }: { clientId: string; run: RunView; reload: () => Promise<void> }) {
  const total = run.checks.length
  const finished = run.checks.filter((c) => c.status !== "QUEUED" && c.status !== "RUNNING").length
  const started = run.checks.some((c) => c.status !== "QUEUED")
  const waitingMs = Date.now() - Date.parse(run.createdAt)
  const stalled = !started && waitingMs > 2 * 60_000
  return (
    <div className={cn("flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl px-4 py-2.5 text-xs shadow-(--card-shadow)", stalled ? "bg-partial-soft/70 text-partial" : "bg-review-soft/60 text-review")}>
      {stalled ? <TriangleAlertIcon className="size-4 shrink-0" /> : <LoaderCircleIcon className="size-4 shrink-0 animate-spin" />}
      <span className="min-w-0 flex-1">
        <span className="font-medium">{run.kind === "INITIAL" ? "First check" : "Weekly re-check"}</span>
        {" · "}
        {finished} of {total} done
        {stalled
          ? ` · Waiting since ${formatDateTime(run.createdAt)} and no question has started. The check worker may not be running. Stop it if you started it by mistake.`
          : " · This page updates on its own."}
      </span>
      <div className="h-1.5 w-28 overflow-hidden rounded-full bg-current/15" aria-hidden>
        <div className="h-full rounded-full bg-current transition-[width]" style={{ width: `${total ? (finished / total) * 100 : 0}%` }} />
      </div>
      <StopRunButton clientId={clientId} run={run} reload={reload} className="h-7 bg-card text-xs" />
    </div>
  )
}

const reveal = (elementId: string, then?: () => void) =>
  window.setTimeout(() => {
    document.getElementById(elementId)?.scrollIntoView({ behavior: "smooth", block: "start" })
    then?.()
  }, 60)

export function ClientRecordPage() {
  const { id = "" } = useParams()
  const [poll, setPoll] = useState(false)
  const [editOpen, setEditOpen] = useState(false)
  const [chatting, setChatting] = useState(false)
  // undefined: follow the record (open the fact that needs you); null: all closed.
  const [openSlot, setOpenSlot] = useState<number | null | undefined>(undefined)
  const [actionOpen, setActionOpen] = useState(false)
  const res = useApi<RecordResponse>(`record:${id}`, async () => {
    const r = await Records.get(id)
    setPoll(r.record.activeRun)
    return r
  }, { pollMs: poll ? 3000 : null })
  const reload = async () => { await res.reload() }
  const { busy, run } = useAction(reload)
  if (res.loading && !res.data) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-14 w-72" />
        <Skeleton className="h-12 rounded-xl" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    )
  }
  if (!res.data) {
    return (
      <EmptyState
        icon={<TriangleAlertIcon />}
        title="Client record could not load"
        description={failure(res.error)}
        action={<Button asChild variant="outline" size="sm"><Link to="/clients">All clients</Link></Button>}
      />
    )
  }
  const { record, surface } = res.data
  // A run stopped before anything ran produced no answers: it stays in the
  // history but never counts as the first check or the latest answers.
  const executed = record.runs.filter((r) => r.status !== "CANCELLED")
  const initial = [...executed].reverse().find((r) => r.kind === "INITIAL")
  const latest = executed.at(-1)
  const hasFollowUp = executed.some((r) => r.kind === "FOLLOW_UP")
  const active = [...record.runs].reverse().find((r) => r.status === "QUEUED" || r.status === "RUNNING")
  const approved = record.slots.filter((s) => s.item.approval).length
  const facts = ([1, 2, 3] as const).map((slot) => ({
    slot,
    item: record.slots.find((s) => s.slot === slot)?.item,
    waiting: checksFor(record, latest?.id, slot).filter(needsReview).length,
  }))
  const unreviewed = facts.reduce((n, f) => n + f.waiting, 0)
  const waitingFacts = facts.filter((f) => f.waiting > 0)
  const initialWaiting = initial ? initial.checks.filter(needsReview).length : 0
  const reviewingFollowUp = latest?.kind === "FOLLOW_UP" && unreviewed > 0
  const shareActive = record.share?.status === "ACTIVE"
  const unapprovedSlot = facts.find((f) => !f.item?.approval)?.slot
  const shownSlot = openSlot === undefined ? (waitingFacts[0]?.slot ?? (approved === 0 ? 1 : null)) : openSlot

  const openFact = (slot: number) => {
    setOpenSlot(slot)
    reveal(`fact-${slot}`)
  }
  const openAction = () => {
    setActionOpen(true)
    reveal("record-action", () => document.querySelector<HTMLTextAreaElement>("#record-action textarea")?.focus({ preventScroll: true }))
  }
  // After the last open sample of a fact: go to the next fact that still has
  // answers to review, or back to the next step when everything is reviewed.
  const factReviewed = (slot: number) => {
    const next = [...facts.filter((f) => f.slot > slot), ...facts.filter((f) => f.slot < slot)].find((f) => f.waiting > 0)
    if (next) openFact(next.slot)
    else {
      setOpenSlot(null)
      reveal("record-next")
    }
  }
  const start = (kind: "INITIAL" | "FOLLOW_UP", label: string) => {
    const samples = initial?.sampleCount ?? 1
    const questions = approved * (kind === "FOLLOW_UP" ? samples : 1)
    const what = kind === "FOLLOW_UP" ? "Run the weekly re-check now?" : initial ? "Redo the first check?" : "Run the first check now?"
    if (!window.confirm(`${what}\n\nThis asks ${surface.model} ${questions} new question${questions === 1 ? "" : "s"}. You can stop it from this page while questions are still waiting.`)) return
    void run(() => Records.run(id, kind), label)
  }

  const next: StepKey | null =
    approved === 0 ? "facts"
    : !initial ? "check"
    : initialWaiting > 0 ? "review"
    : !hasFollowUp && record.actions.length === 0 ? "action"
    : !hasFollowUp || reviewingFollowUp ? "recheck"
    : !shareActive ? "share"
    : null
  const current: StepKey | null = active ? (active.kind === "INITIAL" ? "check" : "recheck") : next
  const done: Record<StepKey, boolean> = {
    facts: approved >= 1,
    check: !!initial,
    review: !!initial && initialWaiting === 0,
    action: record.actions.length > 0,
    recheck: hasFollowUp && !reviewingFollowUp,
    share: shareActive,
  }
  const steps: Step[] = ([
    { key: "facts", label: "Approve facts", hint: `${approved} of 3 approved` },
    { key: "check", label: "First check", hint: initial ? relativeTime(initial.createdAt) : "Not run yet" },
    { key: "review", label: "Review answers", hint: !initial ? "After the first check" : initialWaiting ? `${initialWaiting} left to review` : "All reviewed" },
    { key: "action", label: "Agency action", hint: record.actions.length ? `${record.actions.length} recorded` : "Log what you changed" },
    { key: "recheck", label: "Weekly re-check", hint: !hasFollowUp ? "Same questions again" : reviewingFollowUp ? `${unreviewed} left to review` : "Compared with first" },
    { key: "share", label: "Share", hint: shareActive ? "Link active" : "Send the record" },
  ] as const).map((s) => ({ ...s, state: s.key === current ? "current" : done[s.key] ? "done" : "todo" }))
  const selectStep = (key: StepKey) => {
    if (key === "facts") openFact(unapprovedSlot ?? 1)
    else if (key === "review" || (key === "recheck" && reviewingFollowUp)) openFact(waitingFacts[0]?.slot ?? 1)
    else if (key === "action") openAction()
    else if (key === "share") reveal("record-share")
    else reveal("record-checks")
  }
  const reviewFirst = waitingFacts[0]
  const waitingDetail = waitingFacts.map((f) => `Fact ${f.slot} · ${f.item?.fact.predicate ?? ""} (${f.waiting})`).join("  ·  ")

  return (
    <div className="space-y-4 pb-4">
      <PageHeader
        back={{ to: "/clients", label: "Clients" }}
        title={record.profile.name}
        meta={
          <>
            <a className="inline-flex items-center gap-1 hover:text-foreground hover:underline" href={record.profile.websiteUrl} target="_blank" rel="noreferrer">
              <GlobeIcon className="size-3.5" />
              {domainOf(record.profile.websiteUrl)}
            </a>
            {record.profile.engagement !== "CLIENT" ? <Badge variant="outline">{record.profile.engagement === "DOGFOOD" ? "Dogfood" : "Fixture"}</Badge> : null}
            <button className="font-medium text-foreground hover:underline" onClick={() => setEditOpen(true)}>
              Edit client
            </button>
            <Link className="font-medium text-foreground hover:underline" to={`/clients/${encodeURIComponent(id)}/discovery`}>
              AI Discovery
            </Link>
          </>
        }
        actions={
          active ? (
            <StopRunButton clientId={id} run={active} reload={reload} />
          ) : !initial ? (
            <Button size="sm" disabled={busy || approved === 0} onClick={() => start("INITIAL", "First check started")}>
              <PlayIcon />
              Run first check
            </Button>
          ) : (
            <>
              {!hasFollowUp ? (
                <Button size="sm" variant="outline" disabled={busy} onClick={() => start("INITIAL", "First check started again")}>
                  Redo first check
                </Button>
              ) : null}
              <Button size="sm" variant={next === "recheck" && !reviewingFollowUp ? "default" : "outline"} disabled={busy} onClick={() => start("FOLLOW_UP", "Weekly re-check started")}>
                <RefreshCwIcon />
                Run weekly re-check
              </Button>
            </>
          )
        }
      />

      <details className="rounded-xl border p-4" open={chatting || undefined}>
        <summary className="cursor-pointer text-xs font-medium">Investigate with the agent</summary>
        <div className="pt-4"><AgentChat businessId={id} businessName={record.profile.name} onConversationChange={setChatting} /></div>
      </details>
      <Steps steps={steps} onSelect={selectStep} />

      {active ? (
        <RunBar clientId={id} run={active} reload={reload} />
      ) : next === "facts" ? (
        <NextStep title="Approve a fact" detail="Each approved fact gets one question a buyer would ask, sent to the live AI surface.">
          <Button size="sm" onClick={() => openFact(unapprovedSlot ?? 1)}>Open fact {unapprovedSlot ?? 1}</Button>
        </NextStep>
      ) : next === "check" ? (
        <NextStep title="Run the first check" detail={`Asks ${surface.model} one question for each of the ${approved} approved fact${approved === 1 ? "" : "s"}.`}>
          <Button size="sm" disabled={busy} onClick={() => start("INITIAL", "First check started")}><PlayIcon />Run first check</Button>
        </NextStep>
      ) : (next === "review" || reviewingFollowUp) && reviewFirst ? (
        <NextStep title={`Review ${unreviewed} more answer${unreviewed === 1 ? "" : "s"}`} detail={waitingDetail}>
          <Button size="sm" onClick={() => openFact(reviewFirst.slot)}>Review fact {reviewFirst.slot}<ArrowRightIcon /></Button>
        </NextStep>
      ) : next === "action" ? (
        <NextStep title="Log what the agency changed" detail="Every answer is reviewed. Record the change made on the client's pages, then run the weekly re-check to see if the answers moved.">
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => start("FOLLOW_UP", "Weekly re-check started")}>Skip to re-check</Button>
          <Button size="sm" onClick={openAction}><PenLineIcon />Log agency action</Button>
        </NextStep>
      ) : next === "recheck" ? (
        <NextStep title="Run the weekly re-check" detail="Asks the same questions again and compares the answers with the first check.">
          <Button size="sm" disabled={busy} onClick={() => start("FOLLOW_UP", "Weekly re-check started")}><RefreshCwIcon />Run weekly re-check</Button>
        </NextStep>
      ) : next === "share" ? (
        <NextStep title="Share the record with the client" detail="The link shows reviewed answers only. Unreviewed answers and internal notes stay private.">
          <Button size="sm" disabled={busy} onClick={() => void run(() => Records.share(id), "Share link created").then(() => reveal("record-share"))}><LinkIcon />Create share link</Button>
        </NextStep>
      ) : (
        <NextStep done title="The record is up to date" detail="Run another weekly re-check after the agency's next change." />
      )}

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="min-w-0 space-y-2">
          {facts.map(({ slot }) => (
            <FactCard
              key={slot}
              id={id}
              record={record}
              slot={slot}
              latest={latest}
              initial={initial}
              reload={reload}
              open={shownSlot === slot}
              onToggle={() => setOpenSlot(shownSlot === slot ? null : slot)}
              onAllReviewed={() => factReviewed(slot)}
            />
          ))}
        </div>

        <div className="space-y-3 lg:sticky lg:top-0">
          <Panel id="record-checks" className="scroll-mt-4">
            <PanelHeader title="Checks" description={`${surface.provider === "gemini" ? "Gemini with Google Search" : surface.provider} · ${surface.model}`} />
            <div className="p-2 pt-1">
              {record.runs.length ? (
                <ul>
                  {[...record.runs].reverse().map((r) => {
                    const stopped = r.checks.filter((c) => c.status === "FAILED" && c.failureClass === "CANCELLED").length
                    const failed = r.checks.filter((c) => c.status === "FAILED").length - stopped
                    const finished = r.checks.filter((c) => c.status !== "QUEUED" && c.status !== "RUNNING").length
                    const running = r.status === "RUNNING" || r.status === "QUEUED"
                    return (
                      <li key={r.id} className="flex items-center gap-2 rounded-md px-2 py-1.5">
                        {running ? (
                          <LoaderCircleIcon className="size-3.5 animate-spin text-review" />
                        ) : r.status === "SUCCEEDED" ? (
                          <CheckIcon className="size-3.5 text-supported" />
                        ) : r.status === "CANCELLED" ? (
                          <CircleStopIcon className="size-3.5 text-muted-foreground" />
                        ) : r.status === "FAILED" ? (
                          <TriangleAlertIcon className="size-3.5 text-wrong" />
                        ) : (
                          <CircleDashedIcon className="size-3.5 text-partial" />
                        )}
                        <span className="min-w-0 flex-1">
                          <span className="block font-medium">{r.kind === "INITIAL" ? "First check" : "Weekly re-check"}</span>
                          <span className="block text-[0.6875rem] text-muted-foreground">
                            {running ? `${finished} of ${r.checks.length} done` : RUN_STATUS_LABELS[r.status]}
                            {failed > 0 && !running ? ` · ${failed} failed` : ""}
                            {stopped > 0 && r.status !== "CANCELLED" ? ` · ${stopped} stopped` : ""}
                          </span>
                        </span>
                        <span className="text-[0.6875rem] text-muted-foreground tabular-nums" title={formatDateTime(r.createdAt)}>
                          {relativeTime(r.createdAt)}
                        </span>
                      </li>
                    )
                  })}
                </ul>
              ) : (
                <p className="px-2 py-3 text-muted-foreground">No checks yet. One question per approved fact; re-checks are started by you, nothing runs on a schedule.</p>
              )}
            </div>
          </Panel>
          <Panel id="record-action" className="scroll-mt-4">
            <details className="group" open={actionOpen} onToggle={(e) => setActionOpen(e.currentTarget.open)}>
              <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-4 py-3">
                <span>
                  <span className="block font-medium">Agency action</span>
                  <span className="block text-muted-foreground">{record.actions.length ? `${record.actions.length} recorded · log another` : "Log what the agency changed"}</span>
                </span>
                <ChevronRightIcon className="size-4 text-muted-foreground transition-transform group-open:rotate-90" />
              </summary>
              <div className="px-4 pb-4">
                <ActionForm record={record} reload={reload} />
              </div>
            </details>
          </Panel>
          <Panel id="record-share" className="scroll-mt-4">
            <PanelHeader title="Share with the client" />
            <div className="p-4 pt-3">
              <Share record={record} reload={reload} />
            </div>
          </Panel>
        </div>
      </div>

      <EditClientDialog key={`${record.profile.name}-${record.profile.websiteUrl}`} record={record} reload={reload} open={editOpen} onOpenChange={setEditOpen} />
    </div>
  )
}
