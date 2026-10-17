// AI Discovery for one client: does the measured AI surface recommend this
// business when a buyer asks for a product or service? The operator freezes a
// buyer-question set, starts an acknowledged measurement batch on the existing
// worker, reads exact answers and citations, reviews each candidate mention,
// imports an optional GA4 export, and opens the agency report.
// Detection only highlights candidates; every confirmed count is a human review.
import { useState, type ReactNode } from "react"
import { Link, useParams, useSearchParams } from "react-router"
import { toast } from "sonner"
import { ChevronDownIcon, FileTextIcon, LoaderCircleIcon, PlayIcon, TriangleAlertIcon, UploadIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Skeleton } from "@/components/ui/skeleton"
import { EmptyState, PageHeader, Panel, PanelHeader, StatStrip } from "@/components/page"
import { Spinner } from "@/components/spinner"
import { SearchSuggestions } from "@/components/search-suggestions"
import { useApi } from "@/lib/use-api"
import { ApiError } from "@/lib/api"
import { errorMessage, formatDateTime, relativeTime } from "@/lib/format"
import { cn } from "@/lib/utils"
import {
  BASIS_LABELS, BATCH_STATUS_LABELS, Discovery, GROUP_LABELS, HINT_LABELS, INTENT_GROUPS, MENTION_LABELS, RECOMMENDATION_LABELS,
  discoveryReportPath, formatCompetitors, fraction, parseCompetitors,
  type Basis, type Batch, type Candidate, type Check, type DiscoveryResponse, type IntentGroup, type Mention, type QuestionSet, type Recommendation,
} from "@/lib/acquisition"

const REFUSALS: Record<string, string> = {
  SpendPlanNotAcknowledged: "Confirm the provider-call ceiling before starting.",
  BatchInProgress: "A batch is still running for this client.",
  AliasCollision: "Two brands share a name or alias. Each term must belong to one brand.",
  DomainCollision: "Two brands share a domain.",
  DuplicateQuestion: "Two questions are identical.",
  InvalidBrand: "Check the brand name and owned domains (plain domains like example.com).",
  InvalidCompetitor: "Check the competitor lines: Name | aliases | domains.",
  FixtureProviderDisabled: "The fixture provider is disabled outside tests and demos.",
  FixtureDisabled: "Fixture data is disabled outside tests and demos.",
  DuplicateExportDifferentMetadata: "This exact export was already imported with different details.",
  UnexpectedColumn: "The export has a column OpenRecord does not accept. Export only date, session source, session medium, sessions and (optionally) key events.",
  ConversionEventNotStated: "The export has key events. Name the conversion event they count.",
  ConversionColumnMissing: "A conversion event is named but the export has no key events column.",
  DateOutsideRange: "A row falls outside the stated date range.",
  UnsafeSourceValue: "A source value looks like personal data or a URL with parameters.",
}
const failure = (e: unknown) => {
  if (e instanceof ApiError) {
    const reason = typeof e.body["reason"] === "string" ? e.body["reason"] : e.tag
    const line = typeof e.body["line"] === "number" ? ` (line ${e.body["line"]})` : ""
    return `${REFUSALS[reason] ?? reason}${line}`
  }
  return errorMessage(e)
}

function useBusy(reload: () => Promise<void>) {
  const [busy, setBusy] = useState(false)
  const run = async (fn: () => Promise<unknown>, success: string) => {
    setBusy(true)
    try { await fn(); toast.success(success); await reload(); return true } catch (e) { toast.error(failure(e)); return false } finally { setBusy(false) }
  }
  return { busy, run }
}

// ---------------------------------------------------------------------------
// Question set
// ---------------------------------------------------------------------------

function SetForm({ clientId, previous, websiteUrl, reload, onDone }: { clientId: string; previous: QuestionSet | null; websiteUrl: string; reload: () => Promise<void>; onDone: () => void }) {
  const host = (() => { try { return new URL(websiteUrl).hostname.replace(/^www\./, "") } catch { return "" } })()
  const [basis, setBasis] = useState<Basis>(previous?.basis ?? "AUTHORIZED_CLIENT")
  const [category, setCategory] = useState(previous?.category ?? "")
  const [name, setName] = useState(previous?.target.name ?? "")
  const [aliases, setAliases] = useState(previous?.target.aliases.join(", ") ?? "")
  const [domains, setDomains] = useState(previous?.target.domains.join(", ") ?? host)
  const [ambiguity, setAmbiguity] = useState(previous?.target.ambiguity ?? "")
  const [matchCase, setMatchCase] = useState(previous?.target.matchCase ?? false)
  const [competitors, setCompetitors] = useState(previous ? formatCompetitors(previous.competitors) : "")
  const [questions, setQuestions] = useState<Record<IntentGroup, string>>(() => Object.fromEntries(INTENT_GROUPS.map(g =>
    [g, previous?.questions.filter(q => q.group === g).map(q => q.prompt).join("\n") ?? ""])) as Record<IntentGroup, string>)
  const { busy, run } = useBusy(reload)
  const list = (s: string) => s.split(",").map(x => x.trim()).filter(Boolean)
  const parsed = INTENT_GROUPS.flatMap(g => questions[g].split("\n").map(p => p.trim()).filter(Boolean).map(prompt => ({ group: g, prompt })))
  const submit = () => run(() => Discovery.createSet(clientId, {
    basis, category, target: { name, aliases: list(aliases), domains: list(domains), matchCase, ambiguity: ambiguity.trim() || null },
    competitors: parseCompetitors(competitors), questions: parsed,
  }), previous ? `Question set v${previous.version + 1} frozen` : "Question set frozen").then(ok => { if (ok) onDone() })
  return (
    <div className="space-y-4 p-4 pt-2">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label>Measurement basis</Label>
          <div className="flex flex-wrap gap-1">
            {(["AUTHORIZED_CLIENT", "PUBLIC_RESEARCH", "FIXTURE"] as const).map(b => (
              <Button key={b} type="button" size="sm" variant={basis === b ? "default" : "outline"} className="h-7" onClick={() => setBasis(b)}>{BASIS_LABELS[b]}</Button>
            ))}
          </div>
          <p className="text-[0.6875rem] text-muted-foreground">Public research: the business has not authorized this and is not a customer. It is shown on every report.</p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="acq-category">Product category</Label>
          <Input id="acq-category" value={category} onChange={e => setCategory(e.target.value)} placeholder="AI customer support agents" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="acq-brand">Brand name</Label>
          <Input id="acq-brand" value={name} onChange={e => setName(e.target.value)} />
          <label className="flex items-center gap-1.5 text-[0.6875rem] text-muted-foreground">
            <input type="checkbox" checked={matchCase} onChange={e => setMatchCase(e.target.checked)} />Match case (for names that are also common words or acronyms)
          </label>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="acq-aliases">Known aliases <span className="text-muted-foreground">(comma separated)</span></Label>
          <Input id="acq-aliases" value={aliases} onChange={e => setAliases(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="acq-domains">Owned domains <span className="text-muted-foreground">(verified, comma separated)</span></Label>
          <Input id="acq-domains" value={domains} onChange={e => setDomains(e.target.value)} placeholder="example.com" />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="acq-ambiguity">Name ambiguity <span className="text-muted-foreground">(optional)</span></Label>
          <Input id="acq-ambiguity" value={ambiguity} onChange={e => setAmbiguity(e.target.value)} placeholder="Also the name of an unrelated product" />
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="acq-competitors">Named competitors <span className="text-muted-foreground">(one per line: Name | aliases | domains, add “| case” to match case)</span></Label>
        <Textarea id="acq-competitors" rows={3} value={competitors} onChange={e => setCompetitors(e.target.value)} className="font-mono text-xs" placeholder="Rival | Rival AI | rival.com" />
      </div>
      <div className="space-y-2">
        <div className="flex items-baseline justify-between">
          <Label>Buyer questions <span className="text-muted-foreground">(one per line; ask like a buyer, never “why is this brand the best?”)</span></Label>
          <span className="text-xs text-muted-foreground tabular-nums">{parsed.length} questions</span>
        </div>
        <div className="grid gap-3 lg:grid-cols-2">
          {INTENT_GROUPS.map(g => (
            <div key={g} className="space-y-1">
              <p className="text-xs font-medium">{GROUP_LABELS[g]} <span className="font-normal text-muted-foreground tabular-nums">· {questions[g].split("\n").filter(l => l.trim()).length}</span></p>
              <Textarea rows={4} value={questions[g]} onChange={e => setQuestions({ ...questions, [g]: e.target.value })} className="text-xs" />
            </div>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
        <p className="text-xs text-muted-foreground">Freezing stores the exact text. Nothing can be edited afterwards; a change creates a new version.</p>
        <div className="flex gap-2">
          {previous ? <Button size="sm" variant="ghost" onClick={onDone}>Cancel</Button> : null}
          <Button size="sm" disabled={busy || parsed.length === 0} onClick={() => void submit()}>{busy ? <Spinner /> : null}Freeze {previous ? `version ${previous.version + 1}` : "question set"}</Button>
        </div>
      </div>
    </div>
  )
}

function StartBatchDialog({ clientId, set, maxAttempts, surface, open, onOpenChange, reload }: {
  clientId: string; set: QuestionSet; maxAttempts: number; surface: string; open: boolean; onOpenChange: (v: boolean) => void; reload: () => Promise<void>
}) {
  const firstPerGroup = INTENT_GROUPS.flatMap(g => set.questions.filter(q => q.group === g).slice(0, 1).map(q => q.key))
  const [scope, setScope] = useState<"SMOKE" | "FULL">("SMOKE")
  const [keys, setKeys] = useState<string[]>(firstPerGroup)
  const [samples, setSamples] = useState(1)
  const [approved, setApproved] = useState(false)
  const { busy, run } = useBusy(reload)
  const questionCount = scope === "FULL" ? set.questions.length : keys.length
  const planned = questionCount * samples
  const maxCalls = planned * maxAttempts
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Start a measurement batch</DialogTitle>
          <DialogDescription>{surface}. Each sample is one provider call; failed calls retry at most {maxAttempts - 1} times and are never re-run selectively.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 text-xs">
          <div className="flex gap-1">
            <Button size="sm" className="h-7" variant={scope === "SMOKE" ? "default" : "outline"} onClick={() => { setScope("SMOKE"); setApproved(false) }}>Smoke batch</Button>
            <Button size="sm" className="h-7" variant={scope === "FULL" ? "default" : "outline"} onClick={() => { setScope("FULL"); setApproved(false) }}>All {set.questions.length} questions</Button>
          </div>
          {scope === "SMOKE" ? (
            <div className="max-h-48 space-y-1 overflow-auto rounded-md border p-2">
              {set.questions.map(q => (
                <label key={q.key} className="flex items-start gap-2">
                  <input type="checkbox" className="mt-0.5" checked={keys.includes(q.key)} disabled={!keys.includes(q.key) && keys.length >= 10}
                    onChange={e => { setApproved(false); setKeys(e.target.checked ? [...keys, q.key] : keys.filter(k => k !== q.key)) }} />
                  <span><span className="font-mono text-muted-foreground">{q.key}</span> {q.prompt}</span>
                </label>
              ))}
            </div>
          ) : null}
          <div className="flex items-center gap-2">
            <span>Samples per question</span>
            {[1, 2, 3, 4, 5].map(n => <Button key={n} size="sm" className="h-7 w-7 px-0" variant={samples === n ? "default" : "outline"} onClick={() => { setSamples(n); setApproved(false) }}>{n}</Button>)}
          </div>
          <div className="rounded-md bg-muted/50 p-3 tabular-nums">
            <p>{questionCount} question{questionCount === 1 ? "" : "s"} × {samples} sample{samples === 1 ? "" : "s"} = <span className="font-medium">{planned} planned provider calls</span></p>
            <p className="text-muted-foreground">Ceiling with retries: {maxCalls} calls. Grounded search queries are billed separately by the provider.</p>
          </div>
          <label className="flex items-start gap-2">
            <input type="checkbox" className="mt-0.5" checked={approved} onChange={e => setApproved(e.target.checked)} />
            <span>I have operator approval to spend up to <span className="font-medium">{maxCalls} provider calls</span> on this batch.</span>
          </label>
        </div>
        <DialogFooter>
          <Button size="sm" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button size="sm" disabled={busy || !approved || planned === 0} onClick={() => void run(() => Discovery.startBatch(clientId, {
            setId: set.id, scope, ...(scope === "SMOKE" ? { questionKeys: keys } : {}), samples, acknowledgedMaxProviderCalls: maxCalls,
          }), "Batch queued").then(ok => { if (ok) onOpenChange(false) })}>{busy ? <Spinner /> : <PlayIcon />}Queue {planned} checks</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ImportDialog({ clientId, fixture, open, onOpenChange, reload }: { clientId: string; fixture: boolean; open: boolean; onOpenChange: (v: boolean) => void; reload: () => Promise<void> }) {
  const [propertyRef, setPropertyRef] = useState("")
  const [dateStart, setDateStart] = useState("")
  const [dateEnd, setDateEnd] = useState("")
  const [timeZone, setTimeZone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone)
  const [conversionEvent, setConversionEvent] = useState("")
  const [csv, setCsv] = useState("")
  const { busy, run } = useBusy(reload)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Import a GA4 export</DialogTitle>
          <DialogDescription>A CSV with Date, Session source, Session medium (or Session source / medium), Sessions, and Key events only if a signup event is configured. No visitor-level data.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 text-xs sm:grid-cols-2">
          <div className="space-y-1"><Label htmlFor="ga-prop">GA4 property</Label><Input id="ga-prop" value={propertyRef} onChange={e => setPropertyRef(e.target.value)} placeholder="Property ID or name" /></div>
          <div className="space-y-1"><Label htmlFor="ga-tz">Report time zone</Label><Input id="ga-tz" value={timeZone} onChange={e => setTimeZone(e.target.value)} /></div>
          <div className="space-y-1"><Label htmlFor="ga-start">From</Label><Input id="ga-start" type="date" value={dateStart} onChange={e => setDateStart(e.target.value)} /></div>
          <div className="space-y-1"><Label htmlFor="ga-end">To</Label><Input id="ga-end" type="date" value={dateEnd} onChange={e => setDateEnd(e.target.value)} /></div>
          <div className="space-y-1 sm:col-span-2">
            <Label htmlFor="ga-event">Signup key event <span className="text-muted-foreground">(leave empty if none is configured)</span></Label>
            <Input id="ga-event" value={conversionEvent} onChange={e => setConversionEvent(e.target.value)} placeholder="sign_up" />
          </div>
          <div className="space-y-1 sm:col-span-2">
            <Label htmlFor="ga-file">Export file</Label>
            <Input id="ga-file" type="file" accept=".csv,text/csv" onChange={e => { const file = e.target.files?.[0]; if (file) void file.text().then(setCsv) }} />
            <p className="text-muted-foreground">Attribution basis: session source / medium, as GA4 recorded it.{csv ? ` ${csv.split("\n").length} lines loaded.` : ""}</p>
          </div>
        </div>
        <DialogFooter>
          <Button size="sm" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          {fixture ? <Button size="sm" variant="outline" disabled={busy || !csv} onClick={() => void run(() => Discovery.importReferrals(clientId, {
            dataOrigin: "SYNTHETIC_FIXTURE", propertyRef: propertyRef || "TEST", dateStart, dateEnd, timeZone, attributionBasis: "SESSION_SOURCE_MEDIUM",
            conversionEvent: conversionEvent.trim() || null, csv }), "Synthetic export imported").then(ok => { if (ok) onOpenChange(false) })}>Import as synthetic</Button> : null}
          <Button size="sm" disabled={busy || !csv || !propertyRef || !dateStart || !dateEnd} onClick={() => void run(() => Discovery.importReferrals(clientId, {
            dataOrigin: "GA4_EXPORT", propertyRef, dateStart, dateEnd, timeZone, attributionBasis: "SESSION_SOURCE_MEDIUM", conversionEvent: conversionEvent.trim() || null, csv,
          }).then(r => { if (r.duplicate) toast.info("This export was already imported") }), "Export imported").then(ok => { if (ok) onOpenChange(false) })}>
            {busy ? <Spinner /> : <UploadIcon />}Import
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------------------------------------------------------------------------
// Answers and review
// ---------------------------------------------------------------------------

/** The exact answer with candidate mentions marked; the text itself is unchanged. */
function AnswerText({ text, candidates }: { text: string; candidates: Candidate[] }) {
  const parts: ReactNode[] = []
  let at = 0
  const spans = [...candidates].sort((a, b) => a.start - b.start).filter((c, i, all) => i === 0 || c.start >= all[i - 1]!.end)
  for (const c of spans) {
    if (c.start > at) parts.push(text.slice(at, c.start))
    parts.push(<mark key={`${c.start}-${c.brand}`} title={`${c.role === "TARGET" ? "Target" : "Competitor"} candidate: ${c.brand}`}
      className={cn("rounded-sm px-0.5 text-inherit", c.role === "TARGET" ? "bg-review-soft ring-1 ring-review/30" : "bg-muted ring-1 ring-border")}>{text.slice(c.start, c.end)}</mark>)
    at = c.end
  }
  parts.push(text.slice(at))
  return <div className="text-xs leading-relaxed break-words whitespace-pre-wrap">{parts}</div>
}

const MENTIONS: Mention[] = ["MENTIONED", "NOT_MENTIONED", "UNCLEAR"]
const RECOMMENDATIONS: Recommendation[] = ["RECOMMENDED", "MENTIONED_NOT_RECOMMENDED", "ADVISED_AGAINST", "UNCLEAR"]

function SampleReview({ clientId, check, brand, reload }: { clientId: string; check: Check; brand: string; reload: () => Promise<void> }) {
  const current = check.judgment
  const [mention, setMention] = useState<Mention | null>(current?.mention ?? null)
  const [recommendation, setRecommendation] = useState<Recommendation | null>(current?.recommendation ?? null)
  const [note, setNote] = useState("")
  const { busy, run } = useBusy(reload)
  const o = check.observation
  if (!o) {
    return check.status === "FAILED"
      ? <p className="text-xs text-wrong">Check failed: {check.failureDetailSafe ?? check.failureClass} ({check.attempts} attempt{check.attempts === 1 ? "" : "s"}). It stays in the attempt counts.</p>
      : <p className="flex items-center gap-2 text-xs text-muted-foreground"><LoaderCircleIcon className="size-3.5 animate-spin" />Waiting for the worker</p>
  }
  const target = check.candidates.filter(c => c.role === "TARGET")
  const ready = mention !== null && (mention !== "MENTIONED" || recommendation !== null)
  const changed = !current || current.mention !== mention || current.recommendation !== recommendation
  return (
    <div className="space-y-3">
      <article className="rounded-lg border bg-muted/25">
        <header className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b px-3 py-2 text-[0.6875rem] text-muted-foreground">
          <span>{o.observedModel ?? o.requestedModel ?? o.provider}</span>
          <span>· {formatDateTime(o.collectedAt)}</span>
          <span>· {o.retrievalObserved ? "live web used" : o.retrievalRequested ? "web requested, not observed" : "no web retrieval"}</span>
          {o.synthetic ? <Badge variant="partial">Synthetic, excluded</Badge> : null}
          <Link className="ml-auto underline" to={`/observations/${o.id}`}>Evidence · sha256:{o.rawDigest.slice(0, 10)}…</Link>
        </header>
        <div className="max-h-96 overflow-auto px-3 py-2.5"><AnswerText text={o.answerText} candidates={check.candidates} /></div>
        {o.searchQueries.length ? <p className="border-t px-3 py-1.5 text-[0.6875rem] text-muted-foreground">Searched: {o.searchQueries.map(q => `“${q}”`).join(", ")}</p> : null}
        {o.citations.length ? (
          <ul className="space-y-0.5 border-t px-3 py-2 text-[0.6875rem]">
            {o.citations.map((c, i) => (
              <li key={i} className="flex flex-wrap items-center gap-1.5">
                <span className="text-muted-foreground tabular-nums">[{c.position ?? i + 1}]</span>
                <span className="font-medium">{c.domain ?? c.title ?? "unresolved source"}</span>
                {c.owner === "OWNED" ? <Badge variant="supported">Owned domain</Badge> : c.owner === "COMPETITOR" ? <Badge variant="outline">Competitor: {c.competitor}</Badge> : null}
                <span className="text-muted-foreground">{c.domainBasis === "PROVIDER_TITLE" ? "domain as reported by provider" : c.domainBasis === "UNRESOLVED" ? "domain not resolved" : ""}{c.attributedByProvider ? " · linked to answer text by provider" : ""} · support not verified</span>
              </li>
            ))}
          </ul>
        ) : null}
      </article>
      <SearchSuggestions html={o.searchSuggestionsHtml} />
      {target.length ? (
        <ul className="space-y-1 text-[0.6875rem]">
          {target.map(c => (
            <li key={c.start} className="rounded-md bg-review-soft/50 px-2 py-1">
              <span className="font-medium">“{c.matched}”</span>{c.hints.length ? <span className="text-muted-foreground"> · {c.hints.map(h => HINT_LABELS[h] ?? h).join(", ")}</span> : null}
              {c.ambiguity ? <span className="text-partial"> · ambiguous name: {c.ambiguity}</span> : null}
              {c.collision ? <span className="text-partial"> · also matches another brand</span> : null}
              <span className="block text-muted-foreground">{c.sentence}</span>
            </li>
          ))}
        </ul>
      ) : <p className="text-[0.6875rem] text-muted-foreground">No exact-name candidate for {brand}. Read the answer before deciding: the brand may appear in another form.</p>}
      {!o.synthetic ? (
        <div className="space-y-2 rounded-lg border p-3">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <span className="font-medium">Does this answer mention <span className="text-review">{brand}</span>?</span>
            <span className="text-[0.6875rem] text-muted-foreground">{current ? `Reviewed ${relativeTime(current.reviewedAt)}${check.judgments.length > 1 ? ` · corrected ${check.judgments.length - 1}×` : ""}` : "Not reviewed yet"}</span>
          </div>
          <div className="flex flex-wrap gap-1">
            {MENTIONS.map(m => <Button key={m} size="sm" className="h-7" variant={mention === m ? "default" : "outline"} onClick={() => { setMention(m); if (m !== "MENTIONED") setRecommendation(null) }}>{MENTION_LABELS[m]}</Button>)}
          </div>
          {mention === "MENTIONED" ? (
            <>
              <p className="text-xs font-medium">Does it recommend {brand} for this buyer's request?</p>
              <div className="flex flex-wrap gap-1">
                {RECOMMENDATIONS.map(r => <Button key={r} size="sm" className="h-7" variant={recommendation === r ? "default" : "outline"} onClick={() => setRecommendation(r)}>{RECOMMENDATION_LABELS[r]}</Button>)}
              </div>
            </>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <Input value={note} onChange={e => setNote(e.target.value)} placeholder="Private note (optional)" className="h-7 flex-1 text-xs" />
            <Button size="sm" className="h-7" disabled={busy || !ready || (!changed && !note.trim())} onClick={() => void run(() => Discovery.judge(clientId, {
              observationId: o.id, mention: mention!, recommendation: mention === "MENTIONED" ? recommendation : null, note: note.trim() || null,
            }), current ? "Review corrected" : "Review saved").then(ok => { if (ok) setNote("") })}>{current ? "Save correction" : "Save review"}</Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

const dotTone = (c: Check) => c.status === "FAILED" ? "bg-wrong" : !c.observation ? "bg-muted-foreground/30" : c.observation.synthetic ? "bg-partial"
  : !c.judgment ? "bg-review" : c.judgment.recommendation === "RECOMMENDED" ? "bg-supported" : c.judgment.recommendation === "ADVISED_AGAINST" ? "bg-wrong" : "bg-unknown"

function QuestionRow({ clientId, checks, statement, brand, open, onToggle, reload }: {
  clientId: string; checks: Check[]; statement: string; brand: string; open: boolean; onToggle: () => void; reload: () => Promise<void>
}) {
  const [sample, setSample] = useState(0)
  const first = checks[0]!
  const waiting = checks.filter(c => c.eligible && !c.judgment).length
  const shown = checks[Math.min(sample, checks.length - 1)]!
  return (
    <li className="border-b last:border-0">
      <button type="button" onClick={onToggle} className="flex w-full items-start gap-3 px-4 py-2.5 text-left hover:bg-muted/40">
        <span className="mt-px font-mono text-[0.6875rem] text-muted-foreground">{first.questionKey}</span>
        <span className="min-w-0 flex-1">
          <span className="block text-xs">{first.prompt}</span>
          <span className="mt-0.5 block text-[0.6875rem] text-muted-foreground">{statement}</span>
        </span>
        <span className="mt-1 flex shrink-0 items-center gap-1">{checks.map(c => <span key={c.id} className={cn("size-2 rounded-full", dotTone(c))} />)}</span>
        {waiting ? <Badge variant="review">{waiting} to review</Badge> : null}
        <ChevronDownIcon className={cn("mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} />
      </button>
      {open ? (
        <div className="space-y-3 px-4 pb-4">
          {checks.length > 1 ? (
            <div className="flex gap-1">
              {checks.map((c, i) => (
                <Button key={c.id} size="sm" variant={i === sample ? "secondary" : "ghost"} className="h-6 gap-1.5 px-2 text-[0.6875rem]" onClick={() => setSample(i)}>
                  <span className={cn("size-1.5 rounded-full", dotTone(c))} />Sample {c.sample}
                </Button>
              ))}
            </div>
          ) : null}
          <SampleReview key={shown.id} clientId={clientId} check={shown} brand={brand} reload={reload} />
        </div>
      ) : null}
    </li>
  )
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function ClientDiscoveryPage() {
  const { id = "" } = useParams()
  const [poll, setPoll] = useState(false)
  const res = useApi<DiscoveryResponse>(`discovery:${id}`, async () => {
    const r = await Discovery.get(id)
    setPoll(r.view.activeBatch)
    return r
  }, { pollMs: poll ? 3000 : null })
  const reload = async () => { await res.reload() }
  const [editing, setEditing] = useState(false)
  const [batchOpen, setBatchOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [params, setParams] = useSearchParams()
  const batchId = params.get("batchId")
  const setBatchId = (value: string) => { const next = new URLSearchParams(params); next.set("batchId", value); setParams(next) }
  const [openKey, setOpenKey] = useState<string | null>(null)

  if (res.loading && !res.data) return <div className="space-y-4"><Skeleton className="h-14 w-72" /><Skeleton className="h-64 rounded-xl" /></div>
  if (!res.data) {
    return <EmptyState icon={<TriangleAlertIcon />} title="AI Discovery could not load" description={failure(res.error)}
      action={<Button asChild variant="outline" size="sm"><Link to={`/clients/${id}`}>Client record</Link></Button>} />
  }
  const { view, surface, maxAttemptsPerCheck } = res.data
  const set = view.sets.at(-1) ?? null
  const surfaceLabel = `${surface.provider === "gemini" ? "Gemini API with Google Search grounding" : surface.provider} (${surface.model})`
  const batch: Batch | null = batchId ? view.batches.find(b => b.id === batchId) ?? null : view.batches.at(-1) ?? null
  const batchSet = batch ? view.sets.find(s => s.id === batch.setId) ?? null : null
  const checks = batch ? view.checks.filter(c => c.batchId === batch.id) : []
  const m = batch?.metrics
  const byQuestion = new Map<string, Check[]>()
  for (const c of checks) byQuestion.set(c.questionKey, [...(byQuestion.get(c.questionKey) ?? []), c])

  return (
    <div className="space-y-5 pb-4">
      {batchId && !batch ? <p role="alert" className="text-xs text-wrong">The linked measurement is unavailable in this client record.</p> : null}
      <PageHeader
        back={{ to: `/clients/${id}`, label: view.profile.name }}
        title="AI Discovery"
        description="Does the measured AI surface mention or recommend this business when a buyer asks for a product or service?"
        meta={<>
          <span>{surfaceLabel}</span>
          {set ? <Badge variant={set.basis === "AUTHORIZED_CLIENT" ? "outline" : "partial"}>{BASIS_LABELS[set.basis]}</Badge> : null}
          <span>Measures this surface only, not ChatGPT or Claude</span>
        </>}
        actions={<>
          <Button size="sm" variant="outline" asChild><Link to={discoveryReportPath(id)}><FileTextIcon />Report</Link></Button>
          {set ? <Button size="sm" disabled={view.activeBatch} onClick={() => setBatchOpen(true)}>{view.activeBatch ? <Spinner /> : <PlayIcon />}Start batch</Button> : null}
        </>}
      />

      {!set || editing ? (
        <Panel>
          <PanelHeader title={set ? `New question set (version ${set.version + 1})` : "Freeze a buyer-question set"}
            description="Brand configuration and the exact buyer questions, frozen before any observation." />
          <SetForm clientId={id} previous={set} websiteUrl={view.profile.websiteUrl} reload={reload} onDone={() => setEditing(false)} />
        </Panel>
      ) : null}

      {view.activeBatch ? (
        <div className="flex items-center gap-2 rounded-xl border border-review/20 bg-review-soft/60 px-4 py-2.5 text-xs text-review">
          <LoaderCircleIcon className="size-4 animate-spin" />A batch is running on the existing worker. This page updates on its own.
        </div>
      ) : null}

      {m ? (
        <StatStrip stats={[
          { key: "answers", label: "Answers collected", value: fraction({ n: m.eligible, d: m.planned }), hint: `${m.failed} failed · ${m.providerAttempts} provider attempts` },
          { key: "reviewed", label: "Reviewed", value: fraction(m.reviewed), hint: `${m.candidateSamples.n} with a ${set?.target.name ?? "brand"} candidate`, ...(m.reviewed.n < m.reviewed.d ? { tone: "review" as const } : {}) },
          { key: "mentioned", label: "Mentioned (confirmed)", value: fraction(m.mentionRate), hint: "of collected answers" },
          { key: "recommended", label: "Recommended (confirmed)", value: fraction(m.recommendationRate), hint: "of reviewed answers", tone: "supported" },
          { key: "owned", label: "Owned domain cited", value: fraction(m.ownedCitationRate), hint: "of collected answers" },
        ]} />
      ) : null}

      {set ? (
        <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
          <Panel className="min-w-0">
            <PanelHeader title={batch ? `Answers · ${batch.scope === "SMOKE" ? "smoke batch" : "full batch"} · ${relativeTime(batch.createdAt)}` : "Answers"}
              description={batch ? `${BATCH_STATUS_LABELS[batch.status]} · question set v${batch.setVersion} · ${batch.sampleCount} sample${batch.sampleCount === 1 ? "" : "s"} per question` : "Start a batch to collect answers."} />
            {batch && batchSet ? (
              INTENT_GROUPS.filter(g => m!.questions.some(q => q.group === g)).map(g => (
                <div key={g}>
                  <p className="border-t bg-muted/30 px-4 py-1.5 text-[0.6875rem] font-medium text-muted-foreground">{GROUP_LABELS[g]}</p>
                  <ul>
                    {m!.questions.filter(q => q.group === g).map(q => (
                      <QuestionRow key={`${batch.id}-${q.key}`} clientId={id} checks={byQuestion.get(q.key) ?? []} statement={q.statement} brand={batchSet.target.name}
                        open={openKey === `${batch.id}-${q.key}`} onToggle={() => setOpenKey(openKey === `${batch.id}-${q.key}` ? null : `${batch.id}-${q.key}`)} reload={reload} />
                    ))}
                  </ul>
                </div>
              ))
            ) : <p className="px-4 pb-4 text-xs text-muted-foreground">No batch yet. Start with a smoke batch: one question per group, one sample.</p>}
          </Panel>

          <div className="space-y-4">
            <Panel>
              <PanelHeader title="Batches" />
              <ul className="p-2 pt-1">
                {[...view.batches].reverse().map(b => (
                  <li key={b.id}>
                    <button type="button" onClick={() => setBatchId(b.id)} className={cn("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted/50", batch?.id === b.id && "bg-muted")}>
                      <span className="min-w-0 flex-1">
                        <span className="block font-medium">{b.scope === "SMOKE" ? "Smoke" : "Full"} · v{b.setVersion} · {b.questionCount}×{b.sampleCount}</span>
                        <span className="block text-[0.6875rem] text-muted-foreground">{BATCH_STATUS_LABELS[b.status]} · {b.metrics.succeeded}/{b.metrics.planned} answered{b.metrics.failed ? ` · ${b.metrics.failed} failed` : ""}</span>
                      </span>
                      <span className="text-[0.6875rem] text-muted-foreground" title={formatDateTime(b.createdAt)}>{relativeTime(b.createdAt)}</span>
                    </button>
                  </li>
                ))}
                {view.batches.length === 0 ? <li className="px-2 py-2 text-xs text-muted-foreground">None yet.</li> : null}
              </ul>
            </Panel>

            <Panel>
              <PanelHeader title={`Question set v${set.version}`} description={`${set.questions.length} frozen questions · ${set.category}`}>
                {!editing ? <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => setEditing(true)}>New version</Button> : null}
              </PanelHeader>
              <div className="space-y-2 p-4 pt-2 text-xs">
                <p><span className="text-muted-foreground">Brand</span> {set.target.name}{set.target.aliases.length ? ` (${set.target.aliases.join(", ")})` : ""}</p>
                <p><span className="text-muted-foreground">Owned</span> {set.target.domains.join(", ")}</p>
                <p><span className="text-muted-foreground">Competitors</span> {set.competitors.map(c => c.name).join(", ") || "None"}</p>
                {set.questionsNamingTarget.length ? <p className="text-partial">{set.questionsNamingTarget.length} question{set.questionsNamingTarget.length === 1 ? " names" : "s name"} the brand ({set.questionsNamingTarget.join(", ")}), which can lead the answer.</p> : null}
                <details>
                  <summary className="cursor-pointer text-muted-foreground">Show questions</summary>
                  <ol className="mt-2 space-y-1">{set.questions.map(q => <li key={q.id}><span className="font-mono text-muted-foreground">{q.key}</span> {q.prompt}</li>)}</ol>
                </details>
                <p className="font-mono text-[0.6875rem] break-all text-muted-foreground">sha256:{set.specDigest.slice(0, 24)}…</p>
              </div>
            </Panel>

            {m && m.competitors.length ? (
              <Panel>
                <PanelHeader title="Competitor appearances" description="Exact-name detections, not reviewed. Not market share." />
                <ul className="space-y-1 p-4 pt-2 text-xs">{m.competitors.map(c => <li key={c.name} className="flex justify-between"><span>{c.name}</span><span className="tabular-nums">{fraction(c.samples)}</span></li>)}</ul>
              </Panel>
            ) : null}

            <Panel>
              <PanelHeader title="AI referral evidence" description="From a GA4 export: a separate source, never tied to a sampled answer.">
                <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={() => setImportOpen(true)}>Import</Button>
              </PanelHeader>
              <div className="space-y-3 p-4 pt-2 text-xs">
                {view.referrals.length === 0 ? <p className="text-muted-foreground">No export imported. Referral traffic and signups are not measured.</p> : null}
                {view.referrals.map(r => (
                  <div key={r.id} className="space-y-1">
                    <p className="flex items-center gap-1.5"><span className="font-medium">{r.dateStart} to {r.dateEnd}</span>{r.synthetic ? <Badge variant="partial">Synthetic, not evidence</Badge> : null}</p>
                    <p className="text-muted-foreground">{r.aiSessions} AI-attributed of {r.totalSessions} sessions · {r.signups === "SIGNUPS_NOT_MEASURED" ? "SIGNUPS_NOT_MEASURED" : `${r.signups} ${r.conversionEvent} key events from AI sources`}</p>
                    {r.bySource.map(s => <p key={s.assistant} className="flex justify-between"><span>{s.assistant}</span><span className="tabular-nums">{s.sessions}</span></p>)}
                  </div>
                ))}
              </div>
            </Panel>
          </div>
        </div>
      ) : null}

      {set ? <StartBatchDialog key={`${set.id}-${batchOpen}`} clientId={id} set={set} maxAttempts={maxAttemptsPerCheck} surface={surfaceLabel} open={batchOpen} onOpenChange={setBatchOpen} reload={reload} /> : null}
      <ImportDialog key={String(importOpen)} clientId={id} fixture={view.profile.engagement === "FIXTURE"} open={importOpen} onOpenChange={setImportOpen} reload={reload} />
    </div>
  )
}
