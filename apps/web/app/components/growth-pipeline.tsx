// The visible initiative workflow: Goal → Plan → Execute → Measure → Report.
// The strip states each stage from persisted evidence only (lib/growth-stage);
// the sections below it keep the existing lazy, evidence-preserving components
// in workflow order. Technical depth stays one labeled expansion away.
import { useEffect, useState, type ReactNode } from "react"
import type { GrowthOpportunity, GrowthPlanRead, GrowthReportSummary } from "@openrecord/contracts"
import { ArrowRightIcon, CheckIcon, CircleAlertIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Growth } from "@/lib/growth"
import { GrowthReports } from "@/lib/growth-report"
import { growthStages, type GrowthStage } from "@/lib/growth-stage"
import { GrowthPlanSection } from "@/components/growth-plan"
import { GrowthExecutionSection } from "@/components/growth-execution"
import { GrowthEvaluationSection } from "@/components/growth-evaluation"
import { GrowthReportPanel } from "@/components/growth-report-panel"

const stateDot: Record<GrowthStage["state"], string> = {
  done: "bg-primary-ink/10 text-primary-ink",
  current: "bg-primary text-primary-foreground",
  todo: "bg-muted text-muted-foreground",
  attention: "bg-review-soft text-review",
}

const stateWord: Record<GrowthStage["state"], string> = {
  done: "complete",
  current: "current stage",
  todo: "not started",
  attention: "needs attention",
}

/** The five-stage flow as a compact strip: desktop in one row, mobile stacked. */
export function GrowthStageStrip({ stages, compact }: { stages: ReadonlyArray<GrowthStage>; compact?: boolean }) {
  return (
    <ol aria-label="Initiative stages" className={cn("grid gap-2", compact ? "sm:grid-cols-2" : "sm:grid-cols-3 xl:grid-cols-5")}>
      {stages.map((s, i) => (
        <li
          key={s.key}
          className={cn(
            "relative flex items-start gap-2.5 rounded-lg border px-3 py-2.5",
            s.state === "current" ? "border-primary-ink/30 bg-primary-ink/[0.04]" : "border-border/70",
          )}
        >
          <span
            aria-hidden
            className={cn(
              "flex size-5 shrink-0 items-center justify-center rounded-full text-[0.625rem] font-semibold [&_svg]:size-3",
              stateDot[s.state],
            )}
          >
            {s.state === "done" ? <CheckIcon /> : s.state === "attention" ? <CircleAlertIcon /> : i + 1}
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-baseline justify-between gap-2">
              <span className={cn("text-xs font-semibold", s.state === "todo" && "text-muted-foreground")}>{s.label}</span>
              <span className="sr-only">{stateWord[s.state]}</span>
            </span>
            <span className="mt-0.5 block text-[0.6875rem] leading-snug text-muted-foreground">{s.detail}</span>
            {s.next ? (
              <span className="mt-1 flex items-center gap-1 text-[0.6875rem] font-medium text-foreground">
                <ArrowRightIcon className="size-3 shrink-0 text-muted-foreground" aria-hidden />
                {s.next}
              </span>
            ) : null}
            {s.caveat ? <span className="mt-1 block text-[0.6875rem] leading-snug text-review">{s.caveat}</span> : null}
          </span>
        </li>
      ))}
    </ol>
  )
}

/** Numbered stage section: what the stage is for, then the existing section. */
export function GrowthStageSection({ index, title, purpose, children, className }: {
  index: number
  title: string
  purpose: string
  children: ReactNode
  className?: string
}) {
  return (
    <section className={cn("rounded-lg border p-4", className)} aria-label={title}>
      <div className="flex items-start gap-2.5">
        <span aria-hidden className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[0.625rem] font-semibold text-muted-foreground">{index}</span>
        <div className="min-w-0">
          <h3 className="text-xs font-semibold">{title}</h3>
          <p className="mt-0.5 text-[0.6875rem] leading-snug text-muted-foreground">{purpose}</p>
        </div>
      </div>
      <div className="mt-3 space-y-3">{children}</div>
    </section>
  )
}

/** Loads the persisted stage facts for one approved initiative (its plan and
 * its published reports), renders the strip, then the four stage sections in
 * workflow order. Evaluation stays on demand inside the Measure section:
 * OpenRecord computes evaluations when asked, so the strip never claims one
 * has already run. */
export function GrowthInitiativeStages({ businessId, opportunity, hasGoal, importsCount, refreshKey, onRecordExecution }: {
  businessId: string
  opportunity: GrowthOpportunity
  hasGoal: boolean
  importsCount: number | null
  refreshKey: string
  onRecordExecution: () => void
}) {
  const [plan, setPlan] = useState<GrowthPlanRead | null | undefined>(undefined)
  const [reports, setReports] = useState<ReadonlyArray<GrowthReportSummary> | undefined>(undefined)
  useEffect(() => {
    let alive = true
    void Promise.allSettled([Growth.plan(businessId, opportunity.id), GrowthReports.list(businessId, opportunity.id)]).then(([p, r]) => {
      if (!alive) return
      setPlan(p.status === "fulfilled" ? p.value.plan : undefined)
      setReports(r.status === "fulfilled" ? r.value.reports : undefined)
    })
    return () => { alive = false }
  }, [businessId, opportunity.id, refreshKey])

  const stages = growthStages({ status: opportunity.status, hasGoal, plan, opportunity, imports: importsCount, reports })
  return (
    <div className="space-y-3">
      <GrowthStageStrip stages={stages} />
      <div className="grid gap-3 xl:grid-cols-2">
        <GrowthStageSection index={2} title="Plan" purpose="Agree the before and after periods before the work, so the report can say they were not chosen afterwards.">
          <GrowthPlanSection businessId={businessId} opportunityId={opportunity.id} />
        </GrowthStageSection>
        <GrowthStageSection index={3} title="Execute" purpose="Record what a person actually did. OpenRecord stores the proof level with it.">
          <div>
            <Button size="sm" onClick={onRecordExecution}>Record execution</Button>
            <p className="mt-2 text-[0.6875rem] leading-snug text-muted-foreground">
              Optional: send one exact, reviewed website change as a pull request. A merge is recorded as a system-verified merge — never as live publication or a business result.
            </p>
          </div>
          <GrowthExecutionSection businessId={businessId} opportunityId={opportunity.id} />
        </GrowthStageSection>
        <GrowthStageSection index={4} title="Measure" purpose="Read the recorded daily figures for the agreed periods. Comparable figures are a data-quality statement, not proof of success.">
          <GrowthEvaluationSection businessId={businessId} opportunityId={opportunity.id} />
          <a href={`/clients/${encodeURIComponent(businessId)}/growth-measurement`} className="justify-self-start text-[0.6875rem] font-medium underline underline-offset-2 hover:text-foreground">
            Open measurement imports
          </a>
        </GrowthStageSection>
        <GrowthStageSection index={5} title="Report" purpose="Preview, then publish an immutable version for the client. Publishing freezes the evidence; later data never changes it.">
          <GrowthReportPanel businessId={businessId} opportunityId={opportunity.id} />
        </GrowthStageSection>
      </div>
    </div>
  )
}
