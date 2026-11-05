import { Link, useParams } from "react-router"
import { Button } from "@/components/ui/button"
import { PageHeader } from "@/components/page"
import { DiscoveryOverview } from "@/components/discovery-overview"
import { useActiveBusiness } from "@/lib/workspace"

/** A read-only entry point for existing AI discovery links. */
export function AiDiscoveryPage() {
  const { id = "" } = useParams()
  useActiveBusiness(id)
  return <div className="space-y-5 pb-4">
    <PageHeader back={{ to: `/businesses/${id}/issues`, label: "AI answers" }} title="AI discovery"
      description="See what measured AI answers say about this business and what evidence is available." />
    <DiscoveryOverview businessId={id} />
    <Button asChild variant="outline" size="sm"><Link to={`/businesses/${id}/issues`}>Review AI answers</Link></Button>
    <div className="text-xs text-muted-foreground">
      <Link className="underline underline-offset-2" to={`/clients/${id}/discovery/manual`}>Manual measurement tools</Link>
      <p className="mt-1">For starting batches, reviewing samples, and importing referral data. These steps are not yet automated.</p>
    </div>
  </div>
}
