// W5 client report: one printable page a client can read without the
// workspace. Plain language first; identifiers, digests and technical detail
// only in the closing evidence section. It describes what was recorded and
// never presents a difference as proof that the work caused it.
import type { GrowthEvaluationWindow, PublicGrowthReport } from "@openrecord/contracts"
import { GROWTH_CHANNEL_LABELS, GROWTH_EXECUTION_LABELS, GROWTH_GOAL_LABELS } from "@/lib/growth"
import { REPORT_ASSURANCE_COPY, REPORT_CAVEAT_COPY, REPORT_DECISION_COPY, REPORT_LIMITATIONS, REPORT_REASON_COPY } from "@/lib/growth-report"
import { safeRecordUrl } from "@/lib/record"

const day = (d: string) => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(`${d}T00:00:00Z`))
const instant = (iso: string) => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC", timeZoneName: "short" }).format(new Date(iso))
const number = (n: number) => n.toLocaleString("en-GB")
const signed = (n: number) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${number(Math.abs(n))}`

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="space-y-2 break-inside-avoid"><h2 className="text-base font-semibold">{title}</h2>{children}</section>
}
function Reference({ value }: { value: string }) {
  const url = safeRecordUrl(value)
  // A report URL is a capability: never send it to referenced sites.
  return url ? <a className="break-all underline underline-offset-2" href={url} target="_blank" rel="noreferrer noopener">{value}</a> : <span className="break-all">{value}</span>
}
function PeriodRow({ label, w, unit }: { label: string; w: GrowthEvaluationWindow; unit: string }) {
  return <tr className="border-t align-top">
    <th scope="row" className="py-2 pr-4 text-left font-medium">{label}<br /><span className="font-normal text-muted-foreground">{day(w.start)} – {day(w.end)}</span></th>
    <td className="py-2 pr-4">{w.validDays} of {w.days}</td>
    <td className="py-2 pr-4">{number(w.validTotal)} {unit}</td>
    <td className="py-2">{w.dailyMean ? number(w.dailyMean.value) : "Not available"}</td>
  </tr>
}

export function GrowthReportView({ report: r }: { report: PublicGrowthReport }) {
  const unit = r.metric.label.toLowerCase()
  const goalKind = GROWTH_GOAL_LABELS[r.metric.conversionKind as keyof typeof GROWTH_GOAL_LABELS]?.toLowerCase() ?? "results"
  const own = r.actions.filter(a => a.association === "THIS_INITIATIVE")
  const others = r.actions.filter(a => a.association !== "THIS_INITIATIVE")
  const period = r.plan ? `${day(r.plan.baselineStart)} – ${day(r.plan.observationEnd)}` : "No measurement period was agreed"
  const gaps = [r.baseline, r.observation].filter((w): w is GrowthEvaluationWindow => w !== null)
  return <article className="mx-auto max-w-3xl space-y-7 px-5 py-8 text-sm leading-relaxed" aria-label="Marketing outcome report">
    <header className="space-y-1 border-b pb-4">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">Marketing outcome report</p>
      <h1 className="text-xl font-semibold">{r.business.name}</h1>
      <p className="text-muted-foreground">{r.business.websiteUrl}</p>
      <p>Reporting period: {period}</p>
      <p className="text-muted-foreground">{r.version === null || r.publishedAt === null ? "Draft preview, not yet published." : `Version ${r.version}, published ${instant(r.publishedAt)}.`} Figures as recorded on {instant(r.generatedAt)}; later data does not change this version.</p>
      {r.superseded ? <p role="note" className="rounded-md border border-amber-500 px-3 py-2 font-medium">A newer version of this report has been published. This version is kept unchanged for the record.</p> : null}
    </header>

    <Section title="What we set out to improve">
      <p>{r.goal.statement}.</p>
      <p className="text-muted-foreground">Measured as {r.metric.label}{r.metric.label.toLowerCase().includes(goalKind) ? "" : ` (${goalKind})`} from {r.metric.sourceIdentity}, counted per calendar day in {r.metric.timeZone}.</p>
    </Section>

    <Section title="The approved work">
      <p className="font-medium">{r.initiative.title}</p>
      <p>{r.initiative.problemStatement}</p>
      <p><span className="text-muted-foreground">Planned change: </span>{r.initiative.proposedChange}</p>
      {r.initiative.approvedAt ? <p className="text-muted-foreground">Approved by a person on {instant(r.initiative.approvedAt)}.</p> : null}
    </Section>

    <Section title="What was done">
      {own.length === 0 ? <p>No completed work is recorded for this initiative.</p> : <ul className="space-y-2">{own.map(a => <li key={a.id}>
        <p><span className="font-medium">{GROWTH_EXECUTION_LABELS[a.type]}</span>{a.channel ? ` · ${GROWTH_CHANNEL_LABELS[a.channel as keyof typeof GROWTH_CHANNEL_LABELS] ?? "Other channel"}` : ""} · <Reference value={a.reference} /></p>
        <p className="text-muted-foreground">Done {day(a.performedDay)} · {REPORT_ASSURANCE_COPY[a.assurance]}{a.verification ? ` (${a.verification.claim.toLowerCase().replaceAll("_", " ")})` : ""}</p>
      </li>)}</ul>}
      {others.length ? <div className="pt-2"><p className="font-medium">Other marketing activity in the same period</p>
        <ul className="mt-1 space-y-1">{others.map(a => <li key={a.id}>{GROWTH_EXECUTION_LABELS[a.type]}{a.channel ? ` · ${GROWTH_CHANNEL_LABELS[a.channel as keyof typeof GROWTH_CHANNEL_LABELS] ?? "Other channel"}` : ""} on {day(a.performedDay)} — {a.initiativeTitle ? `part of “${a.initiativeTitle}”` : "not part of a planned initiative"}; {REPORT_ASSURANCE_COPY[a.assurance].toLowerCase()}.</li>)}</ul></div> : null}
    </Section>

    <Section title="What we measured">
      <p className={r.status === "COMPARABLE" ? "font-medium" : "font-medium text-amber-700 dark:text-amber-400"}>
        {r.status === "COMPARABLE" ? "Data quality: the before and after figures can be compared." : "Data quality: the before and after figures cannot be reliably compared."}
      </p>
      {r.reasons.length ? <ul className="list-disc space-y-1 pl-5">{r.reasons.map(x => <li key={x.code}>{REPORT_REASON_COPY[x.code]}</li>)}</ul> : null}
      {r.plan ? <p className="text-muted-foreground">The before and after periods were {r.plan.timing === "PRE_DECLARED" ? "agreed before the work was done" : "chosen after the work was done"}.</p> : null}
      {gaps.length ? <table className="w-full text-left text-sm">
        <thead><tr className="text-muted-foreground"><th className="py-1 pr-4 font-normal">Period</th><th className="py-1 pr-4 font-normal">Days with a usable figure</th><th className="py-1 pr-4 font-normal">Recorded total</th><th className="py-1 font-normal">Daily average</th></tr></thead>
        <tbody>{r.baseline ? <PeriodRow label="Before" w={r.baseline} unit={unit} /> : null}{r.observation ? <PeriodRow label="After" w={r.observation} unit={unit} /> : null}</tbody>
      </table> : null}
      {r.comparison && r.baseline?.dailyMean && r.observation?.dailyMean ? <p className="rounded-md border px-3 py-2">
        The daily average of {unit} went from {number(r.baseline.dailyMean.value)} before to {number(r.observation.dailyMean.value)} after ({signed(r.comparison.dailyMeanDifference)} per day{r.comparison.dailyMeanPercentChange === null ? "" : `, ${signed(r.comparison.dailyMeanPercentChange)}%`}).
        {r.comparison.totalDifference === null ? " The periods differ in length, so totals are not compared." : ` Over the whole period that is ${signed(r.comparison.totalDifference)} ${unit}.`}
        {" "}This describes what was recorded. It does not show that the work caused the change.
      </p> : <p>No before and after comparison is given in this report.</p>}
    </Section>

    <Section title="What limits this result">
      <ul className="list-disc space-y-1 pl-5">
        {r.caveats.map(c => <li key={c.code}>{REPORT_CAVEAT_COPY[c.code]}</li>)}
        {REPORT_LIMITATIONS.map(text => <li key={text}>{text}</li>)}
      </ul>
    </Section>

    <Section title="Decision and next steps">
      {r.review ? <><p><span className="font-medium">{REPORT_DECISION_COPY[r.review.conclusion]}</span> — decided by a person on {instant(r.review.decidedAt)}.</p><p className="whitespace-pre-wrap">{r.review.reason}</p></>
        : <p>No decision has been recorded yet. Whether to keep, undo or extend this work is still open.</p>}
      {r.nextSteps ? <p className="whitespace-pre-wrap"><span className="text-muted-foreground">Next steps: </span>{r.nextSteps}</p> : null}
    </Section>

    <section className="space-y-2 border-t pt-4 text-xs text-muted-foreground" aria-label="Evidence and provenance">
      <h2 className="text-sm font-semibold text-foreground">Evidence and provenance</h2>
      <p>Source: {r.metric.sourceKind === "GA4_AGGREGATE_EXPORT" ? `GA4 aggregate export${r.metric.eventName ? ` (event ${r.metric.eventName})` : ""}` : "operator-supplied daily export"}; {r.metric.countingSemantics}/{r.metric.unit}; metric version {r.metric.version}; goal version {r.goal.version}; time zone {r.metric.timeZone}.</p>
      {r.plan ? <p>Plan declared {instant(r.plan.declaredAt)}: before {r.plan.baselineStart} to {r.plan.baselineEnd}, after {r.plan.observationStart} to {r.plan.observationEnd} ({r.plan.timing.toLowerCase().replaceAll("_", " ")}).</p> : null}
      {gaps.flatMap(w => ([["missing", w.missingDays], ["not covered", w.unavailableDays], ["conflicting", w.conflictingDays], ["sample data", w.syntheticDays]] as const)
        .filter(([, list]) => list.length).map(([name, list]) => <p key={`${w.role}-${name}`}>{w.role === "BASELINE" ? "Before" : "After"}, {name}: {list.join(", ")}</p>))}
      <p>Data imports ({r.evidence.sources.length}):</p>
      <ul className="space-y-0.5 break-all font-mono">{r.evidence.sources.map(s => <li key={s.id}>{s.id} · {s.dateStart}→{s.dateEnd} · {s.rowCount} days · {s.provenance === "SYNTHETIC_FIXTURE" ? "sample data" : "operator-supplied"} · sha256 {s.rawDigest}</li>)}</ul>
      <p>Recorded actions: <span className="break-all font-mono">{r.evidence.actionIds.join(", ") || "none"}</span></p>
      {[...r.reasons, ...r.caveats].length ? <ul className="space-y-0.5">{[...r.reasons, ...r.caveats].map(x => <li key={x.code}><span className="font-mono">{x.code}</span>: {x.detail}</li>)}</ul> : null}
      <p className="break-all">Report {r.evidence.reportId ?? "(draft)"} · initiative {r.evidence.initiativeId} · goal {r.evidence.goalId} · metric {r.evidence.metricDefinitionId} · plan {r.evidence.planId ?? "none"}</p>
      {r.evidence.snapshotDigest ? <p className="break-all">Snapshot sha256 {r.evidence.snapshotDigest}</p> : null}
      <p>Evaluator assumptions and limitations, verbatim:</p>
      <ul className="space-y-0.5">{[...r.assumptions, ...r.limitations].map(text => <li key={text}>{text}</li>)}</ul>
    </section>
  </article>
}
