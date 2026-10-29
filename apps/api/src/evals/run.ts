// Runs the agent quality scenarios against a real model and prints a scoreboard.
//
//   pnpm --filter @openrecord/api eval                                   the hosted model (AGENT_* server settings)
//   pnpm --filter @openrecord/api eval -- --list [--email you@x]         subscriptions connected for an account
//   pnpm --filter @openrecord/api eval -- --instance <id> --model <m> [--email you@x]
//   pnpm --filter @openrecord/api eval -- --regrade <report.json>        re-score saved answers with the current checks (no model calls)
//   options: --scenario <id> (repeatable), --repeat <n>, --min <0..1>
//
// Subscriptions run through the account's bridge, so DATABASE_URL must point
// at that server's database and the bridge must be online. Every scenario's
// evidence is fixed: no tool reads a real business. A report is written to
// ~/.openrecord/evals/. Exits 1 when the pass rate is below --min.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { Effect, Layer, ManagedRuntime, Redacted } from "effect"
import { PgClient } from "@effect/sql-pg"
import { SqlClient } from "@effect/sql"
import type { HarnessSelection } from "@openrecord/contracts"
import { runConversation } from "../agent.js"
import { configuredAgentModel, type AgentModel } from "../agent-model.js"
import { harnessModel } from "../harness-model.js"
import { harnessCatalog } from "../harness-store.js"
import type { AgentToolResult } from "../agent-tools.js"
import { SCENARIOS, grade } from "./scenarios.js"

const args = process.argv.slice(2)
const flag = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined }
const all = (name: string) => args.flatMap((a, i) => a === `--${name}` && args[i + 1] ? [args[i + 1]!] : [])
const email = flag("email") ?? "demo@northstar.test"

const notConnected = (tool: string): AgentToolResult => tool.startsWith("propose_") || tool.startsWith("draft_") || tool.startsWith("prepare_")
  ? { summary: "Not saved: this evaluation saves nothing", citations: [], data: { status: "EVALUATION", note: "Say what you would save; nothing is saved here." } }
  : { summary: "No data for this in the evaluation", citations: [], data: { status: "NOT_CONNECTED", recovery: "Treat as unknown, not zero." } }

const db = () => {
  const url = process.env["DATABASE_URL"]
  if (!url) throw new Error("DATABASE_URL is required to use a subscription")
  return PgClient.layer({ url: Redacted.make(url) })
}
const scopeFor = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const row = (yield* sql`SELECT u.id AS user_id, au.account_id FROM users u JOIN account_users au ON au.user_id = u.id WHERE lower(u.email) = lower(${email}) LIMIT 1`)[0]
  if (!row) return yield* Effect.fail(new Error(`No user ${email}`))
  return { accountId: String(row["account_id"]), userId: String(row["user_id"]), businessId: null }
})

const main = async () => {
  const regrade = flag("regrade")
  if (regrade) {
    const report = JSON.parse(readFileSync(regrade, "utf8")) as { model: string; rows: Array<{ id: string; reply: string; tools: string[] }> }
    const graded = report.rows.flatMap(r => { const s = SCENARIOS.find(x => x.id === r.id); return s ? [grade(s, r.reply, r.tools)] : [] })
    for (const g of graded) console.log(`${g.passed ? "PASS" : "FAIL"}  ${g.id.padEnd(20)} ${g.passed ? "" : g.failed.join("; ")}`)
    console.log(`\n${report.model}: ${graded.filter(g => g.passed).length}/${graded.length} passed with the current checks`)
    return
  }
  if (args.includes("--list")) {
    const catalog = await Effect.runPromise(Effect.flatMap(scopeFor, s => harnessCatalog(s as never)).pipe(Effect.provide(db())))
    for (const i of catalog.instances.filter(i => i.enabled)) console.log(`${i.id}  ${i.driver.padEnd(9)} ${i.state.padEnd(12)} ${i.models.slice(0, 6).map(m => m.id).join(", ")}`)
    return
  }
  const instance = flag("instance"), modelId = flag("model")
  // One runtime for the whole run: a subscription model keeps using its database connection after it is created.
  const runtime = ManagedRuntime.make((instance ? db() : Layer.succeed(SqlClient.SqlClient, undefined as never)) as Layer.Layer<SqlClient.SqlClient, unknown>)
  const { model, label } = await runtime.runPromise(Effect.gen(function*() {
    if (!instance) {
      const m = yield* configuredAgentModel
      return { model: m.invoke as AgentModel, label: `${m.provider}:${m.requestedModel}` }
    }
    if (!modelId) return yield* Effect.fail(new Error("--model is required with --instance"))
    const selection: HarnessSelection = { instanceId: instance, model: modelId }
    const m = yield* harnessModel(yield* scopeFor, selection)
    return { model: m.invoke as AgentModel, label: `${m.provider}:${m.requestedModel}` }
  }))

  const picked = all("scenario").length ? SCENARIOS.filter(s => all("scenario").includes(s.id)) : SCENARIOS
  const repeat = Math.max(1, Math.min(5, Number(flag("repeat") ?? 1)))
  const rows: Array<ReturnType<typeof grade> & { ms: number; reply: string; tools: string[]; error?: string }> = []
  console.log(`Running ${picked.length} scenario${picked.length === 1 ? "" : "s"}${repeat > 1 ? ` × ${repeat}` : ""} on ${label}\n`)
  for (const s of picked) for (let n = 0; n < repeat; n++) {
    const started = Date.now()
    const tools: string[] = []
    const run = await runtime.runPromise(runConversation({ message: s.message, history: [], model,
      dispatch: name => Effect.sync(() => { tools.push(name); return s.evidence[name] ?? notConnected(name) }) }).pipe(Effect.either))
    const reply = run._tag === "Right" ? run.right.reply : ""
    const g = run._tag === "Right" ? grade(s, reply, tools) : { id: s.id, passed: false, failed: ["model did not answer"], checks: s.checks.length }
    rows.push({ ...g, ms: Date.now() - started, reply, tools, ...(run._tag === "Left" ? { error: String((run.left as { reason?: string }).reason ?? run.left) } : {}) })
    console.log(`${g.passed ? "PASS" : "FAIL"}  ${s.id.padEnd(20)} ${String(Math.round((Date.now() - started) / 1000)).padStart(4)}s  ${g.passed ? "" : g.failed.join("; ")}`)
  }
  const passed = rows.filter(r => r.passed).length, rate = passed / rows.length
  console.log(`\n${label}: ${passed}/${rows.length} passed (${Math.round(rate * 100)}%), median ${Math.round([...rows.map(r => r.ms)].sort((a, b) => a - b)[Math.floor(rows.length / 2)]! / 1000)}s per answer`)
  const dir = join(homedir(), ".openrecord", "evals")
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${label.replace(/[^a-z0-9._-]+/gi, "_")}.json`)
  writeFileSync(file, JSON.stringify({ model: label, at: new Date().toISOString(), passRate: rate, rows }, null, 2))
  console.log(`Report: ${file}`)
  await runtime.dispose()
  const min = flag("min")
  if (min !== undefined && rate < Number(min)) process.exitCode = 1
}

main().catch(e => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1 })
