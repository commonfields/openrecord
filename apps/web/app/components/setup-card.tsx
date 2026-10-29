// Finishing setup from Today. A business with a setup under way shows its next
// step (the agent drafts the brief from the website, the person confirms);
// a business with no goal yet is offered setup from its website, because
// without a goal the agent can't save or measure ideas.
import { CompassIcon } from "lucide-react"
import { Skeleton } from "@/components/ui/skeleton"
import { Panel } from "@/components/page"
import { SetupFlow, SetupStartForm, useSetup } from "@/components/setup-flow"
import { Briefs } from "@/lib/brief"
import { useApi } from "@/lib/use-api"

export function SetupCard({ businessId }: { businessId: string }) {
  const { setup, loading, set } = useSetup(businessId)
  const brief = useApi(`brief:${businessId}`, () => Briefs.get(businessId))
  if (loading || !brief.data) return loading ? <Skeleton className="h-24 rounded-xl" /> : null
  const reload = () => { void brief.reload() }
  if (setup && setup.step !== "DONE") return (
    <Panel id="setup" className="space-y-3 p-5">
      <Heading title="Finish setting up" description="Your agent read your website and drafted this. Check it and confirm, and it can start proposing and measuring ideas." />
      <SetupFlow setup={setup} onChange={s => { set(s); reload() }} />
    </Panel>
  )
  if (!setup && !brief.data.hasGoal) return (
    <Panel id="setup" className="space-y-3 p-5">
      <Heading title="Set a goal for this business" description="Give your agent the website and it drafts the rest: what you sell, who buys it, the goal and what to count. Without a goal it can't save or measure ideas." />
      <SetupStartForm businessId={businessId} website={brief.data.website} onStarted={s => { set(s); reload() }} />
    </Panel>
  )
  return null
}

function Heading({ title, description }: { title: string; description: string }) {
  return (
    <div className="flex items-start gap-2.5">
      <CompassIcon aria-hidden className="mt-0.5 size-4 text-muted-foreground" />
      <div className="min-w-0">
        <h2 className="text-base font-medium">{title}</h2>
        <p className="text-[0.8125rem] text-muted-foreground">{description}</p>
      </div>
    </div>
  )
}
