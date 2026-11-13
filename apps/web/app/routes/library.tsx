// Library: everything the agent wrote for this business that a person can
// read, change and ship. Nothing here is asked for in a form: a new piece
// starts as a request to the agent.
import { useEffect, useState } from "react"
import { Link, useParams } from "react-router"
import { ArrowRightIcon, LibraryIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { ArtifactFrame, ArtifactKindIcon, ArtifactViewer } from "@/components/artifact-viewer"
import { EmptyState, PageHeader } from "@/components/page"
import { ARTIFACT_KIND_LABEL, Artifacts, artifactsKey, onArtifactsChanged, type ArtifactSummary } from "@/lib/artifacts"
import { relativeTime } from "@/lib/format"
import { askAgentPath } from "@/lib/nav"
import { useApi } from "@/lib/use-api"
import { useWorkspace } from "@/lib/workspace"

const STARTERS = [
  { label: "A landing page", ask: "Write a landing page for our main offer. Read our site and approved facts first, then build the page." },
  { label: "An article that answers a buyer question", ask: "Write an article that answers the buyer question we are weakest on in AI answers and search. Pick the question from the evidence, then write it." },
  { label: "A launch email", ask: "Write a launch email for our newest offer, with two subject lines to test." },
  { label: "Search ad copy", ask: "Write search ad copy for our main offer: three ad variations with headlines and descriptions inside Google's limits." },
] as const

function ArtifactTile({ businessId, artifact, onOpen }: { businessId: string; artifact: ArtifactSummary; onOpen: () => void }) {
  return (
    <button type="button" onClick={onOpen} className="group flex flex-col overflow-hidden rounded-xl bg-card text-left shadow-(--card-shadow) transition hover:-translate-y-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
      {/* The piece itself at a quarter of its size; it cannot be clicked into from here. */}
      <span className="relative block h-44 w-full overflow-hidden border-b border-border/60 bg-white" aria-hidden>
        <span className="pointer-events-none absolute left-0 top-0 block h-[704px] w-[400%] origin-top-left scale-25">
          <ArtifactFrame businessId={businessId} artifactId={artifact.id} version={artifact.version} title="" />
        </span>
      </span>
      <span className="flex items-start gap-2.5 p-3.5">
        <ArtifactKindIcon kind={artifact.kind} className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0">
          <span className="block truncate text-xs font-medium">{artifact.title}</span>
          <span className="block truncate text-[0.6875rem] text-muted-foreground">{ARTIFACT_KIND_LABEL[artifact.kind]}, version {artifact.version}, {relativeTime(artifact.updatedAt)}</span>
        </span>
      </span>
    </button>
  )
}

export function LibraryPage() {
  const { id = "" } = useParams()
  const { activeBusiness } = useWorkspace()
  const artifacts = useApi(artifactsKey(id), () => Artifacts.list(id))
  const [openId, setOpenId] = useState<string | null>(null)
  const reload = artifacts.reload
  useEffect(() => onArtifactsChanged(() => { void reload() }), [reload])
  const list = artifacts.data?.artifacts ?? []
  const starters = STARTERS.map(s => <Button key={s.label} asChild variant="outline" size="sm"><Link to={askAgentPath(id, s.ask)}>{s.label}<ArrowRightIcon /></Link></Button>)

  return (
    <div className="rise-in w-full space-y-6 pb-4">
      <PageHeader title="Library" description={`Pages, articles, emails and copy your agent wrote for ${activeBusiness?.name ?? "this business"}. Open one to read it, change it or put it live.`} />
      {artifacts.loading && !artifacts.data ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{[0, 1, 2].map(i => <Skeleton key={i} className="h-60 rounded-xl" />)}</div>
      ) : artifacts.error && !artifacts.data ? (
        <p className="text-xs text-muted-foreground">The library could not be read. Reload the page to try again.</p>
      ) : list.length === 0 ? (
        <EmptyState icon={<LibraryIcon />} title="Nothing written yet" description="Ask your agent for a finished piece and it appears here, rendered, with every version kept. Start with one of these." action={starters} />
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {list.map(a => <ArtifactTile key={a.id} businessId={id} artifact={a} onOpen={() => setOpenId(a.id)} />)}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">Ask for another:</span>
            {starters}
          </div>
        </>
      )}
      <ArtifactViewer businessId={id} artifactId={openId} open={openId !== null} onOpenChange={open => { if (!open) { setOpenId(null); void reload() } }} />
    </div>
  )
}
