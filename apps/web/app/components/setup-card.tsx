// Setup where the person is. In the agent chat it shows what the agent is
// doing with the website, then the first initiative to decide on. On Results
// it is a collapsible reminder while setup is still under way, or the one box
// to start from when a business has no goal yet.
import { ChevronDownIcon, CompassIcon } from "lucide-react"
import { useEffect, useState, type ReactNode } from "react"
import { useLocation } from "react-router"
import { Skeleton } from "@/components/ui/skeleton"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Panel } from "@/components/page"
import { SetupFlow, SetupStartForm, useSetup } from "@/components/setup-flow"
import { Briefs } from "@/lib/brief"
import { useApi } from "@/lib/use-api"
import { cn } from "@/lib/utils"

/** Setup inside the agent chat, until the first initiative is decided. */
export function SetupInChat({ businessId }: { businessId: string }) {
  const { setup, set, error, reload } = useSetup(businessId)
  if (error && !setup) return <Panel className="flex flex-wrap items-center gap-3 p-4"><p role="alert" className="flex-1 text-sm text-destructive">Setup could not load.</p><Button size="sm" variant="outline" onClick={() => void reload()}>Try again</Button></Panel>
  if (!setup) return null
  if (setup.step === "DONE" && setup.opportunity?.status !== "PROPOSED") return null
  return <SetupFlow setup={setup} onChange={set} reload={reload} />
}

export function SetupCard({ businessId }: { businessId: string }) {
  const { hash } = useLocation()
  const [open, setOpen] = useState(hash === "#setup")
  useEffect(() => { if (hash === "#setup") setOpen(true) }, [hash])
  const { setup, loading, error, set, reload: reloadSetup } = useSetup(businessId)
  const brief = useApi(`brief:${businessId}`, () => Briefs.get(businessId))
  if (loading) return <Skeleton className="h-24 rounded-xl" />
  if (error && !setup) return <Panel id="setup" className="flex flex-wrap items-center justify-between gap-3 p-4"><p role="alert" className="text-sm text-muted-foreground">Setup could not load.</p><Button size="sm" variant="outline" onClick={() => void reloadSetup()}>Try again</Button></Panel>
  const reload = () => { void brief.reload() }
  if (setup && setup.step !== "DONE") return (
    <SetupPanel open={open} onOpenChange={setOpen} title={setup.step === "CONFIRM" && setup.draft?.status !== "RUNNING" ? "Setup needs you" : "Your agent is setting up"}
      description={setup.step === "DISCOVER" ? "Reading your website. Nothing will be changed." : "Writing the brief and looking for a first step."}>
      <SetupFlow setup={setup} onChange={s => { set(s); reload() }} reload={reloadSetup} />
    </SetupPanel>
  )
  if (!setup && brief.data && !brief.data.hasGoal) return (
    <SetupPanel open={open} onOpenChange={setOpen} title="Tell your agent what you want to achieve" description="Your website and your goal, in one line. The agent does the rest.">
      <SetupStartForm businessId={businessId} website={brief.data.website} onStarted={s => { set(s); reload() }} />
    </SetupPanel>
  )
  return null
}

function SetupPanel({ open, onOpenChange, title, description, children }: { open: boolean; onOpenChange: (open: boolean) => void; title: string; description: string; children: ReactNode }) {
  return (
    <Panel id="setup" className="overflow-hidden">
      <Collapsible open={open} onOpenChange={onOpenChange}>
        <CollapsibleTrigger className="flex w-full items-center gap-3 p-4 text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring">
          <CompassIcon aria-hidden className="mt-0.5 size-4 text-muted-foreground" />
          <span className="min-w-0 flex-1">
            <span className="block text-base font-medium">{title}</span>
            <span className="block text-[0.8125rem] text-muted-foreground">{description}</span>
          </span>
          <ChevronDownIcon aria-hidden className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} />
        </CollapsibleTrigger>
        <CollapsibleContent><div className="border-t border-border/60 p-4">{children}</div></CollapsibleContent>
      </Collapsible>
    </Panel>
  )
}
