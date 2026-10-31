#!/usr/bin/env node
// Protocol fixture only. It never calls a provider or reads user credentials.
import { createInterface } from "node:readline"
import { writeFileSync } from "node:fs"
const args = process.argv.slice(2)
if (args.includes("--version")) {
  process.stdout.write("TEST harness 9.9.9\n")
  process.exit(0)
}
if (args[0] === "auth") {
  process.stdout.write(JSON.stringify({ loggedIn: true }))
  process.exit(0)
}
if (args[0] === "exec") {
  if (!args.includes("--ignore-user-config") || !args.includes("--ephemeral") || !args.includes("read-only"))
    process.exit(2)
  const file = args[args.indexOf("--output-last-message") + 1]
  let input = ""
  process.stdin.on("data", (chunk) => {
    input += chunk
  })
  process.stdin.on("end", () => {
    if (!input.includes("TEST message")) process.exit(2)
    const effort = args.find(value => value.startsWith("model_reasoning_effort="))
    if (effort && effort !== 'model_reasoning_effort="high"') process.exit(2)
    writeFileSync(file, JSON.stringify({ kind: "text", text: effort ? "TEST Codex reply (high)" : "TEST Codex reply", calls: [] }))
    process.stdout.write('{"type":"thread.completed"}\n')
  })
} else if (args.includes("--input-format")) {
  // Claude Code driven by the Claude Agent SDK: one control handshake, then one
  // result per streamed user message. OpenRecord's instructions arrive as the
  // system prompt; the first message is the conversation, later ones only new entries.
  const lockdown = ["--tools=", "--setting-sources=", "--no-session-persistence", "--disable-slash-commands"]
  if (!lockdown.every(flag => args.includes(flag))) process.exit(2)
  let turn = 0
  const out = (message) => process.stdout.write(JSON.stringify(message) + "\n")
  createInterface({ input: process.stdin }).on("line", (line) => {
    const message = JSON.parse(line)
    if (message.type === "control_request") {
      const request = message.request
      // A model session (it sets the answer schema) must carry OpenRecord's instructions as its system prompt.
      if (request.subtype === "initialize" && request.jsonSchema !== undefined && !JSON.stringify(request.systemPrompt ?? "").includes("You are the model transport for OpenRecord")) process.exit(2)
      out({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: request.subtype === "initialize" ? {
        commands: [], agents: [], output_style: "default", available_output_styles: [],
        models: [{ value: "fixture-model", displayName: "TEST model", description: "", supportedEffortLevels: ["low", "high", "future-level"] }, { value: "fixture-fast", displayName: "TEST fast" }],
        account: { email: "fixture@example.test", subscriptionType: "TEST plan" },
      } : {} } })
      return
    }
    if (message.type !== "user") return
    const text = message.message.content[0].text
    turn++
    if (text.includes("Tool declarations:")) process.exit(2)
    if (turn === 1 ? !text.includes("TEST message") : !text.includes("TEST tool result")) process.exit(2)
    const reply = turn === 1 ? "TEST Claude reply" : `TEST Claude continued ${turn}`
    out({ type: "assistant", message: { role: "assistant", content: [{ type: "thinking", thinking: `TEST thinking ${turn}` }] }, parent_tool_use_id: null, session_id: "fixture" })
    out({ type: "result", subtype: "success", is_error: false, result: "", structured_output: { kind: "text", text: reply, calls: [] }, session_id: "fixture",
      duration_ms: 1, duration_api_ms: 1, num_turns: 1, total_cost_usd: 0, usage: {} })
  })
} else if (args.includes("--print")) {
  if (args[args.indexOf("--tools") + 1] !== "" || !args.includes("--strict-mcp-config")) process.exit(2)
  process.stdin.resume()
  process.stdin.on("end", () =>
    process.stdout.write(JSON.stringify({ structured_output: { kind: "text", text: "TEST Claude reply", calls: [] } }))
  )
} else {
  const lines = createInterface({ input: process.stdin })
  let waitingPrompt, prompts = 0, promptText = ""
  let model = "fixture-model", effort
  const configOptions = () => [
    { id: "model", category: "model", options: [{ value: "fixture-model", name: "TEST model" }, { value: "fixture-thinking", name: "TEST thinking model" }] },
    { id: "effort", category: "thought_level", options: (model === "fixture-thinking" ? ["none", "thinking", "default"] : ["none", "low", "high", "max", "default"]).map(value => ({ value, name: value })) }
  ]
  const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n")
  lines.on("line", (line) => {
    const request = JSON.parse(line)
    if (request.method === "initialize") send({ id: request.id, result: { protocolVersion: 1, agentCapabilities: {} } })
    else if (request.method === "account/read")
      send({ id: request.id, result: { account: { type: "chatgpt" }, requiresOpenaiAuth: true } })
    else if (request.method === "account/rateLimits/read")
      send({ id: request.id, result: { ordinaryUsageAllowed: true, rateLimits: { primary: { usedPercent: 5, resetsAt: 1793454769 } } } })
    else if (request.method === "model/list")
      send({ id: request.id, result: { data: [{ id: "fixture-model", displayName: "TEST model", supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }, { reasoningEffort: "future-option" }] }] } })
    else if (request.method === "session/new")
      send({
        id: request.id,
        result: {
          sessionId: "fixture-session",
          configOptions: configOptions()
        }
      })
    else if (request.method === "session/set_model") send({ id: request.id, result: {} })
    else if (request.method === "session/set_config_option") {
      if (request.params.configId === "model") {
        model = request.params.value
        effort = undefined
      } else if (request.params.configId === "effort" && configOptions()[1].options.some(option => option.value === request.params.value)) effort = request.params.value
      else process.exit(2)
      send({ id: request.id, result: { configOptions: configOptions() } })
    }
    else if (request.method === "session/prompt") {
      waitingPrompt = request.id
      prompts++
      promptText = request.params.prompt[0].text
      if (prompts === 1 ? !promptText.includes("TEST message") : promptText.includes("Tool declarations:") || !promptText.includes("TEST tool result")) process.exit(2)
      send({
        id: "permission-test",
        method: "session/request_permission",
        params: { options: [{ optionId: "allow", kind: "allow_once" }] }
      })
    } else if (request.id === "permission-test") {
      if (request.result?.outcome?.outcome !== "cancelled") process.exit(2)
      send({ id: "filesystem-test", method: "fs/read_text_file", params: { path: "/private/secret" } })
    } else if (request.id === "filesystem-test") {
      if (!request.error) process.exit(2)
      send({
        method: "session/update",
        params: {
          sessionId: "fixture-session",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: JSON.stringify({ kind: "text", text: prompts > 1 ? `TEST ACP continued ${prompts}` : effort ? `TEST ACP reply (${effort})` : "TEST ACP reply", calls: [] }) }
          }
        }
      })
      send({ id: waitingPrompt, result: { stopReason: "end_turn" } })
    }
  })
}
