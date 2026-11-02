// The agent on the Workspace tab: one pane beside Results, Needs you and
// Channels, continuing the business's current conversation (the same one the
// Agent tab shows). Any part of a workspace page can hand it a request: the
// pane opens with that request typed in the composer, never sent until the
// person sends it.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react"
import { useLocation, useNavigate } from "react-router"
import { PanelLeftCloseIcon, SparklesIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { AgentPane, useAgentSession, type ComposerSeed } from "@/components/agent-chat"
import { useChrome } from "@/components/app-shell"
import { HeaderActions } from "@/components/page"
import { askAgentPath } from "@/lib/nav"

type WorkspaceAgent = { readonly open: boolean; readonly ask: (request?: string) => void; readonly close: () => void }
const WorkspaceAgentContext = createContext<WorkspaceAgent | null>(null)

/** The workspace agent when a page sits inside one, else null (the page then links to the Agent tab). */
export const useWorkspaceAgent = () => useContext(WorkspaceAgentContext)

/** Hands a request to the agent: the pane beside this page when there is one, else the Agent tab with it typed in. */
export function useAskAgent(businessId: string) {
  const agent = useWorkspaceAgent()
  const navigate = useNavigate()
  return useCallback((request?: string) => {
    if (agent) agent.ask(request)
    else navigate(request ? askAgentPath(businessId, request) : `/businesses/${encodeURIComponent(businessId)}/agent`)
  }, [agent, navigate, businessId])
}

export function WorkspaceAgentProvider({ businessId, businessName, children }: { businessId: string; businessName: string; children: ReactNode }) {
  const onAgentTab = /\/agent\/?$/.test(useLocation().pathname)
  const [open, setOpen] = useState(false)
  const [seed, setSeed] = useState<ComposerSeed | null>(null)
  const session = useAgentSession(businessId, open)
  const { setFocus } = useChrome()
  // Opening the agent collapses the sidebar so the page keeps its room.
  useEffect(() => { setFocus(open); return () => setFocus(false) }, [open, setFocus])
  // Moving to the Agent tab or another business closes the pane: the Agent tab is the full conversation.
  useEffect(() => { if (onAgentTab) setOpen(false) }, [onAgentTab])
  useEffect(() => { setOpen(false); setSeed(null) }, [businessId])
  const ask = useCallback((request?: string) => {
    setOpen(true)
    if (request) setSeed(s => ({ text: request, nonce: (s?.nonce ?? 0) + 1 }))
  }, [])
  const close = useCallback(() => setOpen(false), [])
  // Esc closes the pane, unless focus is in a field that may use Esc itself (a menu, the composer's command list).
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && !e.defaultPrevented && !(e.target instanceof HTMLElement && e.target.closest("[role=menu],[role=listbox],[role=dialog]"))) setOpen(false) }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open])
  const value = useMemo(() => ({ open, ask, close }), [open, ask, close])
  if (onAgentTab) return <>{children}</>
  return (
    <WorkspaceAgentContext.Provider value={value}>
      <HeaderActions>
        {open ? (
          <Button variant="outline" size="sm" className="h-8 text-xs" onClick={close}>
            <PanelLeftCloseIcon />
            Hide the agent
          </Button>
        ) : (
          <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => ask()}>
            <SparklesIcon />
            Ask the agent
          </Button>
        )}
      </HeaderActions>
      <AgentPane open={open} session={session} businessName={businessName} placeholder={`Ask about ${businessName}`} onClose={close}
        onCommand={command => session.send(`/${command}`)} context={{ kind: "business", name: businessName }} seed={seed} />
      {children}
    </WorkspaceAgentContext.Provider>
  )
}

/** A small "Ask the agent" action with the request it hands over. */
export function AskAgentButton({ businessId, request, children = "Ask the agent", variant = "ghost", className }: {
  businessId: string; request: string; children?: ReactNode; variant?: "ghost" | "outline" | "default"; className?: string
}) {
  const ask = useAskAgent(businessId)
  return (
    <Button variant={variant} size="sm" className={className ?? "h-7 text-xs"} onClick={() => ask(request)}>
      <SparklesIcon />
      {children}
    </Button>
  )
}
