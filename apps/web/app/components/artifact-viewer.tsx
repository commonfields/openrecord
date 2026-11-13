// What the agent made, as something to look at and ship: a card under the reply
// that wrote it, and a viewer that shows the piece as a page, its source, and
// every earlier version. The page is drawn by the server's preview route inside
// a sandboxed frame, so nothing the model wrote can run or reach the app.
import { useEffect, useState } from "react"
import { Link } from "react-router"
import { toast } from "sonner"
import { ArrowUpRightIcon, CodeIcon, CopyIcon, DownloadIcon, EyeIcon, FileTextIcon, LayoutTemplateIcon, LinkIcon, MailIcon, MegaphoneIcon, MonitorIcon, RocketIcon, SmartphoneIcon, SparklesIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { ApiError } from "@/lib/api"
import { ARTIFACT_KIND_LABEL, Artifacts, artifactPreviewPath, notifyArtifactsChanged, type Artifact, type ArtifactKind, type ArtifactRef } from "@/lib/artifacts"
import { relativeTime } from "@/lib/format"
import { askAgentPath } from "@/lib/nav"
import { useApi } from "@/lib/use-api"
import { cn } from "@/lib/utils"

export function ArtifactKindIcon({ kind, className }: { kind: ArtifactKind; className?: string }) {
  const Icon = kind === "LANDING_PAGE" ? LayoutTemplateIcon : kind === "EMAIL" ? MailIcon : kind === "AD_COPY" || kind === "SOCIAL_POST" ? MegaphoneIcon : FileTextIcon
  return <Icon className={className} aria-hidden />
}

/** The piece as a page, never able to run scripts, submit forms or navigate the app. */
export function ArtifactFrame({ businessId, artifactId, version, title, className }: { businessId: string; artifactId: string; version?: number; title: string; className?: string }) {
  return <iframe title={title} sandbox="" referrerPolicy="no-referrer" src={artifactPreviewPath(businessId, artifactId, version)} className={cn("size-full border-0 bg-white", className)} />
}

export function ArtifactViewer({ businessId, artifactId, open, onOpenChange }: { businessId: string; artifactId: string | null; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [version, setVersion] = useState<number | undefined>(undefined)
  const [tab, setTab] = useState<"preview" | "source">("preview")
  const [phone, setPhone] = useState(false)
  const [draft, setDraft] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")
  const loaded = useApi(open && artifactId ? `artifact:${businessId}:${artifactId}:${version ?? "current"}` : null, () => Artifacts.read(businessId, artifactId!, version))
  const artifact: Artifact | null = loaded.data?.artifact ?? null
  // Another artifact starts on its current version and its preview.
  useEffect(() => { setVersion(undefined); setTab("preview"); setDraft(null); setError("") }, [artifactId])
  useEffect(() => { setDraft(null); setError("") }, [version])

  const current = artifact !== null && artifact.shownVersion === artifact.version
  const dirty = artifact !== null && draft !== null && draft !== artifact.content
  const save = async () => {
    if (!artifact || !dirty || draft === null) return
    setSaving(true); setError("")
    try {
      await Artifacts.save(businessId, artifact.id, { baseVersion: artifact.version, content: draft, note: "Edited by the team" })
      setDraft(null); setVersion(undefined); notifyArtifactsChanged(); await loaded.reload()
      toast.success("Saved as a new version")
    } catch (e) {
      setError(e instanceof ApiError && e.status === 409 ? "This artifact changed while you were editing. Copy your text, reopen it, then save again." : "The edit could not be saved. Your text is still here.")
    } finally { setSaving(false) }
  }
  const copy = () => { if (artifact) void navigator.clipboard?.writeText(draft ?? artifact.content).then(() => toast.success(artifact.format === "HTML" ? "HTML copied" : "Text copied")).catch(() => {}) }
  const share = async () => {
    if (!artifact) return
    try {
      const link = await Artifacts.link(businessId, artifact.id)
      await navigator.clipboard?.writeText(`${window.location.origin}${link.path}`)
      toast.success("Preview link copied. It works for seven days without an account.")
    } catch { toast.error("The link could not be created. Try again.") }
  }
  const restore = async () => {
    if (!artifact || current) return
    setSaving(true); setError("")
    try {
      await Artifacts.save(businessId, artifact.id, { baseVersion: artifact.version, content: artifact.content, title: artifact.versions.find(v => v.version === artifact.shownVersion)?.title ?? artifact.title, note: `Restored version ${artifact.shownVersion}` })
      setVersion(undefined); notifyArtifactsChanged(); await loaded.reload()
      toast.success(`Version ${artifact.shownVersion} is the current one again`)
    } catch { setError("That version could not be restored. It may already match the current one.") } finally { setSaving(false) }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent aria-describedby={undefined} className="left-auto right-0 w-[min(100vw,1040px)] bg-background data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right">
        <header className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-border/70 px-4 py-3 pr-12">
          <div className="flex min-w-0 flex-1 items-center gap-2.5">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-card text-muted-foreground shadow-(--card-shadow)">{artifact ? <ArtifactKindIcon kind={artifact.kind} className="size-4" /> : <FileTextIcon className="size-4" />}</span>
            <div className="min-w-0">
              <SheetTitle className="truncate text-sm">{artifact?.title ?? "Opening"}</SheetTitle>
              <SheetDescription className="truncate">{artifact ? `${ARTIFACT_KIND_LABEL[artifact.kind]}, updated ${relativeTime(artifact.updatedAt)}` : "Reading the saved version"}</SheetDescription>
            </div>
          </div>
          {artifact ? <>
            <Tabs value={tab} onValueChange={next => setTab(next as "preview" | "source")}>
              <TabsList><TabsTrigger value="preview"><EyeIcon />Preview</TabsTrigger><TabsTrigger value="source"><CodeIcon />{artifact.format === "HTML" ? "HTML" : "Text"}</TabsTrigger></TabsList>
            </Tabs>
            {artifact.versions.length > 1 ? (
              <Select value={String(artifact.shownVersion)} onValueChange={next => setVersion(Number(next) === artifact.version ? undefined : Number(next))}>
                <SelectTrigger aria-label="Version" className="h-7 w-auto gap-1.5 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>{artifact.versions.map(v => <SelectItem key={v.version} value={String(v.version)}>Version {v.version}{v.version === artifact.version ? ", current" : ""}{v.source === "OPERATOR" ? ", edited by the team" : ""}</SelectItem>)}</SelectContent>
              </Select>
            ) : null}
          </> : null}
        </header>

        {artifact ? (
          <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border/70 px-4 py-2">
            {tab === "preview" && artifact.format === "HTML" ? <>
              <Button size="icon" variant={phone ? "ghost" : "secondary"} aria-label="Desktop width" aria-pressed={!phone} onClick={() => setPhone(false)}><MonitorIcon /></Button>
              <Button size="icon" variant={phone ? "secondary" : "ghost"} aria-label="Phone width" aria-pressed={phone} onClick={() => setPhone(true)}><SmartphoneIcon /></Button>
              <span className="mx-1 h-4 w-px bg-border" aria-hidden />
            </> : null}
            <Button size="sm" variant="ghost" onClick={copy}><CopyIcon />Copy</Button>
            <Button size="sm" variant="ghost" asChild><a href={artifactPreviewPath(businessId, artifact.id, artifact.shownVersion, true)} download><DownloadIcon />Download</a></Button>
            <Button size="sm" variant="ghost" asChild><a href={artifactPreviewPath(businessId, artifact.id, artifact.shownVersion)} target="_blank" rel="noreferrer"><ArrowUpRightIcon />Open in a tab</a></Button>
            <Button size="sm" variant="ghost" onClick={() => void share()}><LinkIcon />Share a preview</Button>
            <span className="flex-1" />
            {!current ? <Button size="sm" variant="outline" disabled={saving} onClick={() => void restore()}>Make this the current version</Button> : null}
            {dirty ? <Button size="sm" disabled={saving} onClick={() => void save()}>{saving ? "Saving" : "Save as a new version"}</Button> : null}
            {current && !dirty ? <>
              <Button size="sm" variant="outline" asChild><Link to={askAgentPath(businessId, `Change the artifact "${artifact.title}": `)} onClick={() => onOpenChange(false)}><SparklesIcon />Change it with the agent</Link></Button>
              <Button size="sm" asChild><Link to={askAgentPath(businessId, `Put the artifact "${artifact.title}" live on our site. Read it, then prepare the exact change for me to approve.`)} onClick={() => onOpenChange(false)}><RocketIcon />Put it live</Link></Button>
            </> : null}
          </div>
        ) : null}
        {error ? <p role="alert" className="shrink-0 border-b border-border/70 px-4 py-2 text-xs text-destructive">{error}</p> : null}

        <div className="min-h-0 flex-1 bg-muted/40">
          {!artifact ? (
            loaded.error ? <p className="p-6 text-xs text-muted-foreground">This artifact could not be opened. It may have been put away.</p>
              : <div className="space-y-3 p-6"><Skeleton className="h-8 w-2/3" /><Skeleton className="h-40 w-full" /><Skeleton className="h-24 w-full" /></div>
          ) : tab === "preview" ? (
            <div className={cn("mx-auto h-full transition-[max-width] duration-300", phone && artifact.format === "HTML" ? "max-w-[390px] py-4" : "max-w-none")}>
              <ArtifactFrame key={`${artifact.id}:${artifact.shownVersion}:${artifact.updatedAt}`} businessId={businessId} artifactId={artifact.id} version={artifact.shownVersion} title={artifact.title}
                {...(phone && artifact.format === "HTML" ? { className: "rounded-2xl shadow-(--card-shadow)" } : {})} />
            </div>
          ) : (
            <Textarea aria-label={`${artifact.title} source`} spellCheck={artifact.format === "MARKDOWN"} readOnly={!current} value={draft ?? artifact.content} onChange={e => setDraft(e.target.value)}
              className={cn("size-full resize-none rounded-none border-0 bg-card p-5 text-xs leading-relaxed shadow-none focus-visible:ring-0", artifact.format === "HTML" ? "font-mono" : "")} />
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}

/** The pieces one reply wrote or changed. A reply that just arrived opens its first piece. */
export function ArtifactCards({ businessId, refs, autoOpen = false }: { businessId: string; refs: ReadonlyArray<ArtifactRef>; autoOpen?: boolean }) {
  const [openId, setOpenId] = useState<string | null>(autoOpen ? refs[0]?.id ?? null : null)
  return (
    <div className="w-full space-y-2 pt-1" aria-label="Made in this reply">
      {refs.map(ref => (
        <button key={ref.id} type="button" onClick={() => setOpenId(ref.id)}
          className="group flex w-full items-center gap-3 rounded-xl bg-card p-3 text-left shadow-(--card-shadow) transition hover:bg-control-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-secondary/25 text-primary-ink"><ArtifactKindIcon kind={ref.kind} className="size-4" /></span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-xs font-medium">{ref.title}</span>
            <span className="block truncate text-[0.6875rem] text-muted-foreground">{ARTIFACT_KIND_LABEL[ref.kind]}, version {ref.version}. Saved to your library; nothing is published yet.</span>
          </span>
          <span className="shrink-0 text-xs font-medium text-primary-ink group-hover:underline">Open</span>
        </button>
      ))}
      <ArtifactViewer businessId={businessId} artifactId={openId} open={openId !== null} onOpenChange={open => { if (!open) setOpenId(null) }} />
    </div>
  )
}
