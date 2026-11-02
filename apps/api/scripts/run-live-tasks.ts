// Runs real marketing tasks through OpenRecord's agent (the running API, as
// the signed-in user, on a connected subscription) and, with --baseline,
// through a plain Claude Code session given the same business facts with web
// search and page reading. Writes both answers, the tools used and timings
// for side-by-side review. Nothing is graded automatically.
//
//   tsx scripts/run-live-tasks.ts <tasks.json> --instance <id> --model <m> [--baseline] [--only id,id] [--api http://localhost:3001]
import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

interface Task { readonly id: string; readonly business: string; readonly name: string; readonly website: string; readonly goals: ReadonlyArray<string>; readonly task: string }
const args = process.argv.slice(2)
const flag = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined }
const api = flag("api") ?? "http://localhost:3001", origin = "http://localhost:3000"
const only = flag("only")?.split(",")

const signIn = async () => {
  const r = await fetch(`${api}/api/auth/signin`, { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify({ email: process.env["EVAL_EMAIL"] ?? "demo@northstar.test", password: process.env["EVAL_PASSWORD"] ?? "password123" }) })
  const cookie = r.headers.get("set-cookie")?.split(";")[0]
  if (!cookie) throw new Error(`sign-in failed: ${r.status}`)
  return cookie
}
const openRecord = async (cookie: string, t: Task, instanceId: string, model: string) => {
  const started = Date.now()
  // A new chat per task, as "New chat" does in the app.
  const conversationId = randomUUID()
  await fetch(`${api}/api/businesses/${t.business}/agent/conversation`, { method: "POST", headers: { "content-type": "application/json", origin, cookie }, body: JSON.stringify({ conversationId }) })
  const r = await fetch(`${api}/api/businesses/${t.business}/agent/messages`, { method: "POST", signal: AbortSignal.timeout(600_000),
    headers: { "content-type": "application/json", origin, cookie }, body: JSON.stringify({ message: t.task, requestId: randomUUID(), conversationId, revision: 0, selection: { instanceId, model } }) })
  const body = await r.json().catch(() => ({})) as Record<string, unknown>
  return { ms: Date.now() - started, status: r.status, reply: String(body["reply"] ?? ""), toolCalls: body["toolCalls"] ?? [], citations: body["citations"] ?? [], outcome: body["outcome"] ?? null, error: r.ok ? null : body }
}
const baseline = (t: Task, model: string) => new Promise<{ ms: number; reply: string; error: string | null }>(resolve => {
  const started = Date.now()
  const prompt = `You are a marketing assistant for ${t.name} (${t.website}).${t.goals.length ? ` The owner's goals: ${t.goals.join("; ")}.` : ""} Use web search and read pages as needed.\n\n${t.task}`
  execFile("claude", ["-p", prompt, "--model", model, "--allowedTools", "WebSearch,WebFetch", "--output-format", "json"], { timeout: 600_000, maxBuffer: 20_000_000 }, (err, stdout) => {
    let reply = ""
    try { reply = String((JSON.parse(stdout) as { result?: unknown }).result ?? "") } catch { reply = stdout.slice(0, 20000) }
    resolve({ ms: Date.now() - started, reply, error: err ? String(err.message).slice(0, 300) : null })
  })
})

const main = async () => {
  const tasks = (JSON.parse(readFileSync(args[0]!, "utf8")) as Task[]).filter(t => !only || only.includes(t.id))
  const instance = flag("instance"), model = flag("model") ?? "sonnet"
  if (!instance) throw new Error("--instance is required")
  const cookie = await signIn()
  const rows = []
  for (const t of tasks) {
    const or = await openRecord(cookie, t, instance, model)
    const tools = (or.toolCalls as Array<{ tool: string }>).map(x => x.tool)
    console.log(`OPENRECORD ${t.id.padEnd(22)} ${String(Math.round(or.ms / 1000)).padStart(4)}s  status ${or.status}  tools ${tools.length} (${[...new Set(tools)].join(", ").slice(0, 120)})`)
    const base = args.includes("--baseline") ? await baseline(t, model) : null
    if (base) console.log(`BASELINE   ${t.id.padEnd(22)} ${String(Math.round(base.ms / 1000)).padStart(4)}s  ${base.error ? `error ${base.error.slice(0, 80)}` : `${base.reply.length} chars`}`)
    rows.push({ task: t, openrecord: or, baseline: base })
  }
  const dir = join(homedir(), ".openrecord", "evals")
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `live-${new Date().toISOString().replace(/[:.]/g, "-")}.json`)
  writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), model, rows }, null, 2))
  console.log(`Report: ${file}`)
}
main().catch(e => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1 })
