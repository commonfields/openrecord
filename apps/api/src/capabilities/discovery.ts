import { SqlClient } from "@effect/sql"
import { Effect, JSONSchema, Schema } from "effect"
import type { ToolDeclaration } from "../agent-registry.js"
import { CAPABILITY_MANIFESTS } from "./catalog.js"
import { makeRouter } from "./router.js"

export const CapabilitySearch = Schema.Struct({
  query: Schema.Trim.pipe(Schema.minLength(2), Schema.maxLength(300)),
})

export const FIND_CAPABILITIES: ToolDeclaration = {
  name: "find_capabilities",
  description: "Search OpenRecord's available capabilities by task: describe what you want to do, not a tool name. Returns the best fits with their cost, whether they need approval and how they have worked here lately. Use tool_details to load a matching tool's input schema before calling it. An empty answer means nothing fits: do not search again with other words.",
  parametersJsonSchema: JSONSchema.make(CapabilitySearch),
}

/** How a tool has worked in this account lately, from the run journal. Counts only. */
export interface CapabilityStat { readonly calls: number; readonly succeeded: number; readonly medianSeconds: number | null
  /** Results the agent reported as wrong, empty, stale, beside the point or unusable (tool_feedback). */
  readonly reported?: number }
export type CapabilityStats = ReadonlyMap<string, CapabilityStat>

/** Fewer calls than this say nothing about a tool. */
export const MIN_MEASURED_CALLS = 5
/** A measured tool that worked less often than this is listed after the rest. */
const UNRELIABLE_SHARE = 0.5
const STATS_DAYS = 30
// The model's own mistakes say nothing about the tool.
const CALLER_FAULTS = ["INVALID_INPUT", "BUDGET_EXHAUSTED", "UNKNOWN_TOOL"]

const manifests = new Map(CAPABILITY_MANIFESTS.map(manifest => [manifest.id, manifest]))
const route = makeRouter(CAPABILITY_MANIFESTS)

/**
 * Calls, successes and the median time of each named tool in this account's
 * runs over the last 30 days. Scoped to the account: another workspace's
 * connections say nothing about this one's.
 */
export const capabilityStats = (accountId: string, names: ReadonlyArray<string>) => Effect.gen(function*() {
  if (!names.length) return new Map<string, CapabilityStat>() as CapabilityStats
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql`SELECT s.payload->>'tool' AS tool, count(*)::int AS calls,
      (count(*) FILTER (WHERE f.type='TOOL_COMPLETED'))::int AS succeeded,
      percentile_disc(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM f.created_at - s.created_at)) FILTER (WHERE f.type='TOOL_COMPLETED') AS median
    FROM agent_runs r
    JOIN agent_run_events s ON s.run_id=r.id AND s.type='TOOL_STARTED'
    JOIN agent_run_events f ON f.run_id=s.run_id AND f.type IN ('TOOL_COMPLETED','TOOL_FAILED') AND f.payload->>'invocationId'=s.payload->>'invocationId'
    WHERE r.account_id=${accountId} AND r.started_at>now()-make_interval(days => ${STATS_DAYS})
      AND s.payload->>'tool' IN ${sql.in([...names])} AND coalesce(f.payload->>'code','') NOT IN ${sql.in(CALLER_FAULTS)}
    GROUP BY 1`
  // A call that finished but whose result the agent reported as poor did not really work.
  const reports = yield* sql`SELECT tool, count(*)::int AS n FROM agent_capability_signals
    WHERE account_id=${accountId} AND kind='POOR_RESULT' AND tool IN ${sql.in([...names])} AND created_at>now()-make_interval(days => ${STATS_DAYS}) GROUP BY tool`
  const reported = new Map(reports.map(r => [String(r["tool"]), Number(r["n"])]))
  return new Map(rows.map(r => {
    const tool = String(r["tool"]), n = reported.get(tool) ?? 0
    return [tool, {
      calls: Number(r["calls"]), succeeded: Math.max(0, Number(r["succeeded"]) - n), reported: n,
      medianSeconds: r["median"] === null || r["median"] === undefined ? null : Math.round(Number(r["median"]) * 10) / 10,
    }]
  })) as CapabilityStats
})

const measured = (stat: CapabilityStat | undefined) => stat && stat.calls >= MIN_MEASURED_CALLS
  ? { calls: stat.calls, successRate: Math.round((stat.succeeded / stat.calls) * 100) / 100, medianSeconds: stat.medianSeconds, ...(stat.reported ? { reportedPoor: stat.reported } : {}) }
  : null

/** The tools that fit a task, best fit first, for `rank` to order by how they have worked. */
export const matchCapabilities = (query: string, offered: ReadonlyArray<ToolDeclaration>) => {
  const available = new Set(offered.map(tool => tool.name))
  return route({
    text: query,
    core: [],
    allowedSideEffects: ["none", "internal_write"],
    unavailable: new Set([...manifests.keys()].filter(name => !available.has(name))),
    k: 6,
  }).selected.filter(name => manifests.has(name))
}

/**
 * The matches as the model sees them. Fit to the task decides the order; a
 * tool that has failed in most of its recent calls here moves after the
 * others, and each match says how it has worked so the model can choose.
 */
export const rankCapabilities = (names: ReadonlyArray<string>, stats: CapabilityStats = new Map()) => names
  .map((name, fit) => {
    const manifest = manifests.get(name)!
    const record = measured(stats.get(name))
    return { fit, unreliable: record !== null && record.successRate < UNRELIABLE_SHARE, match: {
      name, title: manifest.title, version: manifest.version, sideEffect: manifest.sideEffect,
      costClass: manifest.costClass, requiresApproval: manifest.permission.requiresApproval, measured: record,
    } }
  })
  .sort((a, b) => Number(a.unreliable) - Number(b.unreliable) || a.fit - b.fit)
  .map(x => x.match)

export const findCapabilities = (query: string, offered: ReadonlyArray<ToolDeclaration>, stats?: CapabilityStats) =>
  rankCapabilities(matchCapabilities(query, offered), stats)

/** What the model is told with the matches; an empty answer says so, so it stops searching. */
export const capabilityNote = (found: number) => found
  ? "Best fit first; measured shows how each worked in this workspace over 30 days (null: too few calls to say). Use tool_details with a matching name to load its input schema."
  : "No registered capability fits this task, and it is saved as a request for the team. Do not search again with other words: answer with what you have and say plainly what OpenRecord cannot do yet."
