import { useEffect, useState } from "react"
import { Agent, type AgentChatSummary } from "@/lib/api"

// The sidebar's chat history. Pages that send or delete a message call
// notifyAgentChats() so the list follows without polling.
const EVENT = "openrecord:agent-chats"
export const notifyAgentChats = () => window.dispatchEvent(new Event(EVENT))

// Where a saved conversation opens: a client's record page with the agent
// beside it, or the business overview's agent view.
export const chatPath = (c: Pick<AgentChatSummary, "businessId" | "isClient">) =>
  c.isClient ? `/clients/${encodeURIComponent(c.businessId)}?agent=1` : `/businesses/${encodeURIComponent(c.businessId)}/overview?view=agent`

export function useAgentChats() {
  const [chats, setChats] = useState<AgentChatSummary[] | null>(null)
  useEffect(() => {
    let live = true
    const load = () => void Agent.conversations().then((r) => { if (live) setChats(r.conversations) }).catch(() => { if (live) setChats((c) => c ?? []) })
    load()
    window.addEventListener(EVENT, load)
    return () => { live = false; window.removeEventListener(EVENT, load) }
  }, [])
  return chats
}
