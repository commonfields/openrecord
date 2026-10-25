import { useEffect } from "react"
import { Link, Outlet, useParams, useSearchParams } from "react-router"
import { Building2Icon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { AgentChat } from "@/components/agent-chat"
import { useChrome } from "@/components/app-shell"
import { EmptyState } from "@/components/page"
import { usePreferences } from "@/lib/preferences"
import { useWorkspace } from "@/lib/workspace"
import { Today } from "./today"

export function BusinessLayout() {
  const { id = "" } = useParams()
  const { setActiveBusinessId, businesses, businessesLoading } = useWorkspace()

  useEffect(() => setActiveBusinessId(id), [id, setActiveBusinessId])

  if (!businessesLoading && !businesses.some((b) => b.id === id)) {
    return (
      <EmptyState
        icon={<Building2Icon />}
        title="Business not found"
        description="It may have been removed, or it belongs to a different account."
        action={
          <Button asChild variant="outline">
            <Link to="/businesses">See all businesses</Link>
          </Button>
        }
      />
    )
  }
  return <Outlet />
}

type OverviewView = "today" | "agent"

export function Overview() {
  const { activeBusiness } = useWorkspace()
  const { preferences } = usePreferences()
  const [params] = useSearchParams()
  // ?view= wins; otherwise the landing view from settings.
  const requested = params.get("view")
  const view: OverviewView = requested === "today" || requested === "agent" ? requested : preferences.landingView
  // Today is a wide dashboard, so the sidebar steps aside while it is open
  // (the agent view collapses it itself once a conversation starts). The
  // Agent / Work switcher lives in the sidebar, under the search bar.
  const { setFocus } = useChrome()
  useEffect(() => {
    if (view !== "today") return
    setFocus(true)
    return () => setFocus(false)
  }, [view, setFocus])

  return (
    <>
      {view === "agent" ? (
        <AgentChat businessId={activeBusiness?.id ?? ""} businessName={activeBusiness?.name ?? "this business"} />
      ) : (
        <Today />
      )}
    </>
  )
}
