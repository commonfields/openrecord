import { describe, expect, it } from "vitest"
import { chatPath, mergeAgentChats, type ChatActivity } from "../app/lib/agent-chats"
import type { AgentChatSummary } from "../app/lib/api"

const activity = (overrides: Partial<ChatActivity> = {}): ChatActivity => ({ businessId: "b1", conversationId: "c1", requestId: "r1", title: "New question", working: true, saved: false, updatedAt: "2026-10-26T10:00:00Z", ...overrides })
const saved: AgentChatSummary = { id: "c1", businessId: "b1", businessName: "Business 1", isClient: false, title: "Original question", messages: 2, updatedAt: "2026-10-25T10:00:00Z" }

describe("chat history while a reply is pending", () => {
  it("shows a new chat immediately while the server history is still empty", () => {
    expect(mergeAgentChats([], new Map([["b1", activity()]]), [{ id: "b1", name: "Business 1" }])).toEqual([
      { id: "c1", businessId: "b1", businessName: "Business 1", isClient: false, title: "New question", messages: 1, updatedAt: "2026-10-26T10:00:00Z", working: true, draft: true },
    ])
  })

  it("preserves a saved chat's title, marks it working and never duplicates it", () => {
    const result = mergeAgentChats([saved], new Map([["b1", activity()]]), [])
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ title: "Original question", working: true, draft: false })
  })

  it("keeps multiple chats for the same business and links to the selected conversation", () => {
    const next = activity({ conversationId: "c2" })
    const result = mergeAgentChats([saved], new Map([["c2", next]]), [])
    expect(result.map(chat => chat.id)).toEqual(["c2", "c1"])
    expect(result.find(chat => chat.id === "c1")).toMatchObject({ title: "Original question", working: false })
    expect(chatPath(saved)).toBe("/businesses/b1/agent?chat=c1")
    expect(chatPath({ ...saved, id: "c2" })).toBe("/businesses/b1/agent?chat=c2")
  })

  it("clears the working indicator after success or failure without pretending a failed draft was saved", () => {
    expect(mergeAgentChats([], new Map([["b1", activity({ working: false, saved: false })]]), [])[0]).toMatchObject({ working: false, draft: true })
    expect(mergeAgentChats([saved], new Map([["b1", activity({ working: false, saved: true })]]), [])[0]).toMatchObject({ working: false, draft: false, title: "Original question" })
    expect(mergeAgentChats([], new Map(), [])).toEqual([])
  })
})
