import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react"
import { Agent, type AgentChatSummary } from "@/lib/api"
import { useWorkspace } from "@/lib/workspace"

export type ChatActivity = { requestId: string; title: string; updatedAt: string; working: boolean; saved: boolean }
type ActivityStore = {
  activity: ReadonlyMap<string, ChatActivity>
  start: (businessId: string, requestId: string, title: string) => void
  finish: (businessId: string, requestId: string, saved: boolean) => void
  forget: (businessId: string) => void
}
const ActivityContext = createContext<ActivityStore | null>(null)

// Scoped to the signed-in app shell, never stored globally or in localStorage.
export function ChatActivityProvider({ children }: { children: ReactNode }) {
  const [activity, setActivity] = useState<ReadonlyMap<string, ChatActivity>>(() => new Map())
  const start = useCallback((businessId: string, requestId: string, title: string) => {
    setActivity(current => current.get(businessId)?.working ? current : new Map(current).set(businessId, {
      requestId, title: title.trim().replace(/\s+/g, " ").slice(0, 100), updatedAt: new Date().toISOString(), working: true, saved: false,
    }))
  }, [])
  const finish = useCallback((businessId: string, requestId: string, saved: boolean) => {
    setActivity(current => {
      const item = current.get(businessId)
      return item?.requestId === requestId ? new Map(current).set(businessId, { ...item, working: false, saved }) : current
    })
  }, [])
  const forget = useCallback((businessId: string) => { setActivity(current => { const next = new Map(current); next.delete(businessId); return next }) }, [])
  const value = useMemo(() => ({ activity, start, finish, forget }), [activity, start, finish, forget])
  return createElement(ActivityContext.Provider, { value }, children)
}

export function useChatActivity() {
  const value = useContext(ActivityContext)
  if (!value) throw new Error("Chat activity requires the signed-in app shell")
  return value
}

export function mergeAgentChats(chats: readonly AgentChatSummary[], activity: ReadonlyMap<string, ChatActivity>, businesses: readonly { id: string; name: string }[]) {
  const merged = new Map(chats.map(chat => [chat.businessId, { ...chat, working: false, draft: false }]))
  for (const [businessId, item] of activity) {
    const saved = merged.get(businessId)
    merged.set(businessId, saved ? { ...saved, working: item.working, updatedAt: item.working ? item.updatedAt : saved.updatedAt } : {
      businessId, businessName: businesses.find(b => b.id === businessId)?.name ?? "Business", isClient: false,
      title: item.title, messages: 1, updatedAt: item.updatedAt, working: item.working, draft: !item.saved,
    })
  }
  return [...merged.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

// The sidebar's chat history. Pages that send or delete a message call
// notifyAgentChats() so the list follows without polling.
const EVENT = "openrecord:agent-chats"
export const notifyAgentChats = () => window.dispatchEvent(new Event(EVENT))

// Every saved conversation opens in its business's agent workspace; it is the
// same conversation the client record's side panel shows.
export const chatPath = (c: Pick<AgentChatSummary, "businessId">) => `/businesses/${encodeURIComponent(c.businessId)}/agent`

export function useAgentChats() {
  const [chats, setChats] = useState<AgentChatSummary[] | null>(null)
  const { activity } = useChatActivity()
  const { businesses } = useWorkspace()
  useEffect(() => {
    let live = true
    const load = () => void Agent.conversations().then((r) => { if (live) setChats(r.conversations) }).catch(() => { if (live) setChats((c) => c ?? []) })
    load()
    window.addEventListener(EVENT, load)
    return () => { live = false; window.removeEventListener(EVENT, load) }
  }, [])
  return useMemo(() => chats === null && activity.size === 0 ? null : mergeAgentChats(chats ?? [], activity, businesses), [chats, activity, businesses])
}
