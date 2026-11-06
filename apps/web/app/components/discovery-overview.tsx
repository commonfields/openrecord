import { Link } from "react-router"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Panel, PanelHeader } from "@/components/page"
import { Discovery, discoveryReportPath, fraction, type Report } from "@/lib/acquisition"
import { useApi } from "@/lib/use-api"

const measured = (value: { n: number; d: number }) => value.d > 0 ? fraction(value) : "not measured"

export function DiscoveryOverview({ businessId }: { businessId: string }) {
  const report = useApi(`discovery-report:${businessId}`, () => Discovery.report(businessId))
  return <Panel>
    <PanelHeader title="AI discovery and referrals" description="What sampled AI answers say, and separately, visits attributed to AI assistants." />
    <div className="space-y-3 px-4 pb-4 text-xs">
      {report.loading && !report.data ? <Skeleton className="h-20 rounded-lg" />
        : report.error && !report.data ? <div className="flex flex-wrap items-center gap-2"><p role="alert" className="min-w-0 flex-1 text-muted-foreground">AI discovery evidence is unavailable. This does not mean there are no results.</p><Button size="sm" variant="outline" onClick={() => void report.reload()}>Try again</Button></div>
        : report.data ? <DiscoverySummary report={report.data.report} businessId={businessId} /> : null}
    </div>
  </Panel>
}

export function DiscoverySummary({ report, businessId }: { report: Report; businessId: string }) {
  const period = report.periods.at(-1)
  const referral = [...report.referrals.imports].sort((left, right) => right.importedAt.localeCompare(left.importedAt))[0]
  const fixtureNotice = report.limitations.find(limitation => /fixture/i.test(limitation))
  return <>
    {fixtureNotice ? <p className="text-muted-foreground">{fixtureNotice}</p> : null}
    {period ? <div className="space-y-1">
      <p className="font-medium">AI answers · {period.surface}</p>
      <p>Reviewed: {measured(period.metrics.reviewed)} successful samples. Confirmed mentions: {measured(period.metrics.mentionRate)} clear mention reviews. Owned-site citations: {measured(period.metrics.ownedCitationRate)} successful samples.</p>
      <p className="text-muted-foreground">{period.scope === "SMOKE" ? "Small test batch" : "Full batch"} · {period.collectedFrom?.slice(0, 10) ?? "date unavailable"} to {period.collectedTo?.slice(0, 10) ?? "date unavailable"} · {period.metrics.failed} failed samples. Citations are reported by the provider, not verified support.</p>
    </div> : <p>AI answer discovery: not measured yet.</p>}
    {referral ? <div className="space-y-1">
      <p className="font-medium">AI-attributed website sessions · GA4 export</p>
      <p>{referral.aiSessions.toLocaleString()} of {referral.totalSessions.toLocaleString()} sessions · {referral.dateStart} to {referral.dateEnd}. {referral.signups === "SIGNUPS_NOT_MEASURED" ? "Signups not measured." : `${referral.signups.toLocaleString()} signups reported.`}</p>
      <p className="text-muted-foreground">This is a separate data source; it does not show that a sampled AI answer caused a visit or signup.</p>
    </div> : <p>AI-attributed website sessions and signups: not measured.</p>}
    <div className="flex flex-wrap gap-2"><Button asChild size="sm" variant="outline"><Link to={discoveryReportPath(businessId)}>View evidence report</Link></Button></div>
  </>
}
