import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react"
import { Agent, type AgentChatSummary } from "@/lib/api"
import { useWorkspace } from "@/lib/workspace"

export type ChatActivity = { businessId: string | null; conversationId: string; requestId: string; title: string; updatedAt: string; working: boolean; saved: boolean }
type ActivityStore = {
  activity: ReadonlyMap<string, ChatActivity>
  start: (businessId: string | null, requestId: string, title: string, conversationId: string) => void
  finish: (businessId: string | null, requestId: string, saved: boolean) => void
  forget: (businessId: string | null, conversationId?: string) => void
}
const ActivityContext = createContext<ActivityStore | null>(null)

// Scoped to the signed-in app shell, never stored globally or in localStorage.
export function ChatActivityProvider({ children }: { children: ReactNode }) {
  const [activity, setActivity] = useState<ReadonlyMap<string, ChatActivity>>(() => new Map())
  const start = useCallback((businessId: string | null, requestId: string, title: string, conversationId: string) => {
    setActivity(current => current.get(conversationId)?.working ? current : new Map(current).set(conversationId, {
      businessId, conversationId, requestId, title: title.trim().replace(/\s+/g, " ").slice(0, 100), updatedAt: new Date().toISOString(), working: true, saved: false,
    }))
  }, [])
  const finish = useCallback((businessId: string | null, requestId: string, saved: boolean) => {
    setActivity(current => {
      const entry = [...current].find(([, item]) => item.businessId === businessId && item.requestId === requestId)
      return entry ? new Map(current).set(entry[0], { ...entry[1], working: false, saved }) : current
    })
  }, [])
  const forget = useCallback((businessId: string | null, conversationId?: string) => { setActivity(current => new Map([...current].filter(([, item]) => item.businessId !== businessId || (conversationId !== undefined && item.conversationId !== conversationId)))) }, [])
  const value = useMemo(() => ({ activity, start, finish, forget }), [activity, start, finish, forget])
  return createElement(ActivityContext.Provider, { value }, children)
}

export function useChatActivity() {
  const value = useContext(ActivityContext)
  if (!value) throw new Error("Chat activity requires the signed-in app shell")
  return value
}

export function mergeAgentChats(chats: readonly AgentChatSummary[], activity: ReadonlyMap<string, ChatActivity>, businesses: readonly { id: string; name: string }[]) {
  // The server reports a session as working while any turn runs there, including a helper's.
  const merged = new Map(chats.map(chat => [chat.id, { ...chat, working: chat.working ?? false, draft: false }]))
  for (const [, item] of activity) {
    const { businessId, conversationId } = item
    const saved = merged.get(conversationId)
    merged.set(conversationId, saved ? { ...saved, working: item.working, updatedAt: item.working ? item.updatedAt : saved.updatedAt } : {
      id: conversationId, businessId, businessName: businessId === null ? "General chat" : businesses.find(b => b.id === businessId)?.name ?? "Business", isClient: false,
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
export const chatPath = (c: Pick<AgentChatSummary, "businessId" | "id">) => `${c.businessId === null ? "/agent" : `/businesses/${encodeURIComponent(c.businessId)}/agent`}?chat=${encodeURIComponent(c.id)}`

export function useAgentChats() {
  const [chats, setChats] = useState<AgentChatSummary[] | null>(null)
  const { activity } = useChatActivity()
  const { businesses } = useWorkspace()
  useEffect(() => {
    let live = true
    let version = 0
    const load = () => {
      const request = ++version
      void Agent.conversations().then(r => { if (live && request === version) setChats(r.conversations) })
        .catch(() => { if (live && request === version) setChats(c => c ?? []) })
    }
    load()
    window.addEventListener(EVENT, load)
    return () => { live = false; window.removeEventListener(EVENT, load) }
  }, [])
  return useMemo(() => chats === null && activity.size === 0 ? null : mergeAgentChats(chats ?? [], activity, businesses), [chats, activity, businesses])
}
