// Durable agent runs (migration 0040). A run is one attempt to answer one user
// message. Its journal records each model step, every tool invocation with a
// server-generated invocation ID, proposal receipts, verification and the
// terminal outcome. Progress is readable while the run executes, and a run
// that stops early (cancel, provider failure, crash) is settled into the
// conversation as an explicit note naming what was saved and what was not.
import { SqlClient } from "@effect/sql"
import { Effect } from "effect"
import { AgentModelError } from "./agent-model.js"
import { toolLabel, type ToolEffect } from "./agent-registry.js"

export type RunEventType = "RUN_STARTED" | "CONTEXT_BUILT" | "MODEL_STEP" | "TOOL_STARTED" | "TOOL_COMPLETED" | "TOOL_FAILED" | "VERIFICATION" | "RUN_FINISHED"
export type RunStatus = "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED" | "INTERRUPTED"
export type RunOutcome = "ANSWERED" | "ANSWERED_WITH_GAPS"
export interface RunEvent { readonly type: RunEventType; readonly payload: Record<string, unknown> }

/** Where a run writes its journal. Recording failure stops the run: work that
 * cannot be recorded must not continue. */
export interface RunJournal {
  readonly record: (type: RunEventType, payload: Record<string, unknown>) => Effect.Effect<void, AgentModelError>
}
export const noJournal: RunJournal = { record: () => Effect.void }
export const memoryJournal = () => {
  const events: RunEvent[] = []
  const journal: RunJournal = { record: (type, payload) => Effect.sync(() => { events.push({ type, payload }) }) }
  return { events, journal }
}

// Events are bounded so a large citation list can never fail the journal.
const bounded = (payload: Record<string, unknown>) => {
  let text = JSON.stringify(payload)
  if (text.length <= 15000) return text
  const { citations: _citations, ...rest } = payload
  text = JSON.stringify({ ...rest, citationsOmitted: true })
  return text.length <= 15000 ? text : JSON.stringify({ truncated: true, tool: payload["tool"] ?? null, invocationId: payload["invocationId"] ?? null })
}

export const sqlJournal = (sql: SqlClient.SqlClient, runId: string): RunJournal => ({
  record: (type, payload) => sql`WITH bumped AS (
      UPDATE agent_runs SET next_seq = next_seq + 1,
        model_steps = model_steps + ${type === "MODEL_STEP" ? 1 : 0}, tool_calls = tool_calls + ${type === "TOOL_STARTED" ? 1 : 0}
      WHERE id = ${runId} AND status = 'RUNNING' RETURNING next_seq - 1 AS seq)
    INSERT INTO agent_run_events(run_id, seq, type, payload) SELECT ${runId}, seq, ${type}, ${bounded(payload)}::jsonb FROM bumped RETURNING seq`.pipe(
    Effect.mapError(() => new AgentModelError({ reason: "UNAVAILABLE" })),
    // A run that is no longer RUNNING was settled elsewhere (cancel or recovery).
    Effect.flatMap(rows => rows.length ? Effect.void : Effect.fail(new AgentModelError({ reason: "CANCELLED" })))),
})

export interface RunScope { readonly accountId: string; readonly userId: string; readonly businessId: string | null }
export const startRun = (scope: RunScope, input: {
  readonly conversationId: string; readonly leaseId: string; readonly requestId: string; readonly objective: string
  readonly workflow: { readonly id: string; readonly version: number } | null; readonly budget: { readonly modelSteps: number; readonly toolCalls: number }
}) => Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql`INSERT INTO agent_runs(conversation_id, account_id, business_id, user_id, request_id, lease_id, objective, workflow)
    VALUES (${input.conversationId}, ${scope.accountId}, ${scope.businessId}, ${scope.userId}, ${input.requestId}, ${input.leaseId}, ${input.objective},
      ${input.workflow === null ? null : JSON.stringify(input.workflow)}::jsonb) RETURNING id`
  const runId = String(rows[0]!["id"])
  const journal = sqlJournal(sql, runId)
  yield* journal.record("RUN_STARTED", { workflow: input.workflow, budget: input.budget })
  return { runId, journal }
})

/** Moves a RUNNING run to its terminal state once; later calls are no-ops. */
export const finishRun = (runId: string, status: Exclude<RunStatus, "RUNNING">, detail: { readonly outcome?: RunOutcome | undefined; readonly reason?: string | undefined; readonly gaps?: ReadonlyArray<string> | undefined } = {}) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* sqlJournal(sql, runId).record("RUN_FINISHED", { status, outcome: detail.outcome ?? null, reason: detail.reason ?? null, gaps: detail.gaps ?? [] }).pipe(Effect.ignore)
    yield* sql`UPDATE agent_runs SET status = ${status}, outcome = ${status === "COMPLETED" ? detail.outcome ?? "ANSWERED" : null},
      failure_reason = ${detail.reason ?? null}, finished_at = now(), settled_at = CASE WHEN ${status} = 'COMPLETED' THEN now() END
      WHERE id = ${runId} AND status = 'RUNNING'`
  })

const STOPPED: Readonly<Record<string, string>> = {
  CANCELLED: "Stopped before finishing.",
  INTERRUPTED: "This request was interrupted before it finished.",
  TIMEOUT: "This request timed out before it finished.",
  RATE_LIMITED: "The model provider was rate limited before this request finished.",
  CONTEXT_LIMIT: "This request ran out of context space before it finished.",
  TOOL_LIMIT: "This request used its whole step budget before it finished.",
}
type JournalRow = { readonly type: RunEventType; readonly payload: Record<string, unknown> }
const str = (v: unknown) => typeof v === "string" ? v : ""

/** The conversation note for a run that stopped before its reply. Built only
 * from the journal, so it states exactly what was recorded. */
export const interruptionNote = (status: RunStatus, reason: string | null, events: ReadonlyArray<JournalRow>) => {
  const finished = new Set(events.filter(e => e.type === "TOOL_COMPLETED" || e.type === "TOOL_FAILED").map(e => str(e.payload["invocationId"])))
  const completed = events.filter(e => e.type === "TOOL_COMPLETED")
  const saved = [...new Set(completed.filter(e => e.payload["effect"] === "propose").map(e => str(e.payload["summary"])))]
  const read = [...new Set(completed.filter(e => e.payload["effect"] !== "propose").map(e => str(e.payload["summary"])))]
  const inflight = events.filter(e => e.type === "TOOL_STARTED" && !finished.has(str(e.payload["invocationId"])))
  const lines = [status === "FAILED" ? STOPPED[reason ?? ""] ?? "The model provider failed before this request finished." : STOPPED[status] ?? STOPPED["INTERRUPTED"]!]
  if (saved.length) lines.push(`Saved for your review before stopping: ${saved.join("; ")}.`)
  for (const e of inflight) lines.push(e.payload["effect"] === "propose"
    ? `A save was in progress (${toolLabel(str(e.payload["tool"])).toLowerCase()}) and may not have completed. Check open proposals before asking again.`
    : `${toolLabel(str(e.payload["tool"]))} did not finish.`)
  if (read.length) lines.push(`Evidence read: ${read.slice(0, 5).join("; ")}.`)
  lines.push(saved.length || inflight.some(e => e.payload["effect"] === "propose")
    ? "No final answer was written. Ask again to continue; saved proposals are reused, not duplicated."
    : "No final answer was written. Ask again to continue.")
  const citations = new Map<string, { kind: string; id: string; text: string }>()
  for (const e of completed) for (const c of (e.payload["citations"] as ReadonlyArray<{ kind: string; id: string; text: string }> | undefined) ?? []) citations.set(`${c.kind}:${c.id}`, c)
  return {
    text: lines.join("\n"),
    citations: [...citations.values()],
    toolCalls: events.filter(e => e.type === "TOOL_COMPLETED" || e.type === "TOOL_FAILED").map(e => ({ tool: str(e.payload["tool"]), summary: str(e.payload["summary"]) })),
    worked: events.some(e => e.type === "TOOL_STARTED"),
  }
}

/** Settles stopped runs of one conversation. Call inside a transaction that
 * holds the conversation row FOR UPDATE. A RUNNING run whose lease no longer
 * holds was interrupted. A stopped run that did tool work adds its request and
 * an interruption note to the conversation; one that did nothing leaves the
 * conversation unchanged so the message can simply be sent again. */
export const settleRuns = (conversationId: string) => Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql`UPDATE agent_runs r SET status = 'INTERRUPTED', failure_reason = 'INTERRUPTED', finished_at = now()
    FROM agent_conversations c WHERE c.id = r.conversation_id AND r.conversation_id = ${conversationId} AND r.status = 'RUNNING'
      AND (c.lease_id IS DISTINCT FROM r.lease_id OR c.lease_until IS NULL OR c.lease_until <= now())`
  const runs = yield* sql`SELECT id, objective, status, failure_reason FROM agent_runs
    WHERE conversation_id = ${conversationId} AND settled_at IS NULL AND status <> 'RUNNING' ORDER BY started_at`
  if (!runs.length) return 0
  const appended: unknown[] = []
  for (const run of runs) {
    const id = String(run["id"]), status = String(run["status"]) as RunStatus
    if (status !== "COMPLETED") {
      const events = (yield* sql`SELECT type, payload FROM agent_run_events WHERE run_id = ${id} ORDER BY seq`) as unknown as ReadonlyArray<JournalRow>
      const note = interruptionNote(status, run["failure_reason"] === null ? null : String(run["failure_reason"]), events)
      if (note.worked) appended.push({ role: "user", text: String(run["objective"]) },
        { role: "agent", text: note.text, citations: note.citations, toolCalls: note.toolCalls, run: { id, status } })
    }
    yield* sql`UPDATE agent_runs SET settled_at = now() WHERE id = ${id}`
  }
  if (appended.length) yield* sql`UPDATE agent_conversations SET
      messages = (SELECT COALESCE(jsonb_agg(m ORDER BY i), '[]'::jsonb) FROM (
        SELECT m, i FROM jsonb_array_elements(messages || ${JSON.stringify(appended)}::jsonb) WITH ORDINALITY AS e(m, i)
        ORDER BY i DESC LIMIT 200) kept),
      revision = revision + 1, updated_at = now(), expires_at = now() + interval '30 days'
    WHERE id = ${conversationId}`
  return appended.length / 2
})

export type RunView = {
  readonly id: string; readonly status: RunStatus; readonly outcome: RunOutcome | null; readonly failureReason: string | null
  readonly modelSteps: number; readonly toolCalls: number; readonly startedAt: string; readonly finishedAt: string | null
}
const view = (r: Record<string, unknown>): RunView => ({
  id: String(r["id"]), status: String(r["status"]) as RunStatus, outcome: (r["outcome"] as RunOutcome | null) ?? null,
  failureReason: (r["failure_reason"] as string | null) ?? null, modelSteps: Number(r["model_steps"]), toolCalls: Number(r["tool_calls"]),
  startedAt: new Date(r["started_at"] as string).toISOString(), finishedAt: r["finished_at"] ? new Date(r["finished_at"] as string).toISOString() : null,
})

/** The newest run for a client request ID, with journal events after `after`.
 * Scoped to the signed-in user; unknown and foreign requests read as null. */
export const readRunProgress = (scope: { readonly accountId: string; readonly userId: string }, requestId: string, after: number) => Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql`SELECT r.id, r.status, r.outcome, r.failure_reason, r.model_steps, r.tool_calls, r.started_at, r.finished_at
    FROM agent_runs r JOIN account_users au ON au.account_id = r.account_id AND au.user_id = r.user_id
    WHERE r.account_id = ${scope.accountId} AND r.user_id = ${scope.userId} AND r.request_id = ${requestId}
    ORDER BY r.started_at DESC LIMIT 1`
  if (!rows[0]) return { run: null, events: [] }
  const run = view(rows[0])
  const events = yield* sql`SELECT seq, type, payload, created_at FROM agent_run_events WHERE run_id = ${run.id} AND seq > ${after} ORDER BY seq LIMIT 200`
  return { run, events: events.map(e => ({ seq: Number(e["seq"]), type: String(e["type"]) as RunEventType, at: new Date(e["created_at"] as string).toISOString(), payload: e["payload"] as Record<string, unknown> })) }
})

export type ToolEventPayload = { readonly invocationId: string; readonly tool: string; readonly effect: ToolEffect }
