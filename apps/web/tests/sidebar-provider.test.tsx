import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { ChatItem } from "../app/components/app-shell"
import { TooltipProvider } from "../app/components/ui/tooltip"
import { mergeAgentChats } from "../app/lib/agent-chats"

describe("saved sidebar provider logo", () => {
  it("renders the provider even when the chat is not working", () => {
    const c = mergeAgentChats([{ id: "chat", businessId: null, businessName: "General chat", title: "Question", isClient: false, messages: 2, updatedAt: "2026-10-26T10:00:00Z", provider: "codex" }], new Map(), [])[0]!
    const markup = renderToStaticMarkup(<TooltipProvider><ChatItem c={c} active={false} /></TooltipProvider>)
    expect(markup).toContain('aria-label="Last reply provider: codex"')
    expect(markup).toContain("<path")
    expect(markup).not.toContain("Working…")
  })
  it("keeps the provider on the right and shows a separate animated status icon on the left", () => {
    const c = mergeAgentChats([{ id: "chat", businessId: null, businessName: "General chat", title: "Launch priorities", isClient: false, messages: 2, updatedAt: "2026-10-26T10:00:00Z", provider: "codex" }], new Map(), [])[0]!
    const markup = renderToStaticMarkup(<TooltipProvider><ChatItem c={{ ...c, working: true }} active={false} /></TooltipProvider>)
    expect(markup).toContain('aria-label="Working provider: codex"')
    expect(markup).toContain('aria-label="Agent is responding"')
    expect(markup).toContain("animate-spin")
    expect(markup).toContain("motion-reduce:animate-none")
    expect(markup.indexOf('aria-label="Agent is responding"')).toBeLessThan(markup.indexOf("Launch priorities"))
  })
})
