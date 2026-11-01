// Upload a server access log so the agent can see AI crawler visits and visits
// referred by AI assistants. The file is read in the browser and sent once;
// the server keeps only counts by crawler, assistant, page and day.
import { useRef, useState } from "react"
import { BotIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Panel } from "@/components/page"
import { api, ApiError } from "@/lib/api"

const MAX_BYTES = 25_000_000
type Saved = { observationId: string; from: string | null; to: string | null; linesParsed: number; crawlers: number; referralAssistants: number }

export function AiTrafficUpload({ businessId }: { businessId: string }) {
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<Saved | null>(null)
  const [error, setError] = useState<string | null>(null)
  const upload = async (file: File) => {
    setError(null); setResult(null)
    if (file.size > MAX_BYTES) { setError("That log is larger than 25 MB. Upload a shorter period."); return }
    setBusy(true)
    try {
      const text = await file.text()
      setResult(await api<Saved>(`/api/businesses/${encodeURIComponent(businessId)}/ai-traffic-logs?name=${encodeURIComponent(file.name)}`, { method: "POST", body: text, headers: { "Content-Type": "text/plain" } }))
    } catch (e) {
      setError(e instanceof ApiError && e.tag === "UnrecognizedLog" ? "No lines in that file look like a web server access log (common or combined format, or JSON lines)." : "The log could not be uploaded. Try again.")
    } finally { setBusy(false); if (input.current) input.current.value = "" }
  }
  return (
    <Panel id="ai-traffic" className="space-y-3 p-4">
      <div className="flex items-start gap-2">
        <BotIcon aria-hidden className="mt-0.5 size-3.5 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <h2 className="text-xs font-medium">AI crawlers and AI referrals</h2>
          <p className="text-[0.6875rem] text-muted-foreground">Upload your website&apos;s access log so the agent can see which AI crawlers read your pages and which visits came from AI assistants. Only counts by crawler, assistant, page and day are kept; IP addresses and raw lines are discarded.</p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input ref={input} type="file" accept=".log,.txt,.json,.jsonl,text/plain" className="hidden" onChange={e => { const f = e.currentTarget.files?.[0]; if (f) void upload(f) }} />
        <Button size="sm" variant="outline" disabled={busy} onClick={() => input.current?.click()}>{busy ? "Reading the log" : "Upload access log"}</Button>
        {result ? <p className="text-xs">Read {result.linesParsed.toLocaleString()} lines{result.from ? ` from ${result.from} to ${result.to}` : ""}: {result.crawlers} AI crawler{result.crawlers === 1 ? "" : "s"} and {result.referralAssistants} assistant{result.referralAssistants === 1 ? "" : "s"} sending visits.</p> : null}
      </div>
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
    </Panel>
  )
}
