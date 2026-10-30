// Finishing setup from Today. A business with a setup under way shows its next
// step (the agent drafts the brief from the website, the person confirms);
// a business with no goal yet is offered setup from its website, because
// without a goal the agent can't save or measure ideas.
import { ChevronDownIcon, CompassIcon } from "lucide-react"
import { Skeleton } from "@/components/ui/skeleton"
import { Button } from "@/components/ui/button"
import { Panel } from "@/components/page"
import { SetupFlow, SetupStartForm, useSetup } from "@/components/setup-flow"
import { Briefs } from "@/lib/brief"
import { useApi } from "@/lib/use-api"

export function SetupCard({ businessId }: { businessId: string }) {
  const { setup, loading, error, set, reload: reloadSetup } = useSetup(businessId)
  const brief = useApi(`brief:${businessId}`, () => Briefs.get(businessId))
  if (loading) return <Skeleton className="h-24 rounded-xl" />
  if (error && !setup) return <Panel id="setup" className="flex flex-wrap items-center justify-between gap-3 p-4"><p role="alert" className="text-sm text-muted-foreground">Setup could not load.</p><Button size="sm" variant="outline" onClick={() => void reloadSetup()}>Try again</Button></Panel>
  const reload = () => { void brief.reload() }
  if (setup && setup.step !== "DONE") return (
    <Panel id="setup" className="overflow-hidden">
      <details className="group">
        <Heading title="Finish setting up" description={setup.step === "DISCOVER" ? (setup.discovery.status === "FETCHING" ? "Reading your website." : "Your website is waiting to be read.") : "Review your business details and continue setup."} />
        <div className="border-t border-border/60 p-4"><SetupFlow setup={setup} onChange={s => { set(s); reload() }} /></div>
      </details>
    </Panel>
  )
  if (!setup && brief.data && !brief.data.hasGoal) return (
    <Panel id="setup" className="overflow-hidden">
      <details className="group">
        <Heading title="Set a goal for this business" description="Add your website and review a suggested goal for your agent." />
        <div className="border-t border-border/60 p-4"><SetupStartForm businessId={businessId} website={brief.data.website} onStarted={s => { set(s); reload() }} /></div>
      </details>
    </Panel>
  )
  return null
}

function Heading({ title, description }: { title: string; description: string }) {
  return (
    <summary className="flex cursor-pointer list-none items-center gap-3 p-4 outline-none focus-visible:ring-[3px] focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
      <CompassIcon aria-hidden className="mt-0.5 size-4 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <h2 className="text-base font-medium">{title}</h2>
        <p className="text-[0.8125rem] text-muted-foreground">{description}</p>
      </div>
      <ChevronDownIcon aria-hidden className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
    </summary>
  )
}
