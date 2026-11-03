// The person's verdict on the agent's work, with the reason, so the agent
// learns what this business wants. Reject opens a one-line "why not?" field
// (optional) before it confirms; approvals are recorded too, so the agent can
// later note what happened after the work.
import { useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { api } from "@/lib/api"

export type DecisionKind = "AGENT_PROPOSAL" | "AGENT_DRAFT" | "GROWTH_OPPORTUNITY" | "WORDPRESS_CHANGE"

/** Records a decision for the agent to read. Never blocks the decision itself. */
export const recordDecision = (businessId: string, d: { kind: DecisionKind; itemId: string; verdict: "APPROVED" | "REJECTED"; title: string; reason?: string | undefined }) =>
  api(`/api/businesses/${encodeURIComponent(businessId)}/decision-feedback`, { method: "POST",
    body: JSON.stringify({ kind: d.kind, itemId: d.itemId, verdict: d.verdict, title: d.title.slice(0, 300) || "Untitled", ...(d.reason?.trim() ? { reason: d.reason.trim().slice(0, 500) } : {}) }) }).catch(() => undefined)

/** "Reject", then an optional one-line reason, then the rejection. The reason is saved for the agent. */
export function RejectWithReason({ onReject, disabled, label = "Reject", size = "sm", className }: {
  onReject: (reason: string | undefined) => Promise<void> | void; disabled?: boolean; label?: string; size?: "sm" | "default"; className?: string
}) {
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState("")
  if (!open) return <Button size={size} variant="outline" disabled={disabled} className={className} onClick={() => setOpen(true)}>{label}</Button>
  return (
    <form className="step-in flex w-full basis-full flex-wrap items-center gap-2" onSubmit={e => { e.preventDefault(); void onReject(reason.trim() || undefined) }}>
      <Input autoFocus value={reason} onChange={e => setReason(e.currentTarget.value)} maxLength={500} aria-label="Why not?"
        placeholder="Why not? One line helps the agent (optional)" className="h-8 min-w-56 flex-1 text-xs" />
      <Button type="submit" size="sm" variant="outline" disabled={disabled}>{label}</Button>
      <Button type="button" size="sm" variant="ghost" onClick={() => { setOpen(false); setReason("") }}>Cancel</Button>
    </form>
  )
}
