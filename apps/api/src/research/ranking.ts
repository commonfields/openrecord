// How research capabilities have worked in this workspace, for
// find_research_capabilities. Several sources often cover one need (a site's
// technologies, its traffic history, keyword data); the list stays in order of
// fit, a source that mostly failed or found nothing here moves after the rest,
// and each one says what it returned lately and what a call costs, so the agent
// can choose. Counts come from saved research observations and the agent's own
// reports of poor results (tool_feedback), in this account only.
import { SqlClient } from "@effect/sql"
import { Effect } from "effect"
import type { AnyCapability } from "./types.js"
import { ENDPOINTS } from "./endpoints/run.js"
import { priceOf } from "./endpoints/metering.js"

export interface ResearchStat {
  readonly runs: number; readonly observed: number; readonly noData: number; readonly failed: number
  readonly reported: number; readonly medianSeconds: number | null
}
export type ResearchStats = ReadonlyMap<string, ResearchStat>

/** Fewer runs than this say nothing about a source. */
export const MIN_MEASURED_RUNS = 5
const UNRELIABLE_SHARE = 0.5
const DAYS = 30

export const researchStats = (accountId: string, ids: ReadonlyArray<string>) => Effect.gen(function*() {
  if (!ids.length) return new Map<string, ResearchStat>() as ResearchStats
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql`SELECT operation, count(*)::int AS runs,
      (count(*) FILTER (WHERE status='OBSERVED'))::int AS observed, (count(*) FILTER (WHERE status='NO_DATA'))::int AS no_data,
      (count(*) FILTER (WHERE status='FAILED'))::int AS failed,
      percentile_disc(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM observed_at - created_at)) FILTER (WHERE observed_at IS NOT NULL) AS median
    FROM research_observations WHERE account_id=${accountId} AND operation IN ${sql.in([...ids])} AND status<>'PENDING'
      AND created_at > now() - make_interval(days => ${DAYS}) GROUP BY operation`
  const reports = yield* sql`SELECT tool, count(*)::int AS n FROM agent_capability_signals
    WHERE account_id=${accountId} AND kind='POOR_RESULT' AND tool IN ${sql.in([...ids])} AND created_at > now() - make_interval(days => ${DAYS}) GROUP BY tool`
  const reported = new Map(reports.map(r => [String(r["tool"]), Number(r["n"])]))
  return new Map(rows.map(r => [String(r["operation"]), {
    runs: Number(r["runs"]), observed: Number(r["observed"]), noData: Number(r["no_data"]), failed: Number(r["failed"]),
    reported: reported.get(String(r["operation"])) ?? 0,
    medianSeconds: r["median"] === null || r["median"] === undefined ? null : Math.round(Number(r["median"]) * 10) / 10,
  }])) as ResearchStats
})

const endpointPrice = new Map(ENDPOINTS.map(e => [e.id, e]))
/** What one call costs on OpenRecord's own account, when it is served there. */
export const priceUsd = (id: string, env: NodeJS.ProcessEnv = process.env) => {
  const e = endpointPrice.get(id)
  const micro = e ? priceOf(e, env) : null
  return micro === null ? null : micro / 1_000_000
}

/** A source's record here: a result it found counts unless the agent reported it as poor. */
export const measuredResearch = (stat: ResearchStat | undefined) => stat && stat.runs >= MIN_MEASURED_RUNS ? {
  runs: stat.runs,
  foundShare: Math.round((Math.max(0, stat.observed - stat.reported) / stat.runs) * 100) / 100,
  noDataShare: Math.round((stat.noData / stat.runs) * 100) / 100,
  failedShare: Math.round((stat.failed / stat.runs) * 100) / 100,
  medianSeconds: stat.medianSeconds,
  ...(stat.reported ? { reportedPoor: stat.reported } : {}),
} : null

/** Fit order, with sources that mostly found nothing usable here moved after the rest. */
export const rankResearch = <C extends AnyCapability>(found: ReadonlyArray<C>, stats: ResearchStats): ReadonlyArray<C> => found
  .map((c, fit) => {
    const m = measuredResearch(stats.get(c.id))
    return { c, fit, weak: m !== null && m.foundShare < UNRELIABLE_SHARE }
  })
  .sort((a, b) => Number(a.weak) - Number(b.weak) || a.fit - b.fit)
  .map(x => x.c)
