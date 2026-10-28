import { useEffect, useRef, useState, type ReactNode, type TransitionEvent } from "react"
import { toast } from "sonner"
import { ArrowUpIcon, CheckIcon, CopyIcon, FileTextIcon, FolderIcon, MicIcon, PlusIcon, SparklesIcon, SquareIcon, XIcon } from "lucide-react"
import type { HarnessReasoningEffort } from "@openrecord/contracts"
import { Button } from "@/components/ui/button"
import { createPortal } from "react-dom"
import { useChrome, usePaneSlot } from "@/components/app-shell"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { modKey, useSettings } from "@/components/settings-dialog"
import { usePreferences } from "@/lib/preferences"
import { Link, useNavigate, useSearchParams } from "react-router"
import { Agent, ApiError, Providers, Questions, type AgentCitation, type AgentMessage, type AgentProposal } from "@/lib/api"
import { agentEvidencePath } from "@/lib/agent-evidence"
import { chatPath, notifyAgentChats, useChatActivity } from "@/lib/agent-chats"
import { Select, SelectTrigger, SelectContent, SelectItem, SelectValue } from "@/components/ui/select"
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import { COMMANDS, commandMatches, parseCommand, type AgentCommand } from "@/components/agent-commands"
import { modelOptions, selectionLabel, selectionValue, useAgentSelection, useHarnessCatalog } from "@/lib/harness"
import { AgentModelPicker } from "@/components/agent-model-picker"
import { NewChatDialog } from "@/components/new-chat-dialog"

type Message = { id: string; role: "user" | "agent"; text: string; tools?: Array<{ tool: string; summary: string }>; citations?: AgentCitation[]; pending?: boolean; provider?: string; model?: string | null }

// The business or client a conversation was started with, shown in the
// composer tray to the left of the model. A general chat has none.
export type AgentChatContext = { kind: "client" | "business"; name: string }
export const chatContext = (businessId: string | null, name: string): AgentChatContext | null =>
  businessId === null ? null : { kind: "business", name }
// Failures stay out of the conversation: an unreachable agent shows in the
// composer's placeholder, and a message that got no reply is marked under it.
const unavailableText = (e: unknown) => e instanceof ApiError && e.body["reason"] === "UNCONFIGURED"
  ? "The agent isn't set up for this workspace yet"
  : "The agent isn't available right now"
const notSentText = (e: unknown) => e instanceof ApiError && e.status === 409
  ? "Changed in another tab. Reload to continue"
  : e instanceof ApiError && e.body["reason"] === "RATE_LIMITED" ? "No reply. This provider reached a usage limit. Choose another model or try again later"
  : e instanceof ApiError && e.body["reason"] === "CONTEXT_LIMIT" ? "No reply. This conversation is too large for the provider. Start a new conversation or shorten the message"
  : e instanceof ApiError && e.body["reason"] === "UNCONFIGURED" ? "Not sent. The agent isn't set up yet"
  : "No reply"

let nextId = 0
const uid = () => `m${Date.now()}-${nextId++}`

// Keep recorded inference metadata on both live and historical messages,
// without adding an attribution line to the conversation.
function toDisplayMessages(messages: AgentMessage[]): Message[] {
  return messages.map(m => ({
    ...m,
    id: uid(),
    ...(m.toolCalls ? { tools: m.toolCalls } : {}),
    ...(m.inference
      ? { provider: m.inference.provider, ...(m.inference.requestedModel ? { model: m.inference.requestedModel } : {}) }
      : {}),
  }))
}

// Minimal shape of the Web Speech API; not in the TS DOM lib.
type Recognition = {
  continuous: boolean
  interimResults: boolean
  lang: string
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null
  onend: (() => void) | null
  onerror: ((e: { error: string }) => void) | null
  start: () => void
  stop: () => void
}

function createRecognition(): Recognition | null {
  const w = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition }
  const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition
  return Ctor ? new Ctor() : null
}

// ---- conversation state, shared by every agent layout ----

type AgentSession = ReturnType<typeof useAgentSession>

// One business's private conversation and the proposals it produced. Loads
// when enabled (a closed side panel costs nothing) and stays scoped to the
// business it was opened for.
export function useAgentSession(businessId: string | null, enabled = true) {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const requestedConversationId = searchParams.get("chat") ?? undefined
  const activity = useChatActivity()
  const [messages, setMessages] = useState<Message[]>([])
  const [conversationId, setConversationId] = useState<string | undefined>()
  const [revision, setRevision] = useState(0)
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)
  const mounted = useRef(true)
  const [proposals, setProposals] = useState<AgentProposal[]>([])
  // Why the conversation could not load, and the last message that got no reply.
  const [unavailable, setUnavailable] = useState<string | null>(null)
  const [failed, setFailed] = useState<{ text: string; note: string; retry: boolean } | null>(null)
  // Which provider the next turn runs on, and its current catalog, shared by
  // chat and composer. The server re-validates every selection at send time.
  const { catalog } = useHarnessCatalog({ enabled, pollMs: 30_000 })
  const { selection, choose, request: selectionField, sendable } = useAgentSelection(catalog)
  const [reasoningChoice, setReasoningChoice] = useState<{ key: string; effort: HarnessReasoningEffort } | null>(null)
  const reasoningKey = selection.status === "instance" ? `${selection.instance.id}:${selection.model.id}` : ""
  const reasoningEfforts = selection.status === "instance" && (selection.instance.driver === "codex" || selection.instance.driver === "opencode") ? selection.model.reasoningEfforts ?? [] : []
  const reasoningEffort = reasoningChoice && reasoningChoice.key === reasoningKey && reasoningEfforts.includes(reasoningChoice.effort) ? reasoningChoice.effort : undefined
  const chooseReasoning = (effort: HarnessReasoningEffort | undefined) => setReasoningChoice(effort && reasoningKey ? { key: reasoningKey, effort } : null)

  const refreshProposals = () => { if (businessId !== null) void Agent.proposals(businessId).then(r => { if (mounted.current) setProposals(r.proposals) }).catch(() => {}) }

  useEffect(() => {
    mounted.current = true
    if (!enabled || businessId === "") return () => { mounted.current = false }
    let live = true
    setMessages([]); setConversationId(undefined); setRevision(0); setReady(false); setFailed(null); setUnavailable(null); setProposals([])
    void Agent.load(businessId, requestedConversationId).then(async r => {
      if (!r.conversation && !requestedConversationId && live) r = await Agent.create(businessId, crypto.randomUUID())
      if (!live) return
      if (!r.conversation) { setUnavailable("This conversation is no longer available"); return }
      if (r.conversation) {
        setConversationId(r.conversation.id); setRevision(r.conversation.revision)
        setMessages(toDisplayMessages(r.conversation.messages))
      }
      setReady(true)
    }).catch(e => { if (live) setUnavailable(unavailableText(e)) })
    if (businessId !== null) void Agent.proposals(businessId).then(r => { if (live) setProposals(r.proposals) }).catch(() => {})
    return () => { live = false; mounted.current = false }
  }, [businessId, enabled, requestedConversationId])

  // A turn can settle while its chat is not on screen — it was left mid-turn
  // and the reply is written by the mount that sent it. A mount that opened
  // during the turn holds the pre-send snapshot; when the pending activity for
  // this conversation goes quiet, pull the settled thread once.
  const pendingWorking = conversationId === undefined ? undefined : activity.activity.get(conversationId)?.working
  useEffect(() => {
    if (conversationId === undefined || businessId === "" || pendingWorking !== false) return
    let live = true
    void Agent.load(businessId, conversationId).then(r => {
      if (!live || !r.conversation) return
      setRevision(r.conversation.revision)
      setMessages(toDisplayMessages(r.conversation.messages))
    }).catch(() => {})
    return () => { live = false }
  }, [businessId, conversationId, pendingWorking])

  const send = (text: string) => {
    if (pending.current || !ready || !conversationId) return
    // A turn cannot start on a selection known to be missing; the server has
    // the final word on anything else.
    if (selection.status === "unavailable" || selection.status === "unset") return
    pending.current = true; setBusy(true); setFailed(null)
    const requestId = crypto.randomUUID()
    // The working indicator in the chat history shows which provider is on it.
    // A still-loading catalog sends nothing explicit, so the server's hosted
    // default answers and the fallback logo says so.
    const providerTag = selection.status === "hosted" ? selection.provider : selection.status === "instance" ? selection.instance.driver : "gemini"
    activity.start(businessId, requestId, "New chat", conversationId, providerTag)
    setMessages(m => [...m, { id: uid(), role: "user", text }, { id: uid(), role: "agent", text: "Working…", pending: true }])
    const turnSelection = selectionField && reasoningEffort ? { ...selectionField, reasoningEffort } : selectionField
    void Agent.send(businessId, text, requestId, revision, conversationId, turnSelection).then(r => {
      activity.finish(businessId, requestId, true, r.provider, r.title)
      notifyAgentChats()
      if (!mounted.current) return
      setConversationId(r.conversationId); setRevision(r.revision)
      setMessages(m => [...m.slice(0, -1), { id: uid(), role: "agent", text: r.reply, tools: r.toolCalls, citations: r.citations, provider: r.provider, ...(r.requestedModel ? { model: r.requestedModel } : {}) }])
      refreshProposals()
    }).catch((e: unknown) => {
      activity.finish(businessId, requestId, false)
      if (!mounted.current) return
      setMessages(m => m.slice(0, -1))
      setFailed({ text, note: notSentText(e), retry: !(e instanceof ApiError && (e.status === 409 || e.body["reason"] === "UNCONFIGURED")) })
      refreshProposals()
      void Agent.load(businessId, conversationId).then(r => {
        if (mounted.current && r.conversation && r.conversation.revision > revision) {
          setConversationId(r.conversation.id); setRevision(r.conversation.revision)
          setMessages(toDisplayMessages(r.conversation.messages))
        }
      }).catch(() => {})
    }).finally(() => { pending.current = false; if (mounted.current) setBusy(false) })
  }
  const clear = () => {
    if (pending.current) return
    pending.current = true; setBusy(true)
    void Agent.clear(businessId, conversationId).then(async () => {
      activity.forget(businessId, conversationId)
      notifyAgentChats()
      const { conversation } = await Agent.create(businessId, crypto.randomUUID())
      if (mounted.current) void navigate(chatPath({ businessId, id: conversation.id }))
    }).catch(() => { if (mounted.current) toast.error("Couldn't delete the conversation. Try again.") }).finally(() => { pending.current = false; if (mounted.current) setBusy(false) })
  }
  // Sends the message that got no reply again, in place of the unanswered copy.
  const retry = () => {
    if (!failed || pending.current) return
    const text = failed.text
    setMessages(m => m.length && m[m.length - 1]!.role === "user" ? m.slice(0, -1) : m)
    send(text)
  }

  const startNew = () => {
    if (pending.current) return
    pending.current = true; setBusy(true)
    void Agent.create(businessId, crypto.randomUUID()).then(({ conversation }) => {
      void navigate(chatPath({ businessId, id: conversation.id }))
    }).catch(() => { if (mounted.current) toast.error("Couldn't start a new chat. Try again.") })
      .finally(() => { pending.current = false; if (mounted.current) setBusy(false) })
  }

  // Asks the server to stop the turn in flight; the pending send settles on
  // its own once the backend records the cancellation.
  const stopTurn = () => {
    if (!pending.current) return
    void Agent.cancel(businessId, conversationId).catch(() => {
      if (mounted.current) toast.error("Couldn't stop the agent. Try again.")
    })
  }

  // Work the agent produced: proposals to decide on, accepted drafts, and the
  // turns where it read stored evidence.
  const openProposals = proposals.filter(p => p.status === "PROPOSED")
  const keptDrafts = proposals.filter(p => p.status === "APPROVED" && p.kind !== "REQUEST_CHECK")
  const reads = messages.flatMap((m, i) => m.role === "agent" && !m.pending && ((m.tools?.length ?? 0) > 0 || (m.citations?.length ?? 0) > 0)
    ? [{ id: m.id, question: messages[i - 1]?.role === "user" ? messages[i - 1]!.text : null, tools: m.tools ?? [], citations: m.citations ?? [] }]
    : [])
  const hasWork = openProposals.length > 0 || keptDrafts.length > 0 || reads.length > 0

  return { businessId, messages, proposals, openProposals, keptDrafts, reads, hasWork, ready, busy, failed, unavailable, active: messages.length > 0, send, retry, clear, startNew, stopTurn, refreshProposals, catalog, selection, choose, sendable, reasoningEfforts, reasoningEffort, chooseReasoning }
}

function ProposalCard({ session, businessName, proposal }: { session: AgentSession; businessName: string; proposal: AgentProposal }) {
  if (session.businessId === null) return null
  const done = session.refreshProposals
  return proposal.kind === "REQUEST_CHECK"
    ? <CheckProposal businessId={session.businessId} businessName={businessName} proposal={proposal} onDone={done} />
    : proposal.kind === "REQUEST_ACQUISITION_BATCH" ? <AcquisitionProposal businessId={session.businessId} proposal={proposal} onDone={done} />
    : <SavedDraft businessId={session.businessId} proposal={proposal} onDone={done} />
}

// ---- the conversation ----

function Thread({ session, compact, placeholder, onCommand, work, context }: {
  session: AgentSession; compact?: boolean; placeholder: string; onCommand: (c: AgentCommand) => void; work?: ReactNode; context?: AgentChatContext | null
}) {
  // Scroll only the thread itself: scrollIntoView would also shift the clipped
  // panes around it while they slide.
  const scrollRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = scrollRef.current
    el?.scrollTo({ top: el.scrollHeight, behavior: "smooth" })
  }, [session.messages])
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        <div className={cn("mx-auto w-full max-w-3xl", compact ? "px-4 py-4" : "px-4 py-6 sm:px-6")}>
          {session.active ? (
            <ol aria-live="polite" className="space-y-3">
              {session.messages.map((m) => (
                <li key={m.id} className={cn("group/msg flex flex-col gap-1", m.role === "user" ? "items-end" : "items-start")}>
                  {m.role === "user" ? (
                    m.text ? <p className="max-w-[85%] rounded-2xl bg-muted px-4 py-2.5 text-base leading-relaxed whitespace-pre-wrap">{m.text}</p> : null
                  ) : (
                    <div className="max-w-[95%] space-y-1.5">
                      {m.pending ? (
                        <p className="thinking text-base leading-relaxed" role="status">{m.text}</p>
                      ) : (
                        <p className="text-base leading-relaxed whitespace-pre-wrap text-foreground/80">{m.text}</p>
                      )}
                      {m.citations?.length ? <ul className="flex flex-wrap gap-2" aria-label="Evidence references">{m.citations.map(c => {
                        const path = session.businessId === null ? null : agentEvidencePath(session.businessId, c)
                        return <li key={`${c.kind}:${c.id}`} className="text-xs">{path ? <Link className="underline underline-offset-2" to={path}>{c.text || "Open evidence"}</Link> : <span>Evidence unavailable</span>}</li>
                      })}</ul> : null}
                      {m.tools && m.tools.length > 0 ? (
                        <p className="text-[0.6875rem] text-muted-foreground">{m.tools.map((t) => t.summary).join("; ")}</p>
                      ) : null}
                    </div>
                  )}
                  <CopyButton text={m.text} className={m.role === "user" ? "-mr-1.5" : "-ml-1.5"} />
                </li>
              ))}
            </ol>
          ) : null}
          {session.failed ? (
            <p role="status" className="pt-1 text-right text-[0.6875rem] text-muted-foreground">
              {session.failed.note}
              {session.failed.retry ? (
                <>
                  {" · "}
                  <button type="button" className="font-medium text-foreground underline-offset-2 hover:underline disabled:opacity-50" disabled={session.busy} onClick={session.retry}>Retry</button>
                </>
              ) : null}
            </p>
          ) : null}
          {work ? <div className="pt-6">{work}</div> : null}
        </div>
      </div>
      <div className={cn("mx-auto w-full max-w-3xl shrink-0", compact ? "px-3 pb-1" : "px-4 pb-1 sm:px-6")}>
        <Composer
          onSend={session.send}
          onCommand={onCommand}
          disabled={session.busy || !session.ready}
          modelBlocked={!session.sendable}
          placeholder={composerPlaceholder(session, placeholder)}
          autoFocus
          session={session}
          context={context ?? null}
        />
      </div>
    </div>
  )
}

// ---- what the agent did: decisions, drafts, and the evidence it read ----

function WorkPane({ session, businessName, reads = true }: { session: AgentSession; businessName: string; reads?: boolean }) {
  return (
    <div className="space-y-5">
      {session.openProposals.length ? (
        <section className="space-y-2" aria-label="Waiting for your decision">
          <h3 className="flex items-center gap-1.5 text-xs font-medium">
            <span aria-hidden className="size-1.5 rounded-full bg-review" />
            Waiting for your decision · {session.openProposals.length}
          </h3>
          {session.openProposals.map(p => <ProposalCard key={p.id} session={session} businessName={businessName} proposal={p} />)}
        </section>
      ) : null}
      {session.keptDrafts.length ? (
        <section className="space-y-2" aria-label="Accepted drafts">
          <h3 className="text-xs font-medium">Accepted drafts · {session.keptDrafts.length}</h3>
          {session.keptDrafts.map(p => <ProposalCard key={p.id} session={session} businessName={businessName} proposal={p} />)}
        </section>
      ) : null}
      {reads && session.reads.length ? (
        <section className="space-y-2" aria-label="What the agent read">
          <h3 className="text-xs font-medium">What the agent read</h3>
          <ol className="space-y-2">
            {[...session.reads].reverse().map(r => (
              <li key={r.id} className="rounded-xl bg-card p-3.5 text-xs shadow-(--card-shadow)">
                {r.question ? <p className="mb-2 line-clamp-2 font-medium">“{r.question}”</p> : null}
                {r.tools.length ? (
                  <ul className="space-y-1 text-muted-foreground">
                    {r.tools.map((t, i) => (
                      <li key={i} className="flex gap-2">
                        <CheckIcon className="mt-0.5 size-3 shrink-0 text-primary-ink" />
                        <span className="min-w-0">{t.summary}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
                {r.citations.length ? (
                  <ul className="mt-2 flex flex-wrap gap-1.5 border-t pt-2" aria-label="Evidence used">
                    {r.citations.map(c => {
                      const path = session.businessId === null ? null : agentEvidencePath(session.businessId, c)
                      return (
                        <li key={`${c.kind}:${c.id}`}>
                          {path ? (
                            <Link to={path} className="inline-flex max-w-full items-center gap-1 rounded-md bg-muted/60 px-2 py-0.5 hover:bg-muted">
                              <FileTextIcon className="size-3 shrink-0" />
                              <span className="truncate">{c.text || "Open evidence"}</span>
                            </Link>
                          ) : <span className="text-muted-foreground">Evidence unavailable</span>}
                        </li>
                      )
                    })}
                  </ul>
                ) : null}
              </li>
            ))}
          </ol>
        </section>
      ) : null}
    </div>
  )
}

// Without a title it is just the conversation's controls, top right. Close is
// for narrow screens, where the chat covers the page.
function ConversationHeader({ title, onClose, closeLabel = "Close the agent", closeIcon = <XIcon className="size-3.5" /> }: {
  title?: ReactNode; onClose?: () => void; closeLabel?: string; closeIcon?: ReactNode
}) {
  if (!title && !onClose) return null
  return (
    <div className={cn("flex shrink-0 items-center gap-2", title ? "h-11 border-b px-4" : "h-12 justify-end px-3")}>
      {title ? (
        <>
          <span className="flex size-6 items-center justify-center rounded-md bg-primary-ink/10 text-primary-ink"><SparklesIcon className="size-3.5" /></span>
          <span className="min-w-0 flex-1 truncate text-xs font-medium">{title}</span>
        </>
      ) : null}
      {onClose ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" className="size-7 text-muted-foreground lg:hidden" onClick={onClose} aria-label={closeLabel}>
              {closeIcon}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{closeLabel}</TooltipContent>
        </Tooltip>
      ) : null}
    </div>
  )
}

// The split panes and the sidebar move together on one curve.
const SPLIT_MOTION = "duration-500 ease-[cubic-bezier(0.22,1,0.36,1)]"

// Keeps a sliding pane's contents mounted until its closing transition ends,
// so it slides away instead of emptying first.
function useSlidePresence(open: boolean) {
  const [present, setPresent] = useState(open)
  if (open && !present) setPresent(true)
  const onTransitionEnd = (e: TransitionEvent<HTMLElement>) => {
    if (e.target === e.currentTarget && e.propertyName === "flex-basis" && !open) setPresent(false)
  }
  return { present: open || present, onTransitionEnd }
}

// The chat as its own card on the canvas, left of the content panel, the way
// the sidebar sits. It grows in to half the width; on narrow screens it takes
// the whole width and the content panel steps aside.
function AgentPane({ open, session, placeholder, onClose, closeLabel, closeIcon, onCommand, context }: {
  open: boolean; session: AgentSession; placeholder: string
  onClose: () => void; closeLabel?: string; closeIcon?: ReactNode
  onCommand: (c: AgentCommand) => void
  context?: AgentChatContext | null
}) {
  const pane = useSlidePresence(open)
  const { slot, setPane } = usePaneSlot()
  useEffect(() => {
    setPane(open)
    return () => setPane(false)
  }, [open, setPane])
  if (!slot) return null
  return createPortal(
    <aside
      aria-label="Agent"
      aria-hidden={!open}
      inert={!open}
      onTransitionEnd={pane.onTransitionEnd}
      className={cn(
        "flex h-svh min-w-0 shrink-0 justify-end overflow-hidden transition-[flex-basis,visibility]",
        SPLIT_MOTION,
        open ? "visible basis-full lg:basis-1/2" : "invisible basis-0",
      )}
    >
      {/* Laid out at its final width and revealed as the pane grows, so it
          slides in from the left rather than reflowing. */}
      <div className="flex h-full w-[100cqw] shrink-0 flex-col p-2 md:pl-0 lg:w-[50cqw]">
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-sidebar-border bg-background shadow-(--panel-shadow)">
          {pane.present ? (
            <>
              <ConversationHeader onClose={onClose} {...(closeLabel ? { closeLabel } : {})} {...(closeIcon ? { closeIcon } : {})} />
              <Thread session={session} compact placeholder={placeholder} onCommand={onCommand} context={context ?? null} />
            </>
          ) : null}
        </div>
      </div>
    </aside>,
    slot,
  )
}

// ---- overview: the agent is the page ----

// Replies, work and evidence remain in one conversation column.
export function AgentChat(props: { businessId: string | null; businessName: string; onConversationChange?: (active: boolean) => void }) {
  const [searchParams] = useSearchParams()
  return <OverviewAgent key={`${props.businessId}:${searchParams.get("chat") ?? "current"}`} {...props} />
}

function OverviewAgent({ businessId, businessName, onConversationChange = () => undefined }: { businessId: string | null; businessName: string; onConversationChange?: (active: boolean) => void }) {
  const session = useAgentSession(businessId)
  const runCommand = (command: AgentCommand) => session.send(`/${command}`)
  const { setMinimal, setWorkspace } = useChrome()
  const active = session.active

  useEffect(() => onConversationChange(active), [active, onConversationChange])
  useEffect(() => {
    setWorkspace(true)
    return () => setWorkspace(false)
  }, [setWorkspace])
  useEffect(() => {
    setMinimal(active)
    return () => setMinimal(false)
  }, [active, setMinimal])

  if (!active) {
    return (
      <div className="flex h-full min-h-0 flex-1 flex-col items-center px-4 sm:px-6">
        <div aria-label="Agent proposals" className="min-h-0 w-full flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-3xl space-y-4 py-6">
            {session.openProposals.map(p => <ProposalCard key={p.id} session={session} businessName={businessName} proposal={p} />)}
          </div>
        </div>
        <div className="w-full max-w-3xl shrink-0 pb-2">
          <Composer
            onSend={session.send}
            onCommand={runCommand}
            disabled={!session.ready || session.busy}
            modelBlocked={!session.sendable}
            placeholder={composerPlaceholder(session, session.unavailable ? `${session.unavailable}. Type / for commands` : "Describe a task or ask a question")}
            autoFocus
            session={session}
            context={chatContext(businessId, businessName)}
          />
        </div>
      </div>
    )
  }

  return (
    <section aria-label="Conversation" className="flex h-full min-h-0 flex-col">
      <Thread session={session} placeholder="Reply to the agent, or type / for commands" onCommand={runCommand}
        context={chatContext(businessId, businessName)}
        work={session.hasWork ? <WorkPane session={session} businessName={businessName} /> : null} />
    </section>
  )
}

// ---- a page with its own content: the agent works beside it ----

// Opens the agent as a card left of a page's content, with the sidebar
// collapsed. Anything the agent prepared shows above the content. Closed, the
// content renders unchanged.
export function AgentWorkspace({ open, onClose, businessId, businessName, children }: {
  open: boolean; onClose: () => void; businessId: string; businessName: string; children: ReactNode
}) {
  const session = useAgentSession(businessId, open)
  const runCommand = (command: AgentCommand) => session.send(`/${command}`)
  const { setWorkspace, setFocus } = useChrome()
  // The page always scrolls in its own pane, so opening the agent only moves
  // the divider; nothing jumps or loses its scroll position.
  useEffect(() => {
    setWorkspace(true)
    return () => setWorkspace(false)
  }, [setWorkspace])
  useEffect(() => {
    setFocus(open)
    return () => setFocus(false)
  }, [open, setFocus])
  const decisions = session.openProposals.length + session.keptDrafts.length
  return (
    <>
      <AgentPane open={open} session={session} placeholder={`Ask about ${businessName}`} onClose={onClose} onCommand={runCommand}
        context={{ kind: "client", name: businessName }} />
      <div className="h-full min-h-0 overflow-y-auto">
        <div className="mx-auto w-full max-w-[1400px] px-4 pt-6 pb-10 sm:px-6 lg:px-10 lg:pt-8">
          {open && decisions ? (
            <section aria-label="From the agent" className="mb-4 space-y-2 rounded-xl border border-primary-ink/20 bg-primary-ink/5 p-4 animate-in fade-in duration-300">
              <p className="flex items-center gap-1.5 text-xs font-medium"><SparklesIcon className="size-3.5 text-primary-ink" />From the agent</p>
              <WorkPane session={session} businessName={businessName} reads={false} />
            </section>
          ) : null}
          {children}
        </div>
      </div>
    </>
  )
}

function CopyButton({ text, className }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false)
  if (!text) return null
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className={cn("size-7 text-muted-foreground opacity-0 transition-opacity group-hover/msg:opacity-100 focus-visible:opacity-100", className)}
          aria-label="Copy message"
          onClick={() => {
            void navigator.clipboard.writeText(text).then(() => {
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            })
          }}
        >
          {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{copied ? "Copied" : "Copy"}</TooltipContent>
    </Tooltip>
  )
}

// Composer copy that explains why typing is disabled without pretending:
// unreachable agent, or a selection known to be missing.
function composerPlaceholder(session: AgentSession, fallback: string): string {
  if (session.selection.status === "unavailable") return "The model you used is unavailable now — pick another model below"
  if (session.selection.status === "unset") return "Pick a model for the agent below"
  return session.unavailable ?? fallback
}

// The business or client chosen when the chat started, shown in the composer
// tray's left side while the model sits on the right.
export function AgentContextChip({ context }: { context: AgentChatContext }) {
  const icon = <FolderIcon className="size-3.5 shrink-0" aria-hidden />
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span aria-label={`Chatting about ${context.name}`} className="inline-flex max-w-56 min-w-0 items-center gap-1 text-xs text-muted-foreground">
          {icon}
          <span className="truncate">{context.name}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent>Chatting about {context.name}</TooltipContent>
    </Tooltip>
  )
}

// The model picker shown in every agent layout's composer tray. It lists the
// hosted default when configured, then enabled ready models per provider, and
// a path to Settings → Agent to manage providers. Locked while a turn is in
// flight.
function ModelSelector({ session, locked }: { session: AgentSession; locked: boolean }) {
  const { openSettings } = useSettings()
  const { catalog, selection, choose } = session
  const options = catalog ? modelOptions(catalog) : []
  const value = selectionValue(selection, options)
  const unavailable = selection.status === "unavailable"
  return (
    <AgentModelPicker options={options} value={value} label={selectionLabel(selection)} checking={catalog === null} unavailable={unavailable} locked={locked}
      onManage={() => openSettings("agent")}
      onChoose={option => {
        if (option.kind === "instance") {
          return choose({ target: "instance", instanceId: option.instance.id, model: option.model.id })
        }
        return choose({ target: "hosted" })
      }}
    />
  )
}

function Composer({
  onSend,
  onCommand,
  placeholder,
  autoFocus,
  disabled,
  session,
  modelBlocked,
  context,
}: {
  onSend: (text: string) => void
  /** Slash commands run as conversational turns through the selected agent. */
  onCommand?: ((command: AgentCommand) => void) | undefined
  disabled: boolean
  placeholder: string
  autoFocus?: boolean
  /** Present in agent layouts: enables the model selector and the stop button. */
  session?: AgentSession
  /** No usable selection: ordinary messages are gated, commands still run. */
  modelBlocked?: boolean
  /** The business or client this conversation was started with, if any. */
  context?: AgentChatContext | null
}) {
  // While a turn is in flight the composer shows Stop instead of Send and the
  // model selection is locked until the server settles the turn.
  const inFlight = session?.busy ?? false
  const { preferences } = usePreferences()
  const { openSettings } = useSettings()
  const [text, setText] = useState("")
  const [listening, setListening] = useState(false)
  const textRef = useRef<HTMLTextAreaElement>(null)
  const recognitionRef = useRef<Recognition | null>(null)
  const baseTextRef = useRef("")

  useEffect(() => () => recognitionRef.current?.stop(), [])

  const command = onCommand ? parseCommand(text) : null
  const matches = onCommand ? commandMatches(text) : []
  const [menuIndex, setMenuIndex] = useState(0)
  const menuOpen = matches.length > 0
  const canSend = !disabled && !modelBlocked && text.trim().length > 0 && text.trim().length <= 4000

  const run = (c: AgentCommand) => {
    if (disabled || modelBlocked) {
      toast.error(modelBlocked ? "Choose an available model before running a command." : "Wait for the current turn to finish.")
      return
    }
    recognitionRef.current?.stop()
    onCommand?.(c)
    setText("")
    setMenuIndex(0)
    textRef.current?.focus()
  }
  const submit = () => {
    if (menuOpen && !command) return run(matches[Math.min(menuIndex, matches.length - 1)]!.key)
    if (!canSend) return
    if (command) return run(command)
    recognitionRef.current?.stop()
    onSend(text.trim())
    setText("")
    textRef.current?.focus()
  }

  const toggleMic = () => {
    if (listening) {
      recognitionRef.current?.stop()
      return
    }
    const rec = createRecognition()
    if (!rec) {
      toast.error("Voice input is not available", { description: "This browser does not support speech recognition. Try Chrome or Safari." })
      return
    }
    rec.continuous = true
    rec.interimResults = true
    rec.lang = navigator.language || "en-US"
    baseTextRef.current = text ? `${text.trimEnd()} ` : ""
    rec.onresult = (e) => {
      let transcript = ""
      for (let i = 0; i < e.results.length; i++) transcript += e.results[i]?.[0]?.transcript ?? ""
      setText(baseTextRef.current + transcript)
    }
    rec.onerror = (e) => {
      if (e.error === "not-allowed") toast.error("Microphone access is blocked", { description: "Allow microphone access for this site, then try again." })
    }
    rec.onend = () => {
      setListening(false)
      recognitionRef.current = null
      textRef.current?.focus()
    }
    recognitionRef.current = rec
    rec.start()
    setListening(true)
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
      onDragOver={e => e.preventDefault()}
      onDrop={e => { e.preventDefault(); toast.error("Attachments are not supported. Paste relevant text instead.") }}
      className="w-full space-y-0.5"
    >
      <div
        onClick={(e) => {
          // The whole box behaves like the input: clicking padding focuses it.
          if (e.target === e.currentTarget) textRef.current?.focus()
        }}
        className="relative flex min-h-12 cursor-text items-end gap-3 rounded-xl border border-border bg-[#fafafa] px-3 py-2 transition-colors focus-within:border-foreground/25 dark:border-[#383838] dark:bg-[#262626]"
      >
        {menuOpen ? (
          <ul role="listbox" aria-label="Commands" className="absolute inset-x-2 bottom-full z-10 mb-2 overflow-hidden rounded-xl border bg-popover p-1 text-left shadow-(--float-shadow-strong)">
            {matches.map((c, i) => (
              <li key={c.key} role="option" aria-selected={i === menuIndex}>
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => run(c.key)}
                  onMouseEnter={() => setMenuIndex(i)}
                  className={cn("flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-xs [&_svg]:size-3.5 [&_svg]:text-muted-foreground", i === menuIndex && "bg-accent")}
                >
                  {c.icon}
                  <span className="font-medium">/{c.key}</span>
                  <span className="truncate text-muted-foreground">{c.description}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="ghost" size="icon-sm" className="size-8 shrink-0 self-end rounded-md text-muted-foreground hover:text-foreground" aria-label="Chat actions" disabled={inFlight}>
              <PlusIcon className="size-5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="top" sideOffset={12}>
            {onCommand ? COMMANDS.map(c => (
              <DropdownMenuItem key={c.key} onSelect={() => run(c.key)}>{c.icon}<span>/{c.key}</span><span className="ml-2 text-muted-foreground">{c.description}</span></DropdownMenuItem>
            )) : null}
            {onCommand ? <DropdownMenuSeparator /> : null}
            <DropdownMenuItem onSelect={() => openSettings("agent")}>Manage providers</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <label htmlFor="agent-input" className="sr-only">
          Message the agent
        </label>
        <textarea
          id="agent-input"
          ref={textRef}
          autoFocus={autoFocus}
          rows={1}
          value={text}
          onChange={(e) => setText(e.currentTarget.value)}
          disabled={disabled && !onCommand}
          aria-expanded={onCommand ? menuOpen : undefined}
          aria-autocomplete={onCommand ? "list" : undefined}
          maxLength={4000}
          onPaste={e => { if (e.clipboardData.files.length) { e.preventDefault(); toast.error("Attachments are not supported. Paste relevant text instead.") } }}
          onKeyDown={(e) => {
            if (menuOpen && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
              e.preventDefault()
              setMenuIndex(i => (i + (e.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length)
              return
            }
            if (menuOpen && e.key === "Tab") {
              e.preventDefault()
              setText(`/${matches[Math.min(menuIndex, matches.length - 1)]!.key}`)
              return
            }
            if (menuOpen && e.key === "Escape") {
              e.preventDefault()
              setText("")
              return
            }
            if (menuOpen && e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit()
              return
            }
            const sendCombo = preferences.enterToSend ? !e.shiftKey && !e.metaKey && !e.ctrlKey : e.metaKey || e.ctrlKey
            if (e.key === "Enter" && (sendCombo || command !== null) && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit()
            } else if (e.key === "Escape" && listening) {
              recognitionRef.current?.stop()
            }
          }}
          placeholder={listening ? "Listening" : placeholder}
          className="field-sizing-content block max-h-48 min-h-6 min-w-0 flex-1 resize-none overflow-y-auto bg-transparent py-1 text-base leading-6 outline-none [scrollbar-width:none] [&::-webkit-scrollbar]:hidden placeholder:text-muted-foreground"
        />

        <div className="flex shrink-0 self-end items-center gap-1">
          {preferences.voiceInput && !inFlight ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button type="button" variant="ghost" size="icon-sm"
                  className={cn("size-8 rounded-md text-muted-foreground hover:text-foreground", listening && "bg-wrong-soft text-wrong hover:bg-wrong-soft hover:text-wrong")}
                  onClick={toggleMic} aria-label={listening ? "Stop voice input" : "Start voice input"} aria-pressed={listening}>
                  {listening ? <SquareIcon className="size-4 fill-current" /> : <MicIcon className="size-5" />}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{listening ? "Stop voice input" : "Voice input"}</TooltipContent>
            </Tooltip>
          ) : null}
          {inFlight && session ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="secondary"
                  size="icon-sm"
                  className="rounded-full"
                  onClick={session.stopTurn}
                  aria-label="Stop the agent"
                >
                  <SquareIcon className="size-3.5 fill-current" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Stop the agent</TooltipContent>
            </Tooltip>
          ) : text.trim().length > 0 ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span>
                  <Button
                    type="submit"
                    size="icon-sm"
                    className="rounded-full bg-primary text-primary-foreground hover:bg-primary/90 disabled:bg-primary disabled:text-primary-foreground disabled:opacity-50"
                    disabled={!canSend}
                    aria-label="Send message"
                  >
                    <ArrowUpIcon />
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent>{preferences.enterToSend ? "Send (Enter). Shift Enter adds a new line." : `Send (${modKey} Enter). Enter adds a new line.`}</TooltipContent>
            </Tooltip>
          ) : null}
        </div>
      </div>
      <div role="toolbar" aria-label="Chat options" className="flex min-h-6 flex-wrap items-center justify-between gap-x-4 gap-y-0.5 px-3 py-0 text-sm">
        {listening ? <span role="status" className="text-wrong">Listening</span> : null}
        {context ? (
          <NewChatDialog
            trigger={
              <button type="button" title={`Change the business or client — now chatting about ${context.name}`} aria-label={`Change the business or client — now chatting about ${context.name}`} className="max-w-56 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50" disabled={inFlight}>
                <AgentContextChip context={context} />
              </button>
            }
          />
        ) : null}
        {session ? <div className="ml-auto flex flex-wrap items-center gap-3">
          <ModelSelector session={session} locked={inFlight} />
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <Select value={session.reasoningEffort ?? "default"} disabled={inFlight || session.reasoningEfforts.length === 0} onValueChange={value => {
              if (value === "default") return session.chooseReasoning(undefined)
              const effort = session.reasoningEfforts.find(effort => effort === value)
              if (effort) session.chooseReasoning(effort)
            }}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex" tabIndex={session.reasoningEfforts.length === 0 ? 0 : undefined}>
                    <SelectTrigger aria-label="Reasoning effort" className="h-auto w-auto gap-1 border-0 bg-transparent p-0 text-xs text-muted-foreground shadow-none disabled:opacity-100"><SelectValue>{session.reasoningEffort ?? "Reasoning"}</SelectValue></SelectTrigger>
                  </span>
                </TooltipTrigger>
                <TooltipContent>{session.reasoningEfforts.length ? "Reasoning effort for the next reply" : "This provider hasn't reported reasoning controls for this model."}</TooltipContent>
              </Tooltip>
              <SelectContent side="top" align="end">
                <SelectItem value="default">Default</SelectItem>
                {session.reasoningEfforts.map(effort => <SelectItem key={effort} value={effort}>{effort === "xhigh" ? "Extra high" : effort === "none" ? "Off" : effort.charAt(0).toUpperCase() + effort.slice(1)}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </div> : null}
      </div>
    </form>
  )
}

function CheckProposal({ businessId, businessName, proposal, onDone }: { businessId: string; businessName: string; proposal: AgentProposal; onDone: () => void }) {
  const [models, setModels] = useState<readonly string[]>([])
  const [model, setModel] = useState("")
  const [prompt, setPrompt] = useState<string | null>(null)
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    void Providers.list().then(r => { if (live) setModels(r.providers.find(p => p.id === "9router" && p.enabled)?.models ?? []) }).catch(() => {})
    void Questions.list(businessId).then(r => { if (live) setPrompt(r.questions.find(q => q.id === proposal.questionId)?.prompt ?? null) }).catch(() => {})
    return () => { live = false }
  }, [businessId, proposal.questionId])
  const decide = async (approve: boolean) => {
    setWorking(true); setError(null)
    try { if (approve) await Agent.approve(businessId, proposal.id, model); else await Agent.reject(businessId, proposal.id); onDone() }
    catch { setError("The proposal could not be updated. Reload its current status before trying again.") }
    finally { setWorking(false) }
  }
  return <section className="space-y-2 rounded-xl border bg-card p-4 text-xs" aria-label="Re-check proposal">
    <p className="font-medium">Proposed re-check for {businessName}</p>
    <p>{prompt ?? "Question unavailable"}</p><p>{proposal.message}</p>
    <p>Approval queues one external measurement call using 9Router and the exact model you select. Estimated cost is unavailable; provider charges may apply. No fact or judgment is approved.</p>
    <Select value={model} onValueChange={setModel}><SelectTrigger aria-label="Measurement model"><SelectValue placeholder="Choose a measurement model" /></SelectTrigger><SelectContent>{models.map(m => <SelectItem key={m} value={m}>{m}</SelectItem>)}</SelectContent></Select>
    {!models.length ? <p>No supported measurement model is configured. This proposal cannot run here.</p> : null}
    <div className="flex gap-2"><Button size="sm" disabled={working || !prompt || !models.includes(model)} onClick={() => void decide(true)}>Approve and queue check</Button><Button size="sm" variant="outline" disabled={working} onClick={() => void decide(false)}>Reject</Button></div>
    {error ? <p role="alert">{error}</p> : null}
  </section>
}

function SavedDraft({ businessId, proposal, onDone }: { businessId: string; proposal: AgentProposal; onDone: () => void }) {
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const decide = async (accept: boolean) => {
    setWorking(true); setError(null)
    try { if (accept) await Agent.acceptDraft(businessId, proposal.id); else await Agent.reject(businessId, proposal.id); onDone() }
    catch { setError("This draft could not be updated. It may have expired or its evidence context changed. Reload before continuing.") }
    finally { setWorking(false) }
  }
  return <section aria-label="Saved private draft" className="group/msg space-y-3 rounded-xl border bg-card p-4 text-xs">
    <p className="font-medium">{proposal.kind === "PREPARE_CLIENT_REPORT" ? "Private client report" : proposal.kind === "PROPOSE_QUESTION_SET" ? "Buyer-question proposal" : "Source action hypothesis"} ({proposal.status === "APPROVED" ? "accepted" : "awaiting review"})</p>
    <p>{proposal.message}</p>
    {proposal.payload ? <>
      <p className="text-muted-foreground">Snapshot prepared {proposal.payload.generatedAt}. Accepting this draft does not publish, deliver, execute or record completed work.</p>
      <p className="max-h-96 overflow-auto whitespace-pre-wrap leading-relaxed">{proposal.payload.text}</p>
      <CopyButton text={proposal.payload.text} />
      <ul className="flex flex-wrap gap-2" aria-label="Draft evidence">{proposal.payload.references.map(c => {
        const path = agentEvidencePath(businessId, c)
        return <li key={`${c.kind}:${c.id}`}>{path ? <Link to={path} className="underline">{c.text}</Link> : <span>Evidence unavailable</span>}</li>
      })}</ul>
    </> : <p>Draft evidence unavailable</p>}
    {proposal.status === "PROPOSED" ? <div className="flex gap-2"><Button size="sm" disabled={working || !proposal.payload} onClick={() => void decide(true)}>Accept draft</Button><Button variant="outline" size="sm" disabled={working} onClick={() => void decide(false)}>Reject</Button></div> : null}
    {error ? <p role="alert">{error}</p> : null}
  </section>
}

function AcquisitionProposal({ businessId, proposal, onDone }: { businessId: string; proposal: AgentProposal; onDone: () => void }) {
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const plan = proposal.payload?.measurementPlan
  const cost = plan?.estimatedMaxCostUsd
  const decide = async (approve: boolean) => {
    setWorking(true); setError(null)
    try { if (approve && cost !== null && cost !== undefined) await Agent.approveAcquisition(businessId, proposal.id, cost); else if (!approve) await Agent.reject(businessId, proposal.id); onDone() }
    catch { setError("The measurement was not approved here. Its configuration, cost or status may have changed. Reload before retrying.") }
    finally { setWorking(false) }
  }
  return <section aria-label="Acquisition measurement proposal" className="space-y-3 rounded-xl border bg-card p-4 text-xs">
    <p className="font-medium">Proposed acquisition measurement</p><p className="max-h-80 overflow-auto whitespace-pre-wrap">{proposal.payload?.text ?? "Measurement plan unavailable"}</p>
    {cost === null || cost === undefined ? <p>Approval is blocked until a measurement cost bound is configured and a new proposal is prepared.</p> : null}
    <div className="flex gap-2"><Button size="sm" disabled={working || !plan || cost === null || cost === undefined || !!plan.missingRequirements.length} onClick={() => void decide(true)}>Approve estimated USD {cost?.toFixed(2) ?? "unknown"} and queue</Button><Button size="sm" variant="outline" disabled={working} onClick={() => void decide(false)}>Reject</Button></div>
    {error ? <p role="alert">{error}</p> : null}
  </section>
}
