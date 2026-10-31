// What the agent remembers about the business you are in: the notes it reads
// at the start of every chat (preferences, decisions, lessons, things to
// avoid). The team can add one, or forget one that is wrong or outdated.
import { useState } from "react"
import { toast } from "sonner"
import { BrainIcon, XIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { SettingGroup } from "@/components/ui/setting"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { BusinessMemory, type BusinessMemoryNote } from "@/lib/api"
import { formatDate } from "@/lib/format"
import { useApi } from "@/lib/use-api"
import { useWorkspace } from "@/lib/workspace"

const KIND_LABEL: Readonly<Record<BusinessMemoryNote["kind"], string>> = {
  PREFERENCE: "Preference", DECISION: "Decision", LESSON: "Lesson", AVOID: "Avoid", CONTEXT: "Context",
}

export function BusinessMemorySection() {
  const { activeBusiness } = useWorkspace()
  if (!activeBusiness) return null
  return <MemoryList key={activeBusiness.id} businessId={activeBusiness.id} businessName={activeBusiness.name} />
}

function MemoryList({ businessId, businessName }: { businessId: string; businessName: string }) {
  const q = useApi(`business-memory:${businessId}`, () => BusinessMemory.list(businessId))
  const [kind, setKind] = useState<BusinessMemoryNote["kind"]>("PREFERENCE")
  const [text, setText] = useState("")
  const [busy, setBusy] = useState(false)
  const act = async (work: () => Promise<unknown>, failed: string) => {
    setBusy(true)
    try { await work(); await q.reload() } catch { toast.error(failed) } finally { setBusy(false) }
  }
  const notes = q.data?.memories ?? []
  return (
    <SettingGroup title={`What the agent remembers about ${businessName}`}
      description="Notes the agent reads at the start of every chat for this business. It saves them when you state a preference or decision, or when results teach something. They guide it; they are not evidence.">
      {q.loading && !q.data ? <p className="p-3.5 text-[0.8125rem] text-muted-foreground">Loading</p> : notes.length === 0 ? (
        <p className="flex items-center gap-2 p-3.5 text-[0.8125rem] text-muted-foreground"><BrainIcon className="size-4 shrink-0" />Nothing saved yet. Tell the agent what to keep in mind, or add a note below.</p>
      ) : notes.map(n => (
        <div key={n.id} className="flex items-start gap-3 p-3.5">
          <span className="mt-0.5 shrink-0 rounded-full bg-muted px-2 py-0.5 text-[0.6875rem] font-medium text-muted-foreground">{KIND_LABEL[n.kind]}</span>
          <div className="min-w-0 flex-1">
            <p className="text-sm">{n.text}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{n.source === "OPERATOR" ? "Added by your team" : "Saved by the agent"}, {formatDate(n.createdAt)}</p>
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" className="size-7 shrink-0 text-muted-foreground" aria-label="Forget this note" disabled={busy}
                onClick={() => void act(() => BusinessMemory.forget(businessId, n.id), "Couldn't forget the note. Try again.")}>
                <XIcon className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Forget</TooltipContent>
          </Tooltip>
        </div>
      ))}
      <form className="flex flex-col gap-2 p-3.5 sm:flex-row" onSubmit={e => {
        e.preventDefault()
        const value = text.trim()
        if (!value) return
        void act(async () => { await BusinessMemory.add(businessId, kind, value); setText("") }, "Couldn't save the note. Forget an old one if the memory is full.")
      }}>
        <Select value={kind} onValueChange={v => setKind(v as BusinessMemoryNote["kind"])}>
          <SelectTrigger className="h-8 w-full text-xs sm:w-[8.5rem]" aria-label="Kind of note"><SelectValue /></SelectTrigger>
          <SelectContent>{(Object.keys(KIND_LABEL) as BusinessMemoryNote["kind"][]).map(k => <SelectItem key={k} value={k}>{KIND_LABEL[k]}</SelectItem>)}</SelectContent>
        </Select>
        <Input value={text} onChange={e => setText(e.currentTarget.value)} maxLength={400} placeholder="For example: always write in Indonesian" aria-label="Note" className="h-8 flex-1 text-xs" />
        <Button type="submit" variant="outline" size="sm" className="h-8 text-xs" disabled={busy || !text.trim()}>Add note</Button>
      </form>
    </SettingGroup>
  )
}
