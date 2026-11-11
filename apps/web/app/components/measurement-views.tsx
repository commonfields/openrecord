import { Link } from "react-router"
import { Button } from "@/components/ui/button"
import { Panel, PanelHeader } from "@/components/page"
import { GoalTrend, SourcesPanel, type OverviewData } from "@/components/today-overview"

export function FunnelMeasurement({ businessId, data }: { businessId: string; data: OverviewData }) {
  const metric = data.profile?.primaryGoal.metricDefinition
  return <div className="space-y-5">
    <Panel className="space-y-3 p-5">
      <h2 className="text-base font-medium">Build a funnel you can trust</h2>
      <p className="max-w-prose text-sm text-muted-foreground">A funnel follows the same people through defined steps. OpenRecord currently reads separate source totals, so a connected conversion funnel and drop-off rates are not available yet.</p>
      <p className="max-w-prose text-sm text-muted-foreground">Search clicks, ad conversions and paying customers can overlap or cover different dates. They are not added together or treated as consecutive funnel steps.</p>
    </Panel>
    <Panel>
      <PanelHeader title="Measurement coverage" description="Where to find each part of the journey. These are separate reports, not a measured funnel." />
      <dl className="divide-y px-4">
        {[
          { title: "Discovery", detail: "Search, ads and what AI assistants say.", section: "performance", label: "View performance" },
          { title: "Goal action", detail: metric ? `${metric.label}. ${metric.eventName ? `Configured event: ${metric.eventName}.` : "No event name saved."}` : "No goal event has been defined yet.", section: "events", label: "View events" },
          { title: "Revenue", detail: "Paid orders, refunds and customers from Stripe, kept separate by currency.", section: "revenue", label: "View revenue" },
        ].map(row => <div key={row.title} className="flex flex-wrap items-center justify-between gap-3 py-4"><div className="min-w-0 flex-1"><dt className="text-sm font-medium">{row.title}</dt><dd className="mt-1 text-xs text-muted-foreground">{row.detail}</dd></div><Link className="text-sm underline underline-offset-4" to={`/businesses/${businessId}/results/${row.section}`}>{row.label}</Link></div>)}
      </dl>
    </Panel>
    <SourcesPanel businessId={businessId} data={data} />
  </div>
}

export function GoalEvents({ businessId, data, days, formatDate }: { businessId: string; data: OverviewData; days: number; formatDate: (date: string) => string }) {
  const metric = data.profile?.primaryGoal.metricDefinition
  if (!metric && data.errors.growth) return <p role="alert" className="rounded-xl border p-5 text-sm text-destructive">Your saved goal could not load. Reload the page to try again.</p>
  return <div className="space-y-5">
    <Panel className="space-y-3 p-5">
      <h2 className="text-base font-medium">{metric?.label ?? "No goal event configured"}</h2>
      <dl className="grid gap-4 text-sm sm:grid-cols-3">
        <div><dt className="text-xs text-muted-foreground">Event name</dt><dd className="mt-1 break-words">{metric?.eventName || "Not configured"}</dd></div>
        <div><dt className="text-xs text-muted-foreground">Counting method</dt><dd className="mt-1">{metric?.countingSemantics === "EVENT_COUNT" ? "Event occurrences, not distinct people" : metric?.countingSemantics === "SUM" ? "Sum of values in the source report" : "See the saved metric definition"}</dd></div>
        <div><dt className="text-xs text-muted-foreground">Reporting timezone</dt><dd className="mt-1">{metric?.reportingTimeZone ?? "Not configured"}</dd></div>
      </dl>
      <p className="max-w-prose text-xs text-muted-foreground">This is the daily history of the saved goal metric. A list of individual events, custom event exploration and live event delivery are not available. Missing days are not zero.</p>
      <Button asChild size="sm" variant="outline"><Link to={`/businesses/${businessId}/channels`}>Manage measurement accounts</Link></Button>
    </Panel>
    <GoalTrend data={data} days={days} formatDate={formatDate} />
  </div>
}

export function RealtimeAvailability({ businessId }: { businessId: string }) {
  return <Panel className="space-y-3 p-5">
    <h2 className="text-base font-medium">Live visitor tracking is not available yet</h2>
    <p className="max-w-prose text-sm text-muted-foreground">OpenRecord does not currently receive a live visitor or event stream. There is no active-user count to display. Daily reports and imported website logs are historical observations.</p>
    <p className="max-w-prose text-sm text-muted-foreground">Connecting a log feed collects AI crawler and referral counts. It does not enable live visitor analytics.</p>
    <Button asChild size="sm" variant="outline"><Link to={`/businesses/${businessId}/results/events`}>View recorded goal events</Link></Button>
  </Panel>
}
