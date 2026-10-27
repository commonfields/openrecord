import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { TooltipProvider } from "@/components/ui/tooltip"
import { AgentContextChip, chatContext, type AgentChatContext } from "../app/components/agent-chat"

const context = (overrides: Partial<AgentChatContext> = {}): AgentChatContext => ({ kind: "business", name: "Northstar", ...overrides })

describe("composer context chip", () => {
  it("shows the chosen business or client name with its kind icon", () => {
    const markup = renderToStaticMarkup(<TooltipProvider><AgentContextChip context={context()} /></TooltipProvider>)
    expect(markup).toContain("Northstar")
    expect(markup).toContain("lucide-building-2")
    const client = renderToStaticMarkup(<TooltipProvider><AgentContextChip context={context({ kind: "client", name: "Acme" })} /></TooltipProvider>)
    expect(client).toContain("Acme")
    expect(client).toContain("lucide-file-check-2")
  })

  it("derives a business context from the conversation's business and none for general chats", () => {
    expect(chatContext(null, "Northstar")).toBeNull()
    expect(chatContext("b1", "Northstar")).toEqual({ kind: "business", name: "Northstar" })
  })
})
