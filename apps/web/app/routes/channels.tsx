import { useParams } from "react-router"
import { RadioTowerIcon } from "lucide-react"
import { Skeleton } from "@/components/ui/skeleton"
import { EmptyState, PageHeader, Panel } from "@/components/page"
import { ChannelList } from "@/components/setup-flow"
import { SearchConsoleSetup } from "@/components/search-console"
import { AdAccountsSetup } from "@/components/ad-accounts"
import { RevenueSetup } from "@/components/revenue"
import { errorMessage } from "@/lib/format"
import { Channels } from "@/lib/setup"
import { useApi } from "@/lib/use-api"
import { useWorkspace } from "@/lib/workspace"

export function ChannelsPage() {
  const { id = "" } = useParams()
  const { activeBusiness } = useWorkspace()
  const q = useApi(`channels:${id}`, () => Channels.get(id))
  return (
    <div className="rise-in mx-auto w-full max-w-3xl space-y-6 pb-4">
      <PageHeader title="Channels" description={`Where ${activeBusiness?.name ?? "this business"} markets, and what OpenRecord can actually read, change, verify or measure there.`} />
      {q.error && !q.data ? (
        <EmptyState icon={<RadioTowerIcon />} title="Channels could not load" description={errorMessage(q.error)} />
      ) : !q.data ? (
        <Skeleton className="h-64 rounded-xl" />
      ) : (
        <>
          <SearchConsoleSetup businessId={id} onChange={() => { void q.reload() }} />
          <AdAccountsSetup businessId={id} />
          <RevenueSetup businessId={id} />
          <Panel className="p-4">
            <ChannelList inventory={q.data.inventory} />
          </Panel>
        </>
      )}
    </div>
  )
}
