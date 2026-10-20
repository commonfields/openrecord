// W5: the client-facing outcome report behind a revocable capability link.
// Public, read-only, outside the workspace shell; unknown and revoked links
// render the same "not available" page.
import { useEffect, useState } from "react"
import { useParams } from "react-router"
import type { PublicGrowthReport } from "@openrecord/contracts"
import { Button } from "@/components/ui/button"
import { GrowthReportView } from "@/components/growth-report-view"
import { fetchPublicGrowthReport } from "@/lib/growth-report"

export function PublicGrowthReportPage() {
  const { publicId = "" } = useParams()
  const [state, setState] = useState<{ report: PublicGrowthReport | null; error: string | null; loading: boolean }>({ report: null, error: null, loading: true })
  useEffect(() => {
    // Keep the capability URL out of search engines and Referer headers.
    const metas = [["robots", "noindex, nofollow"], ["referrer", "no-referrer"]].map(([name, content]) => {
      const m = document.createElement("meta"); m.name = name!; m.content = content!; document.head.appendChild(m); return m
    })
    return () => metas.forEach(m => m.remove())
  }, [])
  useEffect(() => {
    let live = true
    setState({ report: null, error: null, loading: true })
    fetchPublicGrowthReport(publicId).then(
      report => { if (live) setState({ report, error: null, loading: false }) },
      () => { if (live) setState({ report: null, error: "This report is temporarily unavailable.", loading: false }) },
    )
    return () => { live = false }
  }, [publicId])
  useEffect(() => { if (state.report) document.title = `${state.report.business.name} marketing report — OpenRecord` }, [state.report])
  if (state.loading) return <main className="mx-auto max-w-3xl px-5 py-10 text-sm text-muted-foreground">Loading report…</main>
  if (state.error) return <main className="mx-auto max-w-3xl px-5 py-10">{state.error}</main>
  if (!state.report) return <main className="mx-auto max-w-3xl px-5 py-10"><h1 className="text-sm font-semibold">Report not available</h1><p className="text-sm text-muted-foreground">This link is not active.</p></main>
  return <main>
    <div className="mx-auto flex max-w-3xl justify-end px-5 pt-4 print:hidden"><Button size="sm" variant="outline" onClick={() => window.print()}>Print or save as PDF</Button></div>
    <GrowthReportView report={state.report} />
  </main>
}
