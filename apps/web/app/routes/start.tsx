import { Navigate, useNavigate, useSearchParams } from "react-router"
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
  const [params] = useSearchParams()
  const { reloadBusinesses, setActiveBusinessId } = useWorkspace()
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-4 pb-[12vh]">
      <div className="w-full max-w-xl space-y-6">
        <SetupStartForm
          autoFocus
          engagement={params.get("ownership") === "own" ? "DOGFOOD" : "CLIENT"}
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
