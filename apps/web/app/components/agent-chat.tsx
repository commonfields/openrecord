import { useEffect, useRef, useState, type ReactNode, type TransitionEvent } from "react"
import { toast } from "sonner"
import { ArrowUpIcon, CheckIcon, CopyIcon, FileTextIcon, MessageSquareIcon, MessageSquarePlusIcon, MicIcon, PanelRightIcon, SparklesIcon, SquareIcon, Trash2Icon, XIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { createPortal } from "react-dom"
import { useChrome, usePaneSlot } from "@/components/app-shell"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { modKey } from "@/components/settings-dialog"
import { usePreferences } from "@/lib/preferences"
import { Link } from "react-router"
import { Agent, ApiError, Providers, Questions, type AgentCitation, type AgentProposal } from "@/lib/api"
import { agentEvidencePath } from "@/lib/agent-evidence"
import { notifyAgentChats } from "@/lib/agent-chats"
import { Select, SelectTrigger, SelectContent, SelectItem, SelectValue } from "@/components/ui/select"
import { cn } from "@/lib/utils"

type Message = { id: string; role: "user" | "agent"; text: string; tools?: Array<{ tool: string; summary: string }>; citations?: AgentCitation[]; pending?: boolean }
// Failures stay out of the conversation: an unreachable agent shows in the
// composer's placeholder, and a message that got no reply is marked under it.
const unavailableText = (e: unknown) => e instanceof ApiError && e.body["reason"] === "UNCONFIGURED"
  ? "The agent isn't set up for this workspace yet"
  : "The agent isn't available right now"
const notSentText = (e: unknown) => e instanceof ApiError && e.status === 409
  ? "Changed in another tab. Reload to continue"
  : e instanceof ApiError && e.body["reason"] === "UNCONFIGURED" ? "Not sent. The agent isn't set up yet"
  : "Not sent"

let nextId = 0
const uid = () => `m${Date.now()}-${nextId++}`

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
export function useAgentSession(businessId: string, enabled = true) {
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

  const refreshProposals = () => void Agent.proposals(businessId).then(r => { if (mounted.current) setProposals(r.proposals) }).catch(() => {})

  useEffect(() => {
    mounted.current = true
    if (!enabled || !businessId) return () => { mounted.current = false }
    let live = true
    setMessages([]); setConversationId(undefined); setRevision(0); setReady(false); setFailed(null); setUnavailable(null); setProposals([])
    void Agent.load(businessId).then(r => {
      if (!live) return
      if (r.conversation) {
        setConversationId(r.conversation.id); setRevision(r.conversation.revision)
        setMessages(r.conversation.messages.map(m => ({ ...m, id: uid(), ...(m.toolCalls ? { tools: m.toolCalls } : {}) })))
      }
      setReady(true)
    }).catch(e => { if (live) setUnavailable(unavailableText(e)) })
    void Agent.proposals(businessId).then(r => { if (live) setProposals(r.proposals) }).catch(() => {})
    return () => { live = false; mounted.current = false }
  }, [businessId, enabled])

  const send = (text: string) => {
    if (pending.current || !ready) return
    pending.current = true; setBusy(true); setFailed(null)
    setMessages(m => [...m, { id: uid(), role: "user", text }, { id: uid(), role: "agent", text: "Thinking", pending: true }])
    void Agent.send(businessId, text, crypto.randomUUID(), revision, conversationId).then(r => {
      if (!mounted.current) return
      setConversationId(r.conversationId); setRevision(r.revision)
      setMessages(m => [...m.slice(0, -1), { id: uid(), role: "agent", text: r.reply, tools: r.toolCalls, citations: r.citations }])
      refreshProposals()
      notifyAgentChats()
    }).catch((e: unknown) => {
      if (!mounted.current) return
      setMessages(m => m.slice(0, -1))
      setFailed({ text, note: notSentText(e), retry: !(e instanceof ApiError && (e.status === 409 || e.body["reason"] === "UNCONFIGURED")) })
      refreshProposals()
      void Agent.load(businessId).then(r => {
        if (mounted.current && r.conversation && r.conversation.revision > revision) {
          setConversationId(r.conversation.id); setRevision(r.conversation.revision)
          setMessages(r.conversation.messages.map(m => ({ ...m, id: uid(), ...(m.toolCalls ? { tools: m.toolCalls } : {}) })))
        }
      }).catch(() => {})
    }).finally(() => { pending.current = false; if (mounted.current) setBusy(false) })
  }
  const clear = () => {
    if (pending.current) return
    pending.current = true; setBusy(true)
    void Agent.clear(businessId).then(() => {
      if (mounted.current) { setMessages([]); setConversationId(undefined); setRevision(0); setFailed(null); setReady(true) }
      notifyAgentChats()
    }).catch(() => { if (mounted.current) toast.error("Couldn't delete the conversation. Try again.") }).finally(() => { pending.current = false; if (mounted.current) setBusy(false) })
  }
  // Sends the message that got no reply again, in place of the unanswered copy.
  const retry = () => {
    if (!failed || pending.current) return
    const text = failed.text
    setMessages(m => m.length && m[m.length - 1]!.role === "user" ? m.slice(0, -1) : m)
    send(text)
  }

  // "New conversation" returns to an empty thread. The backend keeps exactly
  // one conversation per business and user, so starting fresh goes through the
  // same delete: the next message opens a new conversation.
  const startNew = clear

  // Work the agent produced: proposals to decide on, accepted drafts, and the
  // turns where it read stored evidence.
  const openProposals = proposals.filter(p => p.status === "PROPOSED")
  const keptDrafts = proposals.filter(p => p.status === "APPROVED" && p.kind !== "REQUEST_CHECK")
  const reads = messages.flatMap((m, i) => m.role === "agent" && !m.pending && ((m.tools?.length ?? 0) > 0 || (m.citations?.length ?? 0) > 0)
    ? [{ id: m.id, question: messages[i - 1]?.role === "user" ? messages[i - 1]!.text : null, tools: m.tools ?? [], citations: m.citations ?? [] }]
    : [])
  const hasWork = openProposals.length > 0 || keptDrafts.length > 0 || reads.length > 0

  return { businessId, messages, proposals, openProposals, keptDrafts, reads, hasWork, ready, busy, failed, unavailable, active: messages.length > 0, send, retry, clear, startNew, refreshProposals }
}

function ProposalCard({ session, businessName, proposal }: { session: AgentSession; businessName: string; proposal: AgentProposal }) {
  const done = session.refreshProposals
  return proposal.kind === "REQUEST_CHECK"
    ? <CheckProposal businessId={session.businessId} businessName={businessName} proposal={proposal} onDone={done} />
    : proposal.kind === "REQUEST_ACQUISITION_BATCH" ? <AcquisitionProposal businessId={session.businessId} proposal={proposal} onDone={done} />
    : <SavedDraft businessId={session.businessId} proposal={proposal} onDone={done} />
}

// ---- the conversation ----

function Thread({ session, businessName, compact, placeholder }: {
  session: AgentSession; businessName: string; compact?: boolean; placeholder: string
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
                    m.text ? <p className="max-w-[85%] rounded-2xl bg-muted px-4 py-2.5 text-xs leading-relaxed whitespace-pre-wrap">{m.text}</p> : null
                  ) : (
                    <div className="max-w-[95%] space-y-1.5">
                      {m.pending ? (
                        <p className="thinking text-xs leading-relaxed" role="status">{m.text}</p>
                      ) : (
                        <p className="text-xs leading-relaxed whitespace-pre-wrap text-foreground/80">{m.text}</p>
                      )}
                      {m.citations?.length ? <ul className="flex flex-wrap gap-2" aria-label="Evidence references">{m.citations.map(c => {
                        const path = agentEvidencePath(session.businessId, c)
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
        </div>
      </div>
      <div className={cn("mx-auto w-full max-w-3xl shrink-0", compact ? "px-3 pb-3" : "px-4 pb-4 sm:px-6")}>
        <Composer onSend={session.send} disabled={session.busy || !session.ready} placeholder={session.unavailable ?? placeholder} autoFocus compact={!!compact} />
        {compact ? null : <p className="pt-2 text-center text-[0.6875rem] text-muted-foreground">Private conversation for {businessName}. Nothing runs or is sent without your approval.</p>}
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
                      const path = agentEvidencePath(session.businessId, c)
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
function ConversationHeader({ session, title, onClose, closeLabel = "Close the agent", closeIcon = <XIcon className="size-3.5" /> }: {
  session: AgentSession; title?: ReactNode; onClose?: () => void; closeLabel?: string; closeIcon?: ReactNode
}) {
  return (
    <div className={cn("flex shrink-0 items-center gap-2", title ? "h-11 border-b px-4" : "h-12 justify-end px-3")}>
      {title ? (
        <>
          <span className="flex size-6 items-center justify-center rounded-md bg-primary-ink/10 text-primary-ink"><SparklesIcon className="size-3.5" /></span>
          <span className="min-w-0 flex-1 truncate text-xs font-medium">{title}</span>
        </>
      ) : null}
      {session.active ? (
        <>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" className="size-7 text-muted-foreground" disabled={session.busy} onClick={session.startNew} aria-label="Start a new conversation">
                <MessageSquarePlusIcon className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>New conversation</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" className="size-7 text-muted-foreground" disabled={session.busy} onClick={session.clear} aria-label="Delete conversation">
                <Trash2Icon className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Delete conversation</TooltipContent>
          </Tooltip>
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
function AgentPane({ open, session, businessName, placeholder, onClose, closeLabel, closeIcon }: {
  open: boolean; session: AgentSession; businessName: string; placeholder: string
  onClose: () => void; closeLabel?: string; closeIcon?: ReactNode
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
              <ConversationHeader session={session} onClose={onClose} {...(closeLabel ? { closeLabel } : {})} {...(closeIcon ? { closeIcon } : {})} />
              <Thread session={session} businessName={businessName} compact placeholder={placeholder} />
            </>
          ) : null}
        </div>
      </div>
    </aside>,
    slot,
  )
}

// ---- overview: the agent is the page ----

// Starts as one centered conversation with the sidebar collapsed. As soon as
// the agent does work, the chat slides left into its own card and the work it
// read and prepared fills the content panel on the right.
export function AgentChat(props: { businessId: string; businessName: string; onConversationChange?: (active: boolean) => void }) {
  return <OverviewAgent key={props.businessId} {...props} />
}

function OverviewAgent({ businessId, businessName, onConversationChange = () => undefined }: { businessId: string; businessName: string; onConversationChange?: (active: boolean) => void }) {
  const session = useAgentSession(businessId)
  const { setMinimal, setWorkspace, setFocus } = useChrome()
  const active = session.active
  const split = active && session.hasWork
  // Narrow screens show one side at a time: the chat, or the work.
  const [showWork, setShowWork] = useState(false)
  useEffect(() => { if (!split) setShowWork(false) }, [split])
  const chatOpen = split && !showWork

  useEffect(() => onConversationChange(active), [active, onConversationChange])
  useEffect(() => {
    setMinimal(active)
    setWorkspace(active)
    setFocus(active)
    return () => { setMinimal(false); setWorkspace(false); setFocus(false) }
  }, [active, setMinimal, setWorkspace, setFocus])

  // Mounted in every state, so the chat card slides away when the
  // conversation is deleted instead of vanishing.
  const chatPane = (
    <AgentPane
      open={chatOpen}
      session={session}
      businessName={businessName}
      placeholder="Reply to the agent"
      onClose={() => setShowWork(true)}
      closeLabel="Show the agent's work"
      closeIcon={<PanelRightIcon className="size-3.5" />}
    />
  )

  if (!active) {
    return (
      <div className="flex flex-1 flex-col items-center justify-end px-4 pb-6 sm:px-6 lg:pb-8">
        {chatPane}
        <div className="w-full max-w-3xl space-y-4">
          <h1 className="text-center text-2xl font-medium tracking-tight text-balance text-foreground">
            What should we look into for <span className="name-shimmer">{businessName}</span>?
          </h1>
          {session.openProposals.map(p => <ProposalCard key={p.id} session={session} businessName={businessName} proposal={p} />)}
          <Composer compact onSend={session.send} disabled={!session.ready || session.busy} placeholder={session.unavailable ?? `Ask about stored evidence for ${businessName}`} />
        </div>
      </div>
    )
  }

  return (
    <>
      {chatPane}
      {split ? (
        <section aria-label="Agent work" className="h-full min-h-0 overflow-y-auto animate-in fade-in duration-500">
          <div className="mx-auto w-full max-w-3xl space-y-4 px-4 pt-6 pb-10 sm:px-6 lg:px-10 lg:pt-8">
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <h2 className="text-sm font-medium">Agent work</h2>
                <p className="mt-0.5 text-xs text-muted-foreground">What the agent read and prepared for {businessName}. Nothing is published, delivered or run without your approval.</p>
              </div>
              {chatOpen ? null : (
                <Button variant="outline" size="sm" onClick={() => setShowWork(false)}>
                  <MessageSquareIcon />
                  Show chat
                </Button>
              )}
            </div>
            <WorkPane session={session} businessName={businessName} />
          </div>
        </section>
      ) : (
        <section aria-label="Conversation" className="flex h-full min-h-0 flex-col">
          <ConversationHeader session={session} />
          <Thread session={session} businessName={businessName} placeholder="Reply to the agent" />
        </section>
      )}
    </>
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
      <AgentPane open={open} session={session} businessName={businessName} placeholder={`Ask about ${businessName}`} onClose={onClose} />
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

function Composer({
  onSend,
  placeholder,
  autoFocus,
  disabled,
  compact,
}: {
  onSend: (text: string) => void
  disabled: boolean
  placeholder: string
  autoFocus?: boolean
  compact?: boolean
}) {
  const { preferences } = usePreferences()
  const [text, setText] = useState("")
  const [listening, setListening] = useState(false)
  const textRef = useRef<HTMLTextAreaElement>(null)
  const recognitionRef = useRef<Recognition | null>(null)
  const baseTextRef = useRef("")

  useEffect(() => () => recognitionRef.current?.stop(), [])

  const canSend = !disabled && text.trim().length > 0 && text.trim().length <= 4000

  const submit = () => {
    if (!canSend) return
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
      className={cn("bg-muted", compact ? "rounded-2xl" : "rounded-3xl")}
    >
      {/* The tray behind the input shows only below it, holding the input
          mode and the mic; send stays on the input itself. */}
      <div
        onClick={(e) => {
          // The whole box behaves like the input: clicking padding focuses it.
          if (e.target === e.currentTarget) textRef.current?.focus()
        }}
        className={cn("relative cursor-text border border-border bg-background shadow-(--float-shadow)", compact ? "rounded-2xl" : "rounded-3xl")}
      >
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
          disabled={disabled}
          maxLength={4000}
          onPaste={e => { if (e.clipboardData.files.length) { e.preventDefault(); toast.error("Attachments are not supported. Paste relevant text instead.") } }}
          onKeyDown={(e) => {
            const sendCombo = preferences.enterToSend ? !e.shiftKey && !e.metaKey && !e.ctrlKey : e.metaKey || e.ctrlKey
            if (e.key === "Enter" && sendCombo && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit()
            } else if (e.key === "Escape" && listening) {
              recognitionRef.current?.stop()
            }
          }}
          placeholder={listening ? "Listening" : placeholder}
          className={cn("field-sizing-content block max-h-72 w-full resize-none bg-transparent pb-1 text-xs leading-relaxed outline-none placeholder:text-muted-foreground/80", compact ? "min-h-16 px-4 pt-3" : "min-h-28 px-5 pt-4")}
        />

        <div className="flex items-center justify-end px-3 pb-3">
          <Tooltip>
            <TooltipTrigger asChild>
              <span>
                <Button
                  type="submit"
                  size="icon-sm"
                  className="rounded-full disabled:bg-muted-foreground/25 disabled:text-background disabled:opacity-100"
                  disabled={!canSend}
                  aria-label="Send message"
                >
                  <ArrowUpIcon />
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent>{preferences.enterToSend ? "Send (Enter). Shift Enter adds a new line." : `Send (${modKey} Enter). Enter adds a new line.`}</TooltipContent>
          </Tooltip>
        </div>
      </div>
      <div className={cn("flex min-h-9 items-center gap-1 py-0.5", compact ? "px-3" : "px-4")}>
        <span className="text-[0.6875rem] text-muted-foreground">Text only</span>
        {preferences.voiceInput ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className={cn("rounded-full text-muted-foreground", listening && "bg-wrong-soft text-wrong hover:bg-wrong-soft hover:text-wrong")}
                onClick={toggleMic}
                aria-label={listening ? "Stop voice input" : "Start voice input"}
                aria-pressed={listening}
              >
                {listening ? <SquareIcon className="size-3 fill-current" /> : <MicIcon />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{listening ? "Stop voice input" : "Voice input"}</TooltipContent>
          </Tooltip>
        ) : null}
        {listening ? (
          <span className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="relative flex size-2">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-wrong opacity-60" />
              <span className="relative inline-flex size-2 rounded-full bg-wrong" />
            </span>
            Listening
          </span>
        ) : null}
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
