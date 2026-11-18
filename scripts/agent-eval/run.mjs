#!/usr/bin/env node
// Runs real marketing tasks against the agent through the API (the same path
// the apps use: a new conversation, a queued request, the worker's answer) and
// scores each answer with fixed checks. It measures the harness, not the
// business: run it against a demo workspace, never one with real customers.
//
//   node scripts/agent-eval/run.mjs --business <id> [--model <instanceId:modelId>] [--only id,id] [--judge] [--out file.json]
//
// --judge also grades each answer's quality (specific, actionable, honest,
// useful; 1 to 5) with the same model, in a separate general chat.
//
// Needs the API on OPENRECORD_API_URL (default http://localhost:3001), the
// agent worker, and a ready model. Sign-in: OPENRECORD_EVAL_EMAIL and
// OPENRECORD_EVAL_PASSWORD (default: the demo login).
import { randomUUID } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]?.startsWith("--") ? "" : all[i + 1] ?? ""]] : acc), []))
const API = process.env.OPENRECORD_API_URL ?? "http://localhost:3001"
const ORIGIN = "http://localhost:3000"
const business = args.business ?? process.env.OPENRECORD_DEMO_BUSINESSES?.split(",")[0]
if (!business) { console.error("Pass --business <id>"); process.exit(2) }
const TIMEOUT_MS = Number(args.timeout ?? 12 * 60_000)
const tasks = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "tasks.json"), "utf8"))
  .filter(t => !args.only || args.only.split(",").includes(t.id))

// "(?i)..." marks a case-insensitive pattern.
const pattern = p => p.startsWith("(?i)") ? new RegExp(p.slice(4), "i") : new RegExp(p)
// What no answer to a person should contain, whatever the task.
const NEVER = [
  ["internal tool name", /\b(read|propose|record|prepare|create|edit|run|find|bind|ask)_[a-z_]{3,}\b/],
  ["raw id", /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i],
  ["dot separator", /·/],
  ["sends the person nowhere", /(?:in the scheduler|contact (?:your )?administrator|isn't available here|not available in this chat)/i],
]

let cookie = ""
async function call(method, path, body) {
  const res = await fetch(API + path, {
    method, headers: { "content-type": "application/json", origin: ORIGIN, ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const set = res.headers.getSetCookie?.() ?? []
  if (set.length) cookie = set.map(c => c.split(";")[0]).join("; ")
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* not JSON */ }
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text.slice(0, 200)}`)
  return json
}

async function selection() {
  if (args.model === "hosted") return undefined
  const catalog = await call("GET", "/api/agent/providers")
  const ready = (catalog.instances ?? []).filter(i => i.enabled && i.state === "ready" && (i.models ?? []).length)
  if (args.model) {
    const [instanceId, ...model] = args.model.split(":")
    return { instanceId, model: model.join(":") }
  }
  const pick = ready.find(i => i.driver === "claude") ?? ready[0]
  if (!pick) throw new Error("No ready model. Connect one in Settings, Agent.")
  return { instanceId: pick.id, model: pick.models[0].id }
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

/** Sends one message in a new chat and waits for the finished job. */
async function ask(path, message, chosen) {
  const started = Date.now()
  const conversationId = randomUUID()
  const { conversation } = await call("POST", `${path}/conversation`, { conversationId })
  const requestId = randomUUID()
  await call("POST", `${path}/requests`, { message, requestId, conversationId, revision: conversation.revision ?? 0, ...(chosen ? { selection: chosen } : {}) })
  let job
  while (Date.now() - started < TIMEOUT_MS) {
    await sleep(4000)
    job = await call("GET", `/api/agent/requests/${requestId}`)
    if (!["QUEUED", "RUNNING"].includes(job.status)) return { job, conversationId, seconds: Math.round((Date.now() - started) / 1000) }
  }
  await call("POST", `/api/agent/requests/${requestId}/cancel`, {}).catch(() => {})
  return { job: null, conversationId, seconds: Math.round((Date.now() - started) / 1000) }
}

const RUBRIC = ["specific", "actionable", "honest", "useful"]
/** The same model grades the answer against a fixed rubric; null when it can't. */
async function judge(task, reply, artifacts, chosen) {
  const message = `Grade this marketing assistant's answer for a small team. Score each from 1 (poor) to 5 (excellent):
specific: names real pages, channels, numbers or wording, not generic advice;
actionable: the reader knows exactly what to do next;
honest: says what is unknown, invents no facts, numbers or features;
useful: a founder would be glad to get it.
${artifacts ? "A finished piece was also saved beside the chat; judge the answer as its cover note.\n" : ""}Reply with only JSON: {"specific":n,"actionable":n,"honest":n,"useful":n,"why":"one sentence"}. Read no tools.

TASK: ${task.prompt}

ANSWER:
${reply.slice(0, 2900)}`
  const { job } = await ask("/api/agent", message, chosen)
  const text = typeof job?.result?.reply === "string" ? job.result.reply : ""
  const found = text.match(/\{[\s\S]*\}/)
  if (!found) return null
  try {
    const g = JSON.parse(found[0])
    return RUBRIC.every(k => Number.isFinite(g[k])) ? g : null
  } catch { return null }
}

async function runTask(task, chosen) {
  const { job, conversationId, seconds } = await ask(`/api/businesses/${business}/agent`, task.prompt, chosen)
  if (!job) return { id: task.id, seconds, checks: [["finished in time", false]], reply: "" }
  const r = job.result ?? {}
  const reply = typeof r.reply === "string" ? r.reply : ""
  const tools = Array.isArray(r.toolCalls) ? r.toolCalls.length : 0
  const artifacts = Array.isArray(r.artifacts) ? r.artifacts.length : 0
  const checks = [
    ["completed", job.status === "COMPLETED"],
    ["answered", r.outcome === "ANSWERED" || r.outcome === "ANSWERED_WITH_GAPS"],
    ["has a reply", reply.trim().length >= 40],
  ]
  if (task.minTools) checks.push([`used ${task.minTools}+ tools (${tools})`, tools >= task.minTools])
  if (task.artifact) checks.push([`made the finished piece (${artifacts})`, artifacts > 0])
  for (const p of task.must ?? []) checks.push([`says ${p}`, pattern(p).test(reply)])
  for (const p of task.mustNot ?? []) checks.push([`avoids ${p}`, !pattern(p).test(reply)])
  for (const [name, re] of NEVER) checks.push([`no ${name}`, !re.test(reply)])
  const grade = args.judge !== undefined && reply ? await judge(task, reply, artifacts, chosen) : null
  return { id: task.id, seconds, grade, status: job.status, failure: job.failure_reason ?? null, outcome: r.outcome ?? null, tools, artifacts, gaps: r.gaps ?? [], checks, reply, conversationId }
}

await call("POST", "/api/auth/signin", { email: process.env.OPENRECORD_EVAL_EMAIL ?? "demo@northstar.test", password: process.env.OPENRECORD_EVAL_PASSWORD ?? "password123" })
const chosen = await selection()
console.log(`model: ${chosen ? `${chosen.instanceId.slice(0, 8)}:${chosen.model}` : "hosted"}, ${tasks.length} tasks`)
const results = []
for (const task of tasks) {
  let result
  try { result = await runTask(task, chosen) } catch (e) { result = { id: task.id, seconds: 0, checks: [["ran", false]], error: String(e.message ?? e) } }
  results.push(result)
  const passed = result.checks.filter(c => c[1]).length
  const failed = result.checks.filter(c => !c[1]).map(c => c[0])
  const g = result.grade ? ` quality ${(RUBRIC.reduce((n, k) => n + result.grade[k], 0) / RUBRIC.length).toFixed(1)}/5` : ""
  console.log(`${passed === result.checks.length ? "PASS" : "FAIL"}  ${task.id.padEnd(18)} ${String(passed).padStart(2)}/${result.checks.length}${g}  ${String(result.seconds).padStart(4)}s  ${failed.join("; ")}${result.error ? " " + result.error : ""}`)
}
const total = results.reduce((n, r) => n + r.checks.length, 0)
const passed = results.reduce((n, r) => n + r.checks.filter(c => c[1]).length, 0)
const clean = results.filter(r => r.checks.every(c => c[1])).length
console.log(`\ntasks fully passed: ${clean}/${results.length}   checks passed: ${passed}/${total} (${Math.round((100 * passed) / Math.max(total, 1))}%)`)
const graded = results.filter(r => r.grade)
if (graded.length) console.log(`quality: ${RUBRIC.map(k => `${k} ${(graded.reduce((n, r) => n + r.grade[k], 0) / graded.length).toFixed(1)}`).join(", ")} (${graded.length} graded)`)
if (args.out) writeFileSync(args.out, JSON.stringify({ at: new Date().toISOString(), model: chosen ?? "hosted", results }, null, 2))
