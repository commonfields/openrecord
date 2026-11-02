import { Navigate, useNavigate } from "react-router"
import { SetupStartForm } from "@/components/setup-flow"
import { useWorkspace } from "@/lib/workspace"

/** "/" opens the business you used last, or setup when there is none. */
export function RootRedirect() {
  const { businesses, businessesLoading, activeBusiness } = useWorkspace()
  if (businessesLoading) return null
  const target = activeBusiness ?? businesses[0]
  return <Navigate to={target ? `/businesses/${target.id}/agent` : "/start"} replace />
}

export function StartPage() {
  const navigate = useNavigate()
  const { reloadBusinesses, setActiveBusinessId } = useWorkspace()
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-4 pb-[12vh]">
      <div className="w-full max-w-xl space-y-6">
        <div className="space-y-2 text-center">
          <h1 className="text-2xl font-medium tracking-tight text-balance">What's your website, and what do you want to achieve?</h1>
          <p className="text-sm text-muted-foreground text-balance">That's all your agent needs. It reads your site, writes the brief, and comes back with a first step for you to approve.</p>
        </div>
        <SetupStartForm
          autoFocus
          onStarted={async setup => {
            await reloadBusinesses()
            setActiveBusinessId(setup.businessId)
            navigate(`/businesses/${setup.businessId}/agent`)
          }}
        />
      </div>
    </div>
  )
}
