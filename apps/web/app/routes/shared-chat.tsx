// A shared agent conversation at /shared/:token, read-only, for someone
// without an account: who said what, the agent's replies and the sources
// they cited. No navigation, account controls or reply box.
import { useEffect, useState } from "react"
import { useParams } from "react-router"
import { FileTextIcon } from "lucide-react"
import { ChatMarkdown } from "@/components/chat-markdown"
import { cn } from "@/lib/utils"

type SharedMessage = { role: "user" | "agent"; text: string; citations: Array<{ kind: string; text: string }>; files: string[] }
type SharedChat = { business: string; title: string | null; expiresAt: string; messages: SharedMessage[]; note: string }

export function SharedChatPage() {
  const { token = "" } = useParams()
  const [state, setState] = useState<{ chat: SharedChat } | { error: "gone" | "failed" } | null>(null)
  useEffect(() => {
    let live = true
    void fetch(`/api/shared/chats/${encodeURIComponent(token)}`, { credentials: "omit", referrerPolicy: "no-referrer" })
      .then(async r => { if (!live) return; setState(r.ok ? { chat: await r.json() as SharedChat } : { error: r.status === 404 ? "gone" : "failed" }) })
      .catch(() => { if (live) setState({ error: "failed" }) })
    return () => { live = false }
  }, [token])
  useEffect(() => {
    const meta = document.createElement("meta"); meta.name = "robots"; meta.content = "noindex, nofollow"
    document.head.appendChild(meta)
    return () => meta.remove()
  }, [])
  if (!state) return <main className="mx-auto max-w-3xl px-4 py-16 text-sm text-muted-foreground">Loading the conversation…</main>
  if ("error" in state) return (
    <main className="mx-auto max-w-3xl px-4 py-16">
      <h1 className="text-base font-semibold">{state.error === "gone" ? "This link no longer works" : "The conversation could not be loaded"}</h1>
      <p className="mt-1 text-sm text-muted-foreground">{state.error === "gone" ? "It may have expired or been revoked. Ask the person who shared it for a new link." : "Try again in a moment."}</p>
    </main>
  )
  const { chat } = state
  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-10 sm:px-6">
      <header className="mb-6 space-y-1 border-b pb-4">
        <p className="text-xs text-muted-foreground">Shared conversation · {chat.business}</p>
        <h1 className="text-lg font-semibold tracking-tight">{chat.title ?? `Conversation about ${chat.business}`}</h1>
        <p className="text-xs text-muted-foreground">{chat.note} Link expires {new Date(chat.expiresAt).toLocaleDateString()}.</p>
      </header>
      {chat.messages.length ? (
        <ol className="space-y-4">
          {chat.messages.map((m, i) => (
            <li key={i} className={cn("flex", m.role === "user" ? "justify-end" : "justify-start")}>
              <div className={cn("max-w-[90%] space-y-2 rounded-2xl px-4 py-3 text-sm", m.role === "user" ? "bg-muted" : "bg-card shadow-(--card-shadow)")}>
                <p className="text-[0.6875rem] font-medium text-muted-foreground">{m.role === "user" ? "Question" : "Agent"}</p>
                {m.role === "agent" ? <ChatMarkdown text={m.text} /> : <p className="whitespace-pre-wrap">{m.text}</p>}
                {m.files.length ? <p className="flex flex-wrap items-center gap-1.5 text-[0.6875rem] text-muted-foreground"><FileTextIcon className="size-3" />{m.files.join(", ")} (contents not shared)</p> : null}
                {m.citations.length ? (
                  <div className="border-t pt-2">
                    <p className="text-[0.6875rem] font-medium text-muted-foreground">Sources</p>
                    <ul className="mt-1 space-y-0.5 text-[0.6875rem] text-muted-foreground">{m.citations.map((c, j) => <li key={j}>{c.text}</li>)}</ul>
                  </div>
                ) : null}
              </div>
            </li>
          ))}
        </ol>
      ) : <p className="text-sm text-muted-foreground">No messages yet.</p>}
    </main>
  )
}
