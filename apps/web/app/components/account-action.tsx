// The card a person approves one change to the business's own Google Business
// Profile or Google Ads account on. It shows exactly what changes (the review
// and the reply, the campaign and its old and new status or budget, the new
// ad), carries it out on approval, says what Google holds afterwards, and can
// undo it.
import { useState } from "react"
import { toast } from "sonner"
import { MegaphoneIcon, MessageSquareReplyIcon, Undo2Icon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { AccountActions, ApiError, notifyDecisionsChanged, type AccountAction } from "@/lib/api"
import { relativeTime } from "@/lib/format"
import { useApi } from "@/lib/use-api"

const REASONS: Readonly<Record<string, string>> = {
  ChangedSincePrepared: "This changed in Google after it was prepared, so it wasn't overwritten. Ask the agent to prepare it again.",
  ChangedSinceDone: "This changed in Google since it was done, so it wasn't put back. Change it in Google directly.",
  NotStoredAsApproved: "Google didn't hold the change exactly as approved afterwards, so it isn't counted as done.",
  ActionNotPending: "This was already decided.",
  ActionNotDone: "Only a change that was carried out can be undone.",
  AdsReauthorizationRequired: "The Google connection needs a new sign-in. Reconnect it on the Channels page.",
  ProviderUnavailable: "Google didn't answer. Try again in a moment.",
  ProviderQuota: "Google is limiting requests. Try again in a few minutes.",
  AdAccountNotAccessible: "The connected Google sign-in can't change this account.",
  ProviderRejected: "Google refused this change.",
  CampaignNotFound: "That campaign no longer exists.",
}
const reasonOf = (e: unknown) => e instanceof ApiError && typeof e.body["reason"] === "string" ? e.body["reason"] : ""
const STATUS: Readonly<Record<AccountAction["status"], string>> = { PROPOSED: "Waiting for approval", EXECUTING: "Working", DONE: "Done", REJECTED: "Rejected", FAILED: "Not done", UNDONE: "Undone" }
const str = (v: unknown) => typeof v === "string" ? v : typeof v === "number" ? String(v) : ""
const money = (v: unknown, currency: unknown) => typeof v === "number" ? new Intl.NumberFormat(undefined, { style: "currency", currency: str(currency) || "USD" }).format(v) : ""

const title = (a: AccountAction) => {
  const campaign = `"${str(a.target["campaignName"])}"`
  switch (a.kind) {
    case "REPLY_TO_REVIEW": return `Reply to ${str(a.target["reviewer"])}'s ${a.target["rating"] ? `${str(a.target["rating"])}-star ` : ""}review`
    case "PAUSE_CAMPAIGN": return `Pause the campaign ${campaign}`
    case "ENABLE_CAMPAIGN": return `Turn on the campaign ${campaign}`
    case "SET_DAILY_BUDGET": return `Daily budget of ${campaign}: ${money(a.before["daily"], a.target["currency"])} to ${money(a.after["daily"], a.target["currency"])}`
    case "CREATE_SEARCH_AD": return `New search ad in "${str(a.target["adGroupName"])}" (${campaign})`
  }
}

function Preview({ action: a }: { action: AccountAction }) {
  if (a.kind === "REPLY_TO_REVIEW") return (
    <div className="space-y-2 text-xs">
      <blockquote className="border-l-2 pl-3 text-muted-foreground">{str(a.target["comment"]) || "(no text)"}</blockquote>
      {a.before["reply"] ? <p className="text-muted-foreground line-through">{str(a.before["reply"])}</p> : null}
      <p className="whitespace-pre-wrap rounded-md bg-muted/60 p-2">{str(a.after["reply"])}</p>
      <p className="text-muted-foreground">The reply is public on Google, under the review.</p>
    </div>
  )
  if (a.kind === "CREATE_SEARCH_AD") {
    const list = (v: unknown) => Array.isArray(v) ? v.map(str) : []
    return (
      <div className="space-y-1 rounded-md bg-muted/60 p-2 text-xs">
        <p className="font-medium">{list(a.after["headlines"]).join(" | ")}</p>
        <p>{list(a.after["descriptions"]).join(" ")}</p>
        <p className="text-muted-foreground">{str(a.after["finalUrl"])}</p>
        <p className="text-muted-foreground">Created paused: it doesn't run or spend until someone turns it on.</p>
      </div>
    )
  }
  if (a.kind === "SET_DAILY_BUDGET") return <p className="text-xs text-muted-foreground">Google can spend up to twice the daily budget on a single day; the monthly total stays within about 30 times it.</p>
  return null
}

export function AccountActionCard({ businessId, action: initial, onDone }: { businessId: string; action: AccountAction; onDone?: () => void }) {
  const [action, setAction] = useState(initial)
  const [busy, setBusy] = useState(false)
  const act = (work: () => Promise<{ action: AccountAction }>, success: string) => void (async () => {
    setBusy(true)
    try { const r = await work(); setAction(r.action); toast.success(success); notifyDecisionsChanged(); onDone?.() }
    catch (e) {
      toast.error(REASONS[reasonOf(e)] ?? "That didn't work. Try again.")
      void AccountActions.get(businessId, action.id).then(r => setAction(r.action), () => {})
    } finally { setBusy(false) }
  })()
  const Icon = action.provider === "google_business" ? MessageSquareReplyIcon : MegaphoneIcon
  return (
    <div className="space-y-3 rounded-[10px] bg-card p-4 shadow-(--card-shadow)">
      <div className="flex flex-wrap items-center gap-2">
        <Icon className="size-3.5 text-muted-foreground" />
        <span className="min-w-0 flex-1 text-sm font-medium">{title(action)}</span>
        <Badge variant={action.status === "DONE" ? "supported" : action.status === "FAILED" ? "review" : "outline"}>{STATUS[action.status]}</Badge>
      </div>
      <p className="text-xs text-muted-foreground">{action.rationale}</p>
      <Preview action={action} />
      {action.status === "FAILED" && action.failure ? <p className="text-xs text-destructive">{REASONS[action.failure] ?? "It couldn't be done."}</p> : null}
      {action.status === "DONE" ? <p className="text-xs text-muted-foreground">Done {action.decidedAt ? relativeTime(action.decidedAt) : ""}, and Google shows the change.</p> : null}
      <div className="flex flex-wrap items-center gap-2">
        {action.status === "PROPOSED" ? <>
          <Button size="sm" className="h-8 text-xs" disabled={busy} onClick={() => act(() => AccountActions.approve(businessId, action.id), action.kind === "REPLY_TO_REVIEW" ? "Reply posted" : "Change made in Google Ads")}>
            {action.kind === "REPLY_TO_REVIEW" ? "Approve and post" : "Approve and apply"}
          </Button>
          <Button size="sm" variant="ghost" className="h-8 text-xs" disabled={busy} onClick={() => act(() => AccountActions.reject(businessId, action.id), "Rejected")}>Reject</Button>
        </> : null}
        {action.status === "DONE" ? (
          <Button size="sm" variant="outline" className="h-8 text-xs" disabled={busy} onClick={() => act(() => AccountActions.undo(businessId, action.id), "Undone")}><Undo2Icon />Undo</Button>
        ) : null}
      </div>
    </div>
  )
}

/** The card for an action the agent prepared in this chat, loaded by id. */
export function AccountActionById({ businessId, actionId }: { businessId: string; actionId: string }) {
  const q = useApi(`account-action:${actionId}`, () => AccountActions.get(businessId, actionId))
  if (!q.data) return q.loading ? <Skeleton className="h-32 rounded-[10px]" /> : null
  return <AccountActionCard businessId={businessId} action={q.data.action} />
}
