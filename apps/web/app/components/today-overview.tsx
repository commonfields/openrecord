import { useMemo, type ReactNode } from "react"
import { Link, useNavigate } from "react-router"
import { ArrowRightIcon, PlusIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { AreaTrendChart } from "@/components/charts"
import { Panel, PanelHeader, StatStrip, domainOf, pathOf, type Stat } from "@/components/page"
import { RepresentationStateBadge } from "@/components/status"
import { findingKindLabels } from "@/routes/search"
import { ApiError, Facts, Issues, Representations, Search, api, type Analytics, type RepresentationRow, type VerdictCounts } from "@/lib/api"
import { Growth } from "@/lib/growth"
import { askAgentPath } from "@/lib/nav"
import { groupClaims } from "@/lib/issues"
import { relativeTime, sentenceCase } from "@/lib/format"
import { useApi } from "@/lib/use-api"
import { cn } from "@/lib/utils"
import type { GrowthOpportunity, GrowthProfile, GrowthSeries } from "@openrecord/contracts"

/** Every answer a person reviewed, including those they could not judge (unknown). */
export const reviewed = (c: VerdictCounts) => c.supported + c.wrong + c.partial + c.unknown
/** Answers a person could judge against approved facts: unknown is not false, so it is not in the denominator. */
export const judged = (c: VerdictCounts) => c.supported + c.wrong + c.partial
/** Share of judged answers that were supported; null when nothing could be judged. */
export const accuracy = (c: VerdictCounts) => (judged(c) ? c.supported / judged(c) : null)
/** The counts behind an accuracy figure, unknown kept apart from wrong. */
export const verdictHint = (c: VerdictCounts) =>
  reviewed(c) ? [`${judged(c).toLocaleString()} judged`, c.wrong ? `${c.wrong.toLocaleString()} wrong` : null, c.partial ? `${c.partial.toLocaleString()} partly right` : null, c.unknown ? `${c.unknown.toLocaleString()} unknown` : null].filter(Boolean).join(" · ") : "No reviewed answers yet"
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`
export const pct = (n: number | null, digits = 0) => (n === null ? "—" : `${(n * 100).toFixed(digits)}%`)

export function Delta({ now, prev, goodWhenUp }: { now: number; prev: number; goodWhenUp?: boolean }) {
  if (!prev) return now ? <span className="text-muted-foreground">New</span> : null
  const change = (now - prev) / prev
  if (Math.abs(change) < 0.005) return <span className="text-muted-foreground">0%</span>
  const good = change > 0 === goodWhenUp
  return (
    <span className={goodWhenUp === undefined ? "text-muted-foreground" : good ? "text-supported" : "text-wrong"} title="Change vs previous period">
      {change > 0 ? "+" : ""}
      {(change * 100).toFixed(Math.abs(change) < 0.1 ? 1 : 0)}%
    </span>
  )
}

export function PointsDelta({ pts }: { pts: number }) {
  if (pts === 0) return <span className="text-muted-foreground">0 pts</span>
  return (
    <span className={pts > 0 ? "text-supported" : "text-wrong"} title="Change vs previous period, in percentage points">
      {pts > 0 ? "+" : ""}
      {pts} pts
    </span>
  )
}

/* ------------------------------------------------------------ data */

const NO_OPPORTUNITIES: ReadonlyArray<GrowthOpportunity> = []

// UTC calendar day, n days before today.
const isoDay = (offset: number) => new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10)

/** Every read the overview combines. Each one fails on its own, so a missing
 * surface (no site, no goal) never blanks the rest of the page. */
export function useOverviewData(businessId: string, days: number) {
  const issues = useApi(`issues:${businessId}`, () => Issues.list(businessId))
  const reps = useApi(`representations:${businessId}`, () => Representations.list(businessId))
  const facts = useApi(`facts:${businessId}`, () => Facts.list(businessId))
  const search = useApi(`search-overview:${businessId}`, () => Search.overview(businessId))
  const growth = useApi(`growth:${businessId}`, () => Growth.profile(businessId))
  const opportunities = useApi(`growth-opps:${businessId}`, () => Growth.list(businessId))
  const profile: GrowthProfile | null = growth.data?.profile ?? null
  const definitionId = profile?.primaryGoal.metricDefinition.id ?? null
  // The current period plus the one before it, ending yesterday: today's
  // count is still filling in.
  const range = { start: isoDay(days * 2), end: isoDay(1) }
  const series = useApi(definitionId ? `growth-series:${businessId}:${definitionId}:${range.start}:${range.end}` : null, () =>
    api<{ series: GrowthSeries }>(
      `/api/growth/clients/${encodeURIComponent(businessId)}/metrics/${encodeURIComponent(definitionId ?? "")}/series?start=${range.start}&end=${range.end}`,
    ),
  )
  return {
    issues: issues.data?.issues ?? null,
    representations: reps.data?.representations ?? null,
    activeFacts: facts.data ? facts.data.facts.filter((f) => f.status === "ACTIVE").length : null,
    search: search.data?.overview ?? null,
    profile,
    opportunities: opportunities.data?.opportunities ?? NO_OPPORTUNITIES,
    series: series.data?.series ?? null,
    errors: { growth: growth.error, series: series.error, opportunities: opportunities.error },
    loading: {
      issues: issues.loading && !issues.data,
      representations: reps.loading && !reps.data,
      search: search.loading && !search.data,
      growth: (growth.loading && !growth.data) || (!!definitionId && series.loading && !series.data),
    },
  }
}
export type OverviewData = ReturnType<typeof useOverviewData>

/** Sums the goal metric over the last `days` days and the period before. */
export function goalTotals(series: GrowthSeries | null, days: number) {
  if (!series) return null
  const ok = series.days.filter((d) => d.status === "OK" || d.status === "CONFLICT")
  const sorted = [...series.days].sort((a, b) => a.day.localeCompare(b.day))
  const split = sorted.length - days
  const sum = (from: number, to: number) => sorted.slice(Math.max(0, from), to).reduce((n, d) => n + (d.value ?? 0), 0)
  return {
    current: sum(split, sorted.length),
    previous: split > 0 ? sum(split - days, split) : 0,
    reported: sorted.slice(Math.max(0, split)).filter((d) => d.status === "OK" || d.status === "CONFLICT").length,
    any: ok.length > 0,
    fromGa4: series.days.some((d) => d.provider === "GA4_DATA_API"),
    synthetic: series.days.some((d) => d.origin === "SYNTHETIC"),
  }
}

/* ---------------------------------------------------------- health */

/** Three answers to "are we OK?", one per surface; each opens where to act. The goal has its own card above. */
export function HealthStrip({ businessId, a, data, loading }: { businessId: string; a: Analytics | null; data: OverviewData; loading: boolean }) {
  const navigate = useNavigate()
  const skeleton = <Skeleton className="h-5 w-14" />
  const acc = a ? accuracy(a.current) : null
  const prevAcc = a ? accuracy(a.previous) : null
  const reps = data.representations ?? []
  const inSync = reps.filter((r) => r.finding.state === "IN_SYNC").length
  const drift = reps.filter((r) => r.finding.state === "DRIFT").length
  const unreadable = reps.length - inSync - drift
  const s = data.search

  const stats: Stat[] = [
    {
      key: "accuracy",
      label: "AI answers correct",
      value: loading || !a ? skeleton : pct(acc),
      delta: acc !== null && prevAcc !== null ? <PointsDelta pts={Math.round((acc - prevAcc) * 100)} /> : null,
      hint: a ? verdictHint(a.current) : null,
      ...(a && a.current.wrong > 0 ? { tone: "wrong" as const } : {}),
      onSelect: () => navigate(`/businesses/${businessId}/issues`),
    },
    {
      key: "sources",
      label: "Sources in sync",
      value: data.loading.representations ? skeleton : reps.length ? `${inSync} of ${reps.length}` : "—",
      hint: reps.length ? [drift && `${drift} out of date`, unreadable && `${unreadable} unreadable`].filter(Boolean).join(", ") || "All match your facts" : "No sources tracked yet",
      ...(drift > 0 ? { tone: "wrong" as const } : unreadable > 0 ? { tone: "unknown" as const } : {}),
      onSelect: () => navigate(`/businesses/${businessId}/representations`),
    },
    {
      key: "website",
      label: "Website issues",
      value: data.loading.search ? skeleton : s?.lastInspection ? s.openFindings.toLocaleString() : "—",
      hint: s?.lastInspection ? `${plural(s.urlsInspected, "page")} inspected, ${plural(s.verifiedFixes, "fix", "fixes")} verified` : "Website not inspected yet",
      ...(s && s.openFindings > 0 ? { tone: "partial" as const } : {}),
      onSelect: () => navigate(`/businesses/${businessId}/search`),
    },
  ]
  return <StatStrip stats={stats} />
}

/* --------------------------------------------------------- do next */

type Action = { key: string; tone: "wrong" | "partial" | "unknown" | "review" | "brand"; title: ReactNode; detail: ReactNode; cta: string; to: string; rank: number; setup?: true }

/** What is still unset; each gap becomes a setup step instead of a silent empty card. */
export type SetupState = { activeFacts: number | null; checks: number | null; hasGoal: boolean; goalLoading: boolean }

const severityRank: Record<string, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 }

export function buildActions(businessId: string, data: Pick<OverviewData, "issues" | "representations" | "search" | "opportunities">, setup?: SetupState): Action[] {
  const base = `/businesses/${businessId}`
  const out: Action[] = []

  // A new business has nothing to fix yet: walk it through the loop instead
  // of reporting "all caught up".
  if (setup?.activeFacts === 0)
    out.push({ key: "setup:facts", tone: "brand", setup: true, title: "Approve the facts AI should get right", detail: "Your agent drafts prices, policies and contact details from your site for you to approve", cta: "Ask the agent", to: askAgentPath(businessId, "Draft the facts AI assistants should get right about us, from our website, for me to approve."), rank: 5 })
  if (setup?.checks === 0 && !(data.issues ?? []).length)
    out.push({ key: "setup:check", tone: "brand", setup: true, title: "See what AI says about you today", detail: "Your agent asks AI assistants the questions buyers ask", cta: "Ask the agent", to: askAgentPath(businessId, "Check what AI assistants say about us when buyers ask about what we sell."), rank: 6 })
  if (data.representations && data.representations.length === 0)
    out.push({ key: "setup:sources", tone: "brand", setup: true, title: "Watch the pages that publish your facts", detail: "Get flagged when a pricing page or listing drifts from what you approved", cta: "Ask the agent", to: askAgentPath(businessId, "Find the pages and listings that publish our facts and watch them for changes."), rank: 70 })
  if (data.search && !data.search.lastInspection)
    out.push({ key: "setup:website", tone: "brand", setup: true, title: "Inspect your website", detail: "Find pages AI and search engines cannot read or index", cta: "Ask the agent", to: askAgentPath(businessId, "Inspect our website for pages AI assistants and search engines cannot read or index."), rank: 75 })
  if (setup && !setup.hasGoal && !setup.goalLoading)
    out.push({ key: "setup:goal", tone: "brand", setup: true, title: "Agree a business goal", detail: "Tell your agent what marketing should achieve, and it picks the number to count", cta: "Ask the agent", to: askAgentPath(businessId, "Help me set our marketing goal and what we should count as success."), rank: 80 })

  for (const r of data.representations ?? []) {
    const fact = sentenceCase(r.fact.predicate)
    if (r.finding.state === "DRIFT")
      out.push({
        key: `rep:${r.binding_id}`,
        tone: "wrong",
        title: `${fact} is out of date on ${domainOf(r.source.url)}`,
        detail: `The page shows “${r.effective_observation?.extracted_value ?? "nothing"}”, your approved fact is “${r.fact.valueText}”`,
        cta: "Review",
        to: `${base}/representations/${r.binding_id}`,
        rank: 10,
      })
    else if (r.finding.state !== "IN_SYNC")
      out.push({
        key: `rep:${r.binding_id}`,
        tone: "unknown",
        title: `Can't read ${fact.toLowerCase()} on ${domainOf(r.source.url)}`,
        detail: r.latest_attempt?.failure ?? sentenceCase(r.finding.reason),
        cta: "Check source",
        to: `${base}/representations/${r.binding_id}`,
        rank: 50,
      })
  }

  for (const g of groupClaims(data.issues ?? [], "frequent")) {
    const seen = g.occurrences.length > 1 ? ` · seen ${g.occurrences.length}×` : ""
    const target = g.occurrences.find((o) => o.state !== "NEEDS_REVIEW") ?? g.latest
    const issuePath = `${base}/issues/${target.claim_id}`
    if (g.state === "WRONG")
      out.push({ key: `claim:${g.key}`, tone: "wrong", title: `AI says “${g.text}”`, detail: `This contradicts your approved facts${seen}`, cta: "Fix", to: issuePath, rank: 20 })
    else if (g.state === "PARTIAL")
      out.push({ key: `claim:${g.key}`, tone: "partial", title: `AI is partly right: “${g.text}”`, detail: `Part of the answer is missing or off${seen}`, cta: "Fix", to: issuePath, rank: 35 })
    else if (g.state === "UNKNOWN")
      out.push({
        key: `claim:${g.key}`,
        tone: "unknown",
        title: g.questions[0] ? `AI can't answer “${g.questions[0]}”` : `AI lacks information: “${g.text}”`,
        detail: `Publish the answer where AI looks${seen}`,
        cta: "Open",
        to: issuePath,
        rank: 60,
      })
    else
      out.push({
        key: `claim:${g.key}`,
        tone: "review",
        title: `Review: “${g.text}”`,
        detail: "Check whether this answer matches your facts",
        cta: "Review",
        to: `/observations/${g.latest.observation_id}?claim=${g.latest.claim_id}`,
        rank: 30,
      })
  }

  const s = data.search
  if (s) {
    if (s.awaitingApproval > 0)
      out.push({ key: "fix:approve", tone: "brand", title: `${s.awaitingApproval} website ${s.awaitingApproval === 1 ? "fix is" : "fixes are"} ready for your approval`, detail: "Nothing changes on the site until you approve", cta: "Approve", to: `${base}/search`, rank: 25 })
    if (s.verificationPending > 0)
      out.push({ key: "fix:verify", tone: "brand", title: `${s.verificationPending} applied ${s.verificationPending === 1 ? "fix needs" : "fixes need"} verifying`, detail: "Re-inspect the live page to confirm the change", cta: "Verify", to: `${base}/search`, rank: 45 })
    for (const f of [...s.needsAttention].sort((x, y) => (severityRank[x.severity] ?? 9) - (severityRank[y.severity] ?? 9)))
      out.push({
        key: `finding:${f.id}`,
        tone: f.severity === "HIGH" || f.severity === "CRITICAL" ? "wrong" : "partial",
        title: `${findingKindLabels[f.findingKind] ?? sentenceCase(f.findingKind)} on ${pathOf(f.url) || domainOf(f.url)}`,
        detail: f.recommendedAction || f.diagnosis,
        cta: "Open",
        to: `${base}/search/sites/${f.siteTargetId}/findings/${f.id}`,
        rank: 40 + (severityRank[f.severity] ?? 3) * 10,
      })
  }

  for (const o of data.opportunities) {
    if (o.status === "PROPOSED")
      out.push({ key: `opp:${o.id}`, tone: "brand", title: `Review the initiative “${o.title}”`, detail: "Proposed and waiting for your decision", cta: "Review", to: "/approvals", rank: 55 })
    else if (o.status === "APPROVED" && o.progress === "NOT_STARTED")
      out.push({ key: `opp:${o.id}`, tone: "brand", title: `Start “${o.title}”`, detail: "Approved, not started yet", cta: "Ask the agent", to: askAgentPath(businessId, `Let's start the approved initiative “${o.title}”. What do you need from me?`), rank: 65 })
  }

  return out.sort((x, y) => x.rank - y.rank)
}

/* --------------------------------------------------------- sources */

const repOrder: Record<string, number> = { DRIFT: 0, UNKNOWN: 1, IN_SYNC: 2 }

/** The representation record: each approved fact next to what a public page
 * actually says, so drift reads at a glance instead of behind a tab. */
export function SourcesPanel({ businessId, data }: { businessId: string; data: OverviewData }) {
  const reps = useMemo(() => [...(data.representations ?? [])].sort((x, y) => (repOrder[x.finding.state] ?? 1) - (repOrder[y.finding.state] ?? 1)), [data.representations])
  const inSync = reps.filter((r) => r.finding.state === "IN_SYNC").length
  const pages = new Set(reps.map((r) => r.source.url)).size
  return (
    <Panel>
      <PanelHeader
        title="Where your facts are published"
        description={reps.length ? `${inSync} of ${reps.length} match your approved facts, across ${pages} ${pages === 1 ? "page" : "pages"}` : "Pages that state your facts, like pricing pages and directory listings"}
      >
        <Button asChild variant="ghost" size="sm" className="h-7 text-xs">
          <Link to={`/businesses/${businessId}/representations`}>
            {reps.length ? "View all" : "Track a page"}
            <ArrowRightIcon />
          </Link>
        </Button>
      </PanelHeader>
      {data.loading.representations ? (
        <div className="space-y-2 p-4 pt-1">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="h-8" />
          ))}
        </div>
      ) : reps.length === 0 ? (
        <div className="flex items-center gap-3 px-4 pt-1 pb-4 text-xs text-muted-foreground">
          <span className="flex-1">Track the pages that publish your facts and OpenRecord flags them when they drift from what you approved.</span>
          <Button asChild size="sm" variant="outline" className="h-7 text-xs">
            <Link to={`/businesses/${businessId}/representations`}>
              <PlusIcon />
              Track a page
            </Link>
          </Button>
        </div>
      ) : (
        <div className="overflow-x-auto px-2 pb-2">
          <div className="min-w-[44rem]">
            <div className="grid grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.1fr)_6.5rem_5.5rem] gap-3 px-2 pb-1.5 text-[0.6875rem] text-muted-foreground">
              <span>Fact</span>
              <span>Approved</span>
              <span>Page says</span>
              <span>Page</span>
              <span>Status</span>
              <span className="text-right">Checked</span>
            </div>
            {reps.slice(0, 6).map((r) => (
              <SourceRow key={r.binding_id} businessId={businessId} r={r} />
            ))}
            {reps.length > 6 ? (
              <Link to={`/businesses/${businessId}/representations`} className="block px-2 pt-2 text-xs font-medium text-muted-foreground hover:text-foreground">
                {reps.length - 6} more
              </Link>
            ) : null}
          </div>
        </div>
      )}
    </Panel>
  )
}

function SourceRow({ businessId, r }: { businessId: string; r: RepresentationRow }) {
  const found = r.effective_observation?.extracted_value ?? null
  const checked = r.latest_attempt?.completed_at ?? r.latest_successful_check?.completed_at ?? null
  return (
    <Link
      to={`/businesses/${businessId}/representations/${r.binding_id}`}
      className="grid grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.1fr)_6.5rem_5.5rem] items-center gap-3 rounded-md px-2 py-2 text-xs transition-colors hover:bg-foreground/[0.03]"
    >
      <span className="truncate font-medium">{sentenceCase(r.fact.predicate)}</span>
      <span className="truncate">{r.fact.valueText}</span>
      <span className={cn("truncate", r.finding.state === "DRIFT" ? "font-medium text-wrong" : found === null && "text-muted-foreground")}>{found ?? "Not found"}</span>
      <span className="truncate text-muted-foreground" title={r.source.url}>
        {domainOf(r.source.url)}
        {pathOf(r.source.url) !== "/" ? pathOf(r.source.url) : ""}
      </span>
      <span>
        <RepresentationStateBadge state={r.finding.state} />
      </span>
      <span className="text-right text-muted-foreground tabular-nums">{checked ? relativeTime(checked) : "Never"}</span>
    </Link>
  )
}

/* ------------------------------------------------------------ goal */

export function GoalTrend({ data, days, formatDate }: { data: OverviewData; days: number; formatDate: (d: string) => string }) {
  const series = data.series
  const rows = useMemo(() => {
    if (!series) return []
    return [...series.days]
      .sort((a, b) => a.day.localeCompare(b.day))
      .slice(-days)
      .map((d) => ({ date: d.day, value: d.status === "OK" || d.status === "CONFLICT" ? (d.value ?? 0) : "" }))
  }, [series, days])
  if (data.loading.growth) return <Skeleton className="h-[280px] rounded-xl" />
  if (!series && data.errors.series) return <p role="alert" className="rounded-xl border p-5 text-sm text-destructive">Measurement history could not load. Reload the page to try again.</p>
  if (!series || rows.every((r) => r.value === "")) {
    return (
      <div className="flex h-[280px] flex-col items-center justify-center rounded-xl border border-dashed text-center">
        <p className="text-xs font-medium">No measurements in the last {days} days</p>
        <p className="mt-1 max-w-xs text-xs text-muted-foreground">Connect a measurement account from Channels, or import daily results in the business's growth settings.</p>
      </div>
    )
  }
  const label = series.metricLabel
  return (
    <div className="space-y-2">
      <AreaTrendChart data={rows} dataKey="value" label={label} height={280} formatDate={formatDate} formatValue={(v) => Math.round(v).toLocaleString()} />
      <div className="flex items-center gap-4 text-[0.6875rem] text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span aria-hidden className="size-2 rounded-full bg-chart-primary" />
          {label} per day
        </span>
        {series.days.some((d) => d.status === "MISSING") ? <span>Gaps are days without an import</span> : null}
      </div>
    </div>
  )
}

/** True when the record read failed only because this business has no client record. */
export const isMissing = (e: unknown) => e instanceof ApiError && e.status === 404
