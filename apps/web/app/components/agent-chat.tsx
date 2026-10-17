import { useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { ArrowUpIcon, CheckIcon, CopyIcon, MicIcon, SquareIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useChrome } from "@/components/app-shell"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { modKey } from "@/components/settings-dialog"
import { usePreferences } from "@/lib/preferences"
import { Link } from "react-router"
import { Agent, ApiError, Providers, Questions, type AgentCitation, type AgentProposal } from "@/lib/api"
import { agentEvidencePath } from "@/lib/agent-evidence"
import { Select, SelectTrigger, SelectContent, SelectItem, SelectValue } from "@/components/ui/select"
import { cn } from "@/lib/utils"

type Message = { id: string; role: "user" | "agent"; text: string; tools?: Array<{ tool: string; summary: string }>; citations?: AgentCitation[]; pending?: boolean }
const errorText = (e: unknown) => e instanceof ApiError && e.body["reason"] === "UNCONFIGURED"
  ? "The assistant is not configured. Ask your administrator to enable external processing and set the agent model and key."
  : e instanceof ApiError && e.status === 409 ? "This conversation changed in another tab. Reload before continuing."
  : "The assistant could not complete this request. A draft proposal may have been saved. Review proposals before retrying."

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

export function AgentChat(props: { businessId: string; businessName: string; onConversationChange: (active: boolean) => void }) {
  return <ScopedAgentChat key={props.businessId} {...props} />
}

function ScopedAgentChat({
  businessId,
  businessName,
  onConversationChange,
}: {
  businessId: string
  businessName: string
  onConversationChange: (active: boolean) => void
}) {
  const [messages, setMessages] = useState<Message[]>([])
  const [conversationId, setConversationId] = useState<string | undefined>()
  const [revision, setRevision] = useState(0)
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)
  const mounted = useRef(true)
  const [proposals, setProposals] = useState<AgentProposal[]>([])
  const [failed, setFailed] = useState<string | null>(null)
  const endRef = useRef<HTMLDivElement>(null)
  const active = messages.length > 0
  const { setMinimal } = useChrome()

  useEffect(() => onConversationChange(active), [active, onConversationChange])

  useEffect(() => {
    setMinimal(active)
    return () => setMinimal(false)
  }, [active, setMinimal])

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" })
  }, [messages])

  useEffect(() => {
    mounted.current = true
    let live = true
    void Agent.load(businessId).then(r => {
      if (!live) return
      if (r.conversation) {
        setConversationId(r.conversation.id); setRevision(r.conversation.revision)
        setMessages(r.conversation.messages.map(m => ({ ...m, id: uid(), ...(m.toolCalls ? { tools: m.toolCalls } : {}) })))
      }
      setReady(true)
    }).catch(e => { if (live) setFailed(errorText(e)) })
    void Agent.proposals(businessId).then(r => { if (live) setProposals(r.proposals) }).catch(() => {})
    return () => { live = false; mounted.current = false }
  }, [businessId])

  const send = (text: string) => {
    if (pending.current || !ready) return
    pending.current = true; setBusy(true); setFailed(null)
    setMessages(m => [...m, { id: uid(), role: "user", text }, { id: uid(), role: "agent", text: "Investigating stored evidence…", pending: true }])
    void Agent.send(businessId, text, crypto.randomUUID(), revision, conversationId).then(r => {
      if (!mounted.current) return
      setConversationId(r.conversationId); setRevision(r.revision)
      setMessages(m => [...m.slice(0, -1), { id: uid(), role: "agent", text: r.reply, tools: r.toolCalls, citations: r.citations }])
      void Agent.proposals(businessId).then(p => { if (mounted.current) setProposals(p.proposals) }).catch(() => {})
    }).catch((e: unknown) => {
      if (!mounted.current) return
      setMessages(m => m.slice(0, -1)); setFailed(errorText(e))
      void Agent.proposals(businessId).then(p => { if (mounted.current) setProposals(p.proposals) }).catch(() => {})
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
    }).catch(e => { if (mounted.current) setFailed(errorText(e)) }).finally(() => { pending.current = false; if (mounted.current) setBusy(false) })
  }

  const proposalCards = proposals.filter(p => p.status === "PROPOSED" || (p.status === "APPROVED" && p.kind !== "REQUEST_CHECK")).map(p => p.kind === "REQUEST_CHECK"
        ? <CheckProposal key={p.id} businessId={businessId} businessName={businessName} proposal={p} onDone={() => void Agent.proposals(businessId).then(r => setProposals(r.proposals))} />
        : p.kind === "REQUEST_ACQUISITION_BATCH" ? <AcquisitionProposal key={p.id} businessId={businessId} proposal={p} onDone={() => void Agent.proposals(businessId).then(r => setProposals(r.proposals))} />
        : <SavedDraft key={p.id} businessId={businessId} proposal={p} onDone={() => void Agent.proposals(businessId).then(r => setProposals(r.proposals))} />)

  if (!active) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center pb-[12vh]">
        <div className="w-full max-w-3xl space-y-7">
          <h1 className="text-center text-2xl font-medium tracking-tight text-balance text-foreground">
            What should we look into for {businessName}?
          </h1>
          {failed ? <p role="alert" className="text-xs text-wrong">{failed}</p> : null}
          <p className="text-center text-xs text-muted-foreground">Private conversation for {businessName}. Attachments are unavailable.</p>
          {proposalCards}
          <Composer onSend={send} disabled={!ready || busy} placeholder={`Ask about stored evidence for ${businessName}`} />
        </div>
      </div>
    )
  }

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col">
      <div className="mb-4 flex items-center justify-between gap-3 text-xs"><span>Investigating {businessName}</span><Button variant="ghost" size="sm" disabled={busy} onClick={clear}>Delete conversation</Button></div>
      <ol aria-live="polite" className="flex-1 space-y-3 pb-8">
        {messages.map((m) => (
          <li key={m.id} className={cn("group/msg flex flex-col gap-1", m.role === "user" ? "items-end" : "items-start")}>
            {m.role === "user" ? (
              <>
                {m.text ? (
                  <p className="max-w-[80%] rounded-2xl bg-muted px-4 py-2.5 text-xs leading-relaxed whitespace-pre-wrap">{m.text}</p>
                ) : null}
              </>
            ) : (
              <div className="max-w-[90%] space-y-1.5">
                <p className={cn("text-xs leading-relaxed whitespace-pre-wrap text-foreground/80", m.pending && "animate-pulse")}>{m.text}</p>
                {m.citations?.length ? <ul className="flex flex-wrap gap-2" aria-label="Evidence references">{m.citations.map(c => {
                  const path = agentEvidencePath(businessId, c)
                  return <li key={`${c.kind}:${c.id}`} className="text-xs">{path ? <Link className="underline underline-offset-2" to={path}>{c.text || "Open evidence"}</Link> : <span>Evidence unavailable</span>}</li>
                })}</ul> : null}
                {m.tools && m.tools.length > 0 ? (
                  <p className="text-xs text-muted-foreground">{m.tools.map((t) => t.summary).join("; ")}</p>
                ) : null}
              </div>
            )}
            <CopyButton text={m.text} className={m.role === "user" ? "-mr-1.5" : "-ml-1.5"} />
          </li>
        ))}
      </ol>
      {proposalCards}
      {failed ? <p role="alert" className="pb-2 text-xs text-wrong">{failed}</p> : null}
      <div ref={endRef} />

      <div className="sticky bottom-0 z-10 -mx-2 bg-gradient-to-t from-background from-70% to-transparent px-2 pt-6 pb-1">
        <Composer onSend={send} disabled={busy || !ready} placeholder="Reply to the agent" autoFocus />
      </div>
    </div>
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
}: {
  onSend: (text: string) => void
  disabled: boolean
  placeholder: string
  autoFocus?: boolean
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
      onClick={(e) => {
        // The whole box behaves like the input: clicking padding focuses it.
        if (e.target === e.currentTarget) textRef.current?.focus()
      }}
      onDragOver={e => e.preventDefault()}
      onDrop={e => { e.preventDefault(); toast.error("Attachments are not supported. Paste relevant text instead.") }}
      className="relative cursor-text rounded-3xl border border-border bg-background shadow-(--float-shadow)"
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
        className="field-sizing-content block max-h-72 min-h-28 w-full resize-none bg-transparent px-5 pt-4 pb-1 text-xs leading-relaxed outline-none placeholder:text-muted-foreground/80"
      />

      <div className="flex items-center gap-1 px-3 pb-3">
        <span className="text-xs text-muted-foreground">Text only</span>
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

        <div className="ml-auto flex items-center gap-1.5">
          {listening ? (
            <span className="mr-1 flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className="relative flex size-2">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-wrong opacity-60" />
                <span className="relative inline-flex size-2 rounded-full bg-wrong" />
              </span>
              Listening
            </span>
          ) : null}
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
  return <section className="mb-3 space-y-2 rounded-xl border p-4 text-xs" aria-label="Re-check proposal">
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
  return <section aria-label="Saved private draft" className="group/msg mb-3 space-y-3 rounded-xl border p-4 text-xs">
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
  return <section aria-label="Acquisition measurement proposal" className="mb-3 space-y-3 rounded-xl border p-4 text-xs">
    <p className="font-medium">Proposed acquisition measurement</p><p className="max-h-80 overflow-auto whitespace-pre-wrap">{proposal.payload?.text ?? "Measurement plan unavailable"}</p>
    {cost === null || cost === undefined ? <p>Approval is blocked until a measurement cost bound is configured and a new proposal is prepared.</p> : null}
    <div className="flex gap-2"><Button size="sm" disabled={working || !plan || cost === null || cost === undefined || !!plan.missingRequirements.length} onClick={() => void decide(true)}>Approve estimated USD {cost?.toFixed(2) ?? "unknown"} and queue</Button><Button size="sm" variant="outline" disabled={working} onClick={() => void decide(false)}>Reject</Button></div>
    {error ? <p role="alert">{error}</p> : null}
  </section>
}
