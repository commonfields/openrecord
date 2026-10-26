import { useEffect, useState } from "react"
import { Agent, type AgentChatSummary } from "@/lib/api"

// The sidebar's chat history. Pages that send or delete a message call
// notifyAgentChats() so the list follows without polling.
const EVENT = "openrecord:agent-chats"
export const notifyAgentChats = () => window.dispatchEvent(new Event(EVENT))

// Every saved conversation opens in its business's agent workspace; it is the
// same conversation the client record's side panel shows.
export const chatPath = (c: Pick<AgentChatSummary, "businessId">) => `/businesses/${encodeURIComponent(c.businessId)}/agent`

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
