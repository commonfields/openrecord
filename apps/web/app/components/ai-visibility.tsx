// Connect an external AI-visibility project with a read-only project key, so
// the agent can read its tracked AI answers, cited pages and competitor
// mentions as evidence. OpenRecord can't create, change or publish anything there.
import { useState } from "react"
import { SparklesIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Panel } from "@/components/page"
import { AiVisibility, aiVisibilityError } from "@/lib/ai-visibility"
import { relativeTime } from "@/lib/format"
import { useApi } from "@/lib/use-api"

export function AiVisibilitySetup({ businessId }: { businessId: string }) {
  const q = useApi(`ai-visibility:${businessId}`, () => AiVisibility.status(businessId))
  const [key, setKey] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Hidden unless the server has a service configured: nothing to connect otherwise.
  if (!q.data?.available) return null
  const s = q.data
  const act = async (f: () => Promise<unknown>) => {
    setBusy(true); setError(null)
    try { await f(); setKey(""); await q.reload() } catch (e) { setError(aiVisibilityError(e)) } finally { setBusy(false) }
  }
  return (
    <Panel id="ai-visibility" className="space-y-3 p-4">
      <div className="flex items-start gap-2">
        <SparklesIcon aria-hidden className="mt-0.5 size-3.5 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <h2 className="text-xs font-medium">AI visibility tracking</h2>
          <p className="text-[0.6875rem] text-muted-foreground">If you already track AI answers in an AI-visibility service, the agent can read that project&apos;s answers, cited pages and competitor mentions as evidence. Read-only: OpenRecord can&apos;t create, change or publish anything there.</p>
        </div>
      </div>
      {s.connected ? (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <p className="min-w-0 flex-1">Reading <span className="font-medium">{s.projectName}</span> with key ending {s.keyHint}, connected {s.connectedAt ? relativeTime(s.connectedAt) : ""}.</p>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act(() => AiVisibility.disconnect(businessId))}>Disconnect</Button>
        </div>
      ) : (
        <form className="space-y-2" onSubmit={e => { e.preventDefault(); if (key.trim()) void act(() => AiVisibility.connect(businessId, key.trim())) }}>
          <p className="text-[0.6875rem] text-muted-foreground">Create an API key for this one project with read-only permission, then paste it here. Organization-wide or writable keys are refused.</p>
          <div className="flex flex-wrap items-center gap-2">
            <Input value={key} onChange={e => setKey(e.currentTarget.value)} placeholder="Project API key" autoComplete="off" spellCheck={false} aria-label="AI-visibility project API key" className="w-80 font-mono text-xs" />
            <Button size="sm" type="submit" disabled={busy || !key.trim()}>Connect project</Button>
          </div>
        </form>
      )}
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
    </Panel>
  )
}
