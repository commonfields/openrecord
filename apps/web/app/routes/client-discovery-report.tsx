// The AI Discovery agency report at /clients/:id/discovery/report. An
// authenticated operator document (print or save as PDF), never a public
// page. It answers one question: how often did the measured AI surface
// mention or recommend this business? Every count shows its denominator,
// recommendation counts come from human-reviewed samples only, each period
// stands alone, and referral evidence sits in its own section.
import { useActiveBusiness } from "@/lib/workspace"
import { Link, useParams } from "react-router"
import { PrinterIcon, TriangleAlertIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { EmptyState, PageHeader } from "@/components/page"
import { useApi } from "@/lib/use-api"
import { errorMessage, formatDate } from "@/lib/format"
import {
  BASIS_LABELS, Discovery, GROUP_LABELS, MENTION_LABELS, RECOMMENDATION_LABELS, fraction, type Fraction, type Report,
} from "@/lib/acquisition"

const range = (from: string | null, to: string | null) => (from ? (formatDate(from) === formatDate(to) ? formatDate(from) : `${formatDate(from)} to ${formatDate(to)}`) : "No answers collected")

function Row({ label, value, note }: { label: string; value: string; note?: string | undefined }) {
  return (
    <tr className="border-b border-border/60 last:border-0">
      <th scope="row" className="py-1.5 pr-4 text-left font-normal text-muted-foreground">{label}</th>
      <td className="py-1.5 pr-4 font-medium tabular-nums">{value}</td>
      <td className="py-1.5 text-muted-foreground">{note ?? ""}</td>
    </tr>
  )
}
const f = (x: Fraction) => fraction(x)

export function DiscoveryReportView({ report }: { report: Report }) {
  const latest = report.periods.at(-1)
  return (
    <article className="mx-auto max-w-4xl space-y-8 text-sm leading-relaxed">
      <header className="space-y-4 rounded-xl bg-card p-5 shadow-(--card-shadow) print:shadow-none">
        <div className="space-y-1"><p className="text-xs font-medium text-muted-foreground">AI discovery · Evidence report</p>
          <h1 className="text-xl font-semibold tracking-tight text-balance">{report.business.name}</h1>
          <p className="text-muted-foreground">{report.question}</p></div>
        <details className="text-xs"><summary className="cursor-pointer font-medium">Study details</summary>
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs">
          <dt className="text-muted-foreground">Business</dt><dd>{report.business.name} ({report.business.websiteUrl})</dd>
          <dt className="text-muted-foreground">Category</dt><dd>{report.category ?? "Not set"}</dd>
          <dt className="text-muted-foreground">Basis</dt><dd>{report.basis ? BASIS_LABELS[report.basis] : "Not set"}</dd>
          <dt className="text-muted-foreground">Question set</dt>
          <dd>{report.questionSet ? `Version ${report.questionSet.version}, ${report.questionSet.questions} frozen questions, frozen ${formatDate(report.questionSet.createdAt)}` : "None"}</dd>
          {report.questionSet ? <><dt className="text-muted-foreground">Set digest</dt><dd className="font-mono text-[0.6875rem] break-all">sha256:{report.questionSet.specDigest}</dd></> : null}
          <dt className="text-muted-foreground">Owned domains</dt><dd>{report.ownedDomains.join(", ") || "None"}</dd>
          <dt className="text-muted-foreground">Named competitors</dt><dd>{report.competitors.join(", ") || "None"}</dd>
        </dl>
        </details>
      </header>

      {latest ? <section aria-label="Latest measurement summary" className="space-y-3">
        <div><h2 className="text-base font-semibold">Latest measurement</h2><p className="text-xs text-muted-foreground">{latest.surface} · {range(latest.collectedFrom, latest.collectedTo)} · {latest.scope === "SMOKE" ? "Small test batch" : "Full batch"}</p></div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[
            { label: "Answers collected", value: f({ n: latest.metrics.succeeded, d: latest.metrics.planned }), note: "of planned samples" },
            { label: "Reviewed", value: f(latest.metrics.reviewed), note: "of successful samples" },
            { label: "Mentioned", value: f(latest.metrics.mentionRate), note: "of clear mention reviews" },
            { label: "Recommended", value: f(latest.metrics.recommendationRate), note: "of reviewed samples" },
          ].map(stat => <div key={stat.label} className="rounded-xl bg-card p-4 shadow-(--card-shadow) print:shadow-none"><p className="text-xs text-muted-foreground">{stat.label}</p><p className="mt-1 text-lg font-semibold tabular-nums">{stat.value}</p><p className="text-xs text-muted-foreground">{stat.note}</p></div>)}
        </div>
        <p className="text-xs text-muted-foreground">Mentions and recommendations reflect the sampled answers and their review status—not all AI responses or a guarantee of future results.</p>
      </section> : <p className="rounded-xl bg-card p-4 text-muted-foreground shadow-(--card-shadow)">No completed measurement batch yet. The report will show results once answers have been collected.</p>}
      {report.periods.map((p, i) => (
        <section key={p.batchId} className="space-y-4 rounded-xl bg-card p-5 shadow-(--card-shadow) print:shadow-none">
          <div>
            <h2 className="text-base font-semibold">Period {i + 1}: {range(p.collectedFrom, p.collectedTo)}</h2>
            <p className="text-xs text-muted-foreground">{p.surface} · {p.scope === "SMOKE" ? "Smoke batch" : "Full batch"} · question set v{p.setVersion} · {p.sampleCount} sample{p.sampleCount === 1 ? "" : "s"} per question</p>
          </div>
          <table className="w-full text-xs">
            <tbody>
              <Row label="Planned samples" value={String(p.metrics.planned)} note={`${p.metrics.providerAttempts} provider attempts`} />
              <Row label="Completed samples" value={fraction({ n: p.metrics.succeeded, d: p.metrics.planned })}
                note={[p.metrics.failed ? `${p.metrics.failed} failed` : "", p.metrics.syntheticExcluded ? `${p.metrics.syntheticExcluded} synthetic excluded` : ""].filter(Boolean).join(" · ")} />
              <Row label="Live web retrieval observed" value={f(p.metrics.groundingObserved)} note="of successful samples" />
              <Row label="Human-reviewed" value={f(p.metrics.reviewed)} note="of successful samples" />
              <Row label="Mentioned (confirmed)" value={f(p.metrics.mentionRate)} note="of clear mention reviews; unreviewed and unclear samples are excluded" />
              <Row label="Recommended (confirmed)" value={f(p.metrics.recommendationRate)} note="of reviewed samples" />
              <Row label="Mentioned, not recommended" value={String(p.metrics.breakdown.mentionedNotRecommended)} />
              <Row label="Advised against" value={String(p.metrics.breakdown.advisedAgainst)} />
              <Row label="Owned domain cited" value={f(p.metrics.ownedCitationRate)} note="of successful samples" />
              <Row label="Questions with a recommendation" value={f(p.metrics.questionsRecommended)} note="of questions with a reviewed sample" />
            </tbody>
          </table>

          {p.metrics.competitors.length ? (
            <div>
              <h3 className="text-xs font-semibold">Competitor appearances</h3>
              <p className="text-xs text-muted-foreground">Exact-name detections in successful samples, not human-reviewed. Not market share.</p>
              <table className="mt-1 w-full text-xs"><tbody>
                {p.metrics.competitors.map(c => <Row key={c.name} label={c.name} value={f(c.samples)} />)}
              </tbody></table>
            </div>
          ) : null}

          <div>
            <h3 className="text-xs font-semibold">Repeatability by question</h3>
            <table className="mt-1 w-full text-xs">
              <thead><tr className="border-b text-left text-muted-foreground"><th className="py-1 pr-3 font-normal">Question</th><th className="py-1 font-normal">Result</th></tr></thead>
              <tbody>
                {p.metrics.questions.map(q => (
                  <tr key={q.key} className="border-b border-border/60 align-top last:border-0">
                    <td className="py-1.5 pr-3"><span className="font-mono text-[0.6875rem] text-muted-foreground">{q.key}</span> {q.prompt}<span className="block text-[0.6875rem] text-muted-foreground">{GROUP_LABELS[q.group]}</span></td>
                    <td className="py-1.5 whitespace-nowrap">{q.statement}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {p.representative.length ? (
            <div className="space-y-3">
              <h3 className="text-xs font-semibold">Representative answers, exactly as recorded</h3>
              {p.representative.map(r => (
                <figure key={r.observationId} className="space-y-1.5">
                  <figcaption className="text-xs">
                    <span className="font-mono text-[0.6875rem] text-muted-foreground">{r.questionKey}</span> “{r.prompt}” · sample {r.sample} · {formatDate(r.collectedAt)} ·{" "}
                    <span className="font-medium">{r.recommendation ? RECOMMENDATION_LABELS[r.recommendation] : MENTION_LABELS[r.mention]}</span>
                  </figcaption>
                  <blockquote className="max-h-96 overflow-auto rounded-lg bg-muted/50 px-4 py-3 text-xs whitespace-pre-wrap print:max-h-none">{r.answerText}</blockquote>
                  <p className="text-[0.6875rem] text-muted-foreground">
                    Evidence: <Link className="underline" to={`/observations/${r.observationId}`}>observation {r.observationId.slice(0, 8)}</Link> · sha256:{r.rawDigest.slice(0, 16)}…
                    {r.ownedCitations.length ? ` · cites ${r.ownedCitations.join(", ")}` : ""}
                  </p>
                </figure>
              ))}
            </div>
          ) : null}
        </section>
      ))}

      <section className="space-y-2 rounded-xl bg-card p-5 shadow-(--card-shadow) print:shadow-none">
        <h2 className="text-base font-semibold">AI referral evidence (GA4)</h2>
        {report.referrals.provided ? report.referrals.imports.map(r => (
          <div key={r.id} className="space-y-1 text-xs">
            <p className="text-muted-foreground">Property {r.propertyRef} · {r.dateStart} to {r.dateEnd} ({r.timeZone}) · session source / medium · export sha256:{r.rawDigest.slice(0, 16)}…</p>
            <table className="w-full"><tbody>
              <Row label="All sessions in export" value={String(r.totalSessions)} />
              <Row label="AI-attributed sessions" value={String(r.aiSessions)} />
              {r.bySource.map(s => <Row key={s.assistant} label={`· ${s.assistant}`} value={String(s.sessions)} note={s.sources.join(", ")} />)}
              <Row label={r.conversionEvent ? `AI-attributed “${r.conversionEvent}” key events` : "Signups"} value={r.signups === "SIGNUPS_NOT_MEASURED" ? "Not measured" : String(r.signups)}
                note={r.signups === "SIGNUPS_NOT_MEASURED" ? "No conversion event is configured in this export" : undefined} />
            </tbody></table>
          </div>
        )) : <p className="text-xs text-muted-foreground">No GA4 export provided. AI referral traffic and signups have not been measured.</p>}
      </section>

      <section className="space-y-2 rounded-xl bg-card p-5 shadow-(--card-shadow) print:shadow-none">
        <h2 className="text-base font-semibold">Limitations</h2>
        <ul className="list-disc space-y-1 pl-5 text-xs">
          {report.limitations.map(l => <li key={l}>{l}</li>)}
        </ul>
        <p className="text-[0.6875rem] text-muted-foreground">Detector {report.detectorVersion} · AI source list {report.aiSourcesVersion}</p>
      </section>
    </article>
  )
}

export function ClientDiscoveryReportPage() {
  const { id = "" } = useParams()
  useActiveBusiness(id)
  const res = useApi(`discovery-report:${id}`, () => Discovery.report(id))
  if (res.loading && !res.data) return <Skeleton className="h-96 rounded-xl" />
  if (!res.data) {
    return <EmptyState icon={<TriangleAlertIcon />} title="Report could not load" description={errorMessage(res.error)}
      action={<Button asChild variant="outline" size="sm"><Link to={`/businesses/${id}/issues`}>AI answers</Link></Button>} />
  }
  return (
    <div className="space-y-6 pb-8">
      <div className="print:hidden">
        <PageHeader back={{ to: `/businesses/${id}/issues`, label: "AI answers" }} title="Evidence report"
          actions={<Button size="sm" variant="outline" onClick={() => window.print()}><PrinterIcon />Print or save PDF</Button>} />
      </div>
      <DiscoveryReportView report={res.data.report} />
    </div>
  )
}
