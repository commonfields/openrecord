import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { ChatItem } from "../app/components/app-shell"
import { TooltipProvider } from "../app/components/ui/tooltip"
import { mergeAgentChats } from "../app/lib/agent-chats"

describe("saved sidebar provider logo", () => {
  it("renders the provider even when the chat is not working", () => {
    const c = mergeAgentChats([{ id: "chat", businessId: null, businessName: "General chat", title: "Question", isClient: false, messages: 2, updatedAt: "2026-10-26T10:00:00Z", provider: "codex" }], new Map(), [])[0]!
    const markup = renderToStaticMarkup(<TooltipProvider><ChatItem c={c} active={false} /></TooltipProvider>)
    expect(markup).toContain('aria-label="Providers: codex"')
    expect(markup).toContain("<path")
    expect(markup).not.toContain("Working…")
  })
  it("shows every provider used in the chat, and a pulsing Working status while it answers", () => {
    const c = mergeAgentChats([{ id: "chat", businessId: null, businessName: "General chat", title: "Launch priorities", isClient: false, messages: 4, updatedAt: "2026-10-26T10:00:00Z", provider: "codex", providers: ["claude", "codex"] }], new Map(), [])[0]!
    const markup = renderToStaticMarkup(<TooltipProvider><ChatItem c={{ ...c, working: true }} active={false} /></TooltipProvider>)
    expect(markup).toContain('aria-label="Providers: claude, codex"')
    expect(markup).toContain("Working")
    expect(markup).toContain("motion-safe:animate-[status-pulse_2s_infinite]")
    expect(markup).not.toContain("animate-spin")
    expect(markup.indexOf("Launch priorities")).toBeLessThan(markup.indexOf("Working"))
  })
})
