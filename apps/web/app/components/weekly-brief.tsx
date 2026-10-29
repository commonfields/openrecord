// This week, at the top of Today: the agent's weekly growth brief (what
// changed, the one thing to do next, and what earlier work changed), with the
// idea it saved ready to approve and its chat a click away for questions.
import { useEffect, useRef, useState } from "react"
import { Link } from "react-router"
import { MessageSquareIcon, RefreshCwIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { Panel } from "@/components/page"
import { ChatMarkdown } from "@/components/chat-markdown"
import { InitiativeCard } from "@/components/agent-chat"
import { ThinkingGlyph } from "@/components/agent-trace"
import { chatPath } from "@/lib/agent-chats"
import { Briefs, briefFailure, type Brief } from "@/lib/brief"
import { relativeTime } from "@/lib/format"
import { useApi } from "@/lib/use-api"

export function WeeklyBrief({ businessId }: { businessId: string }) {
  const q = useApi(`brief:${businessId}`, () => Briefs.get(businessId))
  const [busy, setBusy] = useState(false)
  const running = q.data?.brief?.status === "RUNNING"
  // While one is being written, check back every few seconds.
  const reload = useRef(q.reload)
  reload.current = q.reload
  useEffect(() => {
    if (!running) return
    const t = window.setInterval(() => { void reload.current() }, 4000)
    return () => window.clearInterval(t)
  }, [running])
  if (!q.data) return q.loading ? <Skeleton className="h-40 rounded-xl" /> : null
  const { brief, previous, schedule } = q.data
  const shown: Brief | null = brief?.status === "READY" ? brief : previous
  const act = async (f: () => Promise<unknown>) => { setBusy(true); try { await f(); await q.reload() } finally { setBusy(false) } }

  return (
    <Panel id="brief" className="space-y-3 p-5">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 id="brief-title" className="text-base font-medium">This week</h2>
          <p className="text-[0.8125rem] text-muted-foreground">
            {shown?.finishedAt ? `Written ${relativeTime(shown.finishedAt)}` : "Your agent's weekly brief"}
            {schedule.enabled ? ` · next one ${relativeTime(schedule.nextRunAt)}` : " · weekly brief off"}
          </p>
        </div>
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          Every week
          <Switch checked={schedule.enabled} disabled={busy} onCheckedChange={v => void act(() => Briefs.schedule(businessId, v))} aria-label="Write a brief every week" />
        </label>
        <Button size="sm" variant="secondary" disabled={busy || running} onClick={() => void act(() => Briefs.run(businessId))}>
          <RefreshCwIcon />{shown ? "Write a new one" : "Write it now"}
        </Button>
      </div>

      {running ? (
        <p role="status" className="flex items-center gap-1.5 text-sm text-muted-foreground"><ThinkingGlyph /><span className="thinking">Reading this week's numbers and writing the brief</span></p>
      ) : brief?.status === "FAILED" ? (
        <p role="alert" className="text-sm text-destructive">{briefFailure(brief.failure)}</p>
      ) : null}

      {shown?.text ? (
        <>
          <ChatMarkdown text={shown.text} className="text-[0.9375rem]" />
          {shown.decisions.filter(d => d.type === "GROWTH_OPPORTUNITY").map(d => <InitiativeCard key={d.id} businessId={businessId} opportunityId={d.id} />)}
          {shown.decisions.some(d => d.type === "AGENT_PROPOSAL") ? (
            <Button asChild size="sm" variant="secondary"><Link to="/approvals">Review what it saved</Link></Button>
          ) : null}
          {shown.conversationId ? (
            <Button asChild size="sm" variant="ghost" className="-ml-2 text-muted-foreground">
              <Link to={chatPath({ businessId, id: shown.conversationId })}><MessageSquareIcon />Ask about this brief</Link>
            </Button>
          ) : null}
        </>
      ) : !running && brief?.status !== "FAILED" ? (
        <p className="text-sm text-muted-foreground">Your first brief will appear here: what changed, the one thing to do next, and what earlier work changed.</p>
      ) : null}
    </Panel>
  )
}
