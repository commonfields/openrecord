// A scorecard from the runs this server recorded: what the agent did for real
// requests, to judge a change to its instructions, tool cards or limits.
//
//   DATABASE_URL=… pnpm --filter @openrecord/api eval:runs                       the last 7 days
//   … eval:runs -- --days 14                                                      another window
//   … eval:runs -- --from 2026-11-01 --to 2026-11-08                              an exact window (UTC days, end excluded)
//   … eval:runs -- --compare ~/.openrecord/evals/runs-….json                      against an earlier scorecard
//   … eval:runs -- --min-answered 0.95 --max-tool-failure 0.1 --max-invalid-input 0.03 --max-answered-without-tools 0.2
//
// Only counts and run identifiers are read: never a request's text, evidence
// or answer. The scorecard is written to ~/.openrecord/evals/, outside the
// repository. Exits 1 when a limit is not held.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import pg from "pg"
import { compare, gate, scoreRuns, type RecordedRun, type Scorecard } from "../src/evals/run-scorecard.js"

const args = process.argv.slice(2)
const flag = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined }
const share = (name: string) => { const v = flag(name); if (v === undefined) return undefined; const n = Number(v); if (!(n >= 0 && n <= 1)) throw new Error(`--${name} takes a share from 0 to 1`); return n }
const day = (v: string | undefined) => v === undefined ? undefined : /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T00:00:00Z`) : (() => { throw new Error("dates are YYYY-MM-DD") })()

const main = async () => {
  const url = process.env["DATABASE_URL"]
  if (!url) throw new Error("DATABASE_URL is required")
  const days = Number(flag("days") ?? "7")
  if (!(days > 0 && days <= 365)) throw new Error("--days takes 1 to 365")
  const to = day(flag("to")) ?? new Date()
  const from = day(flag("from")) ?? new Date(to.getTime() - days * 86400000)
  const pool = new pg.Pool({ connectionString: url, max: 2 })
  try {
    const runs = (await pool.query(`SELECT id, status, outcome, failure_reason, business_id IS NOT NULL AS business,
        CASE WHEN finished_at IS NULL THEN NULL ELSE EXTRACT(EPOCH FROM (finished_at - started_at)) * 1000 END AS duration_ms
      FROM agent_runs WHERE started_at >= $1 AND started_at < $2 AND status <> 'RUNNING' ORDER BY started_at`, [from, to])).rows
    // Reasoning and answer text are display events: a scorecard never reads them.
    const events = runs.length ? (await pool.query(`SELECT run_id, type, payload FROM agent_run_events
      WHERE run_id = ANY($1::uuid[]) AND type NOT IN ('MODEL_THINKING','MODEL_ANSWERING') ORDER BY run_id, seq`, [runs.map(r => r.id)])).rows : []
    const byRun = new Map<string, RecordedRun["events"][number][]>()
    for (const e of events) { const list = byRun.get(e.run_id) ?? []; list.push({ type: e.type, payload: e.payload ?? {} }); byRun.set(e.run_id, list) }
    const card = scoreRuns(runs.map(r => ({ id: r.id, status: r.status, outcome: r.outcome, failureReason: r.failure_reason, business: r.business === true,
      durationMs: r.duration_ms === null ? null : Math.round(Number(r.duration_ms)), events: byRun.get(r.id) ?? [] })))
    const before = flag("compare") ? (JSON.parse(readFileSync(flag("compare")!, "utf8")) as { scorecard: Scorecard }).scorecard : undefined
    const window = `${from.toISOString().slice(0, 10)} to ${to.toISOString().slice(0, 10)}`
    console.log(`\n${card.runs} runs, ${window}\n`)
    for (const row of compare(card, before)) console.log(`  ${row.measure.padEnd(44)} ${row.now.padStart(8)}${row.before === null ? "" : `   was ${row.before.padStart(8)}${row.better === null ? "" : row.better ? "   better" : "   worse"}`}`)
    if (card.tools.some(t => t.failed)) {
      console.log("\n  Tools that failed (calls, failed, invalid input)")
      for (const t of card.tools.filter(t => t.failed).slice(0, 12)) console.log(`    ${t.tool.padEnd(42)} ${String(t.calls).padStart(5)} ${String(t.failed).padStart(5)} ${String(t.invalidInput).padStart(5)}`)
    }
    if (card.gaps.length) { console.log("\n  What answers left unchecked (runs)"); for (const g of card.gaps.slice(0, 8)) console.log(`    ${String(g.runs).padStart(4)}  ${g.gap}`) }
    if (Object.keys(card.failureReasons).length) console.log(`\n  Runs that did not finish: ${Object.entries(card.failureReasons).map(([k, n]) => `${k} ${n}`).join(", ")}`)
    const dir = join(homedir(), ".openrecord", "evals")
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `runs-${from.toISOString().slice(0, 10)}-${to.toISOString().slice(0, 10)}.json`)
    writeFileSync(file, JSON.stringify({ from: from.toISOString(), to: to.toISOString(), scorecard: card }, null, 2))
    console.log(`\n  Saved to ${file}`)
    const gates = gate(card, { minAnswered: share("min-answered"), minClean: share("min-clean"), maxToolFailure: share("max-tool-failure"), maxInvalidInput: share("max-invalid-input"), maxAnsweredWithoutTools: share("max-answered-without-tools") })
    for (const g of gates) console.log(`  ${g.passed ? "held" : "NOT HELD"}: ${g.label} ${(g.value * 100).toFixed(1)}% (limit ${(g.limit * 100).toFixed(1)}%)`)
    if (gates.some(g => !g.passed)) process.exitCode = 1
  } finally { await pool.end() }
}
main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1 })
