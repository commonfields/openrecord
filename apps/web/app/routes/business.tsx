import { useCallback, useEffect } from "react"
import { Link, Navigate, Outlet, useParams, useSearchParams } from "react-router"
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

/** Kept for links made before the four-area workspace: ?view= or the landing
 * preference decides between the agent and results. */
export function Overview() {
  const [params] = useSearchParams()
  const { preferences } = usePreferences()
  const requested = params.get("view")
  const view = requested === "today" || requested === "agent" ? requested : preferences.landingView
  return <Navigate to={view === "today" ? "../results" : "../agent"} replace />
}

export function AgentPage() {
  const { activeBusiness } = useWorkspace()
  const noop = useCallback(() => {}, [])
  return <AgentChat businessId={activeBusiness?.id ?? ""} businessName={activeBusiness?.name ?? "this business"} onConversationChange={noop} />
}

export function ResultsPage() {
  // Results is a wide dashboard, so the sidebar steps aside while it is open.
  const { setFocus } = useChrome()
  useEffect(() => {
    setFocus(true)
    return () => setFocus(false)
  }, [setFocus])
  return <Today />
}
