import { useActiveBusiness } from "@/lib/workspace"
import { useParams, useSearchParams } from "react-router"
import { TriangleAlertIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { EmptyState, PageHeader } from "@/components/page"
import { GrowthMeasurement, measurementError } from "@/components/growth-measurement"
import { Records } from "@/lib/record"
import { useApi } from "@/lib/use-api"
import { Growth } from "@/lib/growth"

// W3: standalone operator surface for daily measurement imports and the
// resolved series. The growth workspace page stays untouched; this page reads
// the same immutable metric definitions. Manual exports are a first-class
// path here: a Google Analytics connection is optional, never required.
export default function ClientGrowthMeasurementPage() {
  const { id = "" } = useParams()
  useActiveBusiness(id)
  const [params] = useSearchParams()
  const state = useApi(`growth-measurement:${id}`, async () => {
    const [record, growth] = await Promise.all([Records.get(id), Growth.profile(id)])
    return { name: record.record.profile.name, goals: growth.goals }
  })
  if (state.error) return <EmptyState icon={<TriangleAlertIcon />} title="Measurement could not load" description={measurementError(state.error)} action={<Button variant="outline" onClick={() => void state.reload()}>Try again</Button>} />
  if (!state.data || state.loading) return <MeasurementSkeleton />
  const { name, goals } = state.data
  return <div className="space-y-5 pb-4">
    <PageHeader title={`${name} measurement`} back={{ to: `/clients/${id}/growth`, label: "Growth workspace" }}
      description="Import daily aggregates, or read them from Google Analytics, for one metric definition at a time and read the resolved series. The newest import that reports a day wins; days no import reports stay missing and disagreements stay visible — no impact, lift or attribution is inferred."
      meta={<><a href={`/clients/${id}/growth`} className="font-medium hover:underline">Growth workspace</a><a href={`/clients/${id}`} className="font-medium hover:underline">Client record</a></>} />
    {goals.length === 0 ? (
      <EmptyState
        icon={<TriangleAlertIcon />}
        title="No metric to measure yet"
        description="Measurement needs a goal with an exact metric definition. Set the goal in the growth workspace first; a Google Analytics connection is optional — daily CSV exports measure on their own."
        action={<Button size="sm" asChild><a href={`/clients/${id}/growth`}>Open the growth workspace</a></Button>}
      />
    ) : (
      <GrowthMeasurement businessId={id} goals={goals} ga4Status={params.get("ga4")} />
    )}
  </div>
}

function MeasurementSkeleton() {
  return <div className="space-y-5" aria-busy="true" aria-label="Loading measurement">
    <div className="space-y-2"><Skeleton className="h-5 w-64" /><Skeleton className="h-3 w-96 max-w-full" /></div>
    <Skeleton className="h-64 rounded-xl" />
    <Skeleton className="h-40 rounded-xl" />
  </div>
}
