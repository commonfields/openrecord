import { describe, expect, it } from "vitest"
import { chatTargets } from "../app/components/new-chat-dialog"
import { chatPath, mergeAgentChats } from "../app/lib/agent-chats"

describe("new chat context chooser", () => {
  it("groups clients separately without showing the same business twice and searches both", () => {
    const businesses = [{ id: "business", name: "Northstar" }, { id: "client", name: "Client business" }]
    const clients = [{ businessId: "client", name: "Acme" }]
    expect(chatTargets(businesses, clients, "")).toEqual([
      { kind: "business", id: "business", name: "Northstar" },
      { kind: "client", id: "client", name: "Acme" },
    ])
    expect(chatTargets(businesses, clients, " ACME ").map(c => c.id)).toEqual(["client"])
    expect(chatTargets(businesses, clients, "star").map(c => c.id)).toEqual(["business"])
    expect(chatTargets(businesses, clients, "missing")).toEqual([])
  })
  it("routes general chats without a business and retains their pending sidebar history", () => {
    expect(chatPath({ businessId: null, id: "general" })).toBe("/agent?chat=general")
    expect(mergeAgentChats([], new Map([["general", { businessId: null, conversationId: "general", requestId: "request", title: "Hello", updatedAt: "2026-10-26T10:00:00Z", working: true, saved: false }]]), [])[0]).toMatchObject({ businessId: null, businessName: "General chat", working: true })
  })
})
