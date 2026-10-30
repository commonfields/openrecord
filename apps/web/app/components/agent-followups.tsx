import { useCallback, useEffect, useRef, useState } from "react"
import { Link } from "react-router"
import { CalendarClockIcon, LoaderIcon } from "lucide-react"
import type { FollowupConfigure, FollowupResponse } from "@openrecord/contracts"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { ProviderLogo } from "@/components/provider-logo"
import { Followups, followupChatEvent, followupError, followupLocation, followupModelMatches, followupStatus, type FollowupModel } from "@/lib/agent-followups"
import { chatPath, notifyAgentChats } from "@/lib/agent-chats"

type Load = { kind: "loading" } | { kind: "failed"; message: string } | { kind: "ready"; snapshot: FollowupResponse }
type Confirmation = { model: FollowupModel; expectedGrantId: string | null }
const timestamp = (value: string) => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : "Time unavailable"

/** One server-confirmed policy per business/person, bound to a particular chat. */
export function AgentFollowups({ businessId, conversationId, model, chatBusy }: {
  businessId: string; conversationId: string; model: FollowupModel | null; chatBusy: boolean
}) {
  const [open, setOpen] = useState(false)
  const [load, setLoad] = useState<Load>({ kind: "loading" })
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)
  const [saving, setSaving] = useState(false)
  const generation = useRef(0)
  const mounted = useRef(false)
  const pending = useRef(false)
  const lastReceipt = useRef("")
  const accept = useCallback((snapshot: FollowupResponse) => {
    setLoad({ kind: "ready", snapshot })
    const latest = snapshot.wakes[0]
    const key = latest ? `${latest.id}:${latest.status}` : ""
    if (latest && key !== lastReceipt.current) {
      window.dispatchEvent(new Event(followupChatEvent(businessId, latest.conversationId)))
      notifyAgentChats()
    }
    lastReceipt.current = key
  }, [businessId])
  const refresh = useCallback(async () => {
    if (pending.current) return
    const current = ++generation.current
    try {
      const snapshot = await Followups.read(businessId)
      if (mounted.current && generation.current === current) accept(snapshot)
    } catch (error) {
      if (mounted.current && generation.current === current) setLoad({ kind: "failed", message: followupError(error) })
    }
  }, [businessId, accept])
  useEffect(() => {
    const requests = generation
    mounted.current = true
    void refresh()
    return () => { mounted.current = false; requests.current++ }
  }, [refresh])
  useEffect(() => {
    if (open) void refresh()
    const timer = setInterval(() => { if (!document.hidden) void refresh() }, open ? 15_000 : 60_000)
    return () => clearInterval(timer)
  }, [open, refresh])

  const configure = async (request: FollowupConfigure) => {
    if (pending.current) return
    pending.current = true
    const current = ++generation.current
    setSaving(true)
    try {
      const snapshot = await Followups.configure(businessId, request)
      if (mounted.current && generation.current === current) {
        accept(snapshot)
        setConfirmation(null)
      }
    } catch (error) {
      if (mounted.current && generation.current === current) {
        // A lost response is not proof the write failed. Require a fresh read.
        setLoad({ kind: "failed", message: followupError(error) })
        setConfirmation(null)
      }
    } finally {
      pending.current = false
      if (mounted.current) setSaving(false)
    }
  }
  const snapshot = load.kind === "ready" ? load.snapshot : null
  const location = snapshot ? followupLocation(snapshot.policy, conversationId) : null
  const policy = snapshot?.policy.kind === "configured" ? snapshot.policy : null
  return (
    <Dialog open={open} onOpenChange={value => { setOpen(value); if (!value) setConfirmation(null) }}>
      <DialogTrigger asChild>
        <button type="button" aria-label="Manage automatic follow-ups" className="inline-flex items-center gap-1.5 rounded-sm text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
          <CalendarClockIcon className="size-3.5" />
          <span>Follow-ups{location === "here" ? " on" : location === "elsewhere" ? " elsewhere" : ""}</span>
        </button>
      </DialogTrigger>
      <DialogContent className="gap-5 rounded-xl sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base">Automatic follow-ups</DialogTitle>
          <DialogDescription>Let the agent revisit saved investigations when a time or proposal decision is ready. This applies to your follow-ups for this business.</DialogDescription>
        </DialogHeader>
        {load.kind === "loading" ? <p role="status" className="text-sm text-muted-foreground">Loading follow-up settings…</p> : null}
        {load.kind === "failed" ? <div className="space-y-3"><p role="alert" className="text-sm text-muted-foreground">{load.message}</p><Button type="button" variant="secondary" disabled={saving} onClick={() => void refresh()}>Refresh status</Button></div> : null}
        {snapshot ? <>
          <div className="space-y-2 text-sm">
            <p className="font-medium">{location === "off" ? "Paused" : location === "here" ? "Enabled in this chat" : "Enabled in another chat"}</p>
            {policy?.enabled ? <p className="flex items-center gap-2 text-muted-foreground"><ProviderLogo provider={policy.provider} className="size-4" />{policy.model}</p> : null}
            {policy?.enabled && location === "elsewhere" ? <Link className="text-sm underline underline-offset-4" to={chatPath({ businessId, id: policy.conversationId })} onClick={() => setOpen(false)}>Open the follow-up chat</Link> : null}
            <p className="text-muted-foreground">At most {snapshot.limits.wakeUpsPer24Hours} review every 24 hours, with {snapshot.limits.modelSteps} model steps, {snapshot.limits.toolCalls} stored-record reads and a {snapshot.limits.timeoutSeconds / 60}-minute limit. Provider usage or charges may apply.</p>
            <p className="text-muted-foreground">Read-only. No publishing, ad-budget changes, contacting customers or starting other agents. No provider fallback. The server and selected provider must be available.</p>
          </div>
          {confirmation ? <div className="space-y-3 border-t pt-4">
            <p className="text-sm font-medium">Allow automatic reviews using {confirmation.model.label}?</p>
            <p className="text-sm text-muted-foreground">Updates will be saved in this chat. {location === "elsewhere" ? "This moves follow-ups from the other chat. " : ""}You can pause them at any time.</p>
            <div className="flex flex-wrap justify-end gap-2">
              <Button type="button" variant="ghost" disabled={saving} onClick={() => setConfirmation(null)}>Cancel</Button>
              <Button type="button" disabled={saving || chatBusy} onClick={() => void configure({ enabled: true, requestId: crypto.randomUUID(), expectedGrantId: confirmation.expectedGrantId,
                conversationId, selection: confirmation.model.selection, expectedProvider: confirmation.model.provider, expectedModel: confirmation.model.model })}>
                {saving ? <LoaderIcon className="size-4 animate-spin motion-reduce:animate-none" /> : null}Allow follow-ups
              </Button>
            </div>
          </div> : <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-4">
            <Button type="button" variant="ghost" disabled={saving} onClick={() => void refresh()}>Refresh status</Button>
            <div className="flex flex-wrap gap-2">
              {policy?.enabled ? <Button type="button" variant="secondary" disabled={saving} onClick={() => void configure({ enabled: false })}>{saving ? "Pausing…" : "Pause follow-ups"}</Button> : null}
              {location !== "here" || (model && !followupModelMatches(snapshot.policy, model)) ? <Button type="button" disabled={saving || chatBusy || model === null} onClick={() => {
                if (model) setConfirmation({ model, expectedGrantId: policy?.grantId ?? null })
              }}>{location === "elsewhere" ? "Move here" : location === "here" ? "Change model" : "Enable follow-ups"}</Button> : null}
            </div>
          </div>}
          {!model && location !== "here" ? <p className="text-xs text-muted-foreground">Choose an available model in the composer to enable follow-ups.</p> : null}
          <section className="space-y-2 border-t pt-4" aria-label="Recent follow-up reviews">
            <h3 className="text-sm font-medium">Recent reviews</h3>
            {snapshot.wakes.length ? <ul className="max-h-48 space-y-3 overflow-y-auto text-sm">{snapshot.wakes.map(wake => <li key={wake.id} className="flex items-start justify-between gap-3">
              <div><p className="flex items-center gap-1.5">{wake.status === "RUNNING" ? <LoaderIcon className="size-3 animate-spin motion-reduce:animate-none" /> : null}{followupStatus[wake.status]}</p><time className="text-xs text-muted-foreground" dateTime={wake.startedAt}>{timestamp(wake.startedAt)}</time></div>
              <Link className="shrink-0 text-xs underline underline-offset-4" to={chatPath({ businessId, id: wake.conversationId })} onClick={() => setOpen(false)}>Open chat</Link>
            </li>)}</ul> : <p className="text-sm text-muted-foreground">No automatic reviews yet. Saving a waiting condition does not mean a review has run.</p>}
            {snapshot.wakes.some(wake => wake.status === "FAILED" || wake.status === "INTERRUPTED") ? <p className="text-xs text-muted-foreground">Uncertain attempts aren't automatically retried. Open the chat to review what was saved before continuing manually.</p> : null}
          </section>
        </> : null}
      </DialogContent>
    </Dialog>
  )
}
