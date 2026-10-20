// W5 operator panel on an approved initiative: preview the client report,
// publish it explicitly as an immutable version, and manage one revocable
// view-only link per version. Nothing is published automatically.
import { useState } from "react"
import { publicGrowthReport, type GrowthReportPreview, type GrowthReportSummary } from "@openrecord/contracts"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { GrowthReportView } from "@/components/growth-report-view"
import { formatDateTime } from "@/lib/format"
import { GrowthReports, growthReportError, publicGrowthReportPath } from "@/lib/growth-report"

export function GrowthReportPanel({ businessId, opportunityId }: { businessId: string; opportunityId: string }) {
  const [reports, setReports] = useState<ReadonlyArray<GrowthReportSummary> | null>(null)
  const [preview, setPreview] = useState<GrowthReportPreview | null>(null)
  const [requestKey, setRequestKey] = useState(() => crypto.randomUUID())
  const [nextSteps, setNextSteps] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = async (work: () => Promise<void>) => {
    setBusy(true); setError(null)
    try { await work() } catch (err) { setError(growthReportError(err)) } finally { setBusy(false) }
  }
  const load = () => run(async () => setReports((await GrowthReports.list(businessId, opportunityId)).reports))
  const origin = typeof window === "undefined" ? "" : window.location.origin
  return <details className="text-xs" onToggle={e => { if ((e.currentTarget as HTMLDetailsElement).open && reports === null && !busy) void load() }}>
    <summary className="cursor-pointer font-medium">Client report</summary>
    <div className="mt-2 space-y-3">
      <p className="text-muted-foreground">Publishing freezes the evidence and figures shown in the preview. Later data never changes a published version; publish a new version to correct or update it.</p>
      {error ? <p role="alert" className="text-destructive">{error}</p> : null}
      <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(async () => {
        setPreview((await GrowthReports.preview(businessId, opportunityId)).preview); setRequestKey(crypto.randomUUID())
      })}>{preview ? "Refresh preview" : "Preview client report"}</Button>
      {preview ? <div className="space-y-3 rounded-md border">
        <GrowthReportView report={publicGrowthReport({ id: null, snapshotDigest: null, superseded: false, snapshot: { ...preview.snapshot, nextSteps: nextSteps.trim() || null } })} />
        <form className="grid gap-2 border-t p-4" onSubmit={e => { e.preventDefault(); void run(async () => {
          await GrowthReports.publish(businessId, opportunityId, { idempotencyKey: requestKey, expectedLatestVersion: preview.latestVersion, evidenceDigest: preview.evidenceDigest, nextSteps: nextSteps.trim() || null })
          setPreview(null); setNextSteps(""); setReports((await GrowthReports.list(businessId, opportunityId)).reports)
        }) }}>
          <Label htmlFor={`next-steps-${opportunityId}`}>Next steps for the client (optional, written by you)</Label>
          <Textarea id={`next-steps-${opportunityId}`} value={nextSteps} onChange={e => setNextSteps(e.target.value)} maxLength={2000} />
          <p className="text-muted-foreground">{preview.snapshot.evaluation.status === "COMPARABLE" ? "The figures are comparable. That is a statement about data quality, not about success." : "The figures are not comparable. The report will say so and list why."}</p>
          <Button size="sm" disabled={busy} className="justify-self-start">{busy ? "Publishing…" : `Publish version ${preview.latestVersion + 1}`}</Button>
        </form>
      </div> : null}
      {reports?.length ? <ul className="divide-y" aria-label="Published report versions">{reports.map(r => <li key={r.id} className="space-y-1 py-2">
        <p className="flex flex-wrap items-center gap-2"><span className="font-medium">Version {r.version}</span>
          <Badge variant={r.status === "COMPARABLE" ? "supported" : "review"}>{r.status === "COMPARABLE" ? "Comparable" : "Indeterminate"}</Badge>
          {r.superseded ? <Badge variant="outline">Superseded</Badge> : null}
          <span className="text-muted-foreground">published {formatDateTime(r.publishedAt)}</span></p>
        {r.share?.status === "ACTIVE" ? <div className="flex flex-wrap items-center gap-2">
          <a className="break-all underline" href={publicGrowthReportPath(r.share.publicId)} target="_blank" rel="noreferrer noopener">{origin}{publicGrowthReportPath(r.share.publicId)}</a>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(async () => { await GrowthReports.revoke(businessId, r.id); setReports((await GrowthReports.list(businessId, opportunityId)).reports) })}>Revoke link</Button>
        </div> : <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(async () => { await GrowthReports.share(businessId, r.id); setReports((await GrowthReports.list(businessId, opportunityId)).reports) })}>
          {r.share?.status === "REVOKED" ? "Create a new view-only link" : "Create view-only link"}</Button>}
      </li>)}</ul> : reports ? <p className="text-muted-foreground">No report has been published for this initiative.</p> : null}
    </div>
  </details>
}
