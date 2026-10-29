import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react"
import { Link } from "react-router"
import { toast } from "sonner"
import { ArrowRightIcon, CheckIcon, GlobeIcon, LoaderCircleIcon, RotateCwIcon, SparklesIcon } from "lucide-react"
import type { ChannelCapability, ChannelEntry, ChannelInventory, GrowthOpportunity, SetupView } from "@openrecord/contracts"
import { ThinkingGlyph } from "@/components/agent-trace"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { Growth, growthError, growthPath } from "@/lib/growth"
import { Setup, normalizeWebsite, setupError } from "@/lib/setup"
import { useApi } from "@/lib/use-api"
import { cn } from "@/lib/utils"

/** The business's setup, polled only while its homepage is being read. */
export function useSetup(businessId: string) {
  const [override, setOverride] = useState<SetupView | null>(null)
  const [polling, setPolling] = useState(true)
  const q = useApi(businessId ? `setup:${businessId}` : null, () => Setup.get(businessId), { pollMs: polling ? 1500 : null })
  const latest = q.data?.setup ?? null
  // A server response always wins over an older local copy.
  const setup = override && (!latest || override.revision >= latest.revision) ? override : latest
  // Poll while the homepage is read and while the agent drafts the brief from it.
  const discovering = setup?.step === "DISCOVER" || (setup?.step === "CONFIRM" && setup.draft?.status === "RUNNING")
  const settled = !q.loading
  useEffect(() => { if (settled) setPolling(discovering) }, [settled, discovering])
  return { setup, loading: q.loading && !q.data, set: setOverride, reload: q.reload }
}

const STEPS = [
  { key: "DISCOVER", label: "Read website" },
  { key: "CONFIRM", label: "Confirm brief" },
  { key: "CONNECT", label: "Channels" },
  { key: "PROPOSE", label: "First initiative" },
] as const

function Stepper({ step }: { step: SetupView["step"] }) {
  const at = step === "DONE" ? STEPS.length : STEPS.findIndex(s => s.key === step)
  return (
    <ol className="flex flex-wrap items-center gap-x-1 gap-y-1 text-[0.6875rem]" aria-label="Setup progress">
      {STEPS.map((s, i) => (
        <li key={s.key} className="flex items-center gap-1">
          <span
            aria-current={i === at ? "step" : undefined}
            className={cn("flex items-center gap-1 rounded-full px-2 py-0.5", i < at ? "text-primary-ink" : i === at ? "bg-primary text-primary-foreground" : "text-muted-foreground")}
          >
            {i < at ? <CheckIcon className="size-3" /> : <span className="tabular-nums">{i + 1}</span>}
            {s.label}
            <span className="sr-only">{i < at ? " (done)" : i === at ? " (current)" : ""}</span>
          </span>
          {i < STEPS.length - 1 ? <span aria-hidden className="h-px w-3 bg-border" /> : null}
        </li>
      ))}
    </ol>
  )
}

/** One card in the agent thread that walks a business through setup. */
export function SetupFlow({ setup, onChange }: { setup: SetupView; onChange: (s: SetupView) => void }) {
  const host = new URL(setup.websiteUrl).hostname.replace(/^www\./, "")
  return (
    <section aria-label="Business setup" className="space-y-4 rounded-2xl bg-card p-5 text-left shadow-(--card-shadow)">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-xs font-medium"><SparklesIcon className="size-3.5 text-primary-ink" />Setting up {setup.brief?.businessName ?? host}</p>
        <Stepper step={setup.step} />
      </div>
      {setup.step === "DISCOVER" ? <DiscoverStep host={host} />
        : setup.step === "CONFIRM" ? <ConfirmStep setup={setup} onChange={onChange} />
          : setup.step === "CONNECT" ? <ConnectStep setup={setup} onChange={onChange} />
            : setup.step === "PROPOSE" ? <ProposeStep setup={setup} onChange={onChange} />
              : setup.opportunity ? <InitiativeDecision businessId={setup.businessId} opportunity={setup.opportunity} measurement={setup.assessment?.measurement ?? "NONE"} /> : null}
    </section>
  )
}

function DiscoverStep({ host }: { host: string }) {
  return (
    <div className="flex items-start gap-3" role="status">
      <LoaderCircleIcon className="mt-0.5 size-4 shrink-0 animate-spin text-primary-ink" />
      <div className="space-y-1">
        <p className="text-sm font-medium">Reading {host}</p>
        <p className="text-xs text-muted-foreground">Only the public homepage, once. Nothing on your site is changed.</p>
      </div>
    </div>
  )
}

const KIND_METRIC = { LEAD: "Leads", SIGNUP: "Signups", PURCHASE: "Purchases", BOOKING: "Bookings" } as const
type Kind = keyof typeof KIND_METRIC

// The business's current name unless the page names it more precisely; a new
// business starts out named after its website.
function guessName(setup: SetupView) {
  const host = new URL(setup.websiteUrl).hostname.replace(/^www\./, "")
  const existing = setup.businessName !== host ? setup.businessName : null
  if (setup.discovery.status !== "DONE") return existing ?? host
  const s = setup.discovery.signals
  return existing ?? s.organization?.name ?? s.siteName ?? s.title?.split(/\s[|–—-]\s/)[0] ?? host
}

function ConfirmStep({ setup, onChange }: { setup: SetupView; onChange: (s: SetupView) => void }) {
  const id = useId()
  const signals = setup.discovery.status === "DONE" ? setup.discovery.signals : null
  const candidates = useMemo(() => [
    ...(signals?.organization?.telephone ? [{ predicate: "phone_number", label: "Phone number", valueText: signals.organization.telephone }] : []),
    ...(signals?.organization?.email ? [{ predicate: "contact_email", label: "Contact email", valueText: signals.organization.email }] : []),
    ...(signals?.channels.find(c => c.kind === "EMAIL") && !signals.organization?.email
      ? [{ predicate: "contact_email", label: "Contact email", valueText: signals.channels.find(c => c.kind === "EMAIL")!.url.replace(/^mailto:/, "") }] : []),
  ], [signals])
  const [form, setForm] = useState({
    businessName: setup.brief?.businessName ?? guessName(setup),
    category: setup.brief?.category ?? "",
    audience: setup.brief?.audience ?? "",
    valueProposition: setup.brief?.valueProposition ?? signals?.description ?? "",
    goalStatement: setup.brief?.goalStatement ?? setup.goalStatement ?? "",
    conversionKind: (setup.brief?.conversionKind ?? "LEAD") as Kind,
    metricLabel: setup.brief?.metricLabel ?? "",
  })
  const [facts, setFacts] = useState<Record<string, boolean>>({})
  const [saving, setSaving] = useState(false)
  const [retrying, setRetrying] = useState(false)
  const set = (k: keyof typeof form) => (v: string) => setForm(f => ({ ...f, [k]: v }))
  // The agent's draft fills whatever the person hasn't typed yet; their own words always win.
  const draft = setup.draft?.status === "READY" ? setup.draft.value : null
  const drafted = useRef(false)
  useEffect(() => {
    if (!draft || drafted.current || setup.brief) return
    drafted.current = true
    setForm(f => ({
      businessName: f.businessName && f.businessName !== guessName(setup) ? f.businessName : draft.businessName,
      category: f.category || draft.category, audience: f.audience || draft.audience,
      valueProposition: f.valueProposition && f.valueProposition !== (signals?.description ?? "") ? f.valueProposition : draft.valueProposition,
      goalStatement: f.goalStatement || draft.goalStatement, conversionKind: f.category || f.audience ? f.conversionKind : draft.conversionKind,
      metricLabel: f.metricLabel || draft.metricLabel,
    }))
  }, [draft, setup, signals])

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setSaving(true)
    try {
      const r = await Setup.confirm(setup.businessId, {
        expectedRevision: setup.revision,
        businessName: form.businessName.trim(),
        category: form.category.trim(),
        audience: form.audience.trim(),
        valueProposition: form.valueProposition.trim(),
        goalStatement: form.goalStatement.trim(),
        conversionKind: form.conversionKind,
        metricLabel: form.metricLabel.trim() || KIND_METRIC[form.conversionKind],
        reportingTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
        facts: candidates.filter(c => facts[c.predicate]).map(c => ({ predicate: c.predicate, valueText: c.valueText })),
      })
      onChange(r.setup)
    } catch (err) {
      toast.error(setupError(err))
    } finally {
      setSaving(false)
    }
  }
  const retry = async () => {
    setRetrying(true)
    try { onChange((await Setup.retry(setup.businessId, setup.revision)).setup) } catch (err) { toast.error(setupError(err)) } finally { setRetrying(false) }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      {setup.discovery.status === "FAILED" ? (
        <div className="flex flex-wrap items-center gap-3 rounded-xl bg-partial-soft px-3 py-2 text-xs">
          <span className="min-w-0 flex-1">The homepage couldn't be read ({setup.discovery.failure.toLowerCase().replace(/_/g, " ")}). Describe the business below, or try again.</span>
          <Button type="button" variant="outline" size="sm" onClick={retry} disabled={retrying}><RotateCwIcon />Try again</Button>
        </div>
      ) : setup.draft?.status === "RUNNING" ? (
        <p role="status" className="flex items-center gap-1.5 rounded-xl bg-muted/60 px-3 py-2.5 text-xs text-muted-foreground">
          <ThinkingGlyph /><span className="thinking">Your agent is reading your website and filling this in for you</span>
        </p>
      ) : draft ? (
        <div className="space-y-1.5 rounded-xl bg-muted/60 px-3 py-2.5 text-xs">
          <p className="font-medium">Drafted by your agent from your website <span className="font-normal text-muted-foreground">· check it, change anything, then confirm</span></p>
          {draft.competitors.length ? <p className="text-muted-foreground">Competitors it found: {draft.competitors.map(c => c.name).join(", ")}</p> : null}
        </div>
      ) : signals ? (
        <div className="space-y-1.5 rounded-xl bg-muted/60 px-3 py-2.5 text-xs">
          <p className="font-medium">From your homepage <span className="font-normal text-muted-foreground">· suggestions, not verified</span></p>
          {signals.title ? <p className="truncate text-muted-foreground">“{signals.title}”</p> : null}
          <p className="text-muted-foreground">
            {signals.pages.length} {signals.pages.length === 1 ? "page" : "pages"} linked
            {signals.channels.length ? ` · ${signals.channels.length} public ${signals.channels.length === 1 ? "profile" : "profiles"}` : ""}
          </p>
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <Text id={`${id}-name`} label="Business name" value={form.businessName} onChange={set("businessName")} required />
        <Text id={`${id}-category`} label="What you sell" placeholder="Family dentistry, CRM software…" value={form.category} onChange={set("category")} required />
        <Text id={`${id}-audience`} label="Who buys it" placeholder="Families within 10 miles" value={form.audience} onChange={set("audience")} required className="sm:col-span-2" />
        <Text id={`${id}-value`} label="Why they choose you" value={form.valueProposition} onChange={set("valueProposition")} required long className="sm:col-span-2" />
        <Text id={`${id}-goal`} label="Goal for marketing" placeholder="More booked appointments" value={form.goalStatement} onChange={set("goalStatement")} required className="sm:col-span-2" />
        <div className="grid gap-1.5">
          <Label htmlFor={`${id}-kind`}>Count success as</Label>
          <Select value={form.conversionKind} onValueChange={v => setForm(f => ({ ...f, conversionKind: v as Kind }))}>
            <SelectTrigger id={`${id}-kind`}><SelectValue /></SelectTrigger>
            <SelectContent>
              {(Object.keys(KIND_METRIC) as Kind[]).map(k => <SelectItem key={k} value={k}>{KIND_METRIC[k]}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <Text id={`${id}-metric`} label="Metric name" placeholder={KIND_METRIC[form.conversionKind]} value={form.metricLabel} onChange={set("metricLabel")} />
      </div>

      {candidates.length ? (
        <fieldset className="space-y-2">
          <legend className="text-xs font-medium">Save as approved facts <span className="font-normal text-muted-foreground">· AI answers are checked against these</span></legend>
          {candidates.map(c => (
            <div key={c.predicate} className="flex items-center gap-2 text-xs">
              <Checkbox id={`${id}-${c.predicate}`} checked={!!facts[c.predicate]} onCheckedChange={v => setFacts(f => ({ ...f, [c.predicate]: v === true }))} />
              <Label htmlFor={`${id}-${c.predicate}`} className="font-normal">{c.label}: <span className="font-medium">{c.valueText}</span></Label>
            </div>
          ))}
        </fieldset>
      ) : null}

      <div className="flex items-center justify-between gap-3">
        <p className="text-[0.6875rem] text-muted-foreground">You can change this later. Your goal is counted from daily numbers you import or connect.</p>
        <Button type="submit" disabled={saving}>{saving ? <LoaderCircleIcon className="animate-spin" /> : <CheckIcon />}Confirm brief</Button>
      </div>
    </form>
  )
}

function Text({ id, label, value, onChange, placeholder, required, long, className }: {
  id: string; label: string; value: string; onChange: (v: string) => void; placeholder?: string; required?: boolean; long?: boolean; className?: string
}) {
  return (
    <div className={cn("grid gap-1.5", className)}>
      <Label htmlFor={id}>{label}</Label>
      {long
        ? <Textarea id={id} value={value} onChange={e => onChange(e.currentTarget.value)} placeholder={placeholder} required={required} maxLength={2000} rows={2} />
        : <Input id={id} value={value} onChange={e => onChange(e.currentTarget.value)} placeholder={placeholder} required={required} maxLength={1000} />}
    </div>
  )
}

function ConnectStep({ setup, onChange }: { setup: SetupView; onChange: (s: SetupView) => void }) {
  const [saving, setSaving] = useState(false)
  const next = async () => {
    setSaving(true)
    try { onChange((await Setup.reviewChannels(setup.businessId, setup.revision)).setup) } catch (err) { toast.error(setupError(err)) } finally { setSaving(false) }
  }
  return (
    <div className="space-y-4">
      <div>
        <p className="text-sm font-medium">Your channels</p>
        <p className="mt-0.5 text-xs text-muted-foreground">What OpenRecord can actually do with each one today. None are required: you can continue now and connect later.</p>
      </div>
      <ChannelList inventory={setup.inventory} />
      <div className="flex justify-end">
        <Button onClick={next} disabled={saving}>{saving ? <LoaderCircleIcon className="animate-spin" /> : <ArrowRightIcon />}Continue</Button>
      </div>
    </div>
  )
}

const TONE_DOT = { gap: "bg-wrong", ok: "bg-supported", unknown: "bg-unknown" } as const

function ProposeStep({ setup, onChange }: { setup: SetupView; onChange: (s: SetupView) => void }) {
  const [saving, setSaving] = useState(false)
  const propose = async () => {
    setSaving(true)
    try { onChange((await Setup.propose(setup.businessId, setup.revision)).setup) } catch (err) { toast.error(setupError(err)) } finally { setSaving(false) }
  }
  return (
    <div className="space-y-4">
      <div>
        <p className="text-sm font-medium">What we know so far</p>
        <p className="mt-0.5 text-xs text-muted-foreground">From your homepage and connected channels. Unknowns stay unknown.</p>
      </div>
      <ul className="space-y-2">
        {setup.assessment?.findings.map(f => (
          <li key={f.key} className="flex items-start gap-2.5 text-xs">
            <span aria-hidden className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", TONE_DOT[f.tone])} />
            <span><span className="sr-only">{f.tone === "gap" ? "Gap: " : f.tone === "ok" ? "In place: " : "Unknown: "}</span>{f.text}</span>
          </li>
        ))}
      </ul>
      <div className="flex justify-end">
        <Button onClick={propose} disabled={saving}>{saving ? <LoaderCircleIcon className="animate-spin" /> : <SparklesIcon />}Suggest a first initiative</Button>
      </div>
    </div>
  )
}

/** A proposed initiative with its reasoning, and the human decision on it. */
export function InitiativeDecision({ businessId, opportunity, measurement, onDecided }: { businessId: string; opportunity: GrowthOpportunity; measurement: "CONNECTED" | "MANUAL_ONLY" | "NONE"; onDecided?: () => void }) {
  const [current, setCurrent] = useState(opportunity)
  const [busy, setBusy] = useState<"approve" | "cancel" | null>(null)
  const decide = async (decision: "approve" | "cancel") => {
    setBusy(decision)
    try {
      const r = await Growth.decide(businessId, current.id, decision, { expectedStatus: current.status, expectedRevision: current.revision, idempotencyKey: crypto.randomUUID(),
        reason: decision === "approve" ? "Approved in OpenRecord" : "Declined in OpenRecord" })
      setCurrent(r.opportunity)
      onDecided?.()
    } catch (err) {
      toast.error(growthError(err))
    } finally {
      setBusy(null)
    }
  }
  const suggested = current.evidence.some(e => e.type === "MODEL_SUGGESTION")
  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-sm font-medium">{current.title}</p>
          <Badge variant={current.status === "APPROVED" ? "supported" : current.status === "CANCELLED" ? "outline" : "review"}>
            {current.status === "PROPOSED" ? "Waiting for your decision" : current.status === "APPROVED" ? "Approved" : current.status === "CANCELLED" ? "Declined" : current.status.toLowerCase()}
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground">{current.problemStatement}</p>
      </div>
      <dl className="grid gap-3 text-xs sm:grid-cols-2">
        <Detail label="The change">{current.proposedChange}</Detail>
        <Detail label="Why it could help">{current.expectedMechanism}</Detail>
        <Detail label="What we don't know">{current.uncertainty}</Detail>
        <Detail label="Where this came from">{suggested ? "Suggested by OpenRecord from your brief and homepage. A hypothesis, not a measured result." : current.source}</Detail>
      </dl>
      {current.status === "PROPOSED" ? (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <p className="mr-auto text-[0.6875rem] text-muted-foreground">Approving records your decision. Nothing is published or changed on your site.</p>
          <Button variant="ghost" onClick={() => decide("cancel")} disabled={busy !== null}>Not now</Button>
          <Button onClick={() => decide("approve")} disabled={busy !== null}>{busy === "approve" ? <LoaderCircleIcon className="animate-spin" /> : <CheckIcon />}Approve</Button>
        </div>
      ) : current.status === "APPROVED" ? (
        <div className="space-y-2 rounded-xl bg-muted/60 p-3 text-xs">
          <p className="font-medium">Next: make the change, then record it</p>
          <ul className="space-y-1 text-muted-foreground">
            <li>Recording the work marks it as attested by you. OpenRecord verifies only what it can read back.</li>
            <li>{measurement === "CONNECTED" ? "Your goal is measured from Google Analytics." : "Import daily numbers or connect Google Analytics so results can be compared."}</li>
          </ul>
          <div className="flex flex-wrap gap-2 pt-1">
            <Button asChild size="sm"><Link to={`${growthPath(businessId)}#opportunity-${current.id}`}>Record the work</Link></Button>
            <Button asChild size="sm" variant="outline"><Link to={`/businesses/${businessId}/work`}>See all work</Link></Button>
            <Button asChild size="sm" variant="ghost"><Link to={`/businesses/${businessId}/channels`}>Channels</Link></Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-0.5">
      <dt className="text-[0.6875rem] text-muted-foreground">{label}</dt>
      <dd className="leading-relaxed">{children}</dd>
    </div>
  )
}

/* ------------------------------------------------------------ channels */

const STATE_META: Record<ChannelEntry["state"], { label: string; variant: "supported" | "review" | "unknown" | "wrong" | "outline" }> = {
  CONNECTED: { label: "Connected", variant: "supported" },
  DISCOVERED: { label: "Found", variant: "outline" },
  PERMISSION_REQUIRED: { label: "Needs permission", variant: "review" },
  UNSUPPORTED: { label: "Not available", variant: "unknown" },
  REVOKED: { label: "Access revoked", variant: "wrong" },
  UNHEALTHY: { label: "Not working", variant: "wrong" },
}
const CAPABILITY_LABEL: Record<ChannelCapability, string> = { DISCOVER: "Public read", READ: "Read", PROPOSE: "Propose", EXECUTE: "Make changes", VERIFY: "Verify", MEASURE: "Measure" }
// Why an offered capability is not active yet: a missing connection, or a step not done yet.
const pendingNote = (state: ChannelEntry["state"]) => (state === "DISCOVERED" || state === "CONNECTED" ? " (not yet)" : " (once connected)")

export function ChannelList({ inventory, showManual = true }: { inventory: ChannelInventory; showManual?: boolean }) {
  return (
    <div className="space-y-4">
      <ul className="divide-y divide-border/60 rounded-xl border border-border/70">
        {inventory.channels.map(c => (
          <li key={c.key} className="flex flex-wrap items-start gap-x-3 gap-y-2 px-3 py-2.5">
            <GlobeIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-medium">{c.label}</span>
                <Badge variant={STATE_META[c.state].variant}>{STATE_META[c.state].label}</Badge>
                {c.identity ? <span className="max-w-full truncate text-[0.6875rem] text-muted-foreground">{c.identity}</span> : null}
              </div>
              <p className="text-[0.6875rem] text-muted-foreground">{c.note}</p>
              {c.offered.length ? (
                <p className="flex flex-wrap gap-1" aria-label="Capabilities">
                  {c.offered.map(cap => (
                    <span key={cap} className={cn("rounded-full px-1.5 py-px text-[0.625rem]", c.active.includes(cap) ? "bg-primary-ink/10 font-medium text-primary-ink" : "bg-muted text-muted-foreground")}>
                      {CAPABILITY_LABEL[cap]}{c.active.includes(cap) ? "" : pendingNote(c.state)}
                    </span>
                  ))}
                </p>
              ) : null}
            </div>
            {c.action ? (
              <Button asChild size="sm" variant={c.action.kind === "CONNECT_GA4" ? "default" : "outline"}>
                <Link to={c.action.href}>{c.action.label}</Link>
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      {inventory.builtIn.length ? (
        <div className="space-y-1.5">
          <p className="text-xs font-medium">Built into OpenRecord</p>
          <ul className="space-y-1.5">
            {inventory.builtIn.map(b => (
              <li key={b.key} className="flex flex-wrap items-center gap-2 text-[0.6875rem] text-muted-foreground">
                <span className="font-medium text-foreground">{b.label}.</span>
                <span className="min-w-0 flex-1">{b.note}</span>
                {b.action ? <Button asChild size="sm" variant="outline"><Link to={b.action.href}>{b.action.label}</Link></Button> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {showManual ? (
        <div className="space-y-1.5">
          <p className="text-xs font-medium">Always available</p>
          <ul className="space-y-1">
            {inventory.manual.map(m => (
              <li key={m.key} className="text-[0.6875rem] text-muted-foreground"><span className="font-medium text-foreground">{m.label}.</span> {m.note}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}

/* --------------------------------------------------------------- start */

/** Website and goal: everything setup needs to begin. */
export function SetupStartForm({ businessId, onStarted, autoFocus, website: known }: { businessId?: string; onStarted: (s: SetupView) => void; autoFocus?: boolean; website?: string | null }) {
  const id = useId()
  const [website, setWebsite] = useState(known ?? "")
  const [goal, setGoal] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const url = normalizeWebsite(website)
    if (!url) { setError("Enter a website address, like acme.com"); return }
    setBusy(true); setError(null)
    try {
      const r = await Setup.start({ websiteUrl: url, goalStatement: goal.trim() || null, businessId: businessId ?? null })
      onStarted(r.setup)
    } catch (err) {
      setError(setupError(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <form onSubmit={submit} className="space-y-3 rounded-2xl bg-card p-5 text-left shadow-(--card-shadow)" noValidate>
      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-site`}>Business website</Label>
        <Input id={`${id}-site`} value={website} onChange={e => setWebsite(e.currentTarget.value)} placeholder="acme.com" inputMode="url" autoComplete="url" autoFocus={autoFocus}
          aria-invalid={error ? true : undefined} aria-describedby={error ? `${id}-error` : undefined} />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor={`${id}-goal`}>What should marketing achieve? <span className="font-normal text-muted-foreground">(optional)</span></Label>
        <Input id={`${id}-goal`} value={goal} onChange={e => setGoal(e.currentTarget.value)} placeholder="More booked appointments" maxLength={1000} />
      </div>
      {error ? <p id={`${id}-error`} role="alert" className="text-xs text-wrong">{error}</p> : null}
      <div className="flex items-center justify-between gap-3 pt-1">
        <p className="text-[0.6875rem] text-muted-foreground">OpenRecord reads your public homepage once. Nothing is posted or changed.</p>
        <Button type="submit" disabled={busy}>{busy ? <LoaderCircleIcon className="animate-spin" /> : <ArrowRightIcon />}Set up</Button>
      </div>
    </form>
  )
}
